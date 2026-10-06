/**
 * forge-ui ↔ forge-desktop IPC 桥封装。
 *
 * 类型与 @forge/desktop src/ipc-contract.ts 保持一致（事实来源在那，冒烟阶段本地声明
 * 避免 forge-ui 依赖 forge-desktop/electron）。契约变更时两边同步。
 */

/** 全部可调用方法（= forge-core 各 Api 的 methods map 键并集） */
export type ForgeMethod =
  | 'project/addProject'
  | 'project/removeProject'
  | 'project/clearSessions'
  | 'project/queryProjectList'
  | 'project/openProject'
  | 'project/updateProjectAlias'
  | 'project/reorderProjects'
  | 'project/setTrust'
  | 'session/createSession'
  | 'session/querySessionList'
  | 'session/deleteSession'
  | 'session/updateSessionAlias'
  | 'session/updateSessionProject'
  | 'session/markSessionRead'
  | 'session/getSessionStatus'
  | 'session/attachSessionWindow'
  | 'session/detachSessionWindow'
  | 'conversation/sendMessage'
  | 'conversation/cancelStream'
  // CV-S09 队列编辑：删除 / 立即发送（打断当前轮并直发该条）
  | 'conversation/queueRemove'
  | 'conversation/queueSendNow'
  | 'conversation/queryHistory'
  | 'conversation/getLastError'
  | 'conversation/getContextUsage'
  | 'conversation/compact'
  | 'conversation/getSlashCommands'
  | 'tool/queryToolEvents'
  | 'model/queryProviderList'
  | 'model/saveProvider'
  | 'model/testProvider'
  | 'model/deleteProvider'
  | 'model/queryModels'
  | 'model/setDefault'
  | 'model/getSessionModel'
  | 'model/setSessionModel'
  | 'model/getModelThinkingLevels'
  | 'model/getSessionThinkingLevel'
  | 'model/setSessionThinkingLevel'
  | 'subagent/queryList'
  | 'subagent/stop'
  | 'subagent/clearFinished'
  | 'subagent/queryOutput'
  // skill（09：Skill 管理，docs/prd/09_skill_management.md）
  | 'skill/listSkills'
  | 'skill/importSkill'
  | 'skill/createSkill'
  | 'skill/deleteSkill'
  // term（10：内嵌终端，docs/prd/10_embedded_terminal.md）
  | 'term/create'
  | 'term/write'
  | 'term/kill'
  | 'term/resize'
  // file（12：内置代码浏览器，docs/prd/12_code_explorer.md）
  // 安全口径：relPath 一律视为不可信输入，主进程过 path.resolve + realpath 两道
  // containment，越界返回 6103 且不落到磁盘；三个方法均只读。
  | 'file/listDir'
  | 'file/readFile'
  | 'file/searchFiles'
  // 自动刷新：以传入集合为准对齐「已打开文件」的磁盘监听；变化经 code.fileChanged 事件回报
  | 'file/watchSync'
  | 'git/getBranchInfo'
  | 'git/switchBranch'
  // git 提交/推送（模块 11，docs/prd/11_git_commit_push.md）
  | 'git/getStatus'
  // 模块 12：单文件 unified diff（代码查看器「并排 diff」数据源，只读）
  | 'git/getFileDiff'
  | 'git/commit'
  | 'git/push'
  | 'git/generateCommitMessage'
  | 'pi/getInfo'
  | 'pi/updatePlugins'
  | 'app/getUpdateDebug'
  | 'updater/getState'
  | 'updater/checkForUpdates'
  | 'updater/downloadUpdate'
  | 'updater/quitAndInstall'
  // 版本更新说明（升级后首启弹一次 + 关于页回看）
  | 'updater/getReleaseNotes'
  | 'updater/markNotesShown'
  // ask_user_question（Path 2）：问卷回填（renderer → main 的唯一上行入口）
  | 'askUserQuestion/reply';

/** 全部事件名 */
export type ForgeEvent =
  | 'project.opened'
  | 'project.removed'
  | 'session.statusChanged'
  | 'session.removed'
  | 'session.updated'
  | 'conversation.statusChanged'
  | 'conversation.delta'
  | 'conversation.message'
  | 'conversation.queueUpdated'
  | 'conversation.error'
  | 'conversation.compacting'
  | 'conversation.compacted'
  | 'conversation.slashCommandsUpdated'
  | 'conversation.askUserQuestionRequested'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.error'
  | 'model.providersChanged'
  | 'subagent.updated'
  | 'subagent.removed'
  | 'git.branchChanged'
  | 'updater.stateChanged'
  // term（10）：pty 下行数据/退出（按 ptyId 归属各 tab）
  | 'term:data'
  | 'term:exit'
  // v3.76 启动门闩：forge-core 组装完成后主进程推送一次（拉通道见 getBootState）
  | 'boot.ready'
  // 系统通知点击跳转（主进程 notifyToast 直发，不经 core eventBus）：payload { sessionId }，
  // UI 收到后切换到该会话（App.vue onSelectSession）
  | 'notify.focusSession'
  // 模块 12 自动刷新：已打开文件在磁盘上被修改。payload { projectPath, relPath }，
  // useCodeExplorer 据此静默重读对应签条
  | 'code.fileChanged';

/**
 * 启动状态（与 @forge/desktop ipc-contract.ts BootState 同构，本地声明惯例）。
 * v3.76 欢迎页：false 期间 App 只渲染欢迎页，不发任何 forge:invoke 请求——
 * 此时主进程 core（含 pi SDK）尚未组装完，invoke handler 还没注册。
 */
export interface BootState {
  ready: boolean;
  startedAt: number;
  durationMs: number | null;
  /**
   * v3.87：主进程 `win.show()` 完成的时刻；未显示为 null。欢迎页字标入场动效据此起播
   * （必须等「窗口已可见」——BootWelcome 可能在窗口显示之前就 mount，那时约 1.2s 的逐字
   * 动画会在用户看到之前播完）。与 `boot.splashShown` 事件构成推/拉双通道。
   */
  splashShownAt: number | null;
}

/**
 * shell 健康探测结果（与 @forge/desktop ipc-contract.ts ShellProbeResult 同构，本地声明惯例）。
 * 背景：pi 的 bash 三级兜底在 Windows 上可能命中 System32 的 WSL 占位（每条命令只回
 * 一句乱码的「未安装 Linux 子系统」），ok=false 时对话区渲染常驻横幅指引修复。
 *
 * autoFixed：主进程探测失败时会自动定位 Git Bash 写进 shellPath 再复探，成功即回
 * ok=true + autoFixed=true——配置刚落盘，已存在的会话仍持旧解析结果，UI 据此提示重启
 * （见 @forge/desktop pi/shellProbe.ts ensurePiShellPath）。
 */
export type ShellProbeResult = {
  ok: true;
  shell: string;
  autoFixed?: boolean;
} | {
  ok: false;
  reason: 'wsl-stub' | 'no-shell';
  shell: string | null;
  settingsPath: string;
}

/** IPC invoke 返回信封（透传 forge-core RpcResult） */
export interface ForgeResult<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}

/**
 * 上下文压缩触发来源：manual = 用户点击压缩；auto = 运行时按阈值/溢出自动触发。
 * 与 @forge/core CompactReason 一致（本地声明避免浏览器打包引入 node:events）。
 */
export type CompactReason = 'manual' | 'auto';

/**
 * conversation/compact 的压缩结果（P3-A）。
 * 成功时 ok=true 并携带压缩前后 token 数（未知为 null）；失败时 ok=false 且 message
 * 为原因。与 @forge/core ConversationCompactResult 一致。
 */
export interface ConversationCompactResult {
  ok: boolean;
  /** 失败原因（成功时缺省） */
  message?: string;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  summary?: string | null;
}

/**
 * conversation.compacting 事件 payload：一次上下文压缩开始（手动或自动）。
 * UI 据此锁定输入框并显示"正在压缩"横幅；与 compacted 成对出现。
 * 与 @forge/core ConversationCompactingPayload 一致。
 */
export interface ConversationCompactingPayload {
  sessionId: string;
  reason: CompactReason;
}

/**
 * conversation.compacted 事件 payload（P3-A）：一次上下文压缩完成（手动或自动）。
 * 自动压缩没有 RPC 入口，UI 靠本事件感知并重拉会话历史。
 * 与 @forge/core ConversationCompactedPayload 一致。
 */
export interface ConversationCompactedPayload {
  sessionId: string;
  reason: CompactReason;
  tokensBefore: number | null;
  tokensAfter: number | null;
  summary: string | null;
}

/**
 * conversation/getSlashCommands 的命令条目（CV-S08，AC-CV-026~030）。
 * name 为原始命令名（skill 命令带 `skill:` 前缀）；插入输入框时补 `/` 前缀。
 * 与 docs/api/03_conversation.md §9 一致。
 */
export interface SlashCommand {
  name: string;
  /** 命令描述；缺失为 null（UI 副文本留空） */
  description: string | null;
  /** extension = 扩展命令；skill = 技能；prompt = prompt 模板 */
  source: 'extension' | 'skill' | 'prompt';
}

/** conversation/getSlashCommands 请求参数（省略 sessionId = 草稿态查询） */
export interface GetSlashCommandsParams {
  /** 会话 ID：提供时返回该会话的上报清单（三类全量）；省略时为草稿态（skills + 模板） */
  sessionId?: string;
  /** 草稿态时的项目工作目录（发现项目级 skills/模板）；省略时仅发现全局资源 */
  projectPath?: string;
}

/** conversation/getSlashCommands 响应 data */
export interface GetSlashCommandsResult {
  commands: SlashCommand[];
}

/**
 * conversation.slashCommandsUpdated 事件 payload（CV-S08）：命令上报扩展的上报
 * 到达（会话激活后覆盖降级清单）；UI 据此失效该会话命令清单缓存并重拉。
 */
export interface SlashCommandsUpdatedPayload {
  sessionId: string;
}

/*
 * ===== ask_user_question（Path 2 自建内置扩展）=====
 *
 * 真相来源：`docs/plan/ask-user-question-contract.md` §1/§2/§4。
 * 按本文件既有惯例**本地声明**（不 import @forge/core 根入口——其 RPC 层含
 * node:events，浏览器打包会炸）；字段与扩展侧 schema.ts / channels.ts 同构。
 */

/** 问卷选项 */
export interface AskUserQuestionOption {
  /** 选项短标签（≤60 字符） */
  label: string;
  /** 该选项含义/权衡说明 */
  description: string;
  /** 可选 markdown（mockup / 代码 / 配置示例）；任一选项有 preview 时切左右分栏 */
  preview?: string;
  /** ★ forge 扩展字段：推荐项（渲染「推荐」标记） */
  recommended?: boolean;
}

/** 单道问题 */
export interface AskUserQuestionItem {
  /** 完整问题 */
  question: string;
  /** ≤16 字符短标签（tab 标题） */
  header: string;
  /** 2–4 个选项 */
  options: AskUserQuestionOption[];
  /** 默认 false；true 时多选（选项行渲染 checkbox） */
  multiSelect?: boolean;
}

/** conversation.askUserQuestionRequested 事件 payload（sessionId 必需，多窗格据此认领） */
export interface AskUserQuestionRequestPayload {
  sessionId: string;
  requestId: string;
  questions: AskUserQuestionItem[];
  /** 面板倒计时时长（毫秒，由扩展下发；**勿硬编码**） */
  timeoutMs: number;
}

/** 单题作答（回填用；cancelled=true 时仍应带已答部分） */
export interface AskUserQuestionAnswer {
  questionIndex: number;
  question: string;
  kind: 'option' | 'custom' | 'multi';
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

/** askUserQuestion/reply 请求参数 */
export interface AskUserQuestionReplyParams {
  sessionId: string;
  requestId: string;
  answers: AskUserQuestionAnswer[];
  cancelled: boolean;
  /** 全局备注（可选，空/空白不传） */
  globalNote?: string;
}

/** askUserQuestion/reply 响应 data */
export interface AskUserQuestionReplyResult {
  /** 是否已投递到扩展侧等待中的 Promise（false = 会话无活跃 lease，作答被丢弃） */
  delivered: boolean;
}

/** window.forge.askUserQuestion：问卷双向通道 */
export interface ForgeAskUserQuestion {
  /** 订阅问卷请求（收窄 payload 类型）；多窗格各自订阅并**按 sessionId 认领** */
  onRequest(listener: (payload: AskUserQuestionRequestPayload) => void): () => void;
  /** 回填作答（必须带 sessionId + requestId） */
  reply(params: AskUserQuestionReplyParams): Promise<ForgeResult<AskUserQuestionReplyResult>>;
}

/** pi/getInfo 响应 data（设置页「关于」Tab；组件明细不回传 UI——走结构化日志与 updater-state.json）。与 @forge/desktop ipc-contract 同步 */
export interface PiGetInfoResult {
  forgeVersion: string;
}

/** pi/updatePlugins 响应 data（更新器输出尾部；失败时 UI 展示排查信息） */
export interface PiUpdatePluginsResult {
  output: string;
}

/** app/getUpdateDebug 响应 data（本地配置文件开启后返回 true——调试控制台仅对开发/维护者可见） */
export interface GetUpdateDebugResult {
  enabled: boolean;
}

/** 自更新状态机（07 IN-S03）：idle → checking → found → downloading → downloaded → installing；失败回 idle。与 @forge/desktop ipc-contract 同步 */
export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'found'
  | 'downloading'
  | 'downloaded'
  | 'installing';

/** updater/getState 响应 data（自更新状态快照，docs/api/07_pi.md §3.1）。与 @forge/desktop ipc-contract 同步 */
export interface UpdaterSnapshot {
  status: UpdaterStatus;
  /** 当前 forge 版本 */
  currentVersion: string;
  /** 检测到的新版本号（found 之后有值） */
  latestVersion: string | null;
  /** 下载进度 0-100（downloading 时有值） */
  downloadProgress: number | null;
  /** 最近一次失败原因（静默展示用，不主动弹错） */
  error: string | null;
}

/** updater.stateChanged 事件 payload：与 getState.data 同构（全局单例状态，无 sessionId）；任意跃迁都发（含下载进度步进） */
export type UpdaterStateChangedPayload = UpdaterSnapshot;

/** updater/getReleaseNotes 响应 data（版本更新说明）。与 @forge/desktop ipc-contract 同步 */
export interface ReleaseNotesPayload {
  /** 说明对应的 forge 版本（=当前版本） */
  version: string;
  /** Markdown 原文；null = 安装包未携带说明（异常/极老安装包） */
  markdown: string | null;
  /** 是否应自动弹出（升级首启且本版本未展示过）；关于页回看只看 markdown */
  shouldShow: boolean;
}

/** preload 注入的 window.forge 桥 */
export interface ForgeBridge {
  /**
   * 运行平台 = 主进程 process.platform（'darwin' | 'win32' | 'linux' | …）；浏览器 mock 为 'browser'。
   * UI 据此区分 macOS：隐藏自定义窗口三键（用系统 traffic lights）、标题栏左端为灯让位。
   */
  platform: string;
  invoke(method: ForgeMethod, params?: Record<string, unknown>): Promise<ForgeResult>;
  /** 启动状态查询（v3.76 欢迎页门闩「拉」通道；handler 不依赖 core，窗口建好即用） */
  bootState(): Promise<BootState>;
  /** splash 上屏回执（v3.78.7）：主进程据此决定何时显示窗口；纯浏览器环境为空实现 */
  splashReady(): void;
  /**
   * v3.87：订阅「窗口已显示」发令（splash 字标入场动效的起跑信号）。与 splashReady
   * 反向：那条是渲染→主（我准备好了），这条是主→渲染（你该演了）。渲染端另有超时
   * 兜底，故本事件丢失不会让字标永久停在起点。纯浏览器环境为空实现。
   */
  onSplashShown?(listener: () => void): () => void;
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void;
  /** Path 2 问卷双向通道：订阅请求（收窄类型）+ 回填作答 */
  askUserQuestion: ForgeAskUserQuestion;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
  };
  dialog: {
    selectDirectory(): Promise<string | null>;
    selectFiles(): Promise<string[]>;
    /** 另存对话框（画布卡片用）：返回用户选定的绝对路径，取消返回 null */
    saveFile(defaultName: string): Promise<string | null>;
  };
  shell: {
    /** 系统文件管理器打开目录（项目右键"打开项目所在目录"）；失败返回 false */
    openPath(path: string): Promise<boolean>;
    /**
     * 系统默认浏览器打开本地 HTML（改动文件卡右键「用浏览器打开」）。
     * 仅 .html/.htm 且必须是已存在的普通文件——主进程校验（shell/openTarget.ts），
     * 渲染层的扩展名判定只管菜单项显不显示。失败返回 false。
     */
    openInBrowser(path: string): Promise<boolean>;
    /**
     * 扫描本机已安装的外部编辑器（内置编辑器目录 20+ 款：VS Code 家族 / Cursor / Windsurf / Trae / Zed / JetBrains…，主进程三层解析），
     * 代码树右键菜单按结果分项。exe 路径不出主进程，渲染层只拿 id + 展示名。
     */
    listEditors(): Promise<{ id: string; label: string }[]>;
    /**
     * 探测本机可用的内嵌终端 shell（设置 → 个性化 → 终端 Shell 选项源，TD-TM-05 方案 B）。
     * exe 路径不出主进程，渲染层只拿 id + 展示名；选定 id 经 term/create 的 shellId 下发。
     */
    listTerminalShells(): Promise<{ id: string; label: string }[]>;
    /**
     * 用**指定**编辑器（id 必须来自 listEditors）打开一个文件（代码树右键菜单）。
     * 失败返回 false（未装、目标不是普通文件、文件名以 `-` 开头等）。
     * 渲染层只能传文件路径 + 编辑器 id：命令名与参数由主进程决定。
     */
    openInEditor(path: string, editorId: string): Promise<boolean>;
    /** 系统浏览器/邮件客户端打开外链（仅 http/https/mailto，主进程校验）；失败返回 false */
    openExternal(url: string): Promise<boolean>;
    /** pi bash 解析健康探测（对话区横幅数据源，见 ShellProbeResult 注释） */
    shellProbe(): Promise<ShellProbeResult>;
  };
  theme: {
    /**
     * 主题回写主进程（v3.78.6）。主进程把它落到 userData/forge-theme.json，供下次冷启动
     * 建窗时当 BrowserWindow.backgroundColor（建窗时刻读不到 localStorage），并就地刷新
     * 当前窗口底色。单向 fire-and-forget，无返回值、无失败反馈——回写失败只影响下次
     * 启动的第一帧底色。取值同 types.ts 的 ThemeMode。
     */
    set(mode: 'light' | 'dark'): void;
  };
  /**
   * 生效语言回报主进程（与主题通道同构，localStorage['forge.locale'] 唯一事实来源）。
   * 仅系统通知小窗（主进程 notifyToast.ts）标题文案取词用。可选：浏览器 mock 不实现，
   * 旧 preload 亦无此方法，调用侧一律 `window.forge.locale?.set(...)`。
   */
  locale?: {
    set(mode: 'zh-CN' | 'en'): void;
  };
  file: {
    /** 拖拽/粘贴 File 对象 → 磁盘绝对路径；无盘文件（剪贴板截图）返回空串 */
    getPathForFile(file: File): string;
    /** 附件密钥嗅探：文本文件命中凭据特征 → flagged=true */
    scanAttachments(paths: string[]): Promise<Array<{ path: string; name: string; flagged: boolean }>>;
    /** 粘贴截图落盘到系统临时目录，返回真实路径；失败返回 null */
    savePasteImage(base64Data: string, ext?: string): Promise<{ path: string; name: string } | null>;
    /** 超长粘贴文本落盘为临时 txt，返回真实路径；失败返回 null */
    savePastedText(text: string): Promise<{ path: string; name: string } | null>;
    /** 磁盘图片读为 data URL（仅缩略图/预览用）；缺失/超大/非图片返回 null */
    readImage(path: string): Promise<string | null>;
    /** @ 补全候选：项目内白名单文件绝对路径（BFS 浅层优先，上限 2000）；项目缺失/不可读返回 [] */
    listProjectFiles(projectPath: string): Promise<string[]>;
    /** 写 UTF-8 文本（画布卡片另存，主进程限定 .html/.htm）；失败返回 false */
    writeText(path: string, text: string): Promise<boolean>;
  };
}

/** 待发附件（统一给路径）：只持路径与嗅探标记，不读内容 */
export interface PendingAttachment {
  path: string;
  name: string;
  /** 命中疑似密钥/凭据：发送前需用户确认 */
  flagged: boolean;
  /** 图片缩略图 data URL（仅图片附件，加载后填充；预览/放大用） */
  dataUrl?: string;
}

/**
 * ===== Skill 管理（09）类型 =====
 * 事实来源在 @forge/desktop pi/skillService.ts；按本文件惯例本地声明同形类型。
 */

/** skill 作用域：user=全局，project=当前项目 */
export type SkillScope = 'user' | 'project';

/** 单条生效 skill（loader 返回的均为同名冲突生效方；loser 走 issues 诊断） */
export interface SkillEntry {
  name: string;
  description: string;
  /** pi sourceInfo.scope 映射；'other'=不归组兜底展示 */
  scope: 'user' | 'project' | 'other';
  /** skill 目录绝对路径（根路径徽标数据源） */
  dirPath: string;
  /** SKILL.md 绝对路径 */
  filePath: string;
  disableModelInvocation: boolean;
}

/** 异常/冲突诊断（warning=非法或未加载，collision=同名被覆盖） */
export interface SkillIssue {
  type: 'warning' | 'error' | 'collision';
  message: string;
  path: string | null;
  winnerPath: string | null;
  loserPath: string | null;
}

/** skill/listSkills 响应 data */
export interface ListSkillsResult {
  cwd: string;
  skills: SkillEntry[];
  issues: SkillIssue[];
}

/** skill/importSkill | createSkill 同名冲突响应（code=4090，确认后带 overwrite=true 重调） */
export interface SkillConflictData {
  conflictPath: string;
  sourceDir?: string;
}

/**
 * ===== 内嵌终端（10）类型 =====
 * 事实来源在 @forge/desktop term/ptyService.ts；按本文件惯例本地声明同形类型。
 */

/** term/create 响应 data */
export interface TermCreateResult {
  ptyId: string;
  /** 实际 spawn 的系统 shell 绝对路径（tab 内首行展示用） */
  shell: string;
  pid: number;
}

/** term:data 事件 payload（data = pty 原始输出含 ANSI，直接 xterm.write 不转义） */
export interface TermDataPayload {
  ptyId: string;
  data: string;
}

/** term:exit 事件 payload（exit 即发：用户退出/kill/崩溃；tab 内显示退出码） */
export interface TermExitPayload {
  ptyId: string;
  exitCode: number;
}

/**
 * ===== 内置代码浏览器（12）类型 =====
 * 事实来源在 @forge/core file/fileService.ts；按本文件惯例本地声明同形类型
 * （forge-ui 不依赖 @forge/core，契约变更时两边同步）。
 */

/** file/listDir 的一个条目（目录或文件） */
export interface FileNode {
  /** 文件/目录名（单段，不含路径） */
  name: string;
  /** 相对项目根的 POSIX 路径（UI 侧一切寻址都用它，绝不自己拼绝对路径） */
  relPath: string;
  kind: 'file' | 'dir';
  /** 字节数（目录为 0） */
  size: number;
  /** 修改时间（ms，目录为 0） */
  mtimeMs: number;
}

/** file/listDir 响应 data */
export interface ListDirData {
  /** 本次列举的目录相对路径（'' = 项目根） */
  relPath: string;
  nodes: FileNode[];
  /** 被忽略规则隐藏的条目数（底栏不展示，仅供调试/未来「显示被忽略项」用） */
  hidden: number;
}

/** 截断原因；null = 未截断 */
export type TruncatedBy = 'bytes' | 'lines' | null;

/** file/readFile 响应 data */
export interface ReadFileData {
  relPath: string;
  name: string;
  /** 正文；二进制时为 ''（UI 据 binary=true 渲染降级态） */
  content: string;
  /** 实际返回行数 */
  lineCount: number;
  eol: 'lf' | 'crlf' | 'mixed';
  size: number;
  mtimeMs: number;
  binary: boolean;
  truncated: boolean;
  truncatedBy: TruncatedBy;
  /** 截断前的总行数（未截断时等于 lineCount） */
  totalLines: number;
}

/** file/searchFiles 响应 data */
export interface SearchFilesData {
  /** 命中的文件（按路径深度、再字典序） */
  files: string[];
  /** 因触达上限而提前停止（UI 提示「结果已截断」） */
  limitReached: boolean;
}

/** file 域错误码（UI 按它分支：6103 安全事件 / 6104 标签页失效 / 6106 类型不符） */
export const FILE_ERR = {
  INVALID_PARAMS: 6101,
  PROJECT_NOT_FOUND: 6102,
  PATH_ESCAPE: 6103,
  NOT_FOUND: 6104,
  NOT_A_DIRECTORY: 6105,
  NOT_A_FILE: 6106,
  READ_FAILED: 6107,
} as const;

/**
 * 调用主进程方法并原样返回信封（不抛错）。
 * Skill 管理用：4090 冲突是需要 UI 弹确认的**正常分支**，不适合 call() 的抛错语义。
 */
export async function invokeRaw<T = unknown>(
  method: ForgeMethod,
  params?: Record<string, unknown>,
): Promise<ForgeResult<T>> {
  return (await window.forge.invoke(method, params)) as ForgeResult<T>;
}

/**
 * 调用主进程方法，code !== 0 抛错，成功返回 data。
 * @param method 方法名
 * @param params 请求参数
 * @returns data（已断言非 null）
 */
export async function call<T>(
  method: ForgeMethod,
  params?: Record<string, unknown>,
): Promise<T> {
  const res = await window.forge.invoke(method, params);
  if (res.code !== 0) {
    throw new Error(`${method} 失败（${res.code}）: ${res.message}`);
  }
  return res.data as T;
}

// ── 内置代码浏览器（12）专用封装 ────────────────────────────────────────────
//
// 三个方法**不**走 call() 的抛错语义，而是返回信封让调用方按 code 分支：
//   6103 越界（安全事件，只写日志不弹窗）
//   6104 路径失效（把标签页标记为「文件已删除」，不清空当前内容）
//   6105/6106 类型不符（目录/文件搞反了，给对应提示）
// 抛错会让这些分支退化成 try/catch + message 字符串判断，而 code 才是契约。

/** 列单层目录；relPath 缺省 ''= 项目根 */
export function fileListDir(path: string, relPath = ''): Promise<ForgeResult<ListDirData>> {
  return invokeRaw<ListDirData>('file/listDir', { path, relPath });
}

/** 读文本文件（二进制 / 截断 / 失效都走 data 字段表达，不走错误码） */
export function fileReadFile(path: string, relPath: string): Promise<ForgeResult<ReadFileData>> {
  return invokeRaw<ReadFileData>('file/readFile', { path, relPath });
}

/**
 * 对齐「已打开文件」的磁盘监听（自动刷新）：打开/关闭文件后把**该项目**的
 * 全量 relPaths 发给主进程；主进程 diff 目录级 fs.watch，变化经
 * `code.fileChanged` {projectPath, relPath} 事件回报。空数组 = 全部关闭。
 */
export function fileWatchSync(path: string, relPaths: string[]): Promise<ForgeResult<Record<string, never>>> {
  return invokeRaw('file/watchSync', { path, relPaths });
}

/** 按文件名过滤（只搜文件名，不做内容搜索） */
export function fileSearchFiles(path: string, query: string): Promise<ForgeResult<SearchFilesData>> {
  return invokeRaw<SearchFilesData>('file/searchFiles', { path, query });
}

/**
 * 查询主进程启动状态（v3.76 欢迎页门闩）。
 * ready=false 时 App 只渲染欢迎页且不发任何 forge:invoke（handler 未注册）；
 * ready 事件（boot.ready）与本次拉取构成推拉双通道，任一先到即放行。
 */
export async function getBootState(): Promise<BootState> {
  return window.forge.bootState();
}

/** 订阅主进程事件，返回取消订阅函数 */
export function subscribe(
  event: ForgeEvent,
  listener: (payload: unknown) => void,
): () => void {
  return window.forge.on(event, listener);
}

/**
 * 订阅问卷请求（Path 2）：等价 `subscribe('conversation.askUserQuestionRequested')`，
 * 仅收窄 payload 类型。多窗格场景下每个窗格各自订阅并**按 sessionId 认领**。
 */
export function onAskUserQuestionRequest(
  listener: (payload: AskUserQuestionRequestPayload) => void,
): () => void {
  return window.forge.askUserQuestion.onRequest(listener);
}

/**
 * 回填问卷作答（Path 2）。成功返回 `{ delivered }`；失败（code≠0）抛错。
 * 必须携带 `sessionId + requestId`；`cancelled=true` 时 `answers` 仍应带已答部分。
 */
export async function replyAskUserQuestion(
  params: AskUserQuestionReplyParams,
): Promise<AskUserQuestionReplyResult> {
  const res = await window.forge.askUserQuestion.reply(params);
  if (res.code !== 0) {
    throw new Error(`askUserQuestion/reply 失败（${res.code}）: ${res.message}`);
  }
  return res.data as AskUserQuestionReplyResult;
}
