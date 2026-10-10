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
  /** null = 自由会话（不绑定项目，落侧栏「自由对话」分组） */
  projectPath: string | null;
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
/** 新装标志键：置 '1' 后 reload 会触发首次使用指引（真实应用由主进程判定，见 startupFlags.ts） */
const FRESH_INSTALL_STORAGE_KEY = 'forge-mock-fresh-install';

const DB: {
  projects: Array<Record<string, unknown>>;
  sessions: MockSessionSeed[];
  subagents: Record<string, MockSubagentSeed[]>;
  /** mock git 状态（PM-S05）：不在表内 = 非 git 项目（isGitRepo:false 全空值）；
   *  GC-S11 扩展可缺省的状态字段（fileCount 等），缺省按 0/true 兜底 */
  git: Record<
    string,
    {
      branch: string;
      branches: string[];
      dirty: boolean;
      fileCount?: number;
      added?: number;
      removed?: number;
      stagedEmpty?: boolean;
      stagedCount?: number;
      unpushedCount?: number | null;
      hasHead?: boolean;
      /** 模块 12：逐文件状态（代码树的 Git 徽标）；缺省 = 非 git 项目或干净仓库 */
      files?: Array<{ path: string; status: string; staged?: boolean; added?: number; removed?: number }>;
    }
  >;
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
      // GC-S11 演示态：有变更但暂存区为空 → 不勾「包含未暂存变更」时按钮禁用+提示
      fileCount: 8,
      added: 44,
      removed: 11,
      stagedEmpty: true,
      stagedCount: 0,
      unpushedCount: 2,
      hasHead: true,
      // 模块 12：代码树的 Git 徽标 + 变更视图清单。与 fileMock 的假路径对齐，
      // 让 Mock 下 M/A/? 三态可见。added/removed 是**逐文件**行数（含未跟踪，
      // 与汇总口径不同——见 core GitStatusFile 的注释）。
      // 注：此处刻意不列 mock-bridge.ts——文件树 fixture 里没有它，
      // 列了就是一条永远渲染不出来的死数据（踩过一次）。
      files: [
        { path: 'packages/forge-ui/src/App.vue', status: 'M', staged: false, added: 12, removed: 3 },
        { path: 'packages/forge-core/src/file/fileService.ts', status: 'A', staged: true, added: 340, removed: 0 },
        { path: 'packages/forge-ui/src/bridge.ts', status: 'M', staged: false, added: 8, removed: 5 },
        { path: 'docs/prd/12_code_explorer.md', status: '?', staged: false, added: 24, removed: 0 },
      ],
    },
  },
};

/** mock 项目路径（与 DB.projects 首项一致，代码树 fixture 挂在它下面） */
const MOCK_PROJECT_PATH = 'D:/work/aiwork/forge';

/* ===== CE-S11 提交历史 mock 数据 =====
 * 作者刻意选「王工 / 李工」这类**末字相同**的名字：头像首字母若取末字，
 * 两人会渲染成同一个字，E-CE-31 正是为此钉住「必须取姓氏」。
 * 时间戳按 2026-10-08 14:00 倒排，让相对时间在 mock 下也能覆盖
 * 「刚刚 / 小时前 / 天前 / 更早」多档。
 */
const MOCK_COMMITS = [
  {
    sha: '18b1ab025d12655afabf480dad9166e71d7690c3', shortSha: '18b1ab0',
    subject: 'feat(forge-ui): 新增键盘快捷键系统与设置面板，支持代码浏览器右键复制',
    authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn', authoredAt: 1791438623,
    body: '新增完整的键盘快捷键管理功能，包括快捷键配置、i18n 多语言支持、平台按键映射工具及 E2E 测试。\n重构设置面板为可折叠组件，集成快捷键展示与自定义入口。',
    committedAt: 1791438623, committerName: '陈默', committerEmail: 'chenmo@kibo.com.cn',
    parentCount: 1, isMerge: false, isRoot: false,
  },
  {
    sha: 'd171af0c3ee7edbf5ea6b800433aad7ca3036b94', shortSha: 'd171af0',
    subject: 'feat(forge-ui): 选区复制浮窗补右键触发，浮窗落在光标处',
    authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn', authoredAt: 1791427146,
    body: '', committedAt: 1791427146, committerName: '陈默', committerEmail: 'chenmo@kibo.com.cn',
    parentCount: 1, isMerge: false, isRoot: false,
  },
  {
    sha: 'dd0365db6713fc6f94ffffbf105bc9ef74cb269c', shortSha: 'dd0365d',
    subject: 'fix(model): 拦截非法模型 ID 并自愈悬空会话模型',
    authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn', authoredAt: 1791424276,
    body: '会话里引用的模型被删掉后，输入框会一直空着且无法发送。\n现在启动时校验模型 ID，失效则回落到默认模型。\n\n现场报错「模型未配置或不可用: MiniMax M3.1-Flash-Preview」，正确 ID 是连字符版。\n\n根因链：ModelService.saveProvider 只 trim 不校验 ID 形态，空格版被写入 models.json。\n\n改动：\n1. saveProvider 拦截含空白字符的模型 ID，setDefault/setSessionModel 补齐形态校验。\n2. 发送前探测生效模型并自愈，仅在明确返回「无此模型」时改用全局默认。\n3. 模型解析移到任何磁盘写入之前，失败不再产生 header-only JSONL。\n4. ModelRuntime.create 失败后不缓存 rejected Promise。\n\n测试：forge-core 550/550、forge-ui 438/438 通过。',
    committedAt: 1791424276, committerName: '陈默', committerEmail: 'chenmo@kibo.com.cn',
    parentCount: 1, isMerge: false, isRoot: false,
  },
  {
    sha: '8265d38eba8f855fa87274ebe52b9640948c3329', shortSha: '8265d38',
    subject: 'Merge pull request #3 from caslte/dev-v0.2.0',
    authorName: '王工', authorEmail: 'ligang@kibo.com.cn', authoredAt: 1791306606,
    body: '', committedAt: 1791306606, committerName: '王工', committerEmail: 'ligang@kibo.com.cn',
    parentCount: 2, isMerge: true, isRoot: false,
  },
  {
    sha: 'cb9359106cba61ea2f5f1a7db42c1a3a2c3f7f9e1', shortSha: 'cb93591',
    subject: 'docs: 补充内嵌终端 PRD 的 node-pty 原生模块风险说明',
    authorName: '李工', authorEmail: 'lihua@kibo.com.cn', authoredAt: 1791305429,
    body: '', committedAt: 1791305429, committerName: '李工', committerEmail: 'lihua@kibo.com.cn',
    parentCount: 1, isMerge: false, isRoot: false,
  },
  {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', shortSha: 'a1b2c3d',
    subject: 'refactor(forge-ui): 侧栏会话状态点改用盲文点阵',
    authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn', authoredAt: 1791091241,
    body: '', committedAt: 1791091241, committerName: '陈默', committerEmail: 'chenmo@kibo.com.cn',
    parentCount: 1, isMerge: false, isRoot: false,
  },
  {
    sha: 'f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d', shortSha: 'f0e1d2c',
    subject: 'chore: 升级 electron 到 33.2.1',
    authorName: '王工', authorEmail: 'ligang@kibo.com.cn', authoredAt: 1790575320,
    body: '', committedAt: 1790575320, committerName: '王工', committerEmail: 'ligang@kibo.com.cn',
    parentCount: 1, isMerge: false, isRoot: false,
  },
  {
    sha: '99887766554433221100ffeeddccbbaa99887766', shortSha: '9988776',
    subject: 'feat: 首个提交：项目脚手架',
    authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn', authoredAt: 1755653400,
    body: '', committedAt: 1755653400, committerName: '陈默', committerEmail: 'chenmo@kibo.com.cn',
    parentCount: 0, isMerge: false, isRoot: true,
  },
];

/** 提交内文件统计（getCommitDetail 返回；注意**不含 diff 字段**） */
const MOCK_COMMIT_FILES = [
  { path: 'packages/forge-ui/src/App.vue', oldPath: null, status: 'M', additions: 41, deletions: 12, binary: false },
  { path: 'docs/prd/13_keyboard_shortcuts.md', oldPath: null, status: 'A', additions: 128, deletions: 0, binary: false },
  { path: 'packages/forge-ui/src/i18n/domains/shortcuts.ts', oldPath: null, status: 'A', additions: 75, deletions: 0, binary: false },
  // 纯重命名：oldPath 非 null、增删全 0（E-CE-36 展开它时应得空串而非「无变化」页）
  { path: 'docs/说明.md', oldPath: 'docs/说明.md', status: 'R', additions: 0, deletions: 0, binary: false },
  // 二进制：-1 而非 0（0 的语义是「真的没改行」）
  { path: 'packages/forge-ui/public/logo.png', oldPath: null, status: 'M', additions: -1, deletions: -1, binary: true },
];

/** 单文件 patch（getCommitFileDiff）；null = 二进制，缺失键 = 无行级变化（空串） */
const MOCK_COMMIT_DIFFS: Record<string, string | null> = {
  'packages/forge-ui/src/App.vue': [
    'diff --git a/packages/forge-ui/src/App.vue b/packages/forge-ui/src/App.vue',
    'index 3f2a1bc..8c4d92e 100644',
    '--- a/packages/forge-ui/src/App.vue',
    '+++ b/packages/forge-ui/src/App.vue',
    '@@ -1184,7 +1184,8 @@',
    '  <aside class="sidebar">',
    '+   <div class="tree-panel">',
    '    <ProjectTree',
    '@@ -1249,3 +1250,4 @@',
    '    @toggle-layout="toggleCodeLayout"',
    '- />',
    '+    :layout="codeViewerLayout"',
    '+  />',
    ' </aside>',
  ].join('\n'),
  'docs/prd/13_keyboard_shortcuts.md': [
    'diff --git a/docs/prd/13_keyboard_shortcuts.md b/docs/prd/13_keyboard_shortcuts.md',
    'new file mode 100644',
    'index 0000000..5a1c3e7',
    '--- /dev/null',
    '+++ b/docs/prd/13_keyboard_shortcuts.md',
    '@@ -0,0 +1,3 @@',
    '+# 13 快捷键',
    '+',
    '+设置页第 5 个 Tab：只读快捷键清单 4 组 16 行。',
  ].join('\n'),
  'packages/forge-ui/src/i18n/domains/shortcuts.ts': [
    'diff --git a/packages/forge-ui/src/i18n/domains/shortcuts.ts b/packages/forge-ui/src/i18n/domains/shortcuts.ts',
    'new file mode 100644',
    'index 0000000..b7d2f90',
    '--- /dev/null',
    '+++ b/packages/forge-ui/src/i18n/domains/shortcuts.ts',
    '@@ -0,0 +1,2 @@',
    "+export const zhShortcuts = { 'terminal.toggle': '终端' };",
    '+',
  ].join('\n'),
  'packages/forge-ui/public/logo.png': null,
};

/** 与 forge-core 的 MAX_SEARCH_NODES 同值：mock 的 limitReached 阈值不另起一套 */
const FILE_SEARCH_MAX_NODES = 20_000;

/**
 * 模块 12：Mock 假文件系统。
 *
 * 刻意不穷举——只为把**每条降级路径**都跑一遍：目录排序、忽略项、二进制、超大截断、
 * 空文件、路径不存在。真实文件系统的行为在 fileService 的 36 个单测里覆盖；mock 的
 * 职责是让 UI 在没有真实仓库时也能把每个状态屏都点亮。
 */
const fileMock = new Map<string, string>([
  ['README.md', '# forge\n\nElectron + Vue 3 的 AI 编码工作台。\n\n## 快速开始\n\n```bash\nnpm run dev\n```\n'],
  [
    'package.json',
    '{\n  "name": "forge",\n  "private": true,\n  "workspaces": ["packages/*"],\n  "scripts": {\n    "dev": "electron .",\n    "test": "npm run test --workspaces"\n  }\n}\n',
  ],
  [
    'packages/forge-ui/src/App.vue',
    '<script setup lang="ts">\nimport { ref } from \'vue\';\n\n// 主视图：左项目树 + 右对话纸\nconst activeView = ref<\'sessions\' | \'settings\'>(\'sessions\');\n</script>\n\n<template>\n  <main class="content">\n    <p>{{ activeView }}</p>\n  </main>\n</template>\n',
  ],
  [
    'packages/forge-ui/src/bridge.ts',
    '/** UI → 主进程 RPC 封装；保留原始信封以便按错误码分支 */\nexport async function fileListDir(path: string, relPath: string) {\n  return call(\'file/listDir\', { path, relPath });\n}\n',
  ],
  [
    'packages/forge-core/src/file/fileService.ts',
    'import { promises as fs } from \'node:fs\';\nimport path from \'node:path\';\n\n/*\n * 路径边界在这里收口：所有相对路径都经 path.resolve + realpath 双重校验，\n * 任何指向项目根之外的请求一律拒绝（6103）。\n */\nexport class FileService {\n  async listDir(root: string, relPath: string) {\n    const abs = this.safeResolve(root, relPath);\n    const entries = await fs.readdir(abs, { withFileTypes: true });\n    return entries.map(toNode);\n  }\n}\n',
  ],
  [
    'packages/forge-core/test/file/fileService.test.ts',
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { FileService } from '../../src/file/fileService.ts';\n\ntest('listDir: 目录优先排序', () => {\n  assert.equal(1, 1);\n});\n",
  ],
  [
    'docs/prd/12_code_explorer.md',
    '# 模块 12 内置代码浏览器\n\n状态：草稿-待确认\n\n- A 整屏覆盖：默认，对话区宽度零变化\n- B 左右分割：可选偏好，两侧各保底 320px\n',
  ],
  ['src/__demo__/binary.png', '\u0000\u0001binary'],
  [
    'src/__demo__/huge.log',
    Array.from({ length: 60000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
  ],
  ['src/__demo__/empty.txt', ''],
]);

/**
 * 目录 → 直接子项。用扁平表的前缀反推而非显式父子表：mock 只需单层懒加载，
 * 扁平表已经能回答「这个目录下有什么」，新增文件只要加一条 map。
 */
function fileMockChildren(relPath: string): string[] {
  const prefix = relPath === '' ? '' : `${relPath}/`;
  const seen = new Set<string>();
  for (const p of fileMock.keys()) {
    if (!p.startsWith(prefix) || p === relPath) continue;
    const head = p.slice(prefix.length).split('/')[0];
    if (head) seen.add(head);
  }
  return [...seen].sort();
}

/** 某个子项是目录 = 扁平表里存在以它为前缀的**更深**路径。
 *  不能写成「扁平表里有这个名字」——那会把文件也判成目录（文件本身就是一条以名字结尾的路径）。 */
function fileMockIsDir(relPath: string, name: string): boolean {
  const childRel = relPath === '' ? name : `${relPath}/${name}`;
  const prefix = `${childRel}/`;
  for (const p of fileMock.keys()) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/** 按行切分：去掉末尾那一行「\n 之后」的空气，但不改内容本身 */
function fileMockLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** mock 文件名过滤：只匹配 basename，与真实 searchFiles 语义一致 */
function fileMockSearch(query: string): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  for (const p of fileMock.keys()) {
    if (out.length >= 200) break;
    if (p.slice(p.lastIndexOf('/') + 1).toLowerCase().includes(q)) out.push(p);
  }
  return out.sort();
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
      | 'goal.statusChanged'
      | 'goal.notified'
      | 'goal.uiRequested'
      | 'goal.uiTimedOut'
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
  /** goal 接入：取最近一次 goal/uiReply 回填（e2e 断言用） */
  getLastGoalUiReply(): Record<string, unknown> | null;
  /** 读取 SM-S08 会话导出的调用账本（sessionId + targetPath 序列） */
  getSessionExports(): Array<{ sessionId: string; targetPath: string }>;
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
/** goal 接入：最近一次 goal/uiReply 回填（e2e 断言用） */
let lastGoalUiReply: Record<string, unknown> | null = null;

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

/* ===== skill 管理 mock（模块 09）=====
 * 内存版 skills 目录：与 skillService.ts 语义对齐（4090 冲突 → overwrite=true 重调、
 * 删除回报 trashed 标记），仅面向浏览器 dev 预览/E2E，不落盘。 */

/** 与 forge-ui bridge.ts SkillEntry 同构（mock 本地声明，不 import 避免类型环路） */
interface MockSkillEntry {
  name: string;
  description: string;
  scope: 'user' | 'project' | 'other';
  dirPath: string;
  filePath: string;
  disableModelInvocation: boolean;
}

const SKILL_USER_ROOT = 'C:/Users/dev/.pi/agent/skills';

function skillRootFor(scope: unknown, projectPath: string | undefined): string | null {
  if (scope === 'user') return SKILL_USER_ROOT;
  if (scope === 'project') return projectPath ? `${projectPath.replace(/\/+$/, '')}/.agents/skills` : null;
  return null;
}

function mockSkillEntry(name: string, description: string, scope: 'user' | 'project', dirPath: string): MockSkillEntry {
  return { name, description, scope, dirPath, filePath: `${dirPath}/SKILL.md`, disableModelInvocation: false };
}

/** 种子数据：演示分组展示/删除/导入冲突（真实端同名语义一致） */
const mockSkills: MockSkillEntry[] = [
  mockSkillEntry('pdf-report', '生成 PDF 周报（mock 种子）', 'user', `${SKILL_USER_ROOT}/pdf-report`),
  mockSkillEntry('changelog', '按提交历史起草变更日志（mock 种子）', 'user', `${SKILL_USER_ROOT}/changelog`),
  mockSkillEntry('db-migrate', '本项目数据库迁移流程（mock 种子）', 'project', 'D:/work/aiwork/forge/.agents/skills/db-migrate'),
];

function findMockSkill(dirPath: string): MockSkillEntry | undefined {
  const key = dirPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return mockSkills.find((s) => s.dirPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === key);
}

function basenameOf(dir: string): string {
  const segs = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return segs[segs.length - 1] ?? '';
}

// ===== term（10：内嵌终端）假 pty：行缓冲 mini-shell，浏览器全流程演示（不 spawn 真进程）=====
interface MockPty {
  cwd: string;
  buf: string;
  alive: boolean;
}
const termPtys = new Map<string, MockPty>();
let termSeq = 0;

function termOut(id: string, data: string): void {
  emit('term:data', { ptyId: id, data });
}

function termPrompt(p: MockPty): string {
  return `\x1b[36m${p.cwd}>\x1b[0m `;
}

function termRun(id: string, p: MockPty, line: string): void {
  const cmd = line.trim();
  setTimeout(() => {
    if (!p.alive) return;
    if (cmd === 'exit') {
      p.alive = false;
      emit('term:exit', { ptyId: id, exitCode: 0 });
      return;
    }
    if (cmd !== '') {
      let out: string;
      if (cmd === 'ls' || cmd === 'dir') out = 'README.md  package.json  src/  docs/';
      else if (cmd === 'pwd') out = p.cwd;
      else if (cmd.startsWith('echo ')) out = cmd.slice(5);
      else out = `"${cmd}" 不是内部或外部命令。（mock）`;
      termOut(id, `${out}\r\n`);
    }
    termOut(id, termPrompt(p));
  }, 80);
}

/** SM-S08：导出调用账本（e2e 断言「取到目标路径并真的调了主进程打包」）。
 *  声明必须在 bridge 对象之前——bridge.session.exportBundle 是 TDZ 内的闭包引用。 */
const sessionExportCalls: Array<{ sessionId: string; targetPath: string }> = [];

const bridge: ForgeBridge = {
  // 纯浏览器预览：非 Electron 环境，UI 按「无系统窗口控件」处理（不影响 mock 布局核对）
  platform: 'browser',
  // v3.76 启动门闩：mock 无真实 core 组装，永远就绪——欢迎页一帧即过，e2e 不受影响
  // v3.87 splashShownAt：mock 语义是「早已就绪」，视为窗口早已显示（null 会挂起
  // BootWelcome 字标入场动效的拉通道，只能等 2.5s 兜底）
  async bootState() {
    return { ready: true, startedAt: 0, durationMs: 0, splashShownAt: Date.now() };
  },
  // 首次使用指引门闩：默认「不是新装」——蒙层会挡住全窗口，e2e 用例不该被它拦下。
  // 想在浏览器里核对指引落位，置 localStorage['forge-mock-fresh-install'] 后刷新即可。
  async startupFlags() {
    let fresh = false;
    try {
      fresh = localStorage.getItem(FRESH_INSTALL_STORAGE_KEY) === '1';
    } catch {
      // localStorage 不可用（隐私模式等）按非新装处理
    }
    return { isFreshInstall: fresh, isUpgradeRun: false };
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
      case 'project/clearSessions': {
        // E2E：清空项目名下会话（保留项目），逐个广播 session.removed（同真实端）
        const p = (params as { path?: string }).path ?? '';
        const removed = DB.sessions.filter((s) => s.projectPath === p).map((s) => s.sessionId);
        DB.sessions = DB.sessions.filter((s) => s.projectPath !== p);
        for (const sid of removed) {
          delete DB.subagents[sid];
          sendScripts.delete(sid);
          sendQueues.delete(sid);
          emit('session.removed', { sessionId: sid });
        }
        persistSubagents();
        return { code: 0, message: 'ok', data: { removedSessions: removed.length } };
      }
      case 'project/removeProject': {
        // E2E：移除项目并级联删名下会话（同真实端 forge-core：逐个广播 session.removed
        // + project.removed，返回删除会话数；未注册项目幂等成功 removedSessions:0）
        const p = (params as { path?: string }).path ?? '';
        const removed = DB.sessions.filter((s) => s.projectPath === p).map((s) => s.sessionId);
        DB.sessions = DB.sessions.filter((s) => s.projectPath !== p);
        DB.projects = DB.projects.filter((x) => x.path !== p);
        for (const sid of removed) {
          delete DB.subagents[sid];
          sendScripts.delete(sid);
          sendQueues.delete(sid);
          emit('session.removed', { sessionId: sid });
        }
        persistSubagents();
        emit('project.removed', { path: p });
        return { code: 0, message: 'ok', data: { removedSessions: removed.length } };
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
        // E2E：动态新建会话（测试可直接建多会话做并行/删除场景）。
        // projectPath 缺省/null = 自由会话（与真实 forge-core createSession 语义一致，
        // 不再兜底第一项目 —— 归属由前端 draft 显式决定）
        const sessionId = 'sess-' + Math.random().toString(36).slice(2, 10);
        const raw = (params as { projectPath?: string | null }).projectPath;
        const projectPath = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
        DB.sessions.push({
          sessionId,
          projectPath,
          alias: null,
          status: 'idle',
          lastActiveAt: new Date().toISOString(),
          doneReadAt: null,
        });
        return { code: 0, message: 'ok', data: { session: { sessionId } } };
      }
      case 'session/updateSessionProject': {
        // 变更会话归属（自由对话管理，与真实 forge-core updateSessionProject 一致）：
        // projectPath 非空字符串 = 移入项目；null/缺省 = 移出到自由对话
        const sid = (params as { sessionId?: string }).sessionId ?? '';
        const sess = DB.sessions.find((s) => s.sessionId === sid);
        if (!sess) return { code: 1002, message: '会话不存在: ' + sid, data: null };
        const raw = (params as { projectPath?: string | null }).projectPath;
        const target = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
        if (target !== null && !DB.projects.some((p) => p.path === target)) {
          return { code: 1002, message: '项目不存在: ' + target, data: null };
        }
        sess.projectPath = target;
        emit('session.updated', { session: sess });
        return { code: 0, message: 'ok', data: { session: sess } };
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
      // CV-S09 队列编辑（与真实链路同构：操作后返回新队列 + 广播 queueUpdated）
      case 'conversation/queueRemove': {
        const sessionId = (params as { sessionId?: string }).sessionId ?? '';
        const index = (params as { index?: number }).index ?? -1;
        const q = sendQueues.get(sessionId) ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= q.length) {
          return { code: 5000, message: '队列已变化，删除未生效', data: null };
        }
        q.splice(index, 1);
        if (q.length === 0) sendQueues.delete(sessionId);
        else sendQueues.set(sessionId, q);
        emit('conversation.queueUpdated', { sessionId, followUp: [...q] });
        return { code: 0, message: 'ok', data: { followUp: [...q] } };
      }
      case 'conversation/queueSendNow': {
        const sessionId = (params as { sessionId?: string }).sessionId ?? '';
        const index = (params as { index?: number }).index ?? -1;
        const q = sendQueues.get(sessionId) ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= q.length) {
          return { code: 5000, message: '队列已变化，发送未生效', data: null };
        }
        const [content] = q.splice(index, 1);
        if (q.length === 0) sendQueues.delete(sessionId);
        else sendQueues.set(sessionId, q);
        emit('conversation.queueUpdated', { sessionId, followUp: [...q] });
        // 打断语义（与真实链路同构）：中止当前轮 → 立即直发该条并重跑脚本 → 剩余队列
        // 回灌排在其后 FIFO。user 气泡不 emit（真实后端直发路径不转发，UI 本地补），
        // 但要写 HISTORY（会话切换回显依赖，与真实 pi 持久化一致）
        (HISTORY[sessionId] ??= []).push({ role: 'user', content: content!, ts: new Date().toISOString() });
        persistHistory();
        const script = sendScripts.get(sessionId);
        if (script) void runScript(sessionId, script);
        return { code: 0, message: 'ok', data: { followUp: [...q] } };
      }
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
      case 'git/getStatus': {
        // GC-S11：与 getBranchInfo 同表；不在表内 = 非 git 项目全空值
        const gp = (params as { path?: string }).path ?? '';
        const g = DB.git[gp];
        if (!g) {
          return {
            code: 0,
            message: 'ok',
            data: { isGitRepo: false, branch: null, detached: false, fileCount: 0, added: 0, removed: 0, stagedEmpty: true, stagedCount: 0, unpushedCount: null, hasHead: false },
          };
        }
        return {
          code: 0,
          message: 'ok',
          data: {
            isGitRepo: true,
            branch: g.branch,
            detached: false,
            fileCount: g.fileCount ?? 0,
            added: g.added ?? 0,
            removed: g.removed ?? 0,
            stagedEmpty: g.stagedEmpty ?? true,
            stagedCount: g.stagedCount ?? 0,
            unpushedCount: g.unpushedCount ?? null,
            hasHead: g.hasHead ?? true,
            files: g.files ?? [],
          },
        };
      }
      case 'git/commit': {
        // GC-S11：__fail__ 说明模拟 6006（含 git 原始 stderr）；成功后清空脏状态
        const cp = params as { path?: string; message?: string; includeUnstaged?: boolean };
        const cpath = cp.path ?? '';
        const g = DB.git[cpath];
        if (!g) return { code: 1002, message: '项目未注册: ' + cpath, data: null };
        const msg = (cp.message ?? '').trim();
        if (!msg) return { code: 1001, message: '参数错误：message 必须为非空字符串', data: null };
        // 模拟真实 git 耗时（1.2s），让弹窗「提交中…」进行中态在浏览器 dev 可见
        await new Promise((r) => setTimeout(r, 1200));
        if (msg === '__fail__') {
          return {
            code: 6006,
            message: 'git 提交失败',
            data: { stderr: 'husky - pre-commit script failed (code 1)\nnpm test exited with 1' },
          };
        }
        if ((cp.includeUnstaged ?? true) === false && (g.stagedEmpty ?? true)) {
          return { code: 6006, message: '暂存区为空，无变更可提交', data: { stderr: '' } };
        }
        if ((g.fileCount ?? 0) === 0) {
          return { code: 6006, message: '暂存区为空，无变更可提交', data: { stderr: '' } };
        }
        const fileCount = g.fileCount ?? 0;
        const shortHash = 'm' + Math.floor(Math.random() * 0xfffff).toString(16).padStart(5, '0');
        g.fileCount = 0;
        g.stagedEmpty = true;
        g.stagedCount = 0;
        if (typeof g.unpushedCount === 'number') g.unpushedCount += fileCount;
        g.dirty = false;
        return { code: 0, message: 'ok', data: { shortHash, fileCount } };
      }
      case 'git/push': {
        // GC-S11：分支为空模拟 6007（detached/不可解析）；__failpush__ 分支模拟远端拒绝
        const pp = (params as { path?: string }).path ?? '';
        const g = DB.git[pp];
        if (!g) return { code: 1002, message: '项目未注册: ' + pp, data: null };
        // 模拟真实 git 网络耗时（1.8s），让「推送中…」进行中态在浏览器 dev 可见
        await new Promise((r) => setTimeout(r, 1800));
        if (!g.branch) {
          return { code: 6007, message: '无法推送：当前处于分离 HEAD 或分支不可解析', data: { stderr: '' } };
        }
        if (g.branch === '__failpush__') {
          return {
            code: 6007,
            message: 'git 推送失败',
            data: { stderr: "To https://github.com/acme/repo.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs" },
          };
        }
        return { code: 0, message: 'ok', data: { branch: g.branch, remote: 'origin' } };
      }
      case 'git/getFileDiff': {
        // 模块 12 P2：单文件 unified diff。种子变更文件给可演示的小 diff
        //（含上下文/增/删，行号真实连续，CodeViewer 的解析层直接可吃）；
        // 未跟踪（?）回 null（UI 用已加载正文合成全新增）；其余文件 = 无差异空串。
        const dp = params as { path?: string; relPath?: string };
        if (typeof dp.path !== 'string' || dp.path.trim() === '') {
          return { code: 1001, message: '参数错误：path 必须为非空字符串', data: null };
        }
        if (typeof dp.relPath !== 'string' || dp.relPath.trim() === '') {
          return { code: 1001, message: '参数错误：relPath 必须为非空字符串', data: null };
        }
        if (!DB.git[dp.path]) return { code: 0, message: 'ok', data: { diff: null } };
        const MOCK_DIFFS: Record<string, string> = {
          'packages/forge-ui/src/App.vue': [
            'diff --git a/packages/forge-ui/src/App.vue b/packages/forge-ui/src/App.vue',
            'index 3f2a1bc..8c4d92e 100644',
            '--- a/packages/forge-ui/src/App.vue',
            '+++ b/packages/forge-ui/src/App.vue',
            '@@ -2,7 +2,8 @@',
            ' <script setup lang="ts">',
            " import { ref } from 'vue';",
            '',
            ' // 主视图：左项目树 + 右对话纸',
            "-const activeView = ref<'sessions' | 'settings'>('sessions');",
            "+import { useCodeExplorer } from './composables/useCodeExplorer';",
            '+',
            "+const activeView = ref<'sessions' | 'settings'>('sessions');",
            ' </script>',
            '',
            ' <template>',
          ].join('\n'),
          'packages/forge-ui/src/bridge.ts': [
            'diff --git a/packages/forge-ui/src/bridge.ts b/packages/forge-ui/src/bridge.ts',
            'index 1a2b3c4..5d6e7f8 100644',
            '--- a/packages/forge-ui/src/bridge.ts',
            '+++ b/packages/forge-ui/src/bridge.ts',
            '@@ -70,6 +70,9 @@',
            "   | 'term/kill'",
            "   | 'term/resize'",
            "   | 'file/listDir'",
            '+  // 模块 12 P2：单文件 unified diff（并排 diff 数据源）',
            "+  | 'git/getFileDiff'",
            '+',
            "   | 'file/readFile'",
            "   | 'file/searchFiles'",
          ].join('\n'),
          'packages/forge-core/src/file/fileService.ts': [
            'diff --git a/packages/forge-core/src/file/fileService.ts b/packages/forge-core/src/file/fileService.ts',
            'new file mode 100644',
            'index 0000000..1111111',
            '--- /dev/null',
            '+++ b/packages/forge-core/src/file/fileService.ts',
            '@@ -0,0 +1,3 @@',
            '/** 文件服务（模块 12）：listDir / readFile / searchFiles 三只读方法。',
            ' *  relPath 一律视为不可信输入，过 path.resolve + realpath 两道 containment。',
            ' */',
          ].join('\n'),
        };
        // 口径对齐 core：未跟踪 → null（UI 合成全新增）；其余文件无 diff 文本 = 空串
        const g = DB.git[dp.path];
        const st = (g?.files ?? []).find((x) => x.path === dp.relPath);
        if (st?.status === '?') return { code: 0, message: 'ok', data: { diff: null } };
        return { code: 0, message: 'ok', data: { diff: MOCK_DIFFS[dp.relPath] ?? '' } };
      }
      // ===== CE-S11：Git 提交历史（PRD 12 §3.7 / api/11 §6~§8）=====
      // mock 数据刻意造了三个「末字相同」的中文名（王工/李工），用于钉住
      // 头像首字母必须取**姓氏**——取末字会让两人渲染成同一个字（E-CE-31）。
      case 'git/getCommitLog': {
        const gp = (params as { path?: string; limit?: number; skip?: number }).path ?? '';
        if (!DB.git[gp]) {
          // 非 git 项目：与服务层同口径归一为「空历史 + 成功」，不报错
          return { code: 0, message: 'ok', data: { commits: [], hasMore: false } };
        }
        const rawLimit = (params as { limit?: number }).limit;
        const rawSkip = (params as { skip?: number }).skip;
        const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 500 ? rawLimit : 100;
        const skip = typeof rawSkip === 'number' && Number.isInteger(rawSkip) && rawSkip >= 0 ? rawSkip : 0;
        const page = MOCK_COMMITS.slice(skip, skip + limit);
        return {
          code: 0,
          message: 'ok',
          data: { commits: page, hasMore: skip + limit < MOCK_COMMITS.length },
        };
      }
      case 'git/getCommitDetail': {
        const dp = params as { path?: string; sha?: string };
        if (!DB.git[dp.path ?? '']) {
          return { code: 0, message: 'ok', data: null };
        }
        const c = MOCK_COMMITS.find((x) => x.sha.startsWith(dp.sha ?? ''));
        if (!c) return { code: 6001, message: '无法解析提交', data: null };
        // 故意不含 diff 字段——两级取数契约，E-CE-34 会断言这一点
        return { code: 0, message: 'ok', data: { ...c, files: MOCK_COMMIT_FILES } };
      }
      case 'git/getCommitFileDiff': {
        const dp = params as { path?: string; sha?: string; file?: string };
        if (!DB.git[dp.path ?? '']) return { code: 0, message: 'ok', data: { diff: null } };
        if (!dp.file || dp.file.trim() === '') {
          return { code: 1001, message: '参数错误：file 必须为非空字符串', data: null };
        }
        const hit = MOCK_COMMIT_DIFFS[dp.file];
        if (hit === undefined) return { code: 0, message: 'ok', data: { diff: '' } };
        if (hit === null) return { code: 0, message: 'ok', data: { diff: null } };
        return { code: 0, message: 'ok', data: { diff: hit } };
      }
      case 'git/generateCommitMessage': {
        // GC-S11：mock 即时返回固定文案（无真 LLM 调用）；无变更演示 6008
        const gp = (params as { path?: string; lang?: string }).path ?? '';
        const lang = (params as { lang?: string }).lang === 'en' ? 'en' : 'zh';
        const g = DB.git[gp];
        if (!g) return { code: 1002, message: '项目未注册: ' + gp, data: null };
        if ((g.fileCount ?? 0) === 0) {
          return { code: 6008, message: '无变更可总结', data: null };
        }
        const msg =
          lang === 'en'
            ? `feat: update ${g.fileCount} files on ${g.branch} (mock generated)`
            : `feat: 在 ${g.branch} 上更新 ${g.fileCount} 个文件（mock 生成）`;
        return { code: 0, message: 'ok', data: { message: msg } };
      }
      // ===== 模块 12：内置代码浏览器（CE-S01 ~ CE-S07）=====
      // 错误码与 fileService 一一对应（6101~6107），UI 靠它们分支，
      // 所以 mock 必须用同一套码，否则 Mock 模式会把降级态走成白屏。
      case 'file/listDir': {
        const fp = (params as { path?: string; relPath?: string });
        const root = fp.path ?? '';
        const rel = (fp.relPath ?? '').replace(/^\/+|\/+$/g, '');
        if (root !== MOCK_PROJECT_PATH) return { code: 6102, message: '项目未注册: ' + root, data: null };
        if (!root || (fp.relPath === undefined)) {
          return { code: 6101, message: '参数错误：path / relPath 必填', data: null };
        }
        // 越界与不存在要分开报：UI 给的是两种完全不同的引导（改路径 vs 建文件）
        if (rel.startsWith('..') || /^[a-zA-Z]:/.test(rel)) {
          return { code: 6103, message: '路径越界', data: null };
        }
        const children = fileMockChildren(rel);
        if (rel !== '' && children.length === 0) {
          return { code: 6105, message: '不是目录: ' + rel, data: null };
        }
        // 目录优先、同组字典序（与真实 FileService 一致）
        const nodes = children
          .map((name) => {
            const childRel = rel === '' ? name : `${rel}/${name}`;
            const isDir = fileMockIsDir(rel, name);
            return {
              name,
              relPath: childRel,
              kind: isDir ? 'dir' : 'file',
              size: isDir ? 0 : (fileMock.get(childRel) ?? '').length,
              mtimeMs: 0,
            };
          })
          .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        return { code: 0, message: 'ok', data: { relPath: rel, nodes } };
      }
      case 'file/watchSync': {
        // 浏览器 mock 无 fs.watch：接受即成功（e2e 要模拟磁盘变化时直接触发
        // 事件回调即可，见 useCodeExplorer 的 code.fileChanged 订阅）
        return { code: 0, message: 'ok', data: {} };
      }
      case 'file/readFile': {
        const fp = (params as { path?: string; relPath?: string });
        const root = fp.path ?? '';
        const rel = (fp.relPath ?? '').replace(/^\/+|\/+$/g, '');
        if (root !== MOCK_PROJECT_PATH) return { code: 6102, message: '项目未注册: ' + root, data: null };
        if (rel.startsWith('..') || /^[a-zA-Z]:/.test(rel)) {
          return { code: 6103, message: '路径越界', data: null };
        }
        if (rel === '') return { code: 6101, message: '参数错误：relPath 不能为空', data: null };
        const isDir = fileMockChildren(rel).length > 0;
        if (isDir) return { code: 6106, message: '不是文件: ' + rel, data: null };
        if (!fileMock.has(rel)) return { code: 6104, message: '文件不存在: ' + rel, data: null };
        const raw = fileMock.get(rel) ?? '';
        const totalLines = fileMockLines(raw).length;
        // 二进制：含 NUL 或其他控制字节（真实实现用启发式，这里等价）
        // eslint-disable-next-line no-control-regex
        const binary = /[\u0000-\u0008\u000E-\u001F]/.test(raw);
        const lines = binary ? [] : fileMockLines(raw);
        const MAX_LINES = 50000;
        const kept = lines.slice(0, MAX_LINES);
        let truncatedBy = null;
        if (!binary && totalLines > MAX_LINES) truncatedBy = 'lines';
        else if (!binary && raw.length > 2 * 1024 * 1024) truncatedBy = 'bytes';
        return {
          code: 0,
          message: 'ok',
          data: {
            relPath: rel,
            content: kept.join('\n'),
            totalLines,
            truncated: truncatedBy !== null,
            truncatedBy,
            binary,
            size: raw.length,
            mtimeMs: 0,
          },
        };
      }
      case 'file/searchFiles': {
        const fp = (params as { path?: string; query?: string });
        const root = fp.path ?? '';
        if (root !== MOCK_PROJECT_PATH) return { code: 6102, message: '项目未注册: ' + root, data: null };
        const q = (fp.query ?? '').trim();
        if (q === '') return { code: 6101, message: '参数错误：query 不能为空', data: null };
        const files = fileMockSearch(q);
        // 字段名必须与 forge-core 的 SearchFilesData 一致（files/limitReached）。
        // 曾经写成 { matches, truncated }，UI 读 res.data.files 拿到 undefined，
        // 表现为「输入什么都搜不到」——mock 漂移就是这么坑人的。
        return { code: 0, message: 'ok', data: { files, limitReached: files.length >= FILE_SEARCH_MAX_NODES } };
      }
      case 'model/queryModels':
        // 一条配置 = 一个可选项；mock 没有 provider 别名，别名与模型 ID 同名
        return {
          code: 0,
          message: 'ok',
          data: {
            options: modelList.map((m) => ({ providerId: m, model: m })),
            defaultProviderId: modelList[0],
          },
        };
      case 'model/getSessionModel':
        return {
          code: 0,
          message: 'ok',
          data: { model: modelList[0], providerId: modelList[0], effective: 'global' },
        };
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
      case 'skill/listSkills': {
        // 枚举口径与真实端一致：projectPath 缺省时项目组自然为空（按路径归组在 UI 侧）
        return { code: 0, message: 'ok', data: { cwd: (params as { projectPath?: string }).projectPath ?? '', skills: [...mockSkills], issues: [] } };
      }
      case 'skill/checkImport': {
        // 导入预览（只查不拷）：校验口径与 importSkill 同源（invalid- 前缀 = 无 SKILL.md）
        const p = params as { scope?: string; sourceDir?: string; projectPath?: string };
        const root = skillRootFor(p.scope, p.projectPath);
        if (root === null || typeof p.sourceDir !== 'string' || p.sourceDir === '') {
          return { code: 1001, message: '参数错误：scope/sourceDir 非法或项目作用域缺少 projectPath', data: null };
        }
        if (/(^|[\\/])invalid-[^\\/]*$/.test(p.sourceDir)) {
          return {
            code: 0,
            message: 'ok',
            data: { status: 'invalid', conflictPath: null, reason: '目录中未找到有效 SKILL.md（需含非空 description）' },
          };
        }
        const dest = `${root}/${basenameOf(p.sourceDir)}`;
        if (findMockSkill(dest)) {
          return { code: 0, message: 'ok', data: { status: 'conflict', conflictPath: dest, reason: null } };
        }
        return { code: 0, message: 'ok', data: { status: 'ok', conflictPath: null, reason: null } };
      }
      case 'skill/importSkill': {
        const p = params as { scope?: string; sourceDir?: string; projectPath?: string; overwrite?: boolean };
        const root = skillRootFor(p.scope, p.projectPath);
        if (root === null || typeof p.sourceDir !== 'string' || p.sourceDir === '') {
          return { code: 1001, message: '参数错误：scope/sourceDir 非法或项目作用域缺少 projectPath', data: null };
        }
        // 模拟真实端 SKILL.md 校验（E2E 混合选择用例）：invalid- 前缀目录视为无有效 SKILL.md，拒绝
        if (/(^|[\\/])invalid-[^\\/]*$/.test(p.sourceDir)) {
          return { code: 1001, message: '拒绝导入：目录中未找到有效 SKILL.md（需含非空 description）', data: null };
        }
        const dirName = basenameOf(p.sourceDir);
        const dest = `${root}/${dirName}`;
        const existing = findMockSkill(dest);
        if (existing && !p.overwrite) {
          return { code: 4090, message: `目标已存在同名 skill 目录：${dest}`, data: { conflictPath: dest, sourceDir: p.sourceDir } };
        }
        if (existing) mockSkills.splice(mockSkills.indexOf(existing), 1);
        mockSkills.push(mockSkillEntry(dirName, `导入的 mock skill：${dirName}`, p.scope === 'project' ? 'project' : 'user', dest));
        return { code: 0, message: 'ok', data: { path: dest, overwritten: existing !== undefined } };
      }
      case 'skill/createSkill': {
        const p = params as { scope?: string; name?: string; description?: string; projectPath?: string; overwrite?: boolean };
        const root = skillRootFor(p.scope, p.projectPath);
        if (root === null) {
          return { code: 1001, message: '参数错误：scope 非法或项目作用域缺少 projectPath', data: null };
        }
        if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.name) || p.name.length > 64) {
          return { code: 1001, message: '名称不合法：仅小写字母/数字/连字符，以字母或数字开头，不超过 64 字符', data: null };
        }
        if (typeof p.description !== 'string' || p.description.trim() === '') {
          return { code: 1001, message: '描述不能为空', data: null };
        }
        const dest = `${root}/${p.name}`;
        const existing = findMockSkill(dest);
        if (existing && !p.overwrite) {
          return { code: 4090, message: `目标已存在同名 skill 目录：${dest}`, data: { conflictPath: dest } };
        }
        if (existing) mockSkills.splice(mockSkills.indexOf(existing), 1);
        mockSkills.push(mockSkillEntry(p.name, p.description.trim(), p.scope === 'project' ? 'project' : 'user', dest));
        return { code: 0, message: 'ok', data: { path: dest, name: p.name } };
      }
      case 'skill/deleteSkill': {
        const p = params as { path?: string };
        const target = typeof p.path === 'string' ? findMockSkill(p.path) : undefined;
        if (!target) {
          return { code: 1002, message: 'skill 目录不存在（可能已被外部删除），请刷新列表', data: null };
        }
        mockSkills.splice(mockSkills.indexOf(target), 1);
        // mock 恒回收站成功（真实端降级语义 trashed=false 由 E2E seed 覆盖模拟）
        return { code: 0, message: 'ok', data: { path: target.dirPath, trashed: true } };
      }
      case 'term/create': {
        // 与真实端口径一致：cwd 必须是已注册项目根（AC-10-06 的 mock 镜像）
        const p = params as { cwd?: string };
        const cwd = p.cwd ?? '';
        if (!DB.projects.some((x) => x.path === cwd)) {
          return { code: 1002, message: `工作目录不是已注册项目根: ${cwd}`, data: null };
        }
        termSeq += 1;
        const ptyId = `mock-pty-${termSeq}`;
        const rec = { cwd, buf: '', alive: true };
        termPtys.set(ptyId, rec);
        // 300ms 延迟应答（同真实 spawn 往返量级）：让「连接中…」防御态可观察。
        // banner+prompt 在应答「之后」的宏任务下发——复刻真实端「先回 ptyId、事件随后推」
        // 的时序，顺带常态走到前端的首事件缓冲回放路径。
        await new Promise((r) => setTimeout(r, 300));
        if (!rec.alive) {
          return { code: 5000, message: 'mock pty 已被回收', data: null };
        }
        setTimeout(() => {
          if (!rec.alive) return;
          termOut(ptyId, '\x1b[90m[mock-shell] 假 pty · 仅面板联调，不产生真实进程\x1b[0m\r\n');
          termOut(ptyId, termPrompt(rec));
        }, 0);
        return { code: 0, message: 'ok', data: { ptyId, shell: 'mock-shell', pid: 10000 + termSeq } };
      }
      case 'term/write': {
        const p = params as { ptyId?: string; data?: string };
        const id = p.ptyId ?? '';
        const rec = termPtys.get(id);
        if (rec === undefined || !rec.alive || typeof p.data !== 'string') {
          return { code: 0, message: 'ok', data: null }; // 死 pty 静默丢弃（同真实端）
        }
        for (const ch of p.data) {
          if (ch === '\r') {
            termOut(id, '\r\n');
            const line = rec.buf;
            rec.buf = '';
            termRun(id, rec, line);
          } else if (ch === '\x03') {
            termOut(id, '^C\r\n');
            rec.buf = '';
            termOut(id, termPrompt(rec));
          } else if (ch === '\x7f') {
            if (rec.buf.length > 0) {
              rec.buf = rec.buf.slice(0, -1);
              termOut(id, '\b \b');
            }
          } else if (ch >= ' ') {
            rec.buf += ch;
            termOut(id, ch);
          }
        }
        return { code: 0, message: 'ok', data: null };
      }
      case 'term/resize':
        return { code: 0, message: 'ok', data: null };
      case 'term/kill': {
        const p = params as { ptyId?: string };
        const rec = termPtys.get(p.ptyId ?? '');
        if (rec !== undefined) rec.alive = false;
        return { code: 0, message: 'ok', data: null }; // 幂等（同真实端）
      }
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
  goal: {
    // 与真实 preload 同构：复用同一事件多路复用（订阅 goal:* 四条事件）
    onStatus: (listener) =>
      bridge.on('goal.statusChanged', (payload) => listener(payload as never)),
    onNotified: (listener) =>
      bridge.on('goal.notified', (payload) => listener(payload as never)),
    onUiRequested: (listener) =>
      bridge.on('goal.uiRequested', (payload) => listener(payload as never)),
    onUiTimedOut: (listener) =>
      bridge.on('goal.uiTimedOut', (payload) => listener(payload as never)),
    uiReply: async (params) => {
      // 浏览器 dev/e2e：记录最近一次回填供断言（真实端交给宿主 uiContext 的 Promise）
      lastGoalUiReply = params as unknown as Record<string, unknown>;
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
    /** 多选目录 mock：空数组 = 取消（E2E 直接覆盖 window.forge.dialog.selectDirectories 注入） */
    selectDirectories: async () => null,
    selectFiles: async () => [],
    // 无原生保存对话框：一律视为用户取消（画布卡片据此不报错、静默返回）
    saveFile: async (_defaultName?: string, kind?: 'canvas' | 'session') =>
      // SM-S08：导出走 mock 时给出可断言的假路径，让 e2e 能验证「确实取到了目标路径并调了打包」
      kind === 'session' ? 'D:/tmp/forge-mock-export.zip' : null,
  },
  shell: {
    openPath: async () => true,
    openInBrowser: async () => true,
    // 浏览器 dev/e2e 演示：回两个编辑器让右键菜单出分项（真机由主进程扫描决定）
    listEditors: async () => [
      { id: 'vscode', label: 'VS Code' },
      { id: 'cursor', label: 'Cursor' },
    ],
    // 浏览器 dev/e2e 演示：终端 Shell 选项（真机由主进程探测决定，TD-TM-05 方案 B）
    listTerminalShells: async () => [
      { id: 'pwsh', label: 'PowerShell 7' },
      { id: 'powershell', label: 'Windows PowerShell' },
      { id: 'cmd', label: 'cmd' },
    ],
    openInEditor: async () => true,
    // 浏览器 dev 无系统浏览器：直接回失败（点击行为由拦截器静默处理，不报错）
    openExternal: async () => false,
    // 浏览器 dev 无主进程解析：回健康占位，shell 横幅只在 Electron 真机上出现
    shellProbe: async () => ({ ok: true, shell: 'C:\\mock\\Git\\bin\\bash.exe' }),
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
    // 浏览器 dev 无写盘能力：返回 false，卡片按「保存失败」提示
    writeText: async () => false,
    // 浏览器 dev/e2e 无真实盘：固定小清单，@ 补全链路可走通（本地过滤逻辑在渲染层）
    listProjectFiles: async () => [
      'D:/work/aiwork/forge/edu-community/README.md',
      'D:/work/aiwork/forge/edu-community/src/index.ts',
      'D:/work/aiwork/forge/edu-community/docs/prd.md',
    ],
  },
  // SM-S08 会话导出：浏览器 dev/e2e 无盘可写，回成功并把调用记进 mock 账本供断言
  session: {
    exportBundle: async (sessionId: string, targetPath: string) => {
      sessionExportCalls.push({ sessionId, targetPath });
      return { ok: true, bytes: 2048 };
    },
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
  /** goal 接入：取最近一次 goal/uiReply 回填（e2e 断言用） */
  getLastGoalUiReply() {
    return lastGoalUiReply === null ? null : { ...lastGoalUiReply };
  },
  getSessionExports() {
    return sessionExportCalls.map((c) => ({ ...c }));
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