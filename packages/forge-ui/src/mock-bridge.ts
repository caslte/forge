/**
 * Dev-only mock bridge.
 *
 * 仅用于纯浏览器 (vite dev) 预览 UI：当 CSP/Node 环境没有 Electron preload 注入的
 * `window.forge` 时，注入内存种子数据，便于在浏览器里核对视觉布局。
 * - 生产构建 (vite build) 不包含此文件（由 main.ts 在 `import.meta.env.DEV` 下引入）
 * - Electron 真实运行时有 `window.forge`，本文件不触发
 *
 * 模块 06 子 Agent 管理：mock 增加子 agent 内存态、subagent.* 事件、级联 cancelStream。
 */
import type { ForgeBridge, ForgeResult } from './bridge';
import type { Subagent } from './types';

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

/** mock 侧子 agent 记录（含 sessionId 以便按会话归组） */
interface MockSubagentSeed extends Subagent {
  sessionId: string;
}

/** 会话种子持久化键：E2E seed 后 reload（新 JS 上下文）仍保留 */
const SESSIONS_STORAGE_KEY = 'forge-mock-sessions';
/** 子 agent 列表持久化键：setSubagents 后 reload 保留（E-SA-009 重启不重建基线） */
const SUBAGENTS_STORAGE_KEY = 'forge-mock-subagents';
/** 历史持久化键：setHistory 后 reload 保留种子 */
const HISTORY_STORAGE_KEY = 'forge-mock-history';

const DB: {
  projects: Array<Record<string, unknown>>;
  sessions: MockSessionSeed[];
  subagents: Record<string, MockSubagentSeed[]>;
} = {
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
    // 演示会话：运行中 = 黄色脉冲圆点
    {
      sessionId: 'sess-demo-pending',
      projectPath: 'D:/work/aiwork/forge',
      alias: '跑在途分析',
      status: 'streaming',
      lastActiveAt: new Date().toISOString(),
    },
    // 演示会话：已完成未打开 = 绿色圆点
    {
      sessionId: 'sess-demo-done',
      projectPath: 'D:/work/aiwork/forge',
      alias: '数据清洗已完成',
      status: 'done',
      lastActiveAt: new Date().toISOString(),
    },
  ],
  subagents: {},
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

// 初始化：若存在 localStorage 种子（E2E seed 后 reload），覆盖默认数据
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

try {
  const persisted = localStorage.getItem(SUBAGENTS_STORAGE_KEY);
  if (persisted !== null) {
    const parsed = JSON.parse(persisted) as unknown;
    if (parsed && typeof parsed === 'object') {
      DB.subagents = parsed as Record<string, MockSubagentSeed[]>;
    }
  }
} catch {
  // ignore
}

try {
  const persisted = localStorage.getItem(HISTORY_STORAGE_KEY);
  if (persisted !== null) {
    const parsed = JSON.parse(persisted) as unknown;
    if (parsed && typeof parsed === 'object') {
      Object.assign(HISTORY, parsed as Record<string, unknown[]>);
    }
  }
} catch {
  // ignore
}

function persistSubagents(): void {
  try {
    localStorage.setItem(SUBAGENTS_STORAGE_KEY, JSON.stringify(DB.subagents));
  } catch {
    // 忽略持久化失败
  }
}

function persistHistory(): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(HISTORY));
  } catch {
    // 忽略持久化失败
  }
}

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

/** 可选 cancelStream 行为：模拟级联终止 */
interface MockCancelOpts {
  /** 是否级联终止该会话的全部活跃子 agent（emit subagent.updated stopped） */
  cascadeSubagents?: boolean;
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
  emit(
    sessionId: string,
    event:
      | 'conversation.delta'
      | 'conversation.message'
      | 'conversation.error'
      | 'tool.started'
      | 'tool.completed'
      | 'tool.error'
      | 'subagent.updated'
      | 'subagent.removed'
      | 'conversation.statusChanged'
      | 'conversation.compacted',
    payload: Record<string, unknown>,
  ): void;
  /** 注入查询会话列表/历史的种子覆盖 */
  setSessions(list: unknown[]): void;
  setHistory(sessionId: string, messages: unknown[]): void;
  /** 读取当前会话列表（E2E 拿动态新建会话的 id） */
  getSessions(): Array<Record<string, unknown>>;
  /** 等待中的发送脚本数（断言用） */
  pendingCount(): number;
  /** 注入会话的子 agent 列表种子（按 sessionId 隔离，E2E 用以模拟服务端内存态） */
  setSubagents(sessionId: string, list: unknown[]): void;
  /** 读取会话的子 agent 列表（按显示顺序：运行中在前，终态按 finishedAt desc） */
  getSubagents(sessionId: string): Array<Record<string, unknown>>;
  /** 配置 cancelStream 行为（级联/单点） */
  setCancelStream(opts: MockCancelOpts): void;
}

declare global {
  interface Window {
    __forgeMock?: MockControl;
  }
}

/** mock 上下文窗口（与真实模型量级一致，用于百分比计算） */
const CONTEXT_WINDOW = 128000;
/** 会话默认上下文用量（tokens） */
const DEFAULT_USAGE_TOKENS = 4200;
/** 压缩后用量回落比例（mock 模拟：压到原来的 40%） */
const COMPACT_SHRINK_RATIO = 0.4;

/** 每会话当前上下文用量（支持压缩后回落，默认 DEFAULT_USAGE_TOKENS） */
const mockUsage = new Map<string, number>();

const seedHandlers = new Map<string, (params: Record<string, unknown>) => Record<string, unknown> | null>();
const sendScripts = new Map<string, MockScriptItem[]>();
const sendInFlight = new Map<string, Promise<void>>();

/** mock cancelStream 行为配置（默认级联，与真实后端语义一致） */
let cancelOpts: MockCancelOpts = { cascadeSubagents: true };

/** 子 agent 是否处于活跃态（排队中/运行中） */
function isActive(status: Subagent['status']): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * 终态不可逆：终态记录的 finishedAt/result 一经设置不得回退。
 * mock 侧保留同一规则，避免 E2E 误测覆盖语义。
 */
function applySubagentUpsert(sessionId: string, incoming: Subagent): MockSubagentSeed {
  const list = (DB.subagents[sessionId] ??= []);
  const idx = list.findIndex((s) => s.agentId === incoming.agentId);
  if (idx === -1) {
    const rec: MockSubagentSeed = { ...incoming, sessionId };
    list.push(rec);
    return rec;
  }
  const cur = list[idx]!;
  // 终态字段不回退
  const merged: MockSubagentSeed = {
    ...cur,
    ...incoming,
    sessionId,
    finishedAt: cur.finishedAt ?? incoming.finishedAt,
    result: cur.result ?? incoming.result,
    error: cur.error ?? incoming.error,
  };
  list[idx] = merged;
  return merged;
}

/** 按展示顺序排序：运行中在前（启动顺序），终态按 finishedAt desc */
function sortSubagents(list: MockSubagentSeed[]): MockSubagentSeed[] {
  return [...list].sort((a, b) => {
    const aActive = isActive(a.status);
    const bActive = isActive(b.status);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive && bActive) {
      // 活跃：按 startedAt 升序（先来先排前）
      return (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    }
    // 终态：finishedAt desc
    return (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');
  });
}

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
      case 'project/reorderProjects': {
        // 拖拽重排：按传入顺序重排内存项目列表（与真实端持久化语义一致）
        const paths = (params as { paths?: string[] } | null)?.paths ?? [];
        const byPath = new Map(DB.projects.map((p) => [p.path, p]));
        const next = paths
          .map((p) => byPath.get(p))
          .filter((p): p is (typeof DB.projects)[number] => p !== undefined);
        DB.projects = next;
        return { code: 0, message: 'ok', data: null };
      }
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
        const projectPath =
          (params as { projectPath?: string }).projectPath ?? DB.projects[0]?.path ?? 'D:/work/aiwork/forge';
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
        if (sid !== undefined) delete DB.subagents[sid];
        emit('session.removed', { sessionId: sid });
        sendScripts.delete(sid ?? '');
        persistSubagents();
        return { code: 0, message: 'ok', data: null };
      }
      case 'conversation/sendMessage': {
        const sessionId = (params as { sessionId?: string }).sessionId ?? '';
        const content = (params as { content?: string }).content ?? '';
        // 首条用户消息自动命名（与真实 forge-core onFirstUserMessage 一致）+ 状态 idle→streaming，广播刷新会话树
        const sess = DB.sessions.find((s) => s.sessionId === sessionId);
        let sessionTouched = false;
        if (sess && !sess.alias && content.trim() !== '') {
          sess.alias = generateMockTitle(content);
          sessionTouched = true;
        }
        if (sess && sess.status === 'idle') {
          sess.status = 'streaming';
          sessionTouched = true;
        }
        if (sess && sessionTouched) {
          emit('session.updated', { session: sess });
        }
        // 用户消息写入会话历史（与真实 pi 持久化一致，会话切换回显依赖）
        (HISTORY[sessionId] ??= []).push({ role: 'user', content, ts: new Date().toISOString() });
        persistHistory();
        // 挂起：等待测试注入脚本后再执行（模拟真实运行时序）
        const scriptPromise = new Promise<void>((resolve) => {
          const tick = (): void => {
            const script = sendScripts.get(sessionId);
            if (script) {
              resolve();
              void runScript(sessionId, script);
            } else {
              setTimeout(tick, 20);
            }
          };
          tick();
        });
        sendInFlight.set(sessionId, scriptPromise.then(() => undefined));
        return { code: 0, message: 'ok', data: null };
      }
      case 'conversation/cancelStream': {
        // E2E：取消后按 cancelOpts 决定是否级联终止活跃子 agent（默认级联，与真实后端一致）
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        if (cancelOpts.cascadeSubagents) {
          const list = DB.subagents[sid] ?? [];
          const now = new Date().toISOString();
          for (const sa of list) {
            if (!isActive(sa.status)) continue;
            const stopped: Subagent = {
              ...sa,
              status: 'stopped',
              finishedAt: sa.finishedAt ?? now,
              error: sa.error ?? '用户终止',
            };
            applySubagentUpsert(sid, stopped);
            emit('subagent.updated', { sessionId: sid, subagent: stopped });
          }
          persistSubagents();
        }
        return { code: 0, message: 'ok', data: null };
      }
      case 'conversation/queryHistory':
        return {
          code: 0,
          message: 'ok',
          data: { messages: HISTORY[(params as { sessionId: string }).sessionId] ?? [] },
        };
      case 'conversation/getContextUsage': {
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const tokens = mockUsage.get(sid) ?? DEFAULT_USAGE_TOKENS;
        return {
          code: 0,
          message: 'ok',
          data: {
            usage: {
              tokens,
              contextWindow: CONTEXT_WINDOW,
              percent: (tokens / CONTEXT_WINDOW) * 100,
            },
          },
        };
      }
      case 'conversation/compact': {
        // 与真实链路同构（{ result: { ok, tokensBefore, tokensAfter, summary } }）。
        // 缺失该分支时会落到 default 返回 data:null，UI 侧对 null 取值抛 TypeError。
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const before = mockUsage.get(sid) ?? DEFAULT_USAGE_TOKENS;
        const after = Math.max(1, Math.round(before * COMPACT_SHRINK_RATIO));
        mockUsage.set(sid, after);
        return {
          code: 0,
          message: 'ok',
          data: {
            result: {
              ok: true,
              tokensBefore: before,
              tokensAfter: after,
              summary: '上下文已压缩（mock）',
            },
          },
        };
      }
      case 'subagent/queryList': {
        // 返回该会话的子 agent 列表（按展示顺序：运行中在前，终态按 finishedAt desc）
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const list = sortSubagents(DB.subagents[sid] ?? []);
        return { code: 0, message: 'ok', data: { subagents: list as unknown[] } };
      }
      case 'subagent/stop': {
        // 单个终止：标记 stopped 并发出 subagent.updated
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const agentId = (params as { agentId?: string }).agentId ?? '';
        const list = DB.subagents[sid] ?? [];
        const target = list.find((s) => s.agentId === agentId);
        if (!target) return { code: 1002, message: '子 agent 不存在', data: null };
        if (!isActive(target.status)) {
          // 幂等：终态重复终止直接成功
          return { code: 0, message: 'ok', data: null };
        }
        const stopped: Subagent = {
          ...target,
          status: 'stopped',
          finishedAt: target.finishedAt ?? new Date().toISOString(),
          error: target.error ?? '用户终止',
        };
        applySubagentUpsert(sid, stopped);
        emit('subagent.updated', { sessionId: sid, subagent: stopped });
        persistSubagents();
        return { code: 0, message: 'ok', data: null };
      }
      case 'subagent/clearFinished': {
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const list = DB.subagents[sid] ?? [];
        const removedIds: string[] = [];
        const next = list.filter((s) => {
          if (isActive(s.status)) return true;
          removedIds.push(s.agentId);
          return false;
        });
        DB.subagents[sid] = next;
        if (removedIds.length > 0) {
          emit('subagent.removed', { sessionId: sid, agentIds: removedIds });
        }
        persistSubagents();
        return { code: 0, message: 'ok', data: { removed: removedIds } };
      }
      case 'subagent/queryOutput': {
        // 模拟过程输出（真实实现读扩展任务输出文件尾部）：按 agentId 生成稳定多行文本，
        // 运行中的子 agent 模拟"逐步推进"（行数随时间增长），终态返回固定全文
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const agentId = (params as { agentId?: string }).agentId ?? '';
        const target = (DB.subagents[sid] ?? []).find((s) => s.agentId === agentId);
        if (!target) return { code: 1002, message: '子 agent 不存在', data: null };
        const lines = [
          `[${target.agentType}] 开始执行：${target.description}`,
          '读取项目目录结构…',
          '分析 package.json workspaces 配置…',
          '扫描 packages/* 子包清单…',
          '汇总扫描结果，生成报告…',
          `执行完成，共输出 ${target.description.length * 7} 字符。`,
        ];
        const chunk = isActive(target.status)
          ? lines.slice(0, Math.max(1, Math.min(lines.length - 1, Math.floor((Date.now() / 3000) % lines.length)))).join('\n')
          : lines.join('\n');
        return {
          code: 0,
          message: 'ok',
          data: { exists: true, size: chunk.length, chunk },
        };
      }
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
 * 首条用户消息生成会话标题（与 forge-desktop generateSessionTitle 同规则的精简版）：
 * 去换行空白 → 按首句截断 → 超 30 字符加省略号。
 */
function generateMockTitle(rawContent: string): string {
  const cleaned = rawContent.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '新会话';
  const m = cleaned.match(/^(.+?)[。！？!?.;；]/);
  const first = m && m[1] !== undefined ? m[1].trim() : cleaned;
  return first.length > 30 ? first.slice(0, 30) + '…' : first;
}

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
      // assistant 消息写入会话历史（会话切换回显依赖）
      (HISTORY[sessionId] ??= []).push(item.payload);
      persistHistory();
    } else if (item.type === 'tool') {
      emit('tool.started', { sessionId, ...item.payload });
      emit('tool.completed', { sessionId, ...item.payload });
    }
  }
  // 流式结束：会话状态从 streaming 置 done，广播刷新会话树（未打开的完成会话显示绿点）
  const doneSess = DB.sessions.find((s) => s.sessionId === sessionId);
  if (doneSess && doneSess.status === 'streaming') {
    // 真实后端会在所有子 agent 终态后才发 done；mock 简化：脚本结束即视为活跃计数已收敛，
    // 因为本 mock 默认无任何子 agent 种子（无 setSubagents → 计数恒为 0）。
    doneSess.status = 'done';
    emit('session.updated', { session: doneSess });
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
    // subagent.updated 额外写库（mock 侧权威状态由 emit 维护，便于 getSubagents 反查）
    if (event === 'subagent.updated') {
      const sub = payload['subagent'] as Subagent | undefined;
      if (sub && typeof sub === 'object') {
        applySubagentUpsert(sessionId, sub);
        persistSubagents();
      }
    } else if (event === 'subagent.removed') {
      const ids = (payload['agentIds'] as string[] | undefined) ?? [];
      const list = DB.subagents[sessionId] ?? [];
      DB.subagents[sessionId] = list.filter((s) => !ids.includes(s.agentId));
      persistSubagents();
    }
    emit(event, { sessionId, ...payload });
  },
  setSessions(list) {
    DB.sessions = [...list] as MockSessionSeed[];
    // 持久化：page.reload() 后新 JS 上下文重建 DB 时保留 E2E 种子
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(DB.sessions));
    } catch {
      // 持久化失败不影响本次运行
    }
  },
  setHistory(sessionId, messages) {
    HISTORY[sessionId] = [...messages] as unknown[];
    persistHistory();
  },
  getSessions() {
    return DB.sessions.map((s) => ({ ...s }));
  },
  pendingCount() {
    return sendInFlight.size;
  },
  setSubagents(sessionId, list) {
    DB.subagents[sessionId] = (list as Subagent[]).map((s) => ({ ...s, sessionId }));
    persistSubagents();
  },
  getSubagents(sessionId) {
    return sortSubagents(DB.subagents[sessionId] ?? []).map((s) => ({ ...s }));
  },
  setCancelStream(opts) {
    cancelOpts = { ...opts };
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