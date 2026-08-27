/**
 * Dev-only mock bridge。
 *
 * 仅用于纯浏览器 (vite dev) 预览 UI：当 CSP/Node 环境没有 Electron preload 注入的
 * `window.forge` 时，注入内存种子数据，便于在浏览器里核对视觉布局。
 * - 生产构建 (vite build) 不包含此文件（由 main.ts 在 `import.meta.env.DEV` 下引入）
 * - Electron 真实运行时有 `window.forge`，本文件不触发
 */
import type { ForgeBridge, ForgeResult } from './bridge';

declare global {
  interface Window {
    forge: ForgeBridge;
  }
}

interface MockSessionSeed {
  sessionId: string;
  projectPath: string;
  alias: string | null;
  status: string;
  lastActiveAt: string;
}

const DB: { projects: Array<Record<string, unknown>>; sessions: MockSessionSeed[] } = {
  projects: [
    { path: 'D:/work/aiwork/forge', alias: null, lastOpenedAt: new Date().toISOString(), trust: 'trusted' },
  ],
  sessions: [
    {
      sessionId: 'sess-code-review',
      projectPath: 'D:/work/aiwork/forge',
      alias: '代码审查',
      status: 'idle',
      lastActiveAt: new Date().toISOString(),
    },
    {
      sessionId: 'sess-sse',
      projectPath: 'D:/work/aiwork/forge',
      alias: '修 SSE 断流',
      status: 'done',
      lastActiveAt: new Date().toISOString(),
    },
  ],
};

/** 会话种子持久化键：E2E seed 后 reload（新 JS 上下文）仍保留 */
const SESSIONS_STORAGE_KEY = 'forge-mock-sessions';

// 初始化：若存在 localStorage 种子（E2E seed 后 reload），覆盖默认会话数据
try {
  const persisted = localStorage.getItem(SESSIONS_STORAGE_KEY);
  if (persisted !== null) {
    const parsed = JSON.parse(persisted) as unknown;
    if (Array.isArray(parsed)) {
      DB.sessions = parsed as MockSessionSeed[];
    }
  }
} catch {
  // localStorage 不可用（隐私模式等）按默认种子运行
}

const HISTORY: Record<string, unknown[]> = {
  'sess-code-review': [
    {
      role: 'user',
      content:
        '把项目里重复的工具调用逻辑抽成公共函数，参考截图里的结构。',
      ts: new Date(Date.now() - 60000).toISOString(),
    },
    {
      toolEventId: 'tok-1',
      role: 'tool',
      content: '',
      ts: new Date(Date.now() - 59000).toISOString(),
      toolName: 'file.read',
      status: 'completed',
    },
    {
      role: 'assistant',
      content:
        '定位到 `src/cli.py` 中 3 处重复调 `run(self, cmd)` 的代码。\n\n我准备抽一个公共函数 `run_tool(self, cmd)`，补齐类型注解与单元测试。',
      ts: new Date(Date.now() - 58000).toISOString(),
    },
    {
      toolEventId: 'tok-2',
      role: 'tool',
      content: 'src/cli.py · 抽取 run_tool() · 3 处替换完成',
      ts: new Date(Date.now() - 57000).toISOString(),
      toolName: 'Edit',
      status: 'completed',
    },
    {
      role: 'assistant',
      content:
        '已完成：统一错误对象 + 参数校验，并把三处重复调用替换为 `run_tool()`。`bin/run_tool` 相关的单测已补齐。',
      ts: new Date(Date.now() - 56000).toISOString(),
    },
  ],
  'sess-sse': [
    {
      role: 'user',
      content: 'SSE 重连后丢消息，看看为什么',
      ts: new Date(Date.now() - 90000).toISOString(),
    },
    {
      role: 'assistant',
      content:
        '问题在 `services/sse.ts` 未携带 `Last-Event-ID` 续传。已修复，补了回归用例。',
      ts: new Date(Date.now() - 89000).toISOString(),
    },
  ],
};

const listeners: Record<string, Array<(payload: unknown) => void>> = {};

function emit(event: string, payload: unknown): void {
  (listeners[event] ?? []).forEach((fn) => fn(payload));
}

const modelList = ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.2', 'claude-opus-4'];

// ===== E2E 可编程 mock =====
// 测试经 window.__forgeMock 注入：
// - seed(method, handler)：覆盖任意 invoke 方法（如新增会话/删除后事件）
// - onSend(script)：sendMessage 时按脚本发射事件（delta / message / tool.started / tool.completed / tool.error）
// 脚本项：{ type: 'delta'|'message'|'tool', delayMs, payload }
interface MockScriptItem {
  type: 'delta' | 'message' | 'tool';
  delayMs?: number;
  payload: Record<string, unknown>;
}

interface MockControl {
  /** 覆盖/追加方法处理器（返回 { code, message, data } 信封或 null 走默认） */
  seed(
    method: string,
    handler: (params: Record<string, unknown>) => Record<string, unknown> | null,
  ): void;
  /** 配置会话的发送脚本；pending 时发送挂起等待脚本绪 */
  onSend(sessionId: string, script: MockScriptItem[]): void;
  /** 主动向会话发射事件（测工具卡片/流式时序） */
  emit(sessionId: string, event: 'conversation.delta' | 'conversation.message' | 'conversation.error' | 'tool.started' | 'tool.completed' | 'tool.error', payload: Record<string, unknown>): void;
  /** 注入查询会话列表/历史的种子覆盖 */
  setSessions(list: unknown[]): void;
  setHistory(sessionId: string, messages: unknown[]): void;
  /** 等待中的发送脚本数（断言用） */
  pendingCount(): number;
}

declare global {
  interface Window {
    __forgeMock?: MockControl;
  }
}

const seedHandlers = new Map<string, (params: Record<string, unknown>) => Record<string, unknown> | null>();
const sendScripts = new Map<string, MockScriptItem[]>();
const sendInFlight = new Map<string, Promise<void>>();

const bridge: ForgeBridge = {
  async invoke(method, params) {
    // E2E 可编程覆盖：测试注入的处理器优先
    const seeded = seedHandlers.get(method);
    if (seeded) {
      const overridden = seeded((params ?? {}) as Record<string, unknown>);
      if (overridden !== null) {
        return overridden as unknown as ForgeResult;
      }
    }
    switch (method) {
      case 'project/queryProjectList':
        return { code: 0, message: 'ok', data: { projects: DB.projects } };
      case 'session/querySessionList':
        return {
          code: 0,
          message: 'ok',
          data: {
            sessions: DB.sessions.filter((s) => {
              const pp = (params as { projectPath?: string }).projectPath;
              return !pp || s.projectPath === pp;
            }),
          },
        };
      case 'session/createSession': {
        // E2E：动态新建会话（测试可直接建多会话做并行/删除场景）
        const sessionId = 'sess-' + Math.random().toString(36).slice(2, 10);
        const projectPath = (params as { projectPath?: string }).projectPath ?? DB.projects[0]?.path ?? 'D:/work/aiwork/forge';
        DB.sessions.push({
          sessionId,
          projectPath: projectPath as string,
          alias: null,
          status: 'idle',
          lastActiveAt: new Date().toISOString(),
        });
        return { code: 0, message: 'ok', data: { session: { sessionId } } };
      }
      case 'session/deleteSession': {
        const sid = (params as { sessionId?: string }).sessionId;
        DB.sessions = DB.sessions.filter((s) => s.sessionId !== sid);
        emit('session.removed', { sessionId: sid });
        sendScripts.delete(sid ?? '');
        return { code: 0, message: 'ok', data: null };
      }
      case 'conversation/sendMessage': {
        const sessionId = (params as { sessionId?: string }).sessionId ?? '';
        // 挂起：等待测试注入脚本后再执行（模拟真实运行时序）
        const scriptPromise = new Promise<void>((resolve) => {
          const tick = () => {
            const script = sendScripts.get(sessionId);
            if (script) {
              resolve();
              runScript(sessionId, script);
            } else {
              setTimeout(tick, 20);
            }
          };
          tick();
        });
        sendInFlight.set(sessionId, scriptPromise.then(() => undefined));
        return { code: 0, message: 'ok', data: null };
      }
      case 'conversation/cancelStream':
        // E2E：取消后补发 canceled 状态（保留已生成内容由 UI 状态机处理）
        return { code: 0, message: 'ok', data: null };
      case 'conversation/queryHistory':
        return {
          code: 0,
          message: 'ok',
          data: { messages: HISTORY[(params as { sessionId: string }).sessionId] ?? [] },
        };
      case 'conversation/getContextUsage':
        return { code: 0, message: 'ok', data: { usage: { tokens: 4200, contextWindow: 128000, percent: 3.3 } } };
      case 'model/queryModels':
        return { code: 0, message: 'ok', data: { models: modelList, defaultModel: modelList[0] } };
      case 'model/getSessionModel':
        return { code: 0, message: 'ok', data: { model: modelList[0], effective: modelList[0] } };
      default:
        return { code: 0, message: 'ok', data: null };
    }
  },
  on(event, listener) {
    (listeners[event] ||= []).push(listener);
    return () => {
      listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== listener);
    };
  },
  window: {
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    isMaximized: async () => false,
  },
  dialog: {
    // 浏览器 dev 下无原生对话框，返回默认示例路径（可直接回车创建）
    selectDirectory: async () => 'D:/work/aiwork',
    selectFiles: async () => [],
  },
};

/**
 * 按脚本发射事件序列（流式时序：每个条目间隔 delayMs）。
 * delta/message 归 conversation.*，tool 归 tool.*；事件载荷拼 sessionId。
 */
async function runScript(sessionId: string, script: MockScriptItem[]): Promise<void> {
  for (const item of script) {
    if (item.delayMs && item.delayMs > 0) {
      await new Promise((r) => setTimeout(r, item.delayMs));
    }
    if (item.type === 'delta') {
      emit('conversation.delta', { sessionId, delta: item.payload });
    } else if (item.type === 'message') {
      emit('conversation.message', { sessionId, message: item.payload });
    } else if (item.type === 'tool') {
      emit('tool.started', { sessionId, ...item.payload });
      emit('tool.completed', { sessionId, ...item.payload });
    }
  }
}

/** E2E 控制句柄（挂 window.__forgeMock） */
const mockControl: MockControl = {
  seed(method, handler) {
    seedHandlers.set(method, handler);
  },
  onSend(sessionId, script) {
    sendScripts.set(sessionId, script);
  },
  emit(sessionId, event, payload) {
    emit(event, { sessionId, ...payload });
  },
  setSessions(list) {
    DB.sessions = [...list] as typeof DB.sessions;
    // 持久化：page.reload() 后新 JS 上下文重建 DB 时保留 E2E 种子
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(DB.sessions));
    } catch {
      // 持久化失败不影响本次运行
    }
  },
  setHistory(sessionId, messages) {
    HISTORY[sessionId] = [...messages] as unknown[];
  },
  pendingCount() {
    return sendInFlight.size;
  },
};

/** 仅浏览器 dev 且无真实 bridge 时注入 */
export function ensureDevBridge(): void {
  if (window.location.origin !== import.meta.env.FORGE_DEV_SERVER_ORIGIN) {
    return;
  }
  if (!window.forge) {
    window.forge = bridge;
  }
  if (!window.__forgeMock) {
    window.__forgeMock = mockControl;
  }
}
