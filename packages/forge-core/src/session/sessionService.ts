/**
 * 会话管理服务（wu-02-session-service）。
 *
 * 职责：实现 docs/api/02_session.md 的会话管理方法契约（createSession /
 * querySessionList / deleteSession / updateSessionAlias / getSessionStatus /
 * attachSessionWindow / detachSessionWindow），消费 forge-store 持久化层
 * （src/store/forgeStore.ts）与会话运行时状态/窗口绑定内存表，是 forge-core
 * 纯 Node 业务层，不 import Electron / Vue / pi —— pi 会话生命周期操作经构造
 * 注入的 PiSessionAdapter 适配器完成，测试注入 mock。
 *
 * 设计决策：
 * 1. 错误码映射（docs/api/02_session.md §8）：
 *    - 1001 参数错误：projectPath / sessionId 为空、别名空。
 *    - 1002 会话/项目不存在：createSession 项目未注册，其余方法会话未注册。
 *    - 1004 会话重复开窗（TD-SM-04：一会话至多一个观察窗口）。
 *    - 5000 内部错误：adapter 异常向上抛出，由 rpc 层统一映射为 5000（与
 *      projectService「store 落盘异常向上抛」一致，本服务不吞异常）。
 * 2. 会话运行时状态：内存表 sessionRuntimeStates（Map<sessionId, status>），
 *    默认 idle。pi 会话真实状态（JSONL 流）由模块 03 经 setSessionStatus 驱动，
 *    本层不感知消息内容。多会话并行（TD-SM-01）：各会话独立状态键，无模块级
 *    可变会话数据。
 * 3. deleteSession 幂等：会话已不存在时直接返回成功（code 0），重复删除无副作用
 *    （PRD SM-S03）；运行中会话先 adapter.stopSession 再 adapter.deleteSession，
 *    最后才移除 store 记录 —— stop/delete 失败时错误上抛、会话保留。
 * 4. 窗口绑定（TD-SM-04）：windowBindings（Set<sessionId>）表示会话已有观察窗口；
 *    attach 重复返回 1004；detach 幂等（窗口只是展示器，摘除不影响会话）。
 *    v1 attach 返回 { session, status }，history/流式内容随模块 03 / rpc 层接入。
 * 5. 项目校验：createSession 仅验证项目已注册于 forge-store（getProject），
 *    会话信任继承所属项目（不额外存储信任字段）。
 * 6. 所有方法返回判别联合 `{ ok: true, data } | { ok: false, code, message }`，
 *    调用方无需 try/catch 即可映射错误码；adapter 异常向上抛出由 rpc 层映射 5000。
 */

import path from 'node:path';
import { ForgeStore, normalizeProjectPath } from '../store/index.ts';
import type { SessionRecord } from '../types/forge-store.ts';

/** 会话运行状态（docs/api/02_session.md §5：idle / running / done / error） */
export type SessionStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * pi 会话适配器（可注入 mock）。
 * 隔离 pi 会话生命周期操作，服务层不直接 import pi。
 * @param createSession 在项目目录下创建 pi session，返回 sessionId
 * @param stopSession 停止会话执行（删除运行中会话前必须先停止）
 * @param deleteSession 删除 pi session（硬删，不可逆）
 */
export interface PiSessionAdapter {
  createSession(projectPath: string): Promise<string>;
  stopSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/**
 * 通用方法结果（判别联合）。
 * - `{ ok: true, data }`：成功
 * - `{ ok: false, code, message }`：失败，code 为 API 错误码（1001/1002/1004）
 */
export type SessionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 1002 | 1004; message: string };

/** 会话列表项（会话记录 + 运行时状态，docs/api/02_session.md §2 响应含 status） */
export type SessionListItem = SessionRecord & { status: SessionStatus };

/** 会话状态驱动选项（setSessionStatus 预留，供 rpc 层扩展事件发射等行为） */
export interface SessionStatusOptions {
  /** 预留：rpc 层事件发射开关；本层（v1）不发射事件，忽略 */
  emit?: boolean;
}

/**
 * 会话管理服务：会话生命周期/状态/窗口绑定，消费 forge-store 与注入的 pi 适配器。
 * @param store forge-store 持久化实例（由上层注入）
 * @param adapter pi 会话适配器（测试注入 mock，生产注入真实 pi 实现）
 */
export class SessionService {
  private readonly store: ForgeStore;
  private readonly adapter: PiSessionAdapter;
  /** 会话运行时状态表（sessionId -> status），默认 idle；无模块级可变会话数据 */
  private readonly sessionRuntimeStates: Map<string, SessionStatus> = new Map();
  /** 窗口绑定表（已开观察窗口的 sessionId 集合，TD-SM-04 一会话一窗口） */
  private readonly windowBindings: Set<string> = new Set();

  constructor(store: ForgeStore, adapter: PiSessionAdapter) {
    this.store = store;
    this.adapter = adapter;
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
   * 创建会话（SM-S01）：校验项目已注册 → adapter 建 pi session → 写 forge 元数据。
   * 会话信任继承所属项目（不额外存储信任字段）。
   * @param projectPath 所属项目路径
   * @returns 成功返回会话记录；项目未注册返回 1002；空路径返回 1001
   */
  async createSession(projectPath: string): Promise<SessionResult<{ session: SessionRecord }>> {
    if (typeof projectPath !== 'string' || projectPath.trim() === '') {
      return { ok: false, code: 1001, message: '项目路径不能为空' };
    }
    const key = this.resolveProjectKey(projectPath);
    if (this.store.getProject(key) === null) {
      return { ok: false, code: 1002, message: `项目不存在: ${key}` };
    }
    const sessionId = await this.adapter.createSession(key);
    const now = new Date().toISOString();
    const session: SessionRecord = {
      sessionId,
      projectPath: key,
      alias: null,
      lastActiveAt: now,
      createdAt: now,
      modelOverride: null,
    };
    this.store.saveSession(session);
    return { ok: true, data: { session } };
  }

  /**
   * 查询会话列表（SM-S05 跨项目会话池）：不传 projectPath 返回全部项目会话，
   * 传则按项目过滤；列表项附带运行时状态。
   * @param projectPath 可选：所属项目路径；为空/省略时返回所有项目的会话
   * @returns 会话列表（按最近活动倒序，store 已排序）
   */
  querySessionList(projectPath?: string): SessionResult<{ sessions: SessionListItem[] }> {
    const filter =
      typeof projectPath === 'string' && projectPath.trim() !== ''
        ? this.resolveProjectKey(projectPath)
        : undefined;
    const sessions = this.store.listSessions(filter);
    return {
      ok: true,
      data: {
        sessions: sessions.map((s) => ({
          ...s,
          status: this.sessionRuntimeStates.get(s.sessionId) ?? 'idle',
        })),
      },
    };
  }

  /**
   * 删除会话（SM-S03）：硬删 pi session（不可逆，前端先二次确认）。
   * 运行中会话先 stop 再 delete；会话已不存在时幂等返回成功（code 0）。
   * @param sessionId 会话 ID
   * @returns 成功返回 null；空 ID 返回 1001；adapter 异常向上抛出（rpc 层映射 5000）
   */
  async deleteSession(sessionId: string): Promise<SessionResult<null>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    const session = this.store.getSession(sessionId);
    if (session === undefined) {
      // 幂等：已删除/不存在视为成功，无副作用（PRD SM-S03 重复删除无副作用）
      return { ok: true, data: null };
    }
    if (this.sessionRuntimeStates.get(sessionId) === 'running') {
      // 状态校验：运行中必须先停止执行（U-SM-001），stop 失败则错误上抛、会话保留
      await this.adapter.stopSession(sessionId);
    }
    await this.adapter.deleteSession(sessionId);
    this.store.removeSession(sessionId);
    this.sessionRuntimeStates.delete(sessionId);
    this.windowBindings.delete(sessionId);
    return { ok: true, data: null };
  }

  /**
   * 更新会话别名（SM-S03 重命名）：仅改 forge 元数据，不触碰 pi 消息文件。
   * @param sessionId 会话 ID
   * @param alias 新别名（非空，前后空白会被去除）
   * @returns 成功返回更新后的会话；空别名返回 1001；会话不存在返回 1002
   */
  updateSessionAlias(sessionId: string, alias: string): SessionResult<{ session: SessionRecord }> {
    if (typeof alias !== 'string' || alias.trim() === '') {
      return { ok: false, code: 1001, message: '别名不能为空' };
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    const session = this.store.getSession(sessionId);
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    const updated: SessionRecord = { ...session, alias: alias.trim() };
    this.store.saveSession(updated);
    return { ok: true, data: { session: updated } };
  }

  /**
   * 查询会话状态（SM-S04 状态显示）：返回会话当前状态与服务内运行中会话数。
   * @param sessionId 会话 ID
   * @returns 成功返回 { status, runningCount }；会话不存在返回 1002
   */
  getSessionStatus(sessionId: string): SessionResult<{ status: SessionStatus; runningCount: number }> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.store.getSession(sessionId) === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    let runningCount = 0;
    for (const status of this.sessionRuntimeStates.values()) {
      if (status === 'running') {
        runningCount += 1;
      }
    }
    return {
      ok: true,
      data: { status: this.sessionRuntimeStates.get(sessionId) ?? 'idle', runningCount },
    };
  }

  /**
   * 窗口订阅会话（SM-S05 / TD-SM-04）：绑定会话已有观察窗口，一会话至多一窗口。
   * v1 返回 { session, status }；history/流式内容随模块 03 / rpc 层接入
   * （本层不拥有消息存储，消息内容在 pi）。
   * @param sessionId 会话 ID
   * @returns 成功返回会话与状态；会话不存在返回 1002；重复开窗返回 1004
   */
  attachSessionWindow(sessionId: string): SessionResult<{ session: SessionRecord; status: SessionStatus }> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    const session = this.store.getSession(sessionId);
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    if (this.windowBindings.has(sessionId)) {
      return { ok: false, code: 1004, message: '会话已有关注窗口' };
    }
    this.windowBindings.add(sessionId);
    return {
      ok: true,
      data: { session, status: this.sessionRuntimeStates.get(sessionId) ?? 'idle' },
    };
  }

  /**
   * 窗口摘除订阅（SM-S05）：仅移除窗口绑定，会话本身不受影响（窗口只是展示器）。
   * 幂等：会话存在但未开窗时同样返回成功。
   * @param sessionId 会话 ID
   * @returns 成功返回 null；会话不存在返回 1002
   */
  detachSessionWindow(sessionId: string): SessionResult<null> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.store.getSession(sessionId) === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    this.windowBindings.delete(sessionId);
    return { ok: true, data: null };
  }

  /**
   * 会话运行时状态驱动（内部辅助，供 rpc 层 / 测试驱动状态）。
   * 直接写入内存状态表；本层不发射事件（事件接线在 rpc 层）。
   * @param sessionId 会话 ID
   * @param status 目标状态
   * @param opts 预留选项（当前忽略，供 rpc 层扩展事件发射等行为）
   */
  setSessionStatus(sessionId: string, status: SessionStatus, opts?: SessionStatusOptions): void {
    void opts;
    this.sessionRuntimeStates.set(sessionId, status);
  }
}