/**
 * forge-desktop ←→ forge-ui IPC 契约（唯一事实来源）。
 *
 * 本文件定义渲染进程（forge-ui）通过 preload 暴露的 `window.forge` 完整接口，
 * 以及主进程（forge-desktop）如何把方法调用路由到 forge-core 的 Api 方法映射、
 * 如何把 Api 事件转发到渲染进程。UI 侧与主进程侧都引用同一组方法名/事件名，
 * 避免两边漂移。
 *
 * 使用方式：
 * - UI 侧：`window.forge.invoke('project/queryProjectList')` / `window.forge.on('tool.started', fn)`
 * - 主进程侧：见 `preload.ts`（bridge）与 `main.ts`（路由 + 事件转发）
 */
import type {
  RpcResult,
  ConversationCompactedPayload,
  AskUserQuestionRequestPayload,
  AskUserQuestionReplyParams,
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
  // 内置代码浏览器（12）的只读数据形状：从 @forge/core 按类型再导出（本文件是
  // preload 不引 node:fs 的关键——类型导入不会把 fs 拖进 bundle，值导入会）。
  FileNode,
  ListDirData,
  ReadFileData,
  SearchFilesData,
  TruncatedBy,
} from '@forge/core';
import type { AppUpdaterSnapshot } from './pi/appUpdater.ts';

/** 全部可调用方法（= forge-core 各 Api 的 methods map 键并集） */
export type ForgeMethod =
  // project（01）
  | 'project/addProject'
  | 'project/removeProject'
  | 'project/clearSessions'
  | 'project/queryProjectList'
  | 'project/openProject'
  | 'project/updateProjectAlias'
  | 'project/reorderProjects'
  | 'project/setTrust'
  // git（wu-02）
  | 'git/getBranchInfo'
  | 'git/switchBranch'
  // git 提交/推送（模块 11，docs/prd/11_git_commit_push.md）
  | 'git/getStatus'
  | 'git/commit'
  | 'git/push'
  | 'git/generateCommitMessage'
  // session（02）
  | 'session/createSession'
  | 'session/querySessionList'
  | 'session/deleteSession'
  | 'session/updateSessionAlias'
  | 'session/getSessionStatus'
  | 'session/attachSessionWindow'
  | 'session/detachSessionWindow'
  // conversation（03）
  | 'conversation/sendMessage'
  | 'conversation/cancelStream'
  // CV-S09 队列编辑：删除 / 立即发送（打断当前轮并直发该条）
  | 'conversation/queueRemove'
  | 'conversation/queueSendNow'
  | 'conversation/queryHistory'
  | 'conversation/getContextUsage'
  | 'conversation/compact'
  | 'conversation/getSlashCommands'
  // tool（04）
  | 'tool/queryToolEvents'
  // model（05）
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
  // subagent（06）
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
  // 安全口径：cwd 由主进程按已注册项目路径校验（AC-10-06）；spawn 目标固定系统 shell
  | 'term/create'
  | 'term/write'
  | 'term/kill'
  | 'term/resize'
  // file（12：内置代码浏览器，docs/prd/12_code_explorer.md）
  // 安全口径：relPath 一律视为不可信输入，主进程过 path.resolve + realpath 两道
  // containment；越界返回 6103 且不落到磁盘。三个方法均只读。
  | 'file/listDir'
  | 'file/readFile'
  | 'file/searchFiles'
  // pi（07）
  | 'pi/getInfo'
  | 'pi/updatePlugins'
  | 'app/getUpdateDebug'
  // updater（07 IN-S03 应用自更新）
  | 'updater/getState'
  | 'updater/checkForUpdates'
  | 'updater/downloadUpdate'
  | 'updater/quitAndInstall'
  // ask_user_question（Path 2）：renderer → main 的问卷回填（唯一上行入口，
  // 必须是方法而非事件——main.ts 只经 IPC_INVOKE → invoke(methodTable) 接收）
  | 'askUserQuestion/reply';

/** preload ↔ main 窗口控制通道 */
export const IPC_WINDOW_MINIMIZE = 'forge:window:minimize';
export const IPC_WINDOW_MAXIMIZE = 'forge:window:maximize';
export const IPC_WINDOW_CLOSE = 'forge:window:close';
export const IPC_WINDOW_IS_MAXIMIZED = 'forge:window:isMaximized';

/**
 * 启动状态查询通道（v3.76 欢迎页门闩）。
 *
 * 与 forge:invoke 不同：该 handler 不依赖 forge-core 组装，窗口创建后立即可用。
 * 渲染进程用它做「拉」通道（避免主进程推 boot.ready 时渲染侧尚未订阅而错过）；
 * 「推」通道是 boot.ready 事件，两者配合实现拉推双保险。
 */
export const IPC_BOOT_STATE = 'forge:boot-state';

/**
 * splash 上屏回执通道（v3.78.7，渲染进程 → 主进程，单向）。
 *
 * 主进程用 `show:false` 建窗，需要知道「splash 真的画到窗口表面了」才显示窗口——这样用户
 * 看到的第一帧就是 splash，而不会是「页面尚未绘制的空文档白帧」。为什么不用 Electron 自带的
 * `ready-to-show`：v3.78.7 实测它在 1206ms 触发，而页面的 first-contentful-paint 到 6872ms
 * 才出现——原因是主进程紧接着的同步重活（pi SDK 求值 + jiti 预热）会把浏览器进程的合成一起
 * 卡住，于是「已渲染」与「已提交到窗口表面」差了 5.6s。渲染进程自己数满两帧再回执，是唯一
 * 能代表「提交完成」的信号。
 */
export const IPC_BOOT_SPLASH_READY = 'forge:boot-splash-ready';

/** 启动状态（forge:boot-state 响应与 boot.ready 事件 payload 同构） */
export interface BootState {
  /** forge-core（含 pi SDK）是否组装完成 */
  ready: boolean;
  /** 主进程启动时刻（performance.now 基准，仅观测用） */
  startedAt: number;
  /** core 组装耗时（毫秒）；未完成时为 null */
  durationMs: number | null;
  /**
   * v3.87：主进程 `win.show()` + 显示后帧校验完成的时刻（主进程时钟）；未显示为 null。
   * 欢迎页字标入场动效据此起播——**动效必须等「窗口已可见」，不能从组件 mount 或
   * CSS 首帧自动开始**：BootWelcome 可能在窗口显示之前就 mount（实测 dev 下
   * splashReady 后 ~300ms 即 mount，而 win.show() 还要等一张合成帧），那时窗口
   * 不可见，约 1.2s 的逐字动画会在用户看到之前就播完。
   * 「事件早于订阅」与「订阅早于事件」两种顺序都要覆盖，故事件 + 本字段双通道。
   */
  splashShownAt: number | null;
}

/** preload ↔ main 原生对话框通道 */
export const IPC_DIALOG_OPEN_DIRECTORY = 'forge:dialog:openDirectory';
export const IPC_DIALOG_OPEN_FILE = 'forge:dialog:openFile';

/** preload ↔ main shell 通道：系统文件管理器打开路径 */
export const IPC_SHELL_OPEN_PATH = 'forge:shell:openPath';

/**
 * preload ↔ main shell 通道：系统默认浏览器打开本地 HTML 文件
 * （改动文件汇总卡右键「用浏览器打开」）。
 *
 * 与 openPath（只放行目录，CV-TRUST-02）刻意分开：这条放行的是**文件**，因此白名单收得
 * 更紧——必须是「已存在的普通文件 + .html/.htm」（软链/可执行文件/协议关联一律拒，
 * 见 shell/openTarget.ts）。校验不落在渲染层：渲染层只决定菜单项显不显示。
 */
export const IPC_SHELL_OPEN_IN_BROWSER = 'forge:shell:openInBrowser';

/**
 * preload ↔ main shell 通道：系统浏览器/邮件客户端打开外链（消息正文链接拦截）。
 * 与 openPath 刻意分开：这条只收 http/https/mailto 绝对 URL，绝不落到 shell.openPath
 * （后者会把任意字符串交给系统「打开」，指向 .exe 就等于双击运行）。
 */
export const IPC_SHELL_OPEN_EXTERNAL = 'forge:shell:openExternal';

/**
 * preload ↔ main shell 通道：pi bash 解析健康探测 + 自愈（渲染层启动横幅数据源）。
 * 探测到不可用时主进程会自动定位 Git Bash 并写入 settings.json，再复探一次。
 */
export const IPC_SHELL_PROBE = 'forge:shell:probe';

/**
 * shell 探测结果（forge:shell:probe 响应）。
 *
 * 背景：pi 的 bash 解析在 Windows 上按 settings.shellPath → Program Files Git ×2 →
 * PATH bash.exe 三级兜底，第三级会命中 System32 的 WSL 占位 bash.exe——WSL 未装时
 * 每条命令只返回一句 UTF-16 乱码的「未安装 Linux 子系统」，模型侧表现为
 * 「bash 工具被 WSL 拦截、彻底不可用」（2026-09 dev 切根事故）。forge 启动时用同一
 * 口径探测一次，异常则在对话区横幅给出可操作指引。
 *
 * 自愈（2026-09 追加）：探测异常时主进程会按 where git.exe 反推 / 注册表 / 常见安装
 * 路径 / PATH 的顺序找真 bash 并写进 shellPath（见 pi/gitBashResolver.ts），用户不需要
 * 自己编辑配置。只有本机确实没有可用 bash 时才把异常交给横幅。
 */
export type ShellProbeResult =
  | {
      ok: true;
      /** 解析到的 shell 绝对路径 */
      shell: string;
      /** true=本次结果是「自动写入 shellPath 后复探」得到的（配置刚落盘，重启后全会话生效） */
      autoFixed?: boolean;
    }
  | {
      ok: false;
      /** wsl-stub=PATH 兜底命中 System32 WSL 占位；no-shell=三级全落空（getShellConfig 抛错） */
      reason: 'wsl-stub' | 'no-shell';
      /** 探测到的可疑/缺失 shell 路径；no-shell 时为 null */
      shell: string | null;
      /** 修复目标：forge agent 根下 settings.json（自动修复也失败时，用户可在此手工兜底） */
      settingsPath: string;
    };

/**
 * 画布卡片「另存」（见 docs/plan/canvas-card.md）：原生保存对话框选位置 + 写 UTF-8 文本。
 *
 * 为什么走保存对话框而不是自造目录（如项目下 .forge/canvas/）：卡片是模型产出的
 * 一次性图示，落到项目里会污染 git 状态（改动文件卡会变吵），落到 userData 又不好
 * 找。让用户在对话框里自己决定去哪，两条顾虑一起消掉。
 */
export const IPC_DIALOG_SAVE_FILE = 'forge:dialog:saveFile';
export const IPC_FILE_WRITE_TEXT = 'forge:file:writeText';

/**
 * preload ↔ main 主题通道（v3.78.6）：渲染进程把当前主题同步给主进程。
 *
 * 为什么需要：`BrowserWindow.backgroundColor` 只在建窗时刻可给，而那一刻主进程读不到
 * 渲染进程的 localStorage（唯一事实来源在 forge-ui 的 useTheme.ts）。故渲染进程每次
 * 解析/切换主题都回写一次，主进程落盘（userData/forge-theme.json）供下次冷启动建窗取用，
 * 并就地刷新当前窗口底色。单向、无返回值——回写失败只影响下次启动的底色。
 *
 * 详见 packages/forge-desktop/src/theme.ts 顶部说明。
 */
export const IPC_THEME_SET = 'forge:theme:set';

/**
 * preload ↔ main 界面语言通道：渲染进程把生效语言同步给主进程。
 * 与主题通道同构（localStorage 唯一事实来源，主进程只持镜像）：语言存 localStorage
 * ['forge.locale']，主进程读不到——而系统通知小窗（notifyToast.ts）的标题文案
 * 「回复已完成 / Reply completed」需要按当前语言取词。单向 fire-and-forget。
 */
export const IPC_LOCALE_SET = 'forge:locale:set';

/** 生效语言（与 forge-ui i18n 的 ActiveLocale 同构，本地声明惯例） */
export type ToastLocale = 'zh-CN' | 'en';

/**
 * 通知小窗（notifyToast.ts）↔ 页面通道：每条通知一个 data: URL 页面 +
 * notifyToastPreload 暴露的 window.notifyToast 三动作（ready/close/activate）。
 * ready 携带页面实测的通知卡片高度（主进程据此调整窗口尺寸再 showInactive）。
 */
export const IPC_NOTIFY_TOAST_READY = 'forge:notifyToast:ready';
export const IPC_NOTIFY_TOAST_CLOSE = 'forge:notifyToast:close';
export const IPC_NOTIFY_TOAST_ACTIVATE = 'forge:notifyToast:activate';

/** preload ↔ main 附件通道（统一给路径：嗅探 + 截图落盘 + 缩略图读取） */
export const IPC_ATTACHMENT_SCAN = 'forge:attachment:scan';
export const IPC_CLIPBOARD_SAVE_IMAGE = 'forge:clipboard:saveImage';
export const IPC_CLIPBOARD_SAVE_TEXT = 'forge:clipboard:saveText';
export const IPC_FILE_READ_IMAGE = 'forge:file:readImage';
/** @ 补全候选：项目内白名单文件绝对路径列表（v3.30 输入框 @ 弹文件补全） */
export const IPC_FILE_LIST_PROJECT = 'forge:file:listProjectFiles';

/** 全部事件名（与 forge-core 各 Api events.emit 的 channel 一致） */
export type ForgeEvent =
  | 'project.opened'
  | 'project.removed'
  | 'git.branchChanged'
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
  | 'updater.stateChanged'
  // term（10）：pty 下行数据/退出（TD-TM-03，按 ptyId 广播）
  | 'term:data'
  | 'term:exit'
  // v3.76 启动门闩：forge-core 组装完成后由 main 手动 send 一次。
  // 注意：不进 FORGE_EVENTS 数组（那是 eventBus 转发注册表，core 未就绪时 eventBus
  // 不存在、注册不了）；渲染端通过 forge:boot-state 拉取兜底防错过。
  | 'boot.ready'
  // v3.87：splash 字标入场动效的**发令**。必须在 win.show() 之后再发——动画属于
  // 「用户看得见的那一刻」，而 splash 从 HTML 一解析就在跑（paintWhenInitiallyHidden
  // 默认 true），若从首帧起跑，约 1.2s 的逐字动画会在 decode + 2 帧 rAF + 显示前帧校验
  // （上限 700ms）走完之前就播完了，窗口亮起时只剩静态终态。
  // 同样不进 FORGE_EVENTS（主进程直发）；渲染端带超时兑底，不依赖本事件必达。
  | 'boot.splashShown'
  // 系统通知点击跳转（notifyToast.ts）：主进程直发（不经 core eventBus），
  // payload { sessionId }——渲染端收到后切换到该会话（App.vue onSelectSession）
  | 'notify.focusSession';

/** 全部事件名运行时数组（主进程遍历注册转发，避免遗漏事件） */
export const FORGE_EVENTS: readonly ForgeEvent[] = [
  'project.opened',
  'project.removed',
  'git.branchChanged',
  'session.statusChanged',
  'session.removed',
  'session.updated',
  'conversation.statusChanged',
  'conversation.delta',
  'conversation.message',
  'conversation.queueUpdated',
  'conversation.error',
  'conversation.compacting',
  'conversation.compacted',
  'conversation.slashCommandsUpdated',
  // Path 2：主进程不转发未登记事件（静默丢弃），漏登记 → 渲染进程收不到 → 面板永不出现
  'conversation.askUserQuestionRequested',
  'tool.started',
  'tool.completed',
  'tool.error',
  'model.providersChanged',
  'subagent.updated',
  'subagent.removed',
  'updater.stateChanged',
  // 主进程不转发未登记事件：term:data/term:exit 漏登记 → 渲染进程收不到 → 终端无输出
  'term:data',
  'term:exit',
];

/** 子 Agent 信息（API 06 §0 业务对象；与 forge-ui types.ts 的 Subagent 字段一致） */
export interface SubagentInfo {
  /** 扩展派生的子 agent 唯一 ID（幂等合并键） */
  agentId: string;
  /** agent 类型（如 general-purpose / Explore） */
  agentType: string;
  /** 描述（Tab 显示名，截断由前端处理） */
  description: string;
  /** 状态机：queued → running → completed / failed / stopped；终态不可逆 */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  /** 开始时间（ISO 8601） */
  startedAt: string;
  /** 结束时间（终态才有，否则 null） */
  finishedAt: string | null;
  /** 结果全文（completed 才有；failed 时为 null，错误信息走 error 字段） */
  result: string | null;
  /** 失败/终止原因（终态非 completed 时有值） */
  error: string | null;
  /** Token 用量（lifetime 累计；无产出时缺省） */
  usage?: { inputTokens: number; outputTokens: number };
}

/** subagent/queryList 请求参数 */
export interface SubagentQueryListParams {
  sessionId: string;
}

/** subagent/stop 请求参数 */
export interface SubagentStopParams {
  sessionId: string;
  agentId: string;
}

/** subagent/clearFinished 请求参数 */
export interface SubagentClearFinishedParams {
  sessionId: string;
}

/** subagent/queryOutput 请求参数（wu-06 v1.1 实时过程查看） */
export interface SubagentQueryOutputParams {
  sessionId: string;
  agentId: string;
  /** 单次读取尾部字节上限（默认/上限 64KB） */
  maxBytes?: number;
}

/** subagent/queryOutput 响应 data（扩展任务输出文件只读 tail） */
export interface SubagentQueryOutputResult {
  /** 输出文件是否存在（false = 无过程记录） */
  exists: boolean;
  /** 文件总字节数（exists 时有效） */
  size: number;
  /** 尾部内容（UTF-8，多字节边界安全截断） */
  chunk: string;
}

/** subagent/queryList 响应 data（运行中在前，终态按 finishedAt 倒序；无子 agent 时空数组） */
export interface SubagentQueryListResult {
  subagents: SubagentInfo[];
}

/** subagent/clearFinished 响应 data（被移除的终态子 agent ID 列表） */
export interface SubagentClearFinishedResult {
  removed: string[];
}

/** subagent.updated 事件 payload（携带完整记录，前端按 agentId 幂等 upsert） */
export interface SubagentUpdatedPayload {
  sessionId: string;
  subagent: SubagentInfo;
}

/** subagent.removed 事件 payload（清除已完成后被移除的子 agent ID 列表） */
export interface SubagentRemovedPayload {
  sessionId: string;
  agentIds: string[];
}

/**
 * Skill 管理（09）契约类型（事实来源在 ./pi/skillService.ts；type-only 再导出，
 * 不会把 pi SDK 拉进 preload 运行时 bundle）。forge-ui 按仓库惯例在 types.ts 独立
 * 声明同形类型。4090 = 同名冲突待确认（data.conflictPath，UI 弹确认后带
 * overwrite=true 重调）。
 */
export type { SkillScope, SkillEntry, SkillIssue, ListSkillsResult } from './pi/skillService.ts';

/**
 * 内嵌终端（10）契约类型（事实来源在 ./term/ptyService.ts；type-only 再导出，
 * 不会把 node-pty/@forge/core 拉进 preload 运行时 bundle）。forge-ui 按仓库惯例
 * 在 bridge.ts 独立声明同形类型。
 */
export type { TermCreateResult, TermDataPayload, TermExitPayload } from './term/ptyService.ts';

/** pi/getInfo 响应 data（设置页「关于」Tab；组件明细不回传 UI——走结构化日志与 updater-state.json） */
export interface PiGetInfoResult {
  /** forge 产品版本（app.getVersion()） */
  forgeVersion: string;
}

/** pi/updatePlugins 响应 data（更新器输出尾部，失败时 UI 展示排查信息） */
export interface PiUpdatePluginsResult {
  output: string;
}

/** 自更新状态机（07 IN-S03）：idle → checking → found → downloading → downloaded → installing；失败回 idle */
export type UpdaterStatus = AppUpdaterSnapshot['status'];

/** updater/getState 响应 data（自更新状态快照，docs/api/07_pi.md §3.1） */
export type UpdaterSnapshot = AppUpdaterSnapshot;

/**
 * updater.stateChanged 事件 payload（docs/api/07_pi.md §4）。
 * 与 getState.data 同构（全局单例状态，无 sessionId）；任意跃迁都发（含下载进度步进）。
 */
export type UpdaterStateChangedPayload = AppUpdaterSnapshot;

/**
 * conversation.compacted 事件 payload（P3-A）：一次上下文压缩完成。
 * 手动压缩与运行时自动压缩都会发射；UI 收到后应重拉会话历史并提示用户。
 */
export type { ConversationCompactedPayload };

/**
 * ask_user_question（Path 2）跨进程类型再导出。
 * 事实来源在 `@forge/core`（与扩展侧 `channels.ts` / `schema.ts` 同构）；
 * forge-ui 不依赖本包，按仓库惯例在 `bridge.ts` 独立声明同形类型。
 */
export type {
  AskUserQuestionRequestPayload,
  AskUserQuestionReplyParams,
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
};

/**
 * window.forge.askUserQuestion：问卷双向通道（Path 2，契约 §4.2）。
 *
 * 为何单独开一条而不复用 `window.forge.on`：问卷是**请求-应答**语义（有 requestId
 * 需要回填），与其余单向广播事件性质不同；语义化命名让消费方不易漏掉回填步骤。
 * 底层仍走同一套 IPC（事件 + invoke），不新增物理通道。
 */
export interface ForgeAskUserQuestion {
  /**
   * 订阅问卷请求（等价 `window.forge.on('conversation.askUserQuestionRequested')`，
   * 仅收窄 payload 类型）。返回取消订阅函数。
   * 多窗格场景下每个窗格各自订阅并**按 sessionId 认领**（契约 §4.4）。
   */
  onRequest(listener: (payload: AskUserQuestionRequestPayload) => void): () => void;
  /**
   * 回填作答。必须携带 `sessionId + requestId`，主进程按二者匹配等待中的请求；
   * `cancelled=true` 时 `answers` 仍应带已答部分（超时/取消保留已答，契约 §2.1）。
   */
  reply(params: AskUserQuestionReplyParams): Promise<ForgeResult<{ delivered: boolean }>>;
}

/** IPC 主通道：渲染进程发起方法调用 */
export const IPC_INVOKE = 'forge:invoke';

/** IPC 主通道：主进程向渲染进程推送事件 */
export const IPC_EVENT = 'forge:event';

/**
 * window.forge 全局（preload 注入）。
 * UI 侧通过 `window.forge` 调用方法并订阅事件。
 */
export interface ForgeBridge {
  /**
   * 调用方法层：params 直接透传给 forge-core 对应 handler，
   * 返回统一信封 `{ code, message, data }`（code=0 成功）。
   */
  invoke(method: ForgeMethod, params?: Record<string, unknown>): Promise<ForgeResult>;
  /**
   * 订阅引擎事件。返回取消订阅函数。
   * 事件 payload 结构 = 各 Api events.emit(channel, …) 的载荷：
   * - project.opened/removed: { path }
   * - git.branchChanged: { path, branch }
   * - session.statusChanged: { sessionId, status }
   * - session.removed: { sessionId }
   * - conversation.statusChanged: { sessionId, status }
   * - conversation.delta: { sessionId, delta }
   * - conversation.message: { sessionId, message }
   * - conversation.error: { sessionId, code, message }
   * - conversation.compacted: ConversationCompactedPayload（{ sessionId, reason, tokensBefore, tokensAfter, summary }）
   * - tool.started: ToolDescriptor / tool.completed: ToolResult / tool.error: ToolErrorInfo
   * - model.providersChanged: { providers }
   * - subagent.updated: SubagentUpdatedPayload（{ sessionId, subagent } 完整记录）
   * - subagent.removed: SubagentRemovedPayload（{ sessionId, agentIds }）
   */
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void;
  /** ask_user_question（Path 2）双向通道：订阅问卷请求 + 回填作答 */
  askUserQuestion: ForgeAskUserQuestion;
  /** 原生对话框（目录选择等） */
  dialog: ForgeDialog;
}

/**
 * window.forge.dialog 原生对话框能力
 */
export interface ForgeDialog {
  /**
   * 打开系统目录选择框。
   * @returns 用户选中的目录绝对路径；取消/失败返回 null。
   */
  selectDirectory(): Promise<string | null>;
  /**
   * 打开系统文件选择框（多选，图片 + 文本过滤，附件）。
   * @returns 选中文件的绝对路径数组（不读内容，模型自行 read）；取消返回空数组。
   */
  selectFiles(): Promise<string[]>;
}

/** window.forge.file：附件统一给路径能力 */
export interface ForgeFile {
  /** 解析拖拽/粘贴的 File 对象对应磁盘绝对路径（剪贴板截图等无盘文件返回空串） */
  getPathForFile(file: File): string;
  /** 附件密钥嗅探：文本文件命中凭据特征 → flagged=true，发送前需用户确认 */
  scanAttachments(paths: string[]): Promise<Array<{ path: string; name: string; flagged: boolean }>>;
  /** 粘贴截图落盘：base64 图片写入系统临时目录，返回真实路径；失败返回 null */
  savePasteImage(base64Data: string, ext?: string): Promise<{ path: string; name: string } | null>;
  /** 超长粘贴文本落盘：纯文本写入系统临时目录 txt，返回真实路径；失败返回 null */
  savePastedText(text: string): Promise<{ path: string; name: string } | null>;
  /** 磁盘图片读为 data URL（仅输入框缩略图/预览用）；缺失/超大/非图片返回 null */
  readImage(path: string): Promise<string | null>;
}

/** IPC invoke 的返回信封（透传 forge-core RpcResult） */
export interface ForgeResult<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}