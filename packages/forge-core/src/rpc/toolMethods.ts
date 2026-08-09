/**
 * 工具事件 RPC 方法层（wu-04-rpc）。
 *
 * 职责：把 ToolEventService 的工具事件契约包装为传输无关的推送方法。工具执行
 * 不走方法请求-响应（docs/api/04_tool.md §3：无错误码，订阅方按 status 字段渲染），
 * 本层不包装请求，而是暴露事件发射辅助方法（emitToolStarted / emitToolCompleted /
 * emitToolError），把工具事件喂入事件汇（EventSink），并同步服务层状态。本模块是
 * 纯 Node，不 import Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 单向推送：tool.started / tool.completed / tool.error 全部由本层发射，载荷与
 *    docs/api/04_tool.md §1 CanonicalEvent 工具部分一致。
 * 2. 状态同步：emitToolStarted 经 service.recordToolEvent 记录 started 事件；
 *    emitToolCompleted / emitToolError 经 service.setToolStatus 流转状态，成功后
 *    复用服务层已存储事件构建完整载荷 —— started 时透传的 tool 描述符（edit 类
 *    input 含 old_string / new_string）在 completed / error 中得以保留，调用方
 *    无需重复传 tool。
 * 3. 非法流转：终态（completed/error）不可再流转。emitToolStarted 对终态事件、
 *    emitToolCompleted / emitToolError 对非 running 事件均不发射事件，返回
 *    { ok: false, code, message } 联合；合法流转返回 { ok: true }。
 * 4. 方法映射：tool/queryToolEvents 为唯一请求-响应方法（读会话工具事件），返回
 *    { events }；其余均为单向推送（非 methods 条目）。
 * 5. 事件汇（EventSink）为 EventEmitter 兼容接口（仅需 emit），默认使用 node:events
 *    EventEmitter；调用方可注入自定义汇（如跨进程转发）。
 */

import { EventEmitter } from 'node:events';
import { ToolEventService } from '../tool/toolService.ts';
import type { RpcResult, EventSink } from './projectMethods.ts';
import type {
  ToolEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  ToolErrorEvent,
} from '../tool/toolService.ts';

/** 工具描述符（docs/api/04_tool.md §1：name + input 透传） */
export interface ToolDescriptor {
  /** 工具名（edit / read / write / bash / grep 等） */
  name: string;
  /** 入参（透传 pi 输入；edit 类含 file_path / old_string / new_string） */
  input: Record<string, unknown>;
}

/** 工具结果（tool.completed 载荷；text/image 可为 null） */
export type ToolResult = ToolCompletedEvent['result'];

/** 工具错误信息（tool.error 载荷） */
export type ToolErrorInfo = ToolErrorEvent['error'];

/** 发射结果（判别联合；非法流转 / 事件不存在时 ok=false） */
export type ToolEmitResult =
  | { ok: true }
  | { ok: false; code: 'invalid-transition' | 'not-found'; message: string };

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
 * 工具事件 RPC 方法层：事件发射 + 方法映射。
 * @param service ToolEventService 业务实例
 * @param events 事件汇（默认新建 EventEmitter；可注入自定义汇）
 */
export class ToolApi {
  /** 方法映射：方法名 -> handler(params) -> 统一信封（可同步/异步） */
  readonly methods: Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;
  /** 事件汇：tool.started / tool.completed / tool.error 在此发射 */
  readonly events: EventSink;
  private readonly service: ToolEventService;

  constructor(service: ToolEventService, events?: EventSink) {
    this.service = service;
    this.events = events ?? new EventEmitter();
    this.methods = {
      'tool/queryToolEvents': (params) => this.queryToolEvents(params),
    };
  }

  /** tool/queryToolEvents：查询会话工具事件（读，唯一请求-响应方法） */
  private queryToolEvents(params: unknown): RpcResult {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    return ok({ events: this.service.getSessionToolEvents(sessionId) });
  }

  /**
   * 工具开始（非 RPC 方法）：记录 started 事件并发射 tool.started。
   * @param sessionId 会话 ID
   * @param toolEventId 工具事件 ID（会话内唯一，幂等键）
   * @param tool 工具描述符（name + input；edit 类 input 含 old_string / new_string）
   * @returns { ok: true } 并发射 tool.started { sessionId, toolEventId, tool, status: 'running' }；
   *          终态事件重复 started 返回 { ok: false, code: 'invalid-transition' } 且不发射
   */
  emitToolStarted(sessionId: string, toolEventId: string, tool: ToolDescriptor): ToolEmitResult {
    const current = this.service.getToolEvent(sessionId, toolEventId);
    if (current !== undefined && current.status !== 'running') {
      return {
        ok: false,
        code: 'invalid-transition',
        message: `非法状态流转: ${current.status} -> running`,
      };
    }
    const event: ToolStartedEvent = { sessionId, toolEventId, tool, status: 'running' };
    this.service.recordToolEvent(event);
    this.events.emit('tool.started', event);
    return { ok: true };
  }

  /**
   * 工具完成（非 RPC 方法）：流转为 completed 后发射 tool.completed。
   * 复用服务层已存储事件构建载荷（tool 描述符含 started 时透传的 input）。
   * @param sessionId 会话 ID
   * @param toolEventId 工具事件 ID
   * @param result 工具结果（text/image 可为 null）
   * @returns { ok: true } 并发射 tool.completed { sessionId, toolEventId, tool, status: 'completed', result }；
   *          事件不存在 / 非 running 返回 { ok: false, code, message } 且不发射
   */
  emitToolCompleted(
    sessionId: string,
    toolEventId: string,
    result: ToolResult,
  ): ToolEmitResult {
    const current = this.service.getToolEvent(sessionId, toolEventId);
    if (current === undefined) {
      return { ok: false, code: 'not-found', message: `工具事件不存在: ${toolEventId}` };
    }
    if (current.status !== 'running') {
      return {
        ok: false,
        code: 'invalid-transition',
        message: `非法状态流转: ${current.status} -> completed`,
      };
    }
    const updated = this.service.setToolStatus(sessionId, toolEventId, 'completed', { result });
    if (!updated.ok) {
      return { ok: false, code: updated.code, message: updated.message };
    }
    this.events.emit('tool.completed', {
      sessionId,
      toolEventId,
      tool: updated.data.tool,
      status: 'completed',
      result,
    });
    return { ok: true };
  }

  /**
   * 工具出错（非 RPC 方法）：流转为 error 后发射 tool.error。
   * @param sessionId 会话 ID
   * @param toolEventId 工具事件 ID
   * @param error 错误信息
   * @returns { ok: true } 并发射 tool.error { sessionId, toolEventId, tool, status: 'error', error }；
   *          事件不存在 / 非 running 返回 { ok: false, code, message } 且不发射
   */
  emitToolError(sessionId: string, toolEventId: string, error: ToolErrorInfo): ToolEmitResult {
    const current = this.service.getToolEvent(sessionId, toolEventId);
    if (current === undefined) {
      return { ok: false, code: 'not-found', message: `工具事件不存在: ${toolEventId}` };
    }
    if (current.status !== 'running') {
      return {
        ok: false,
        code: 'invalid-transition',
        message: `非法状态流转: ${current.status} -> error`,
      };
    }
    const updated = this.service.setToolStatus(sessionId, toolEventId, 'error', { error });
    if (!updated.ok) {
      return { ok: false, code: updated.code, message: updated.message };
    }
    this.events.emit('tool.error', {
      sessionId,
      toolEventId,
      tool: updated.data.tool,
      status: 'error',
      error,
    });
    return { ok: true };
  }

  /**
   * 查询会话工具事件（非 RPC 方法）：服务层透传读。
   * @param sessionId 会话 ID
   * @returns { events } 事件列表副本（未记录会话返回空数组）
   */
  getSessionToolEvents(sessionId: string): { events: ToolEvent[] } {
    return { events: this.service.getSessionToolEvents(sessionId) };
  }
}

/**
 * 创建 ToolApi 实例（工厂）。
 * @param events 事件汇（可选，默认新建 EventEmitter）
 * @returns ToolApi 实例（内部新建 ToolEventService）
 */
export function createToolApi(events?: EventSink): ToolApi {
  return new ToolApi(new ToolEventService(), events);
}