# 内嵌终端 PRD

> 状态：PRD 已确认（2026-09-23 demo 验收通过，用户「按照这个demo对齐」；开工指令待下达）
> 交互原型：`prototypes/terminal-git-prototype.html`（终端面板 + Git 弹窗共用一个 demo，Git 部分见 prd/11）

## 1. 场景意图

### 1.1 业务背景与目标

forge 目前没有任何终端能力：agent 的 bash 工具由 pi SDK 在主进程内非交互执行（无 pty），用户想手工跑 `npm run dev`、构建、调试命令必须离开 forge 开外部终端，验证 agent 产出时来回切换。

本模块目标：在窗口底部提供一个**完整交互式内嵌终端面板**（xterm.js + node-pty），多 tab、跨项目共享、可拖高度，让用户在 forge 内完成"改完即跑"的闭环。

### 1.2 场景清单

| 场景 ID | 场景 | 业务价值 | 必须达成 | 明确不做 |
|---|---|---|---|---|
| TM-S01 | 面板开关与调高 | 不离开主界面即可用终端 | 工具栏右侧图标按钮（纯图标+外框，demo 已定）开/关底部面板；`Ctrl+\`` 同效；面板顶边可拖高度（上限/下限见 F01）；开关有过渡动画 | 不做右侧竖置面板、不做独立终端窗口、不做全屏模式 |
| TM-S02 | 多标签管理 | 并行跑多个命令互不干扰 | 点 ＋ 新建 tab，**cwd 自动取当前会话所属项目根**（用户 2026-09-23 定的"自动"口径）；tab 显示项目名；点 ✕ 关闭并销毁对应 pty；切项目不影响已开 tab | 不做 tab 右键菜单/重命名/拖拽排序（本期）；不做"按项目分组 tab" |
| TM-S03 | 交互式 shell | 真终端体验 | 完整 pty 交互：ANSI 色彩、vim/top 等 TUI、Ctrl+C 中断、窗口 resize 同步列数行数 | 不做管道式伪终端（无 TUI 能力方案已否） |
| TM-S04 | 进程生命周期 | 心智简单、无泄漏 | 收起面板 pty 保活（回来还在）；关闭 tab 即 kill；窗口关闭全部回收；崩溃的 pty 在 tab 内提示退出码 | 不与 agent 的 bash 执行共享进程/会话（两套独立，用户已拍板） |
| TM-S05 | 状态记忆 | 不重复摆弄布局 | 面板开/关状态与高度持久化（localStorage，usePreferences 模式）；shell 类型默认系统默认 | 不持久化 tab 列表与终端内容（重启后新终端） |

### 1.3 边界与权限

- **不可接受方案**：fork/修改 pi SDK 的命令执行链路来"共享"终端；用 webview 内嵌外部终端应用。
- **必须满足条件**：pty 只在主进程 spawn（渲染进程零文件系统/进程权限）；数据通道过 ipc-contract + bridge 双白名单；spawn 的进程固定为系统 shell（`process.env.COMSPEC`/`SHELL`），不接受渲染层传入任意可执行路径；cwd 必须是已存在目录且来自主进程已知的项目路径。
- **角色与权限边界**：单用户本地应用；终端权限即用户本机权限，forge 不做额外沙箱（与外部终端一致）。

### 1.4 已确认业务决策

| 决策 | 内容 | 来源 |
|---|---|---|
| D1 | 面板位置=底部展开（方案 A），非覆盖层；挂载点 `.content` 内、`.session-stage` 之后兄弟节点 | 本 PRD 提议 + demo 验收通过 |
| D2 | 生命周期=窗口级一个面板 + 用户手动管 tab；新 tab cwd 自动跟随当前会话项目，已开 tab 不随项目切换变化（"自动+手动"混合口径） | 用户 2026-09-23 拍板 |
| D3 | 完整交互终端（xterm.js + node-pty），非管道简化版 | 用户 2026-09-23 拍板 |
| D4 | 用户终端与 agent bash 执行两套独立，互不共享进程 | 本 PRD 提议，采纳无异议 |
| D5 | 入口=工具栏右侧纯图标外框按钮 + `Ctrl+\``；tab 与面板连体视觉（活动 tab 底边压住面板顶边框） | demo 验收通过（2026-09-23 两轮调整后定稿） |

## 2. 关键技术决策

| 决策 ID | 影响场景 | 关键理由 | 备选方案 | 推荐方案 | 确认结果 |
|---|---|---|---|---|---|
| TD-TM-01 | TM-S03 | pty 是唯一硬依赖，node-pty 为原生模块：Electron ABI 重编译 + Windows ConPTY + 依赖安装 allowScripts 白名单需放行 install 脚本 | A: node-pty（官方，需 rebuild）；B: @lydell/node-pty（预编译产物 fork，免 compile，社区 Electron 终端广泛使用）；C: child_process 管道（无 TUI，已被 D3 否） | B（A 失败回退），**前置 spike：先验证安装+rebuild+Electron 内 spawn 成功，再进入面板开发** | 已确认（spike 列为开发第一步） |
| TD-TM-02 | TM-S03 | 前端渲染 | A: @xterm/xterm + @xterm/addon-fit（事实标准）；B: 自绘（无意义） | A | 已确认（采纳推荐，无异议） |
| TD-TM-03 | TM-S03/S04 | 终端数据是高频双向流，现有 RPC 是请求-响应+事件单向。方案：主进程按 ptyId 广播 `term:data`/`term:exit` 事件（沿用 forge.on 通道），渲染层输入走 `term/write` invoke（或专用 ipc channel）；resize 走 invoke | A: 事件下行 + invoke 上行（复用现有 on/invoke 基建，双白名单改动小）；B: 独立 ipcMain.on 裸通道（少一层封装但破坏现有契约治理） | A | 已确认（采纳推荐，无异议） |
| TD-TM-04 | TM-S01/S05 | 面板与高度持久化 | A: usePreferences localStorage 模式（现 showDiff 同款）；B: 后端配置 | A | 已确认 |
| TD-TM-05 | TM-S02 | 默认 shell 选择 | A: 系统默认（Win: COMSPEC 即 pwsh/cmd；Unix: $SHELL），不做选择 UI；B: 设置页可选 shell | A（本期），B 记入待办 | 已确认 |

### 已采用的常规默认项

- 面板默认高度 240px，拖拽范围 120–520px（demo 值，开发期按真实字体微调）。
- 无 tab 时面板保留空态（"点 ＋ 新建"），不自动收起——收起/展开只由用户控制。
- 终端 scrollback 上限 1000 行（xterm 默认级），不做搜索、不做链接识别（记入待办）。
- 主题：xterm 前景/背景/边框色从 design-tokens 取值映射，深浅主题切换即时生效。
- pty 退出：tab 内显示 `[进程已退出 code=N]`，tab 保留至用户手动关闭（可回看尾部输出）。
- 主进程英文日志：pty spawn/exit/kill（含 ptyId、cwd、shell），沿用可观测性纪律。

## 3. 详细设计

### 3.1 模块概述与边界

- 业务目标：窗口底部多 tab 交互式终端。
- 核心职责：pty 生命周期（主进程）、数据流桥接（IPC）、终端渲染（xterm）、面板 UI（开/关/拖高/tab）。
- 核心业务对象：TermSession = ptyId + projectId(cwd 来源) + shell + 状态(alive/exited)；PanelState = open + height。
- 涉及角色：单用户本地应用。
- 前置条件：TD-TM-01 spike 通过（node-pty 系原生模块在本项目 Electron 版本可安装、可 rebuild、可 spawn）。
- 上下游与职责边界：上游=App.vue 工具栏与面板容器；下游=操作系统 shell（forge 只是宿主）；与模块 04 工具执行零交集（agent bash 不经过本模块）；与模块 11 Git 弹窗零依赖。

### 3.2 核心流程与状态

```
开面板：点工具栏图标 / Ctrl+` → 面板 height 过渡展开 → 若无 tab：自动 newTab(当前会话项目根)
新建 tab：UI invoke term/create {cwd}
  → 主进程校验 cwd（存在 + 来自主进程项目路径）→ pty.spawn(shell, [], {cwd, cols, rows})
  → 返回 ptyId → UI 建 xterm 实例挂载 → 双向流开始
输入：xterm onData → invoke term/write {ptyId, data} → pty.write
输出：pty.onData → 事件 term:data {ptyId, data} → 仅活动 tab 渲染？否——所有 tab 各自持有 xterm
      （后台 tab 也收数据写入自身 buffer，切回即最新；xterm 实例保活隐藏）
resize：面板/窗口尺寸变化 → addon.fit → invoke term/resize {ptyId, cols, rows}
关闭 tab：invoke term/kill {ptyId} → pty.kill → 主进程移除
退出：pty.onExit → 事件 term:exit → tab 标记退出态
窗口关闭：主进程 before-quit 遍历 kill 全部 pty
```

### 3.3 功能点

#### 功能点：TM-F01 底部面板容器

- 目标：可开关、可拖高、状态记忆的面板壳。
- 前置条件：App.vue `.content` 布局。
- 业务规则：开关按钮在 `.app-toolbar` 右侧（纯图标+1px 外框，激活态描边变 brand 色，demo 定稿样式）；`Ctrl+\`` 全局快捷键（输入框聚焦时同样生效，与 VSCode 一致）；拖高 grip 在面板顶边（hover 有品牌色提示条）；高度范围 120–520px；开/关与高度写 localStorage，重启恢复。
- 交互与反馈：展开/收起 200ms 过渡（--transition-base）；恢复时直接以记忆高度展开。
- 异常与边界：恢复的高度超当前窗口高度 → clamp 到上限。
- 跨模块影响：会话区被压缩属预期，不改 ConversationView 内部。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-10-01 | 按钮与 Ctrl+` 均能开/关，动画平滑，会话区同步压缩 | e2e+人工 | TM-S01 | 主流程 | 输入框聚焦时快捷键不吞输入 |
| AC-10-02 | 拖高在上下限内生效，松手后状态持久，重启恢复 | 单元+人工 | TM-S05 | 记忆 | 极小窗口 clamp |

#### 功能点：TM-F02 tab 管理

- 目标：多终端并存，cwd 自动跟随。
- 前置条件：F01。
- 业务规则：＋ 新建（cwd=当前会话项目根；无当前项目 → 按钮禁用+tooltip）；tab 标题=项目名，前缀终端图标；活动 tab 与面板连体（demo 定稿：tab 底边压面板顶边框、左上角直角）；✕ 关闭即 kill；多 tab 各自持有存活 xterm 实例（display 切换，不销毁）。
- 交互与反馈：切 tab 即时呈现该终端最新输出与滚动位置。
- 异常与边界：同项目多 tab 并存允许；tab 数不设硬上限（pty 是系统资源，超 20 个提示一次即可，开发期实现）。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-10-03 | 切项目后点 ＋，新 tab 的 pwd 为新项目根；旧 tab pwd 不变 | 人工 | TM-S02 | 自动 cwd | 核心口径，demo 已对齐 |
| AC-10-04 | 后台 tab 持续接收输出，切回无断流 | 人工 | TM-S02 | 数据完整 | 后台跑长输出命令 |

#### 功能点：TM-F03 pty 服务（主进程）

- 目标：安全的 shell 宿主。
- 前置条件：TD-TM-01 spike 通过。
- 业务规则：spawn 目标固定为系统 shell（Windows `$COMSPEC`，Unix `$SHELL` 回退 bash）；cwd 校验：目录存在 + 等于某已知项目根（主进程侧数据，不信任渲染层任意路径）；每 pty 记录 ptyId/shell/cwd；kill 幂等（已退出不报错）。
- 异常与边界：spawn 失败（shell 不存在/权限）→ 返回错误码，UI 在 tab 内显示原因；pty 意外退出 → term:exit 事件带退出码。
- 数据一致性与幂等：before-quit 全量回收；渲染层 reload（开发期 HMR）后孤儿 pty 按 ptyId 对账清理（UI 不再引用的 id 一律 kill）。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-10-05 | vim/top 可进入并正常退出；Ctrl+C 中断生效 | 人工 | TM-S03 | TUI 完整 | Windows ConPTY |
| AC-10-06 | 伪造非项目根 cwd 调 term/create 被主进程拒绝 | 单元 | TM-S04 | 安全 | 路径穿越/不存在目录 |
| AC-10-07 | 关闭 forge 后系统无残留 shell 进程 | 人工 | TM-S04 | 泄漏 | 任务管理器核对 |

#### 功能点：TM-F04 数据流 IPC

- 目标：双向低延迟。
- 业务规则：按 TD-TM-03：下行事件 `term:data`/`term:exit`（含 ptyId），上行 invoke `term/create|write|kill|resize`；ipc-contract 与 bridge 双白名单同步登记；write 不分片（xterm onData 单条已小），data 事件渲染侧直接 term.write 不做二次转义。
- 异常与边界：向已退出 pty write → 静默丢弃（返回 0 数据）；事件风暴（`cat 大文件`）→ 依赖 xterm 自身吞吐，不预设节流，实测卡则加 16ms 批量合并（记入开发期验证项）。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-10-08 | `npm run dev` 级输出量滚动不阻塞输入 | 人工 | TM-S03 | 性能 | 极端：`cat` 10MB 文件 |

### 3.4 页面承载

- 页面路径与访问权限：主窗口 `.content` 底部，所有项目可用；无设置页开关（功能常驻，本期不做禁用开关）。
- 页面结构：`.app-toolbar` 右侧图标按钮 → 面板（grip / tab 条[tab… ＋ …右侧留白] / 终端区）；demo `terminal-git-prototype.html` 即视觉与交互事实来源。
- 操作入口、按钮和链接：工具栏图标、Ctrl+\`、＋、✕。
- 表单字段与业务校验：无表单。
- 弹窗、loading、成功/失败反馈：pty 创建中 tab 显示"连接中…"（本地 spawn 通常 <100ms，仅防御性状态）。
- 失败时的上下文和数据保留：spawn 失败 tab 内保留错误文本至关闭。

### 3.5 非功能要求

- 性能与容量：单 pty 内存由系统 shell 决定；xterm scrollback 1000 行；tab 数软提示阈值 20。
- 安全与审计：spawn 参数主进程硬编码（shell 路径+cwd+cols/rows），渲染层无任何路径注入面；cwd containment 见 AC-10-06。
- 可用性与降级：node-pty 不可用（spike 失败且无回退）→ 本模块整体不交付，不留半成品入口；HMR/崩溃后孤儿 pty 对账清理。
- 可观测性：pty 生命周期英文日志（spawn/exit/kill + id/cwd/shell）。
- 兼容性：Windows 主平台（ConPTY）；macOS/Linux 理论兼容不验收。i18n：面板所有文案走词条（terminal.ts 新域，中英双语，注意字宽敏感控件按模块 08 经验双查）。

## 4. 自检报告

| 来源 | 来源要求 | 第 3 节承接位置 | AC ID | 结果 | 说明 |
|---|---|---|---|---|---|
| D1/D5（demo 定稿） | 底部面板+图标外框入口+连体 tab | F01/F02、§3.4 | AC-10-01 | PASS | demo 视觉为事实来源 |
| D2（用户拍板） | 自动 cwd + tab 手动管理 + 切项目不动旧 tab | F02 | AC-10-03/04 | PASS | — |
| D3（用户拍板） | 完整交互终端 | F03/F04 | AC-10-05 | PASS | 依赖 spike |
| §1.3 边界 | 渲染层零路径注入 | F03 | AC-10-06 | PASS | containment 主进程强制 |
| 风险：node-pty 原生模块安装 | allowScripts 白名单 + Electron ABI | TD-TM-01 | — | **已消除** | 2026-09-23 spike 通过：@lydell/node-pty@1.2.0-beta.15 npmmirror 安装零 install 脚本拦截，Electron 40 主进程 spawn cmd.exe 读写验证 PASS（N-API prebuilds，免 rebuild）。遗留：打包期 electron-builder 对 prebuilds .node 的 asarUnpack 配置开发期实测 |
| 风险：输出风暴性能 | 大输出卡顿 | F04 | AC-10-08 | WARN | 预留 16ms 批量合并方案 |
