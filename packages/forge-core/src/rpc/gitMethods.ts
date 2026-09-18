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
}

/**
 * 创建 GitApi 实例（工厂）。
 * @param deps git 服务 + 项目服务 + 事件汇（events 可选，默认新建 EventEmitter）
 */
export function createGitApi(deps: GitApiDeps): GitApi {
  return new GitApi(deps);
}
