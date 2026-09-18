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
import type { ForgeBridge, ForgeResult, SlashCommand } from './bridge';
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
  /** 最近查看完成结果时间（与真实 forge-store SessionRecord 字段一致） */
  doneReadAt: string | null;
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
/** 项目持久化键：setProjects 后 reload 保留种子（空数组=零项目落地场景） */
const PROJECTS_STORAGE_KEY = 'forge-mock-projects';

const DB: {
  projects: Array<Record<string, unknown>>;
  sessions: MockSessionSeed[];
  subagents: Record<string, MockSubagentSeed[]>;
  /** mock git 状态（PM-S05）：不在表内 = 非 git 项目（isGitRepo:false 全空值） */
  git: Record<string, { branch: string; branches: string[]; dirty: boolean }>;
} = {
  projects: [
    { path: 'D:/work/aiwork/forge', alias: null, lastOpenedAt: new Date().toISOString(), trust: 'trusted' },
  ],
  sessions: [
    {
      sessionId: 'sess-code-review',
      projectPath: 'D:/work/aiwork/forge',
      alias: '代码审查',
      doneReadAt: null,
      status: 'idle',
      lastActiveAt: new Date().toISOString(),
    },
    {
      sessionId: 'sess-sse',
      projectPath: 'D:/work/aiwork/forge',
      alias: '修 SSE 断流',
      doneReadAt: null,
      status: 'done',
      lastActiveAt: new Date().toISOString(),
    },
    // 演示会话：运行中 = 黄色脉冲圆点
    {
      sessionId: 'sess-demo-pending',
      projectPath: 'D:/work/aiwork/forge',
      alias: '跑在途分析',
      doneReadAt: null,
      status: 'streaming',
      lastActiveAt: new Date().toISOString(),
    },
    // 演示会话：已完成未打开 = 绿色圆点
    {
      sessionId: 'sess-demo-done',
      projectPath: 'D:/work/aiwork/forge',
      alias: '数据清洗已完成',
      doneReadAt: null,
      status: 'done',
      lastActiveAt: new Date().toISOString(),
    },
  ],
  subagents: {},
  git: {
    'D:/work/aiwork/forge': {
      branch: 'dev-v0.1.0',
      branches: ['dev-v0.1.0', 'main', 'feat/login'],
      dirty: true,
    },
  },
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

try {
  const persisted = localStorage.getItem(PROJECTS_STORAGE_KEY);
  if (persisted !== null) {
    const parsed = JSON.parse(persisted) as unknown;
    if (Array.isArray(parsed)) {
      DB.projects = parsed as Array<Record<string, unknown>>;
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

/**
 * 斜杠命令示例清单（语义对齐 docs/api/03_conversation.md §9 双模式）：
 * - 会话模式（提供 sessionId）：命令上报扩展的上报清单，三类全量；
 * - 草稿态（无 sessionId）：轻量资源查询，仅 skills + 模板（无 source:'extension' 项，TD-CV-08）。
 * 均含无描述项（description: null，UI 副文本留空）；seed 可整单覆盖。
 */
const SESSION_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
  { name: 'compact', description: null, source: 'extension' },
  { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
  { name: 'skill:write-tests', description: null, source: 'skill' },
  { name: 'write-tests', description: '生成测试用例', source: 'prompt' },
];

const DRAFT_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
  { name: 'skill:write-tests', description: null, source: 'skill' },
  { name: 'write-tests', description: '生成测试用例', source: 'prompt' },
];

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
      | 'conversation.compacting'
      | 'conversation.compacted'
      | 'conversation.slashCommandsUpdated'
      | 'conversation.askUserQuestionRequested'
      | 'updater.stateChanged',
    payload: Record<string, unknown>,
  ): void;
  /** 注入查询会话列表/历史的种子覆盖 */
  setSessions(list: unknown[]): void;
  /** 注入项目列表种子（空数组=零项目落地场景）；reload 保留 */
  setProjects(list: unknown[]): void;
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
  /** 读取最近一次问卷回填载荷（Path 2；null = 尚无回填） */
  getLastAskUserReply(): Record<string, unknown> | null;
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
/** CV-S09 待发队列（模拟 pi followUp）：sessionId -> FIFO 文本；流式中入队，脚本结束后派发 */
const sendQueues = new Map<string, string[]>();

/** mock cancelStream 行为配置（默认级联，与真实后端语义一致） */
let cancelOpts: MockCancelOpts = { cascadeSubagents: true };

/** 最近一次问卷回填载荷（Path 2；浏览器 dev/e2e 断言用，真实端交给扩展侧 Promise） */
let lastAskUserReply: Record<string, unknown> | null = null;

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
  // 纯浏览器预览：非 Electron 环境，UI 按「无系统窗口控件」处理（不影响 mock 布局核对）
  platform: 'browser',
  // v3.76 启动门闩：mock 无真实 core 组装，永远就绪——欢迎页一帧即过，e2e 不受影响
  async bootState() {
    return { ready: true, startedAt: 0, durationMs: 0 };
  },
  // v3.78.7 splash 上屏回执：纯浏览器环境没有真实窗口可显示，空实现即可
  splashReady() {
    /* noop */
  },
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
        // 返回副本（同真实 IPC 结构化克隆语义）：共享活数组会让
        // projects.value 赋同实例不触发响应式，mock 侧 push 也不被追踪
        return { code: 0, message: 'ok', data: { projects: DB.projects.map((p) => ({ ...p })) } };
      case 'project/addProject': {
        // E2E：注册项目入内存列表（排尾，同真实端未打开垫底；重复返 1001 同真实端）
        const p = (params as { path?: string }).path ?? '';
        if (!p || DB.projects.some((x) => x.path === p)) {
          return { code: 1001, message: `项目已存在: ${p}`, data: null };
        }
        DB.projects.push({
          path: p,
          alias: null,
          lastOpenedAt: new Date().toISOString(),
          trust: 'trusted',
        });
        return { code: 0, message: 'ok', data: null };
      }
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
          doneReadAt: null,
        });
        return { code: 0, message: 'ok', data: { session: { sessionId } } };
      }
      case 'session/markSessionRead': {
        // 绿点已读落盘（与真实 forge-core SessionService.markSessionRead 一致）
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const sess = DB.sessions.find((s) => s.sessionId === sid);
        if (!sess) return { code: 1002, message: '会话不存在: ' + sid, data: null };
        sess.doneReadAt = new Date().toISOString();
        emit('session.updated', { session: sess });
        return { code: 0, message: 'ok', data: { session: sess } };
      }
      case 'session/deleteSession': {
        const sid = (params as { sessionId?: string }).sessionId;
        DB.sessions = DB.sessions.filter((s) => s.sessionId !== sid);
        if (sid !== undefined) delete DB.subagents[sid];
        emit('session.removed', { sessionId: sid });
        sendScripts.delete(sid ?? '');
        sendQueues.delete(sid ?? '');
        persistSubagents();
        return { code: 0, message: 'ok', data: null };
      }
      case 'conversation/sendMessage': {
        const sessionId = (params as { sessionId?: string }).sessionId ?? '';
        const content = (params as { content?: string }).content ?? '';
        const sess = DB.sessions.find((s) => s.sessionId === sessionId);
        // CV-S09 忙时入队：流式中收到 sendMessage → 入待发队列（不写历史/不重置状态），
        // 派发时机在 runScript 尾部（当前脚本结束后 FIFO 取出，与 pi followUp 同构）
        if (sess && sess.status === 'streaming') {
          const q = sendQueues.get(sessionId) ?? [];
          q.push(content);
          sendQueues.set(sessionId, q);
          emit('conversation.queueUpdated', { sessionId, followUp: [...q] });
          return { code: 0, message: 'ok', data: null };
        }
        // 首条用户消息自动命名（与真实 forge-core onFirstUserMessage 一致）+ 状态 idle→streaming，广播刷新会话树
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
        // CV-S09：清空待发队列（与 pi TUI ESC 同款）+ 广播队列变更；返回清空的文本供 UI 回填
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const cleared = sendQueues.get(sid) ?? [];
        if (cleared.length > 0) {
          sendQueues.delete(sid);
          emit('conversation.queueUpdated', { sessionId: sid, followUp: [] });
        }
        // E2E：取消后按 cancelOpts 决定是否级联终止活跃子 agent（默认级联，与真实后端一致）
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
        return { code: 0, message: 'ok', data: { clearedMessages: [...cleared] } };
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
        // 同时模拟真实后端的 compacting/compacted 事件时序（横幅 + 输入锁定依赖）。
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        emit('conversation.compacting', { sessionId: sid, reason: 'manual' });
        const before = mockUsage.get(sid) ?? DEFAULT_USAGE_TOKENS;
        const after = Math.max(1, Math.round(before * COMPACT_SHRINK_RATIO));
        mockUsage.set(sid, after);
        emit('conversation.compacted', {
          sessionId: sid,
          reason: 'manual',
          tokensBefore: before,
          tokensAfter: after,
          summary: '上下文已压缩（mock）',
        });
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
      case 'conversation/getSlashCommands': {
        // 双模式（docs/api §9）：有 sessionId → 会话模式三类全量；无 → 草稿态 skills+模板。
        // seed 可覆盖（invoke 开头的 seedHandlers 优先级已保证）。
        const slashSid = (params as { sessionId?: string }).sessionId;
        const commands =
          typeof slashSid === 'string' && slashSid !== '' ? SESSION_SLASH_COMMANDS : DRAFT_SLASH_COMMANDS;
        return { code: 0, message: 'ok', data: { commands } };
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
        // 模拟过程输出（真实实现读扩展任务输出文件 JSONL 尾部）：
        // 按真实格式返回 JSONL（每行 type=user/assistant/toolResult），
        // 运行中模拟"逐步推进"（条目数随已运行时长增长，不含末条终态正文），终态返回全文
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const agentId = (params as { agentId?: string }).agentId ?? '';
        const target = (DB.subagents[sid] ?? []).find((s) => s.agentId === agentId);
        if (!target) return { code: 1002, message: '子 agent 不存在', data: null };
        const desc = target.description;
        const entries: object[] = [
          { type: 'user', message: { role: 'user', content: desc } },
          { type: 'assistant', message: { role: 'assistant', content: [
            { type: 'toolCall', id: 'call_1', name: 'ls', arguments: { path: 'packages' } },
            { type: 'toolCall', id: 'call_2', name: 'grep', arguments: { pattern: 'subagent' } },
          ] } },
          { type: 'toolResult', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'ls', content: [{ type: 'text', text: 'forge-core\nforge-ui' }], isError: false } },
          { type: 'toolResult', message: { role: 'toolResult', toolCallId: 'call_2', toolName: 'grep', content: [{ type: 'text', text: '6 matches' }], isError: false } },
          { type: 'assistant', message: { role: 'assistant', content: [
            { type: 'text', text: `正在扫描 packages/* 子包清单，查找与“${desc}”相关的内容…` },
            { type: 'toolCall', id: 'call_3', name: 'read', arguments: { path: 'package.json' } },
          ] } },
          { type: 'toolResult', message: { role: 'toolResult', toolCallId: 'call_3', toolName: 'read', content: [{ type: 'text', text: '{ "name": "forge" }' }], isError: false } },
          { type: 'assistant', message: { role: 'assistant', content: [
            { type: 'text', text: target.result ?? `扫描完成，共 **2** 个子包，输出 ${desc.length * 7} 字符。` },
          ] } },
        ];
        const toLine = (entry: object): string => JSON.stringify({
          isSidechain: true,
          agentId,
          timestamp: new Date().toISOString(),
          cwd: 'C:\\works\\ai_work\\forge',
          ...entry,
        });
        const visible = isActive(target.status)
          ? Math.max(2, Math.min(entries.length - 1, 2 + Math.floor((Date.now() - Date.parse(target.startedAt)) / 2000)))
          : entries.length;
        const chunk = entries.slice(0, Math.min(visible, entries.length)).map(toLine).join('\n');
        return {
          code: 0,
          message: 'ok',
          data: { exists: true, size: chunk.length, chunk },
        };
      }
      case 'git/getBranchInfo': {
        // PM-S05：路径命中 mock git 表返回固定分支信息；未命中 = 非 git 项目全空值
        const gp = (params as { path?: string }).path ?? '';
        const g = DB.git[gp];
        if (!g) return { code: 0, message: 'ok', data: { isGitRepo: false, branch: '', branches: [], dirty: false, detached: false } };
        return {
          code: 0,
          message: 'ok',
          data: { isGitRepo: true, branch: g.branch, branches: [...g.branches], dirty: g.dirty, detached: false },
        };
      }
      case 'git/switchBranch': {
        // PM-S05：__conflict__ 模拟 dirty 冲突（6001 + git 原始 stderr 样例，浮窗不关）
        const sp = (params as { path?: string }).path ?? '';
        const sb = (params as { branch?: string }).branch ?? '';
        const g = DB.git[sp];
        if (!g) return { code: 1002, message: '项目未注册: ' + sp, data: null };
        if (sb === '__conflict__') {
          return {
            code: 6001,
            message: 'git 切换失败',
            data: {
              stderr:
                'error: Your local changes to the following files would be overwritten by checkout:\n\tpackage.json\nPlease commit your changes or stash them before you switch branches.\nAborting',
            },
          };
        }
        g.branch = sb;
        emit('git.branchChanged', { path: sp, branch: sb });
        return { code: 0, message: 'ok', data: { branch: sb } };
      }
      case 'model/queryModels':
        return { code: 0, message: 'ok', data: { models: modelList, defaultModel: modelList[0] } };
      case 'model/getSessionModel':
        return { code: 0, message: 'ok', data: { model: modelList[0], effective: modelList[0] } };
      case 'pi/getInfo':
        // 设置页「关于」Tab（组件明细不回传 UI；测试可 seed 覆盖）
        return { code: 0, message: 'ok', data: { forgeVersion: '0.1.0' } };
      case 'pi/updatePlugins':
        return { code: 0, message: 'ok', data: { output: 'all extensions are up to date' } };
      case 'app/getUpdateDebug':
        // 调试控制台开关（默认关闭=普通用户不可见；测试可 seed 覆盖）
        return { code: 0, message: 'ok', data: { enabled: false } };
      case 'updater/getState':
        // 设置页「版本更新」状态快照（mock 固定 idle；测试可 seed 覆盖）
        return {
          code: 0,
          message: 'ok',
          data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
        };
      case 'updater/checkForUpdates':
        // mock 无新版：回到 idle、latestVersion=null（不发提示）
        return {
          code: 0,
          message: 'ok',
          data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
        };
      case 'updater/downloadUpdate':
        // mock 下载起步：downloading 0%（进度经 updater.stateChanged 事件推送，可 emit 模拟）
        return {
          code: 0,
          message: 'ok',
          data: { status: 'downloading', currentVersion: '0.1.0', latestVersion: null, downloadProgress: 0, error: null },
        };
      case 'updater/quitAndInstall':
        // mock 不真正退出重启：返回 idle 快照
        return {
          code: 0,
          message: 'ok',
          data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
        };
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
  askUserQuestion: {
    // 与真实 preload 同构：复用同一事件多路复用（订阅 conversation.askUserQuestionRequested）
    onRequest: (listener) =>
      bridge.on('conversation.askUserQuestionRequested', (payload) =>
        listener(payload as never),
      ),
    reply: async (params) => {
      // 浏览器 dev/e2e：记录最近一次回填供断言（真实端交给扩展侧 Promise）
      lastAskUserReply = params as unknown as Record<string, unknown>;
      return { code: 0, message: 'ok', data: { delivered: true } };
    },
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
  shell: {
    openPath: async () => true,
  },
  theme: {
    // 浏览器 dev/e2e 无主进程：回写只对 Electron 窗口底色有意义，这里空实现
    set: () => {},
  },
  file: {
    // 浏览器 dev 下无 Electron webUtils，拿不到盘上路径
    getPathForFile: () => '',
    scanAttachments: async (paths) =>
      paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p, flagged: false })),
    savePasteImage: async () => null,
    savePastedText: async () => null,
    readImage: async () => null,
    // 浏览器 dev/e2e 无真实盘：固定小清单，@ 补全链路可走通（本地过滤逻辑在渲染层）
    listProjectFiles: async () => [
      'D:/work/aiwork/forge/edu-community/README.md',
      'D:/work/aiwork/forge/edu-community/src/index.ts',
      'D:/work/aiwork/forge/edu-community/docs/prd.md',
    ],
  },
};

/**
 * 首条用户消息生成会话标题（与 forge-desktop generateSessionTitle 同规则的精简版）：
 * 取首行（附件路径行不进标题）→ 按首句截断 → 超 30 字符加省略号。
 */
function generateMockTitle(rawContent: string): string {
  const firstLine = rawContent.split('\n', 1)[0] ?? rawContent;
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
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
  // 流式结束：若待发队列非空 → FIFO 派发下一条（模拟 pi followUp 收尾投递：
  // 广播队列变更 + user 气泡消息 + 重跑脚本），全部派发完才置 done
  const queued = sendQueues.get(sessionId) ?? [];
  if (queued.length > 0) {
    const content = queued.shift()!;
    emit('conversation.queueUpdated', { sessionId, followUp: [...queued] });
    (HISTORY[sessionId] ??= []).push({ role: 'user', content, ts: new Date().toISOString() });
    persistHistory();
    emit('conversation.message', {
      sessionId,
      message: { role: 'user', content, ts: new Date().toISOString() },
    });
    const script = sendScripts.get(sessionId);
    if (script) {
      void runScript(sessionId, script);
      return;
    }
  }
  // 流式结束：会话状态从 streaming 置 done，广播刷新会话树（未打开的完成会话显示绿点）
  const doneSess = DB.sessions.find((s) => s.sessionId === sessionId);
  if (doneSess && doneSess.status === 'streaming') {
    // 真实后端会在所有子 agent 终态后才发 done；mock 简化：脚本结束即视为活跃计数已收敛，
    // 因为本 mock 默认无任何子 agent 种子（无 setSubagents → 计数恒为 0）。
    doneSess.status = 'done';
    doneSess.doneReadAt = null; // 新一轮完成 → 清已读，未打开的会话重新显示绿点
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
  setProjects(list) {
    DB.projects = [...list] as Array<Record<string, unknown>>;
    try {
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(DB.projects));
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
  getLastAskUserReply() {
    return lastAskUserReply === null ? null : { ...lastAskUserReply };
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