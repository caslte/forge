/**
 * 项目管理 RPC 方法层（wu-01-rpc）。
 *
 * 职责：把 ProjectService 的业务方法包装为传输无关的方法映射（method -> handler），
 * 统一返回 `{ code, message, data }` 信封（docs/api/index.md 响应格式），供任意传输
 * 层（Electron IPC / headless HTTP）直接调用。本模块是纯 Node，不 import
 * Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 信封格式：成功 `{ code: 0, message: "success", data }`；失败 `{ code, message,
 *    data: null }`。错误码与 docs/api/01_project.md §8 一致：1001 参数错误 / 1002
 *    项目不存在 / 1005 信任未授予 / 5000 内部错误。
 * 2. 参数校验：每个 handler 先校验 params（path/alias/decision 必须为非空字符串），
 *    非法输入直接返回 1001，不进入服务层。
 * 3. 异常隔离：服务层意外抛错（如 store 落盘失败）被捕获并返回 5000，不向调用方
 *    泄漏异常细节；错误日志用英文 + `[方法名]` 前缀（docs/specs/common/coding-style.md）。
 * 4. removeProject 幂等映射（重要）：服务层对未注册项目返回 1002（API 契约），
 *    本层按 PRD PM-S03「重复移除无副作用」实现幂等客户端行为 —— 把 1002 映射为
 *    `{ code: 0, data: null }` 返回成功，且不发射 project.removed 事件（未实际移除）。
 * 5. 事件：project.opened / project.removed 在成功时经事件汇发射；project.trustRequested
 *    仅声明类型不发射 —— v1 信任询问主路径是 openProject 同步返回 1005（docs/api/
 *    01_project.md §4/§7），前端从响应体取 prompt 渲染弹窗。
 * 6. 事件汇（EventSink）为 EventEmitter 兼容接口（仅需 emit），默认使用 node:events
 *    EventEmitter；调用方可注入自定义汇（如跨进程转发）。
 */

import { EventEmitter } from 'node:events';
import type { ProjectService, ProjectResult, OpenProjectResult } from '../project/projectService.ts';
import type { TrustDecision } from '../project/projectService.ts';

/** 统一响应信封（docs/api/index.md：code=0 成功，非 0 失败） */
export interface RpcResult<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}

/** 事件汇：EventEmitter 兼容的最小接口（仅需 emit） */
export interface EventSink {
  emit(event: string, ...args: unknown[]): boolean;
}

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

/**
 * 从 params 中取非空字符串参数。
 * @param params 请求参数（未知类型，来自传输层）
 * @param key 参数名
 * @returns 非空字符串；缺失/非字符串/空白返回 null
 */
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

/** 从 params 读取非空字符串数组（reorderProjects 用）；缺失/非数组/空/含非字符串返回 null */
function requireArray(params: unknown, key: string): string[] | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    return null;
  }
  return value as string[];
}

/** 类型守卫：decision 是否为合法信任决策值 */
function isTrustDecision(value: string): value is TrustDecision {
  return value === 'trust' || value === 'reject' || value === 'trustOnce';
}

/**
 * 项目管理 RPC 方法层：方法映射 + 事件发射。
 * @param service ProjectService 业务实例
 * @param events 事件汇（默认新建 EventEmitter；可注入自定义汇）
 */
export class ProjectApi {
  /** 方法映射：方法名 -> handler(params) -> 统一信封 */
  readonly methods: Record<string, (params: unknown) => RpcResult>;
  /** 事件汇：project.opened / project.removed 在此发射 */
  readonly events: EventSink;
  private readonly service: ProjectService;

  constructor(service: ProjectService, events?: EventSink) {
    this.service = service;
    this.events = events ?? new EventEmitter();
    this.methods = {
      'project/addProject': (params) => this.addProject(params),
      'project/removeProject': (params) => this.removeProject(params),
      'project/queryProjectList': (params) => this.queryProjectList(params),
      'project/openProject': (params) => this.openProject(params),
      'project/updateProjectAlias': (params) => this.updateProjectAlias(params),
      'project/reorderProjects': (params) => this.reorderProjects(params),
      'project/setTrust': (params) => this.setTrust(params),
    };
  }

  /**
   * 通用调用包装：执行服务方法并映射为信封；意外异常捕获为 5000。
   * @param method 方法名（日志前缀）
   * @param fn 服务调用
   * @returns 统一信封
   */
  private call<T>(method: string, fn: () => ProjectResult<T>): RpcResult {
    try {
      const result = fn();
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error(`[${method}] internal error`, err);
      return fail(5000, 'internal error');
    }
  }

  /** project/addProject：注册项目（PM-S01） */
  private addProject(params: unknown): RpcResult {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    return this.call('addProject', () => this.service.addProject(path));
  }

  /** project/removeProject：移除项目（PM-S03），未注册视为成功（幂等） */
  private removeProject(params: unknown): RpcResult {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    try {
      const result = this.service.removeProject(path);
      if (result.ok) {
        this.events.emit('project.removed', { path });
        return ok(null);
      }
      // 幂等客户端行为：未注册项目视为移除成功（PRD PM-S03 重复移除无副作用）
      if (result.code === 1002) {
        return ok(null);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error('[removeProject] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** project/queryProjectList：查询项目列表（钉扎优先，其余按最近打开倒序） */
  private queryProjectList(_params: unknown): RpcResult {
    return this.call('queryProjectList', () => this.service.queryProjectList());
  }

  /** project/reorderProjects：全量重排项目（拖拽钉扎） */
  private reorderProjects(params: unknown): RpcResult {
    const paths = requireArray(params, 'paths');
    if (paths === null) {
      return fail(1001, '参数错误：paths 必须为非空字符串数组');
    }
    return this.call('reorderProjects', () => this.service.reorderProjects(paths));
  }

  /** project/openProject：打开项目（PM-S02），含 .pi 未信任时同步返回 1005 */
  private openProject(params: unknown): RpcResult {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    try {
      const result = this.service.openProject(path);
      if (result.ok) {
        this.events.emit('project.opened', { path: result.data.path });
        return ok(result.data);
      }
      if (result.code === 1005) {
        // 信任询问：同步返回 1005 + prompt；project.trustRequested 事件预留但不发射
        return { code: 1005, message: result.message, data: result.data };
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error(`[openProject] internal error`, err);
      return fail(5000, 'internal error');
    }
  }

  /** project/updateProjectAlias：更新项目别名（非空校验） */
  private updateProjectAlias(params: unknown): RpcResult {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const alias = requireString(params, 'alias');
    if (alias === null) {
      return fail(1001, '参数错误：alias 必须为非空字符串');
    }
    return this.call('updateProjectAlias', () => this.service.updateProjectAlias(path, alias));
  }

  /** project/setTrust：回传信任决策（PM-S04） */
  private setTrust(params: unknown): RpcResult {
    const path = requireString(params, 'path');
    if (path === null) {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    const decision = requireString(params, 'decision');
    if (decision === null || !isTrustDecision(decision)) {
      return fail(1001, '参数错误：decision 必须为 trust/reject/trustOnce');
    }
    return this.call('setTrust', () => this.service.setTrust(path, decision));
  }
}

/**
 * 创建 ProjectApi 实例（工厂）。
 * @param service 项目管理业务服务
 * @param events 事件汇（可选，默认新建 EventEmitter）
 * @returns ProjectApi 实例
 */
export function createProjectApi(service: ProjectService, events?: EventSink): ProjectApi {
  return new ProjectApi(service, events);
}