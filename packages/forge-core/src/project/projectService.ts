/**
 * 项目管理服务（wu-01-project-service）。
 *
 * 职责：实现 docs/api/01_project.md 的项目管理方法契约（addProject / removeProject /
 * queryProjectList / openProject / updateProjectAlias / setTrust），消费 forge-store
 * 持久化层（src/store/forgeStore.ts），是 forge-core 纯 Node 业务层，不 import
 * Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 错误码映射（以冻结的 API 契约为准，docs/api/01_project.md §8）：
 *    - 1001 参数错误：路径为空 / 非法路径 / 重复注册 / 别名空 / 信任状态非法流转。
 *    - 1002 项目不存在：removeProject / openProject / updateProjectAlias / setTrust
 *      对未注册路径统一返回 1002。
 *    - 1005 信任未授予：openProject 检测到 `.pi` 资源且信任状态未确定时同步返回，
 *      附带 prompt 供前端渲染信任弹窗。
 *    - store 内部错误码映射：store.addProject 的 1002（路径无效/不可访问）与 1001
 *      （重复注册）均映射为 API 1001（API 契约将"非法路径"归入 1001）；store.updateProject
 *      的 1003（内部未找到）映射为 API 1002。
 * 2. removeProject 的 1002 与 PRD 幂等约束的取舍（重要）：
 *    - PRD PM-S03「重复移除同一项目无副作用（已不存在则忽略）」是数据安全约束：
 *      不崩溃、不丢数据、只动 forge 元数据（本服务与 store 均满足：removeProject
 *      仅删除 project 记录，源文件与 pi 会话不动）。
 *    - API 契约（冻结，错误码权威）规定 removeProject 对不存在项目返回 1002。
 *    - 结论：服务层返回 1002；「重复移除无副作用」的幂等客户端行为（把 1002 视为
 *      成功）由 wu-01-rpc 层实现，本服务不吞掉 1002。
 * 3. 信任状态机（PRD PM-S04）：untrusted -> asking -> trusted / rejected。
 *    - openProject 检测到 `.pi` 资源且状态为 untrusted/asking 时，将 untrusted 置为
 *      asking 并同步返回 1005（v1 信任询问主路径，docs/api/01_project.md §4）。
 *    - setTrust：asking + trust -> trusted；asking + reject -> rejected；asking +
 *      trustOnce -> 回到 untrusted（本次信任不持久，下次打开重新询问）。
 *    - 已确定状态（trusted/rejected）幂等：重复 setTrust 成功且不改变状态，重复
 *      openProject 不再询问。
 *    - 非法流转拒绝：untrusted 未经询问直接 setTrust（跳过询问直接加载）返回 1001。
 * 4. 路径解析：openProject / removeProject / updateProjectAlias / setTrust 使用
 *    resolveProjectKey —— 优先 realpath 规范化（匹配唯一键），目录已删除时降级为
 *    词法绝对路径（保证失效目录仍可移除/打开不崩溃，PRD §2 异常与边界）。
 * 5. 所有方法返回判别联合 `{ ok: true, data } | { ok: false, code, message }`，
 *    调用方无需 try/catch 即可映射错误码；store 落盘异常（如磁盘满）向上抛出，
 *    由 rpc 层统一映射为 5000。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ForgeStore, normalizeProjectPath } from '../store/index.ts';
import type { ProjectRecord, TrustState } from '../types/forge-store.ts';

/** 信任决策（docs/api/01_project.md §6：trust / reject / trustOnce） */
export type TrustDecision = 'trust' | 'reject' | 'trustOnce';

/**
 * 项目级联删除会话端口（v3.32 用户改判 TD-PM-05：移除项目=连同名下会话一并删除）。
 * 由上层（forge-desktop）注入真实 sessionService.deleteSession（停运行+删 pi 会话文件+删 forge 记录）；
 * 未注入时不级联（旧语义，测试兼容）。
 */
export interface ProjectSessionsPort {
  deleteSession(sessionId: string): Promise<void>;
}

/**
 * 信任权威端口（P2-A：真实权威交给 pi 项目信任机制，forge store 只缓存展示状态）。
 * forge-core 不 import pi，由上层（forge-desktop）注入真实 pi 实现；测试注入 fake。
 * - hasTrustRequiringResources：目录是否含需要信任门禁的项目资源（.pi / .agents/skills）
 * - getDecision / setDecision：pi 权威信任决策读写（true=信任 false=拒绝 null=未定）
 */
export interface TrustStorePort {
  hasTrustRequiringResources(cwd: string): boolean;
  getDecision(cwd: string): boolean | null;
  setDecision(cwd: string, decision: boolean): void;
}

/** 信任询问提示载荷（docs/api/01_project.md §4：reason=project-extensions） */
export interface TrustPrompt {
  reason: 'project-extensions';
}

/**
 * 通用方法结果（判别联合）。
 * - `{ ok: true, data }`：成功
 * - `{ ok: false, code, message }`：失败，code 为 API 错误码（1001/1002/1005）
 */
export type ProjectResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 1002 | 1005; message: string };

/**
 * openProject 结果：成功返回项目路径；信任询问（1005）额外携带 prompt 载荷。
 */
export type OpenProjectResult =
  | { ok: true; data: { path: string } }
  | {
      ok: false;
      code: 1005;
      message: string;
      data: { path: string; prompt: TrustPrompt };
    }
  | { ok: false; code: 1002; message: string };

/**
 * 项目管理服务：项目注册/移除/查询/打开/别名/信任，消费 forge-store。
 * @param store forge-store 持久化实例（由上层注入，路径指向 userData 下 forge-store.json）
 * @param trust 信任权威端口（可选；注入后权威信任决策读写交给 pi，forge store 仅缓存展示状态；
 *              未注入时回退到本地 `.pi` 目录检测 + forge 状态机（历史行为，测试兼容））
 */
export class ProjectService {
  private readonly store: ForgeStore;
  private readonly trust: TrustStorePort | null;
  private readonly sessions: ProjectSessionsPort | null;

  constructor(store: ForgeStore, trust?: TrustStorePort, sessions?: ProjectSessionsPort) {
    this.store = store;
    this.trust = trust ?? null;
    this.sessions = sessions ?? null;
  }

  /** 判断目录是否含需要信任门禁的项目资源（注入权威端口时用它，否则本地 `.pi` 检测） */
  private hasTrustResources(key: string): boolean {
    if (this.trust !== null) {
      return this.trust.hasTrustRequiringResources(key);
    }
    return fs.existsSync(path.join(key, '.pi'));
  }

  /** 读取权威信任决策（未注入端口视为未定，走本地状态机） */
  private trustDecision(key: string): boolean | null {
    return this.trust?.getDecision(key) ?? null;
  }

  /** 写入权威信任决策（trust=true / reject=false；trustOnce 不持久） */
  private persistTrustDecision(key: string, decision: boolean | null): void {
    if (this.trust !== null && decision !== null) {
      this.trust.setDecision(key, decision);
    }
  }

  /**
   * 解析项目唯一键：优先 realpath 规范化，目录已删除时降级为词法绝对路径。
   * @param input 用户传入的路径（可为相对路径/符号链接）
   * @returns 用于匹配 store 记录的唯一键
   */
  private resolveProjectKey(input: string): string {
    try {
      return normalizeProjectPath(input);
    } catch {
      return path.resolve(input);
    }
  }

  /**
   * 注册项目（PM-S01）：规范化路径为唯一键，判重后写入 forge 元数据。
   * @param input 目录绝对路径（未规范化原值）
   * @returns 成功返回规范化后的项目记录；失败返回 1001（空/非法路径/重复注册）
   */
  addProject(input: string): ProjectResult<{ project: ProjectRecord }> {
    if (typeof input !== 'string' || input.trim() === '') {
      return { ok: false, code: 1001, message: '路径不能为空' };
    }
    let normalized: string;
    try {
      normalized = normalizeProjectPath(input);
    } catch {
      return { ok: false, code: 1001, message: '路径无效或不可访问' };
    }
    const record: ProjectRecord = {
      path: normalized,
      alias: path.basename(normalized) || 'untitled',
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
      trustState: 'untrusted',
    };
    const result = this.store.addProject(record);
    if (!result.ok) {
      // store 内部 1001=重复注册、1002=路径无效，均映射为 API 1001（参数错误）
      return { ok: false, code: 1001, message: result.message };
    }
    return { ok: true, data: { project: result.project } };
  }

  /**
   * 移除项目（PM-S03）：级联删除名下会话（v3.32 用户改判 TD-PM-05：停运行+删 pi 会话文件+删
   * forge 会话记录，逐个经 sessions 端口执行），再删 forge 项目元数据；不删用户源文件。
   * @param input 项目路径
   * @returns 成功返回级联删除的会话 id 列表；项目未注册返回 1002（幂等客户端行为由 rpc 层实现）
   */
  async removeProject(input: string): Promise<ProjectResult<{ removedSessions: string[] }>> {
    const key = this.resolveProjectKey(input);
    if (this.store.getProject(key) === null) {
      return { ok: false, code: 1002, message: `项目不存在: ${key}` };
    }
    const removedSessions: string[] = [];
    if (this.sessions !== null) {
      for (const session of this.store.listSessions(key)) {
        await this.sessions.deleteSession(session.sessionId);
        removedSessions.push(session.sessionId);
      }
    }
    this.store.removeProject(key);
    return { ok: true, data: { removedSessions } };
  }

  /**
   * 查询项目列表（PM-S01 列表页）：按最近打开时间倒序（未打开过排最后）。
   * @returns 项目记录列表（store 已排序）
   */
  queryProjectList(): ProjectResult<{ projects: ProjectRecord[] }> {
    return { ok: true, data: { projects: this.store.listProjects() } };
  }

  /**
   * 打开项目（PM-S02）：更新最近打开时间；含 `.pi` 资源且未信任时同步返回 1005
   * 并携带信任询问载荷（v1 信任询问主路径）。
   * @param input 项目路径
   * @returns 成功返回项目路径；未注册返回 1002；需信任返回 1005 + prompt
   */
  openProject(input: string): OpenProjectResult {
    const key = this.resolveProjectKey(input);
    const project = this.store.getProject(key);
    if (project === null) {
      return { ok: false, code: 1002, message: `项目不存在: ${key}` };
    }
    const hasPiResource = this.hasTrustResources(key);
    // 无项目资源：不触发信任门禁，展示状态为 untrusted（权威决策无关）
    let nextState: TrustState = !hasPiResource ? 'untrusted' : project.trustState;
    if (hasPiResource && this.trust !== null) {
      // 注入权威端口时以 pi 决策为准：pi 已确定覆盖 forge 缓存展示状态
      const authority = this.trustDecision(key);
      if (authority === true) {
        nextState = 'trusted';
      } else if (authority === false) {
        nextState = 'rejected';
      } else if (project.trustState === 'untrusted') {
        // 权威未决且含资源：未信任 → 进入询问中
        nextState = 'asking';
      }
    } else if (
      hasPiResource &&
      (project.trustState === 'untrusted' || project.trustState === 'asking')
    ) {
      nextState = project.trustState === 'untrusted' ? 'asking' : project.trustState;
    }
    // 仅在最终状态仍未确定（asking / untrusted 且含资源）时触发询问
    const needsTrust =
      hasPiResource && (nextState === 'untrusted' || nextState === 'asking');
    const updated = this.store.updateProject({
      ...project,
      lastOpenedAt: new Date().toISOString(),
      trustState: nextState,
    });
    if (!updated.ok) {
      // store 内部 1003（未找到）映射为 API 1002
      return { ok: false, code: 1002, message: updated.message };
    }
    if (needsTrust) {
      return {
        ok: false,
        code: 1005,
        message: '项目含 .pi 资源，需确认信任',
        data: { path: key, prompt: { reason: 'project-extensions' } },
      };
    }
    return { ok: true, data: { path: key } };
  }

  /**
   * 更新项目别名（PM-S01 别名可编辑）：别名非空校验。
   * @param input 项目路径
   * @param alias 新别名（非空，前后空白会被去除）
   * @returns 成功返回更新后的项目；空别名返回 1001；未注册返回 1002
   */
  updateProjectAlias(input: string, alias: string): ProjectResult<{ project: ProjectRecord }> {
    if (typeof alias !== 'string' || alias.trim() === '') {
      return { ok: false, code: 1001, message: '别名不能为空' };
    }
    const key = this.resolveProjectKey(input);
    const project = this.store.getProject(key);
    if (project === null) {
      return { ok: false, code: 1002, message: `项目不存在: ${key}` };
    }
    const updated = this.store.updateProject({ ...project, alias: alias.trim() });
    if (!updated.ok) {
      return { ok: false, code: 1002, message: updated.message };
    }
    return { ok: true, data: { project: updated.project } };
  }

  /**
   * 全量重排项目（拖拽钉扎）：按传入顺序持久化优先级，列表排序以钉扎为准。
   * @param paths 新的全量顺序（已注册项目路径列表）
   * @returns 成功返回 null；非字符串数组/空/含空白串返回 1001；含未注册路径返回 1002
   */
  reorderProjects(paths: unknown): ProjectResult<null> {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, code: 1001, message: 'paths 必须为非空数组' };
    }
    if (paths.some((p) => typeof p !== 'string' || p.trim() === '')) {
      return { ok: false, code: 1001, message: 'paths 必须为字符串数组' };
    }
    const result = this.store.reorderProjects(paths as string[]);
    if (!result.ok) {
      return { ok: false, code: 1002, message: result.message };
    }
    return { ok: true, data: null };
  }

  /**
   * 设置项目信任（PM-S04）：回传信任询问决策，驱动状态机流转。
   * @param input 项目路径
   * @param decision 决策：trust（信任）/ reject（拒绝）/ trustOnce（本次信任）
   * @returns 成功返回 null；未注册返回 1002；非法状态流转返回 1001
   */
  setTrust(input: string, decision: TrustDecision): ProjectResult<null> {
    const key = this.resolveProjectKey(input);
    const project = this.store.getProject(key);
    if (project === null) {
      return { ok: false, code: 1002, message: `项目不存在: ${key}` };
    }
    switch (project.trustState) {
      case 'trusted':
      case 'rejected':
        // 已确定状态：幂等，不重复询问、不改变状态
        return { ok: true, data: null };
      case 'asking': {
        let next: TrustState;
        if (decision === 'trust') {
          next = 'trusted';
        } else if (decision === 'reject') {
          next = 'rejected';
        } else {
          // trustOnce：本次信任，不持久状态，回到未信任（下次打开重新询问）
          next = 'untrusted';
        }
        // 权威端口联动：trust/reject 写入 pi 信任决策（持久），trustOnce 不持久
        this.persistTrustDecision(key, decision === 'trust' ? true : decision === 'reject' ? false : null);
        const updated = this.store.updateProject({ ...project, trustState: next });
        if (!updated.ok) {
          return { ok: false, code: 1002, message: updated.message };
        }
        return { ok: true, data: null };
      }
      case 'untrusted':
        // 非法流转：未询问直接决策（跳过询问直接加载）→ 1001
        return { ok: false, code: 1001, message: '信任状态非法：未信任状态不可直接决策' };
    }
  }
}