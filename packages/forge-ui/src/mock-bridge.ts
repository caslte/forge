/**
 * Dev-only mock bridge。
 *
 * 仅用于纯浏览器 (vite dev) 预览 UI：当 CSP/Node 环境没有 Electron preload 注入的
 * `window.forge` 时，注入内存种子数据，便于在浏览器里核对视觉布局。
 * - 生产构建 (vite build) 不包含此文件（由 main.ts 在 `import.meta.env.DEV` 下引入）
 * - Electron 真实运行时有 `window.forge`，本文件不触发
 */
import type { ForgeBridge } from './bridge';

declare global {
  interface Window {
    forge: ForgeBridge;
  }
}

const DB = {
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

const bridge: ForgeBridge = {
  async invoke(method, params) {
    switch (method) {
      case 'project/queryProjectList':
        return { code: 0, message: 'ok', data: { projects: DB.projects } };
      case 'session/querySessionList':
        return {
          code: 0,
          message: 'ok',
          data: {
            sessions: DB.sessions.filter((s) => s.projectPath === (params as { projectPath?: string }).projectPath),
          },
        };
      case 'conversation/queryHistory':
        return {
          code: 0,
          message: 'ok',
          data: { messages: HISTORY[(params as { sessionId: string }).sessionId] ?? [] },
        };
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
};

/** 仅浏览器 dev 且无真实 bridge 时注入 */
export function ensureDevBridge(): void {
  if (!window.forge) {
    window.forge = bridge;
  }
  // 预留：便于后续交互事件演示（当前仅静态种子数据）
  void emit;
}