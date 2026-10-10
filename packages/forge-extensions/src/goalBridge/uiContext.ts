/**
 * pi-goal 的宿主 UI 适配层。
 *
 * 问题：`noOpUIContext.confirm` 恒返回 false（pi-coding-agent/dist/core/extensions/runner.js:88），
 * 导致 pi-goal 替换未完成目标时被静默拒绝；`notify` 空实现导致全部状态通知丢失。
 *
 * 做法：本模块在 main 进程内实现一个 `ExtensionUIContext`，把交互请求转发到会话事件总线，
 * 由 forge-desktop 桥接给 renderer 渲染，回填后再 resolve 对应的 Promise。
 * pi-goal 侧的调用代码零改动。
 *
 * 失败语义（关键，避免重演「静默拒绝」）：
 * - `confirm` 宽限到期且用户未回填 → 返回 **false**（等价「用户取消」，与 pi 语义一致）。
 * - `input` / `editor` / `select` 宽限到期 → 返回 **undefined**。
 * - 总线不可用（无订阅者 / 投递抛错）→ 立即按上述缺省值收敛，绝不让 pi-goal 的 await 永久悬挂。
 */

import { randomUUID } from 'node:crypto';

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

import {
  GOAL_STATUS_CHANNEL,
  GOAL_UI_NOTIFY_CHANNEL,
  GOAL_UI_REQUEST_CHANNEL,
  GOAL_UI_REPLY_GRACE_MS,
  GOAL_UI_TIMEOUT_CHANNEL,
  goalUiReplyChannel,
  type GoalStatusPayload,
  type GoalUiReplyPayload,
  type GoalUiRequestKind,
  type GoalUiRequestPayload,
} from './channels.ts';

/**
 * pi-goal 写入状态行的固定 key（pi-goal `runtime.ts:113` `STATUS_KEY = "goal"`）。
 * 硬编码而非从插件导入：pi-goal 未导出该常量，且它属于跨版本可能变动的内部实现。
 * 若上游改 key，表现为徽标不更新（降级为不可见），不会误伤其它扩展的状态行。
 */
const GOAL_STATUS_KEY = 'goal';

/** 适配层所需的最小总线面（与 SubagentEventBus 同构，便于复用既有注入点）。 */
export interface GoalUiEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ForgeUiContextOptions {
  /** 该会话的事件总线（pi-goal 的 `pi.events` 即此总线）。 */
  bus: GoalUiEventBus;
  /** 是否真的要在 GUI 里问用户。false 时全部交互立即按缺省值收敛（降级 / 测试用）。 */
  interactive?: boolean;
  /** 宽限时长（毫秒），测试可注入小窗口。 */
  graceMs?: number;
}

/** 一次挂起请求的全部清理责任：kind 决定缺省语义 + resolve 回调 + 定时器 + 退订函数。 */
interface PendingRequest {
  kind: GoalUiRequestKind;
  resolve: (value: string | boolean | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: (() => void) | undefined;
}

/**
 * 宽限到期 / dispose 时的缺省值（纯函数，可单测）。
 *
 * `confirm` 必须是 **false** 而不是 undefined：pi-goal 拿 `await ctx.ui.confirm(...)`
 * 的返回值直接进 `if (!shouldReplace) { 保留旧目标 }` 判断，虽 truthiness 上二者等价，
 * 但 SDK 的契约签名是 `Promise<boolean>`，返回 undefined 会让 pi 侧的调用方
 * 拿到「类型不符的值」——若上游为此加了运行时断言就会抛。
 */
function defaultForKind(kind: GoalUiRequestKind): string | boolean | undefined {
  return kind === 'confirm' ? false : undefined;
}

function isReply(raw: unknown): raw is GoalUiReplyPayload {
  if (!raw || typeof raw !== 'object') return false;
  const v = raw as Record<string, unknown>;
  if (typeof v.requestId !== 'string' || typeof v.cancelled !== 'boolean') return false;
  return v.value === null || typeof v.value === 'string' || typeof v.value === 'boolean';
}

/**
 * 创建一个转发到 forge 事件总线的 `ExtensionUIContext`。
 *
 * 会话隔离：本工厂在 `bindExtensions` 处按会话调用，闭包内持有该会话总线，
 * 故并发多会话互不串扰（与 askUserQuestion 的会话隔离约定一致）。
 */
export function createForgeUiContext(options: ForgeUiContextOptions): {
  ui: ExtensionUIContext;
  dispose: () => void;
} {
  const { bus, interactive = true, graceMs = GOAL_UI_REPLY_GRACE_MS } = options;

  const pending = new Map<string, PendingRequest>();

  /** 收敛一次挂起请求：清定时器 + 退订 + resolve，保证 Promise 只 settle 一次。 */
  function settle(requestId: string, reply: GoalUiReplyPayload | undefined): void {
    const entry = pending.get(requestId);
    if (entry === undefined) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.unsubscribe !== undefined) {
      try { entry.unsubscribe(); } catch { /* 退订失败不影响收敛 */ }
    }
    if (reply === undefined) {
      // 超时 / dispose / 投递失败：按 kind 的缺省语义收敛（confirm → false）。
      entry.resolve(defaultForKind(entry.kind));
      return;
    }
    if (reply.cancelled) {
      // 用户显式取消：confirm 同样是「否」，必须给 false 而不是 undefined。
      entry.resolve(defaultForKind(entry.kind));
      return;
    }
    entry.resolve(reply.value ?? undefined);
  }

  function request(kind: GoalUiRequestKind, payload: {
    title: string;
    message: string;
    placeholder?: string;
    options?: string[];
  }): Promise<string | boolean | undefined> {
    // 非交互降级：立即按缺省语义收敛，不投递到总线。
    if (!interactive) {
      return Promise.resolve(kind === 'confirm' ? false : undefined);
    }

    const requestId = randomUUID();
    const body: GoalUiRequestPayload = {
      requestId,
      kind,
      title: payload.title,
      message: payload.message,
      ...(payload.placeholder !== undefined ? { placeholder: payload.placeholder } : {}),
      ...(payload.options !== undefined ? { options: payload.options } : {}),
      timeoutMs: graceMs,
    };

    return new Promise<string | boolean | undefined>((resolve) => {
      const entry: PendingRequest = {
        kind,
        resolve,
        timer: setTimeout(() => {
          settle(requestId, undefined);
          if (kind === 'confirm') {
            // 超时被当成「取消」，补一条通知让用户知道发生过什么（否则就是静默拒绝）。
            try {
              bus.emit(GOAL_UI_TIMEOUT_CHANNEL, { requestId, title: payload.title });
            } catch { /* 通知尽力而为 */ }
          }
        }, graceMs),
        unsubscribe: undefined,
      };
      // **不 unref**：宽限定时器是这次交互的持有者，unref 会让 Node 事件循环在
      // 用户尚未作答时就判定「无事可做」而退出（Electron 主进程同理会提前结束应用）。
      // 进程退出由 dispose() 收敛，不是靠定时器维持存活。
      pending.set(requestId, entry);

      const off = bus.on(goalUiReplyChannel(requestId), (raw) => {
        if (!isReply(raw)) return;
        settle(requestId, raw);
      });
      entry.unsubscribe = off;

      try {
        bus.emit(GOAL_UI_REQUEST_CHANNEL, body);
      } catch {
        // 总线投递失败（如会话正在销毁）→ 立即收敛，避免泄漏。
        settle(requestId, undefined);
      }
    });
  }

  const ui = {
    select: (title: string, options: string[]) =>
      request('select', { title, message: title, options: [...options] }) as Promise<string | undefined>,

    confirm: (title: string, message: string) =>
      request('confirm', { title, message }) as Promise<boolean>,

    input: (title: string, placeholder?: string) =>
      request('input', {
        title,
        message: title,
        ...(placeholder !== undefined ? { placeholder } : {}),
      }) as Promise<string | undefined>,

    /**
     * pi-goal 的目标编辑框走 `ui.editor`（不是 `ui.input`）。SDK 的 `editor` 面向终端编辑器
     * 组件，在 GUI 宿主下不可达；但 pi-goal 用它只是「取一段多行文本」。
     * 故按多行 input 处理：pi-goal 拿到非 undefined 文本即可正常往下走。
     */
    editor: (title: string, placeholder?: string) =>
      request('editor', {
        title,
        message: title,
        ...(placeholder !== undefined ? { placeholder } : {}),
      }) as Promise<string | undefined>,

    /**
     * notify：pi-goal 的**全部**状态播报都走这里（errors.ts 的 notifyTerminal）。
     * no-op 实现会让「目标已启动 / 已暂停 / 预算耗尽」全部静默。
     * 转发到总线，由 forge 桥接成 UI 内提示（应用内提示，不用系统级 notifyToast）。
     */
    notify: (message: string, type?: 'info' | 'warning' | 'error') => {
      try {
        bus.emit(GOAL_UI_NOTIFY_CHANNEL, { message, level: type ?? 'info' });
      } catch {
        // 通知通道不可用时静默——通知尽力而为，不能因它中断 pi-goal 流程。
      }
    },

    /**
     * setStatus：pi-goal 的**状态徽标唯一完整数据源**。
     *
     * pi-goal 每次状态变化都调 `ctx.ui.setStatus("goal", <紧凑状态串>)`（runtime.ts:567），
     * 形态覆盖 active / waiting / paused / blocked / usage / budget / complete，
     * 且带 `automatic 已用/上限` 与 token 预算用量。no-op 实现会让用户完全看不到进度。
     * 这里按 key 过滤（只接 pi-goal 的 "goal" 键），转发到总线供 UI 渲染徽标。
     */
    setStatus: (key: string, text: string | undefined) => {
      if (key !== GOAL_STATUS_KEY) return;
      try {
        bus.emit(GOAL_STATUS_CHANNEL, { key, text } satisfies GoalStatusPayload);
      } catch { /* 状态上报尽力而为 */ }
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    onTerminalInput: () => () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    custom: async () => undefined,
  } as unknown as ExtensionUIContext;

  return {    ui,
    dispose: () => {
      // 会话销毁：所有等待中的请求按缺省值收敛，防止 pi-goal 的 await 悬挂。
      for (const requestId of [...pending.keys()]) settle(requestId, undefined);
      pending.clear();
    },
  };
}
