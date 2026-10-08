/**
 * Git RPC 方法层（wu-01-project-git-core）。
 *
 * 职责：把 GitService 包装为传输无关的方法映射（git/getBranchInfo、git/switchBranch），
 * 统一返回 `{ code, message, data }` 信封（docs/api/01_project.md §10/§11）。
 * 纯 Node，不 import Electron / Vue / pi。模式与 projectMethods.ts 一致。
 *
 * 设计决策：
 * 1. 1001 参数校验：path / branch 必须为非空字符串，非法输入不进服务层。
 * 2. 1002 未注册：经 ProjectService.queryProjectList 判定 path 是否已注册（realpath
 *    规范化匹配唯一键，与 projectService.resolveProjectKey 同口径）。
 * 3. 6001 透传：git 切换失败时 data.stderr 附 git 原始错误输出（§9/§11）。
 * 4. 事件 git.branchChanged（TD-PM-09）：switchBranch 成功且分支变化时发射
 *    { path, branch }；幂等（目标即当前分支，changed=false）不发射。
 * 5. 异常隔离：意外异常捕获为 5000，不向调用方泄漏异常细节。
 * 6. 模块 11（git 提交/推送）扩 getStatus / commit / push 三方法（TD-GC-01），
 *    错误码 6006（提交失败）/ 6007（推送失败）沿用 6001 的 data.stderr 透传形态；
 *    commit 的 includeUnstaged 缺省视为 true（勾选框默认勾上口径）。
 *    git/generateCommitMessage 不在本层——需要 provider 配置与密钥解密，
 *    由 forge-desktop 组装（src/git/commitMessageService.ts）。
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeProjectPath } from '../store/index.ts';
import type { RpcResult, EventSink } from './projectMethods.ts';
import type { GitService } from '../git/gitService.ts';
import type { ProjectService } from '../project/projectService.ts';

/** 构造成功信封 */
function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

/** 构造失败信封（data 恒为 null） */
function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** 类型守卫：params 是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从 params 中取非空字符串参数；缺失/非字符串/空白返回 null */
function requireString(params: unknown, key: string): string | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return value;
}

/** Git RPC 依赖：git 服务 + 项目服务（注册判定）+ 事件汇 */
export interface GitApiDeps {
  gitService: GitService;
  projectService: ProjectService;
  events?: EventSink;
}

/**
 * Git RPC 方法层：方法映射 + git.branchChanged 事件发射。
 */
export class GitApi {
  /** 方法映射：方法名 -> handler(params) -> 统一信封（git 命令为 async） */
  readonly methods: Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;
  /** 事件汇：git.branchChanged 在此发射 */
  readonly events: EventSink;
  private readonly gitService: GitService;
  private readonly projectService: ProjectService;

  constructor(deps: GitApiDeps) {
    this.gitService = deps.gitService;
    this.projectService = deps.projectService;
    this.events = deps.events ?? new EventEmitter();
    this.methods = {
      'git/getBranchInfo': (params) => this.getBranchInfo(params),
      'git/switchBranch': (params) => this.switchBranch(params),
      'git/getStatus': (params) => this.getStatus(params),
      'git/getFileDiff': (params) => this.getFileDiff(params),
      'git/getCommitLog': (params) => this.getCommitLog(params),
      'git/getCommitDetail': (params) => this.getCommitDetail(params),
      'git/getCommitFileDiff': (params) => this.getCommitFileDiff(params),
      'git/commit': (params) => this.commit(params),
      'git/push': (params) => this.push(params),
    };
  }

  /** 解析项目唯一键：优先 realpath 规范化，目录不可达时降级词法绝对路径 */
  private resolveProjectKey(input: string): string {
    try {
      return normalizeProjectPath(input);
    } catch {
      return path.resolve(input);
    }
  }

  /** path 是否已注册（经 ProjectService 查询全量列表后匹配唯一键） */
  private isRegistered(input: string): boolean {
    const result = this.projectService.queryProjectList();
    if (!result.ok) {
      return false;
    }
    const key = this.resolveProjectKey(input);
    return result.data.projects.some((p) => p.path === key);
  }

  /** git/getBranchInfo：实时查询分支信息（PM-S05） */
  private async getBranchInfo(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      return ok(await this.gitService.getBranchInfo(path));
    } catch (err) {
      console.error('[getBranchInfo] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** git/switchBranch：切换分支（PM-S05），成功且分支变化时广播 git.branchChanged */
  private async switchBranch(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const branch = requireString(params, 'branch');
    if (branch === null) {
      return fail(1001, '参数错误：branch 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.switchBranch(path, branch);
      if (result.ok) {
        if (result.data.changed) {
          this.events.emit('git.branchChanged', { path, branch: result.data.branch });
        }
        return ok({ branch: result.data.branch });
      }
      if (result.code === 6001) {
        // 6001：data.stderr 附 git 原始错误输出（docs/api/01_project.md §11）
        return { code: 6001, message: result.message, data: { stderr: result.stderr ?? '' } };
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[switchBranch] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** git/getStatus：提交弹窗数据源（模块 11 GC-F01，只读） */
  private async getStatus(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      return ok(await this.gitService.getStatus(path));
    } catch (err) {
      console.error('[getStatus] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /**
   * git/getFileDiff：单文件 unified diff（模块 12 代码查看器「并排 diff」数据源，只读）。
   * relPath 逃逸（绝对路径 / `..`）由服务层判 1001，这里只做参数存在性校验。
   */
  private async getFileDiff(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const relPath = requireString(params, 'relPath');
    if (relPath === null) {
      return fail(1001, '参数错误：relPath 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.getFileDiff(path, relPath);
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[getFileDiff] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /**
   * git/getCommitLog（CE-S11，api/11 §6）：提交历史列表。
   * 空仓库（unborn HEAD）与非 Git 目录均由**服务层**归一为 code=0 + 空数组，
   * 本层不重复判断——判断逻辑只有一处，避免两处口径漂移。
   */
  private async getCommitLog(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const rawLimit = isRecord(params) ? params.limit : undefined;
    const rawSkip = isRecord(params) ? params.skip : undefined;
    // 缺省口径与 api/11 §6 一致；非法值原样下传由服务层拒（1001），不在这里夹取
    const limit = rawLimit === undefined ? 100 : rawLimit;
    const skip = rawSkip === undefined ? 0 : rawSkip;
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.getCommitLog(path, limit as number, skip as number);
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[getCommitLog] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** git/getCommitDetail（CE-S11，api/11 §7）：提交元数据 + 逐文件增删，**不含 patch** */
  private async getCommitDetail(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const sha = requireString(params, 'sha');
    if (sha === null) {
      return fail(1001, '参数错误：sha 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.getCommitDetail(path, sha);
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[getCommitDetail] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** git/getCommitFileDiff（CE-S11，api/11 §8）：单文件提交级 unified diff（两级取数第二级） */
  private async getCommitFileDiff(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const sha = requireString(params, 'sha');
    if (sha === null) {
      return fail(1001, '参数错误：sha 必须为非空字符串');
    }
    const file = requireString(params, 'file');
    if (file === null) {
      return fail(1001, '参数错误：file 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.getCommitFileDiff(path, sha, file);
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[getCommitFileDiff] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /**
   * git/commit：提交（模块 11 GC-F03）。includeUnstaged 缺省 true（勾选框默认口径）；
   * 6006/1001 失败信封与 6001 同款（data.stderr 附 git 原始错误）。
   */
  private async commit(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const message = requireString(params, 'message');
    if (message === null) {
      return fail(1001, '参数错误：message 必须为非空字符串');
    }
    const raw = isRecord(params) ? params.includeUnstaged : undefined;
    const includeUnstaged = typeof raw === 'boolean' ? raw : true;
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.commit(path, message, includeUnstaged);
      if (result.ok) {
        return ok(result.data);
      }
      if (result.code === 6006) {
        return { code: 6006, message: result.message, data: { stderr: result.stderr ?? '' } };
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[commit] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** git/push：推送当前分支（模块 11 GC-F04），6007 附 git 原始 stderr */
  private async push(params: unknown): Promise<RpcResult> {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    try {
      if (!this.isRegistered(path)) {
        return fail(1002, `项目不存在: ${path}`);
      }
      const result = await this.gitService.push(path);
      if (result.ok) {
        return ok(result.data);
      }
      if (result.code === 6007) {
        return { code: 6007, message: result.message, data: { stderr: result.stderr ?? '' } };
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[push] internal error', err);
      return fail(5000, 'internal error');
    }
  }
}

/**
 * 创建 GitApi 实例（工厂）。
 * @param deps git 服务 + 项目服务 + 事件汇（events 可选，默认新建 EventEmitter）
 */
export function createGitApi(deps: GitApiDeps): GitApi {
  return new GitApi(deps);
}
