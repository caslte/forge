/**
 * 会话管理 RPC 方法层（wu-02-rpc）。
 *
 * 职责：把 SessionService 的业务方法包装为传输无关的方法映射（method -> handler），
 * 统一返回 `{ code, message, data }` 信封（docs/api/index.md 响应格式），供任意传输
 * 层（Electron IPC / headless HTTP）直接调用。本模块是纯 Node，不 import
 * Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 信封格式：成功 `{ code: 0, message: "success", data }`；失败 `{ code, message,
 *    data: null }`。错误码与 docs/api/02_session.md §9 一致：1001 参数错误 / 1002
 *    会话/项目不存在 / 1004 会话重复开窗 / 5000 内部错误。
 * 2. 参数校验：每个 handler 先校验 params（projectPath/sessionId/alias 必须为非空
 *    字符串），非法输入直接返回 1001，不进入服务层。
 * 3. 异常隔离：服务层意外抛错（如 adapter 异常、store 落盘失败）被捕获并返回 5000，
 *    不向调用方泄漏异常细节；错误日志用英文 + `[方法名]` 前缀（docs/specs/common/
 *    coding-style.md）。
 * 4. 事件：session.removed 在删除成功后发射；session.statusChanged 由本层
 *    setSessionStatus 驱动（服务层不发射事件，事件接线在 rpc 层）。事件汇
 *    （EventSink）为 EventEmitter 兼容接口（仅需 emit），默认使用 node:events
 *    EventEmitter；调用方可注入自定义汇（如跨进程转发）。
 * 5. attachSessionWindow v1 返回 `{ history: [], status }`：history 恒为空数组，
 *    消息历史/流式内容随模块 03（对话与消息）接入；status 为会话当前状态。
 * 6. 异步方法（createSession/deleteSession 为 async）统一经 call 包装，返回
 *    Promise<RpcResult>；方法映射签名兼容同步/异步 handler。
 */

import { EventEmitter } from 'node:events';
import type { RpcResult, EventSink } from './projectMethods.ts';
import type { SessionService, SessionResult, SessionStatus } from '../session/sessionService.ts';

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

/**
 * 会话管理 RPC 方法层：方法映射 + 事件发射。
 * @param service SessionService 业务实例
 * @param events 事件汇（默认新建 EventEmitter；可注入自定义汇）
 */
export class SessionApi {
  /** 方法映射：方法名 -> handler(params) -> 统一信封（可同步/异步） */
  readonly methods: Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;
  /** 事件汇：session.statusChanged / session.removed 在此发射 */
  readonly events: EventSink;
  private readonly service: SessionService;

  constructor(service: SessionService, events?: EventSink) {
    this.service = service;
    this.events = events ?? new EventEmitter();
    this.methods = {
      'session/createSession': (params) => this.createSession(params),
      'session/querySessionList': (params) => this.querySessionList(params),
      'session/deleteSession': (params) => this.deleteSession(params),
      'session/updateSessionAlias': (params) => this.updateSessionAlias(params),
      'session/updateSessionProject': (params) => this.updateSessionProject(params),
      'session/markSessionRead': (params) => this.markSessionRead(params),
      'session/getSessionStatus': (params) => this.getSessionStatus(params),
      'session/attachSessionWindow': (params) => this.attachSessionWindow(params),
      'session/detachSessionWindow': (params) => this.detachSessionWindow(params),
    };
  }

  /**
   * 通用调用包装：执行服务方法并映射为信封；意外异常捕获为 5000。
   * @param method 方法名（日志前缀）
   * @param fn 服务调用（同步或异步）
   * @returns 统一信封
   */
  private async call<T>(
    method: string,
    fn: () => SessionResult<T> | Promise<SessionResult<T>>,
  ): Promise<RpcResult> {
    try {
      const result = await fn();
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error(`[${method}] internal error`, err);
      return fail(5000, 'internal error');
    }
  }

  /**
   * session/createSession：创建会话（SM-S01）。
   * projectPath 缺省/null/空白 = 自由会话（与服务层语义一致）；非空字符串 =
   * 归属项目；其他类型（如数字）返回 1001。
   */
  private createSession(params: unknown): Promise<RpcResult> {
    if (!isRecord(params) || !('projectPath' in params) || params.projectPath === null) {
      return this.call('createSession', () => this.service.createSession(null));
    }
    const raw = params.projectPath;
    if (typeof raw !== 'string') {
      return Promise.resolve(fail(1001, '参数错误：projectPath 必须为非空字符串或 null'));
    }
    if (raw.trim() === '') {
      return this.call('createSession', () => this.service.createSession(null));
    }
    return this.call('createSession', () => this.service.createSession(raw));
  }

  /** session/querySessionList：查询会话列表（SM-S05 跨项目会话池） */
  private querySessionList(params: unknown): Promise<RpcResult> {
    let projectPath: string | undefined;
    if (isRecord(params) && typeof params.projectPath === 'string' && params.projectPath.trim() !== '') {
      projectPath = params.projectPath;
    }
    return this.call('querySessionList', () => this.service.querySessionList(projectPath));
  }

  /** session/deleteSession：删除会话（SM-S03），成功后发射 session.removed */
  private async deleteSession(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    const result = await this.call('deleteSession', () => this.service.deleteSession(sessionId));
    if (result.code === 0) {
      this.events.emit('session.removed', { sessionId });
    }
    return result;
  }

  /** session/updateSessionAlias：重命名会话（SM-S03），成功后发射 session.updated */
  private async updateSessionAlias(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    const alias = requireString(params, 'alias');
    if (alias === null) {
      return fail(1001, '参数错误：alias 必须为非空字符串');
    }
    const result = await this.call('updateSessionAlias', () => this.service.updateSessionAlias(sessionId, alias));
    if (result.code === 0 && result.data !== null) {
      this.events.emit('session.updated', { session: (result.data as { session: unknown }).session });
    }
    return result;
  }

  /**
   * session/updateSessionProject：变更会话归属（自由对话管理）。
   * projectPath 为字符串 = 移入该项目；缺省/null = 移出到自由对话。
   * 成功后发射 session.updated 同步各窗口会话树。
   */
  private async updateSessionProject(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    if (!isRecord(params) || !('projectPath' in params) || params.projectPath === null) {
      return this.callAndEmitUpdate('updateSessionProject', () =>
        this.service.updateSessionProject(sessionId, null),
      );
    }
    const projectPath = requireString(params, 'projectPath');
    if (projectPath === null) {
      return fail(1001, '参数错误：projectPath 必须为非空字符串或 null');
    }
    return this.callAndEmitUpdate('updateSessionProject', () =>
      this.service.updateSessionProject(sessionId, projectPath),
    );
  }

  /** 执行服务调用并在成功时发射 session.updated（updateSessionProject 专用） */
  private async callAndEmitUpdate(
    method: string,
    fn: () => SessionResult<{ session: unknown }> | Promise<SessionResult<{ session: unknown }>>,
  ): Promise<RpcResult> {
    const result = await this.call(method, fn);
    if (result.code === 0 && result.data !== null) {
      this.events.emit('session.updated', { session: (result.data as { session: unknown }).session });
    }
    return result;
  }

  /** session/markSessionRead：标记完成结果已读（绿点落盘），成功后发射 session.updated 同步各窗口会话树 */
  private async markSessionRead(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    const result = await this.call('markSessionRead', () => this.service.markSessionRead(sessionId));
    if (result.code === 0 && result.data !== null) {
      this.events.emit('session.updated', { session: (result.data as { session: unknown }).session });
    }
    return result;
  }

  /** session/getSessionStatus：查询会话状态（SM-S04） */
  private getSessionStatus(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('getSessionStatus', () => this.service.getSessionStatus(sessionId));
  }

  /** session/attachSessionWindow：窗口订阅会话（SM-S05 / TD-SM-04） */
  private async attachSessionWindow(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    const result = await this.call('attachSessionWindow', () => this.service.attachSessionWindow(sessionId));
    if (result.code === 0 && result.data !== null) {
      // v1：history 恒为空数组，消息历史/流式内容随模块 03 接入
      const status = (result.data as { status: SessionStatus }).status;
      return ok({ history: [], status });
    }
    return result;
  }

  /** session/detachSessionWindow：窗口摘除订阅（SM-S05），幂等 */
  private detachSessionWindow(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('detachSessionWindow', () => this.service.detachSessionWindow(sessionId));
  }

  /**
   * 会话状态驱动（非 RPC 方法）：供模块 03 / 测试驱动状态，并发射 session.statusChanged。
   * @param sessionId 会话 ID
   * @param status 目标状态
   */
  setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.service.setSessionStatus(sessionId, status);
    const result = this.service.getSessionStatus(sessionId);
    if (result.ok) {
      this.events.emit('session.statusChanged', {
        sessionId,
        status: result.data.status,
        runningCount: result.data.runningCount,
      });
    }
  }
}

/**
 * 创建 SessionApi 实例（工厂）。
 * @param service 会话管理业务服务
 * @param events 事件汇（可选，默认新建 EventEmitter）
 * @returns SessionApi 实例
 */
export function createSessionApi(service: SessionService, events?: EventSink): SessionApi {
  return new SessionApi(service, events);
}