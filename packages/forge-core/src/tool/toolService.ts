/**
 * 工具事件服务（wu-04-tool-service）。
 *
 * 职责：实现 docs/api/04_tool.md 的工具事件契约（tool.started / tool.completed /
 * tool.error）与 docs/prd/04_tool_execution.md §3.3 的 TE-S01~S04 功能点，是
 * forge-core 纯 Node 业务层，不 import Electron / Vue / pi —— 工具事件由调用方
 * （rpc 层）喂入，本服务只负责内存记录 / 状态流转 / 长结果判断 / Diff 数据提取，
 * 不发射事件（事件接线在 rpc 层）。
 *
 * 设计决策：
 * 1. 事件存储：内存表 toolEvents（Map<sessionId, ToolEvent[]>），每会话独立事件
 *    列表，多会话并行（TD-TE-03 A）互不串扰，无模块级可变会话数据。
 * 2. 幂等（TE-S01「同一工具事件只渲染一张卡片」）：recordToolEvent 对同一
 *    toolEventId 已存在时原地更新而非追加，重复推送不产生第二条记录。
 * 3. 状态机（TE-S04 / U-TE-005）：running -> completed / running -> error 合法；
 *    终态（completed/error）不可再流转，非法反向（completed/error -> running 等）
 *    返回 invalid-transition 错误联合且记录不变；同状态重复推送为幂等成功。
 * 4. 长结果折叠（TD-TE-02 A）：isLongResult 为纯函数阈值判断（默认 5000 字符），
 *    折叠逻辑边界收敛于此，前端据此默认折叠长结果。
 * 5. Diff 数据（TD-TE-01 A）：getDiffData 仅对 edit 类（input 含 old_string /
 *    new_string）返回 DiffData；old_string 缺失时 oldString 为 null（前端降级
 *    显示 newText，PRD TE-S03 边界）。
 * 6. 本层不渲染 Diff DOM（前端职责），无真实 pi，无事件发射。
 */

/** 工具执行状态（docs/api/04_tool.md §1：running / completed / error） */
export type ToolStatus = 'running' | 'completed' | 'error';

/** 工具事件公共字段（docs/api/04_tool.md §1 CanonicalEvent 工具部分） */
export interface ToolEventBase {
  /** 会话 ID */
  sessionId: string;
  /** 工具事件 ID（会话内唯一，幂等键） */
  toolEventId: string;
  /** 工具信息（名称 + 入参透传） */
  tool: {
    /** 工具名（edit / read / write / bash / grep 等） */
    name: string;
    /** 入参（透传 pi 输入；edit 类含 file_path / old_string / new_string） */
    input: Record<string, unknown>;
  };
  /** 执行状态 */
  status: ToolStatus;
}

/** 工具开始事件（tool.started，status=running） */
export interface ToolStartedEvent extends ToolEventBase {
  status: 'running';
}

/** 工具完成事件（tool.completed，status=completed，含结果） */
export interface ToolCompletedEvent extends ToolEventBase {
  status: 'completed';
  /** 执行结果（text/image 可为 null，空结果显示「无输出」） */
  result: { text: string | null; image: string | null };
}

/** 工具错误事件（tool.error，status=error，含错误信息） */
export interface ToolErrorEvent extends ToolEventBase {
  status: 'error';
  /** 错误信息（卡片标红展示） */
  error: { message: string };
}

/** 工具事件（判别联合，按 status 区分三种事件） */
export type ToolEvent = ToolStartedEvent | ToolCompletedEvent | ToolErrorEvent;

/** 状态流转载荷（setToolStatus 的 extra 参数） */
export interface ToolStatusExtra {
  /** 完成结果（status='completed' 时携带；省略时 text/image 置 null） */
  result?: { text: string | null; image: string | null };
  /** 错误信息（status='error' 时携带；省略时使用默认错误文案） */
  error?: { message: string };
}

/** 状态流转结果（判别联合；非法流转 / 事件不存在时 ok=false） */
export type ToolStatusResult =
  | { ok: true; data: ToolEvent }
  | { ok: false; code: 'invalid-transition' | 'not-found'; message: string };

/** Diff 数据（edit 类工具，docs/api/04_tool.md §2） */
export interface DiffData {
  /** 文件路径（来自 input.file_path；缺失为 null） */
  filePath: string | null;
  /** 旧文本（input.old_string；缺失为 null，前端降级显示 newText） */
  oldString: string | null;
  /** 新文本（input.new_string；缺失为 null） */
  newString: string | null;
}

/**
 * 工具事件服务：记录 / 查询 / 状态流转 / 长结果判断 / Diff 提取。
 * 纯内存状态机，无外部依赖；事件由调用方喂入，本服务不发射事件。
 */
export class ToolEventService {
  /** 会话工具事件表（sessionId -> 事件列表），无模块级可变会话数据 */
  private readonly toolEvents: Map<string, ToolEvent[]> = new Map();

  /**
   * 记录工具事件（TE-S01）：追加到会话事件列表；同一 toolEventId 已存在时原地
   * 更新而非追加（幂等，保证一事件一卡片）。
   * @param event 工具事件（started / completed / error）
   * @returns 无返回值（写操作；幂等性由调用方经 getSessionToolEvents 验证）
   */
  recordToolEvent(event: ToolEvent): void {
    const list = this.toolEvents.get(event.sessionId);
    if (list === undefined) {
      this.toolEvents.set(event.sessionId, [event]);
      return;
    }
    const idx = list.findIndex((e) => e.toolEventId === event.toolEventId);
    if (idx === -1) {
      list.push(event);
    } else {
      list[idx] = event; // 幂等：同一事件原地更新，不产生第二条记录
    }
  }

  /**
   * 查询会话工具事件列表（读）。
   * @param sessionId 会话 ID
   * @returns 事件列表副本（未记录会话返回空数组）
   */
  getSessionToolEvents(sessionId: string): ToolEvent[] {
    return [...(this.toolEvents.get(sessionId) ?? [])];
  }

  /**
   * 查询单个工具事件（读）。
   * @param sessionId 会话 ID
   * @param toolEventId 工具事件 ID
   * @returns 事件对象；不存在返回 undefined
   */
  getToolEvent(sessionId: string, toolEventId: string): ToolEvent | undefined {
    return this.toolEvents.get(sessionId)?.find((e) => e.toolEventId === toolEventId);
  }

  /**
   * 状态流转（TE-S04）：running -> completed / running -> error 合法；终态
   * （completed/error）不可再流转，非法反向（completed/error -> running 等）返回
   * invalid-transition 且记录不变；同状态重复推送为幂等成功。合法流转原地更新
   * 事件记录。
   * @param sessionId 会话 ID
   * @param toolEventId 工具事件 ID
   * @param status 目标状态
   * @param extra 状态载荷（completed 携带 result；error 携带 error）
   * @returns 成功返回更新后事件；事件不存在返回 not-found；非法流转返回
   *          invalid-transition（记录不变）
   */
  setToolStatus(
    sessionId: string,
    toolEventId: string,
    status: ToolStatus,
    extra?: ToolStatusExtra,
  ): ToolStatusResult {
    const list = this.toolEvents.get(sessionId);
    if (list === undefined) {
      return { ok: false, code: 'not-found', message: `工具事件不存在: ${toolEventId}` };
    }
    const event = list.find((e) => e.toolEventId === toolEventId);
    if (event === undefined) {
      return { ok: false, code: 'not-found', message: `工具事件不存在: ${toolEventId}` };
    }
    if (event.status === status) {
      // 同状态幂等：重复推送无副作用
      return { ok: true, data: event };
    }
    if (event.status !== 'running') {
      // 终态不可再流转：非法反向被阻止，记录不变
      return {
        ok: false,
        code: 'invalid-transition',
        message: `非法状态流转: ${event.status} -> ${status}`,
      };
    }
    const updated = this.buildUpdatedEvent(event, status, extra);
    const idx = list.indexOf(event);
    list[idx] = updated;
    return { ok: true, data: updated };
  }

  /**
   * 长结果折叠判断（TD-TE-02 A）：纯函数阈值判断，超过阈值视为长结果，前端默认
   * 折叠（U-TE-001 折叠逻辑边界收敛于此）。
   * @param text 结果文本
   * @param threshold 折叠阈值（字符数，默认 5000）
   * @returns 文本长度 > 阈值返回 true（需折叠）；否则 false
   */
  isLongResult(text: string, threshold = 5000): boolean {
    return text.length > threshold;
  }

  /**
   * 提取 Diff 数据（TE-S03）：仅 edit 类（input 含 old_string / new_string）返回
   * DiffData；old_string 缺失时 oldString 为 null（前端降级显示 newText）。
   * @param sessionId 会话 ID
   * @param toolEventId 工具事件 ID
   * @returns Diff 数据；非 edit 类事件或事件不存在返回 null
   */
  getDiffData(sessionId: string, toolEventId: string): DiffData | null {
    const event = this.getToolEvent(sessionId, toolEventId);
    if (event === undefined) {
      return null;
    }
    const input = event.tool.input;
    const hasOld = Object.prototype.hasOwnProperty.call(input, 'old_string');
    const hasNew = Object.prototype.hasOwnProperty.call(input, 'new_string');
    if (!hasOld && !hasNew) {
      return null; // 非 edit 类工具，无 Diff
    }
    return {
      filePath: typeof input.file_path === 'string' ? input.file_path : null,
      oldString: typeof input.old_string === 'string' ? input.old_string : null,
      newString: typeof input.new_string === 'string' ? input.new_string : null,
    };
  }

  /** 构建状态流转后的新事件（内部辅助，供 setToolStatus 原地替换） */
  private buildUpdatedEvent(
    event: ToolEvent,
    status: ToolStatus,
    extra?: ToolStatusExtra,
  ): ToolEvent {
    if (status === 'completed') {
      return {
        sessionId: event.sessionId,
        toolEventId: event.toolEventId,
        tool: event.tool,
        status: 'completed',
        result: extra?.result ?? { text: null, image: null },
      };
    }
    if (status === 'error') {
      return {
        sessionId: event.sessionId,
        toolEventId: event.toolEventId,
        tool: event.tool,
        status: 'error',
        error: extra?.error ?? { message: '工具执行失败' },
      };
    }
    return event; // status='running'（调用方已在上层拦截，此处仅类型完备）
  }
}