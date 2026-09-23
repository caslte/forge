# Git 提交与推送 PRD

> 状态：代码交付（2026-09-23「开工」当日完成：后端 4 RPC+单测、前端弹窗双入口+mock 链路浏览器验收；**Electron 真机验收待确认**——契约见 docs/api/11_git_commit_push.md）
> 交互原型：`prototypes/terminal-git-prototype.html`（弹窗部分；终端见 prd/10）
> 承接：模块 01 扩展 PM-S05（gitService/gitMethods/BranchBadge 底座）

## 1. 场景意图

### 1.1 业务背景与目标

forge 的 git 能力目前止于**分支查看与切换**（`gitService.ts` 的 getBranchInfo/switchBranch + BranchBadge 浮窗）。agent 完成一轮修改后，用户提交/推送必须离开 forge 用外部工具，"改完即提交"断链。

本模块目标：提供**提交或推送弹窗**——全量语义（提交工作区变更，不做"仅本会话"）、staged 勾选控制、AI 一键生成提交说明（单次 API 调用，复用现有 provider 配置）、push 失败 stderr 透传回显。

### 1.2 场景清单

| 场景 ID | 场景 | 业务价值 | 必须达成 | 明确不做 |
|---|---|---|---|---|
| GC-S01 | 弹窗入口 | 就近触达 | 两个等价入口（demo 定稿）：① 输入框状态行分支徽章右侧「⊙ 提交或推送」；② 分支徽章向上浮窗内分隔线下的「提交或推送…」菜单项。非 git 项目两处均不渲染（与 BranchBadge 现有 isGitRepo 语义一致） | 变更文件卡片（ChangedFilesCard）不加提交按钮——用户 2026-09-23 明确砍掉 |
| GC-S02 | 提交或推送弹窗 | 完成提交闭环 | 弹窗结构（demo 定稿，ExitConfirmDialog 视觉模式）：标题+关闭 → 副标题「提交 <项目> 中的变更。」→ 当前分支展示条 → 提交说明 textarea → 「AI 生成」ghost 按钮（无边框黑字）→ footer：左「☑ 包含未暂存变更」勾选（默认勾上），右 推送 / 提交并推送 / 提交（黑色主按钮） | 不做变更文件清单、不做 +/- 统计展示（用户 2026-09-23 明确砍掉）；弹窗内不切分支（切分支仍归 BranchBadge）；不做 pull/fetch/新建分支/冲突处理 |
| GC-S03 | 提交执行 | 可靠落库 | 勾选=先 `git add -A` 再 commit；不勾=只 commit 已暂存内容，**暂存区为空时提交/提交并推送按钮禁用并提示**；成功后 toast 含 commit 短哈希与文件数，弹窗关闭 | 不做 patch 级部分暂存（文件级 add -A 语义，用户手动 stage 的内容与全量合并提交） |
| GC-S04 | 推送执行 | 一键出网 | 推送当前分支到 origin（`git push`，无 upstream 时 `-u origin <branch>`）；失败时**弹窗不关**，git 原始 stderr 展示在弹窗内错误区（参照 BranchBadge 6001 模式） | 不做 force push、不做远程选择、不代输凭据（凭据走用户 git 全局配置/管理器） |
| GC-S05 | AI 生成提交说明 | 免手写 | 点「AI 生成」→ 主进程单次 OpenAI 兼容 `chat/completions` 调用（当前会话模型所在 provider）→ 填入 textarea（可手改、可重新生成）；生成中按钮转圈禁用 | 不起 agent 会话（用户已确认口径）；不做"留空自动提交时生成"（显式按钮触发）；不做仓库历史风格学习（第一版语言跟随 app locale，记待办） |
| GC-S06 | 并发保护 | 防提交半成品 | 项目 busy（任一会话 streaming）时入口禁用（复用 BranchBadge 的 busy prop 与 AC-PM-016 同款语义，tooltip「会话进行中」）；弹窗打开后 agent 开始跑 → 提交按钮不额外禁用（git 原子性由 CLI 保证），但 toast 如实反映结果 | 不做提交前 diff 预览、不做 pre-commit hook 定制 |

### 1.3 边界与权限

- **不可接受方案**：引入 simple-git/isomorphic-git 等库（现有 execFile 调 git CLI 模式已验证，保持一致）；在 forge 存储任何 git 远端凭据；实现"仅提交本会话变更"（需后端变更账本+文件粒度歧义，用户 2026-09-23 拍板砍掉）。
- **必须满足条件**：全部 git 操作在主进程 execFile（cwd=项目根，超时保护沿用 gitService 现值）；AI 调用的 apiKey 经既有 safeStorage/keychain 解密路径获取，不回显不落日志；提交身份完全交给用户 git config（未配置时透传 git 报错，forge 不代填）。
- **角色与权限边界**：单用户本地应用；操作目标=当前会话项目仓库工作区。

### 1.4 已确认业务决策

| 决策 | 内容 | 来源 |
|---|---|---|
| D1 | **全量语义**：提交工作区变更，无"本次/全部"区分（用户问"简单点吗"后拍板砍掉会话级提交） | 用户 2026-09-23 |
| D2 | 「包含未暂存变更」勾选（参照用户截图）：勾=add -A + commit；不勾=仅暂存区；不勾且暂存空→禁用+提示 | 用户 2026-09-23 提供参照图；禁用兜底为本 PRD 提议，采纳无异议 |
| D3 | AI 生成=一次 `chat/completions` API 调用，复用 pi models.json provider，非 agent | 用户 2026-09-23 确认「就是 api 的一次 ai 调用」 |
| D4 | 弹窗视觉=ExitConfirmDialog 模式（overlay blur + radius-3xl + 黑色主按钮）；入口收敛为状态行+分支浮窗两处 | demo 验收通过 |
| D5 | 弹窗内不放文件清单与 diff 统计 | 用户 2026-09-23 demo 反馈 |

## 2. 关键技术决策

| 决策 ID | 影响场景 | 关键理由 | 备选方案 | 推荐方案 | 确认结果 |
|---|---|---|---|---|---|
| TD-GC-01 | GC-S02~S04 | git 操作实现层 | A: 扩展 `gitService.ts`（execFile git CLI，与 getBranchInfo 同款错误码/超时/日志模式）+ `gitMethods.ts` 注册 RPC + ipc-contract/bridge 双白名单；B: simple-git 库（多依赖少收益） | A。新增方法：`git/getStatus`（porcelain v1 + numstat，返回文件数与增删总数，供按钮态与 toast 用）、`git/commit {path, message, includeUnstaged}`、`git/push {path}` | 已确认（采纳推荐，无异议） |
| TD-GC-02 | GC-S05 | AI 调用通道：provider 配置在 pi models.json（baseUrl/api/apiKey，apiKey 可能为 keychain 引用/safeStorage 加密），会话链路已有解密路径 | A: 主进程直接 fetch `{baseUrl}/chat/completions`（非流式，一次往返），复用既有 key 解密与模型选择（当前会话模型）；B: 起临时 pi 会话（重、污染历史、已否） | A | 已确认 |
| TD-GC-03 | GC-S05 | diff 上下文预算 | `git diff HEAD`（含暂存+工作区合并视图）截断：文件清单全量 + 每文件 diff 前 N 行 + 总字符上限约 30k；二进制/超大文件只列名；无 HEAD（空仓库）时用 `git diff --cached` | 截断策略如左 | 已确认（采纳推荐，无异议） |
| TD-GC-04 | GC-S04 | push 失败回显形态 | A: 弹窗内错误区展示 git 原始 stderr、弹窗不关（BranchBadge 6001 既有模式，用户已熟悉）；B: toast 一行（信息量不足） | A | 已确认 |
| TD-GC-05 | GC-S05 | 生成语言 | A: 跟随 app locale（zh 时提示词要求中文说明）；B: 学习仓库历史 commit 风格（prompt 多喂近 10 条历史，效果好但首版不做） | A，B 记待办 | 已确认 |

### 已采用的常规默认项

- 错误码沿用 git 域段位顺延（6001 已被切换占用；getStatus/commit/push/generateMessage 各自新码，开发期在 gitMethods.ts 现有注释表登记）。
- commit/push execFile 超时沿用 gitService 现值；AI 调用超时 30s，失败错误 toast「生成失败」+ 保留手动输入能力。
- 提交成功 toast：`已提交 <shortHash> · N 个文件`；提交并推送成功合并一条 toast。
- AI 生成结果只做首尾 trim，不二次加工；用户手改后「重新生成」覆盖需二次确认？否——直接覆盖（demo 行为，改动成本低、可再生成）。
- 弹窗打开时拉一次 getStatus；提交/推送过程中三按钮禁用防双击；副标题文件数即该查询结果。
- 全部新文案 i18n 词条（git 域，中英成对；字宽敏感控件按模块 08 经验双查）。

## 3. 详细设计

### 3.1 模块概述与边界

- 业务目标：forge 内完成 提交/推送 闭环 + AI 辅助写提交说明。
- 核心职责：git 写操作 RPC（status/commit/push）、提交弹窗 UI、单次 LLM 调用生成文案、busy 联动禁用。
- 核心业务对象：GitStatus = {fileCount, added, removed, stagedEmpty}；CommitResult = {shortHash, fileCount}；错误回显 = git stderr 原文。
- 涉及角色：单用户本地应用。
- 前置条件：模块 01 PM-S05 底座（gitService/gitMethods/BranchBadge）不变；无新依赖（纯 CLI + fetch）。
- 上下游与职责边界：上游=InstructionInput 状态行 + BranchBadge 浮窗（各加入口）；下游=git CLI 与用户已配 provider；与模块 10 终端零依赖；与 ChangedFilesCard 零改动（明确不加按钮）。

### 3.2 核心流程与状态

```
打开弹窗：点入口（busy 或 非git 时不可达）
  → invoke git/getStatus {path} → 副标题文件数 + 暂存空判定 → 渲染
AI 生成：点按钮 → 主进程 git diff HEAD（截断）→ 读当前会话模型 provider（解密 key）
  → fetch chat/completions（system: 生成简洁 conventional 提交说明，语言=app locale）
  → 成功填 textarea / 失败错误 toast（弹窗保持，可重试可手填）
提交：勾选? → [勾] git add -A → git commit -m <msg>
     → [不勾] 暂存空? 禁用 : git commit -m <msg>
     → 成功 toast + 关闭；失败（如无 user.name）弹窗内 stderr 区展示、不关
推送：git push（无 upstream → git push -u origin <branch>）
     → 成功 toast；失败弹窗内 stderr、不关
提交并推送：commit 成功后串 push；commit 失败即止
```

### 3.3 功能点

#### 功能点：GC-F01 git/getStatus RPC

- 目标：弹窗数据源 + 暂存空判定。
- 业务规则：`git status --porcelain=v1` + `--untracked-files=all` 统计文件数；`git diff HEAD --numstat`（无 HEAD 退 `--cached`）汇总 +/-；返回 `{fileCount, added, removed, stagedEmpty, branch}`；非 git 仓库/无 HEAD 空仓库如实标记。
- 异常与边界：命令失败透传 stderr 与错误码；仓库锁（index.lock）报错原样展示。
- 数据一致性与幂等：只读，无副作用。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-11-01 | 外部工具改了文件后开弹窗，文件数即时正确 | 单元+人工 | GC-S02 | 新鲜度 | 窗口 focus 重查沿用 AC-PM-023 模式 |
| AC-11-02 | 空仓库（无 commit）弹窗可用，diff 走 --cached 分支 | 单元 | GC-S05 | 边界 | — |

#### 功能点：GC-F02 提交弹窗 UI

- 目标：demo 定稿形态的承载组件 `GitCommitDialog.vue`。
- 业务规则：结构与视觉严格对齐 demo（overlay blur 10px、dialog radius-3xl、分支条 secondary 底、footer 左勾选右三按钮、AI 按钮无边框黑字、错误区 destructive 浅底）；Esc/点遮罩关闭（提交中不可关）；勾选状态不持久（每次打开默认勾上）。
- 交互与反馈：getStatus 加载中骨架；busy 竞态（弹窗开着会话开始跑）不强制关闭——按钮态按点击时实时结果。
- 异常与边界：项目切换后旧弹窗实例即关（入口本身随项目消失）。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-11-03 | 弹窗视觉与 demo 一致（深浅主题、中英文案双查） | 人工 | GC-S02 | 还原度 | 英文长文案不破布局 |
| AC-11-04 | 不勾且暂存空：提交/提交并推送禁用+提示，推送仍可用 | e2e | GC-S03 | 口径 | D2 核心行为 |

#### 功能点：GC-F03 commit RPC

- 目标：可靠提交。
- 业务规则：includeUnstaged=true → `git add -A` 后 `git commit -m`；false → 直接 commit（服务端二次校验暂存非空，空则拒绝，UI 禁用是第一道）；message 必填（空/纯空白拒绝，无默认兜底文案）；成功返回 shortHash+文件数。
- 异常与边界：git 报错（身份未配置、pre-commit hook 失败、index.lock）→ 错误码+stderr 透传，弹窗展示不关；hook 失败时已 add 不回退（如实提示"变更已暂存"）。
- 数据一致性与幂等：连点防护靠 UI 禁用；服务端无状态。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-11-05 | 勾选提交全量变更成功，外部 `git log` 可见，toast 含哈希 | 接口+人工 | GC-S03 | 主流程 | — |
| AC-11-06 | 身份未配置仓库：stderr 展示、弹窗不关、无假成功 | 接口 | GC-S03 | 失败路径 | 临时 HOME 环境 |
| AC-11-07 | 服务端拒绝空暂存 commit（绕过 UI 直调 RPC） | 单元 | GC-S03 | 安全 | — |

#### 功能点：GC-F04 push RPC

- 目标：一键推送+失败可读。
- 业务规则：`git push`；检测无 upstream（stderr/`rev-parse --abbrev-ref` 判定）→ `git push -u origin <当前分支>`；成功返回远端与分支名。
- 异常与边界：认证失败/non-fast-forward/无远端 → stderr 原文进弹窗错误区；超时（默认沿用 gitService 值，push 网络慢场景开发期实测放宽）。
- 跨模块影响：外部提交后分支状态变化由既有 `git.branchChanged`/focus 重查覆盖，无新增。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-11-08 | 正常推送成功 toast；远端可见新 commit | 人工 | GC-S04 | 主流程 | GitHub 私有仓凭据复用 |
| AC-11-09 | 落后远端时 stderr（rejected…fast-forward）完整展示，弹窗不关 | 接口 | GC-S04 | 失败回显 | 不自动 pull |

#### 功能点：GC-F05 AI 生成提交说明

- 目标：一次调用、可改可重试。
- 业务规则：`git/generateCommitMessage {path}` → 主进程组装 diff（TD-GC-03 截断）+ provider 解析（当前会话模型 → models.json 记录 → key 解密）→ 非流式 chat/completions → 返回纯文本；UI 填入 textarea。
- 交互与反馈：生成中按钮禁用+转圈；成功无 toast（文本即反馈）；失败错误 toast「生成失败：原因」，弹窗保持。
- 异常与边界：无 provider/无模型 → 按钮点击即报「未配置模型」不发请求；diff 为空 → 报「无变更可总结」；响应超长/多段 → 取首段非空文本；apiKey 绝不入日志。
- 性能：30s 超时；单次调用成本为百 token 级 diff，可忽略。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-11-10 | 真实变更生成中文（zh locale）conventional 风格说明，可手改后提交 | 人工 | GC-S05 | 主流程 | 端点为 OpenAI 兼容 |
| AC-11-11 | 断网/坏 key：错误 toast，textarea 与弹窗状态不受损 | 接口 | GC-S05 | 降级 | — |
| AC-11-12 | 大 diff（>30k 字符）截断后仍成功生成 | 单元 | GC-S05 | 容量 | 含二进制文件清单 |

#### 功能点：GC-F06 入口与 busy 联动

- 目标：入口稳定、竞态受控。
- 业务规则：状态行入口与浮窗入口共用同一打开函数；isGitRepo=false 两处均不渲染；busy=true 禁用（tooltip「会话进行中」，沿用 project.sessionBusy 词条）；浮窗内入口位于分隔线下（demo 定稿）。
- 跨模块影响：InstructionInput/BranchBadge 各加少量代码，不改其现有行为。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-11-13 | 会话 streaming 中两入口禁用，空闲恢复 | e2e | GC-S06 | 竞态 | 与 AC-PM-016 同语义 |
| AC-11-14 | 非 git 项目两入口消失 | e2e | GC-S01 | 降级 | — |

### 3.4 页面承载

- 页面路径与访问权限：主窗口会话视图（输入框状态行 + 分支浮窗）；弹窗覆盖整窗。
- 页面结构：`GitCommitDialog.vue`（新建组件，挂 App.vue 层或 InstructionInput 层，开发期按现有 Dialog 挂载惯例定——ExitConfirmDialog 挂 App.vue 根，本弹窗随项目上下文，建议同样根挂 + store 状态驱动）。
- 操作入口、按钮和链接：GC-S01 两入口；弹窗内 AI 生成/推送/提交并推送/提交/关闭。
- 表单字段与业务校验：message（必填，服务端二次校验）；勾选（布尔）。
- 弹窗、loading、成功/失败反馈：见 §3.2/各 F；错误区统一一处（复用 git-stderr 视觉）。
- 失败时的上下文和数据保留：任何失败 textarea 内容原样保留。

### 3.5 非功能要求

- 性能与容量：getStatus/commit/push 均百 ms 级（execFile）；AI 调用秒级异步不阻塞 UI。
- 安全与审计：apiKey 解密即用即弃、不入日志不外发（除目标 provider 端点）；git 参数数组化传 execFile，message 不经 shell 拼接（防注入）；无 force push 能力面。
- 可用性与降级：AI 失败不影响手动提交；push 失败不影响已完成的 commit。
- 可观测性：commit/push 主进程英文日志（项目、分支、结果、shortHash），不含 message 全文（可含前 60 字符）。
- 兼容性：Windows 主平台；git 版本要求与现有 gitService 一致（porcelain v1/numstat 均老特性）。i18n：git 域词条中英成对。

## 4. 自检报告

| 来源 | 来源要求 | 第 3 节承接位置 | AC ID | 结果 | 说明 |
|---|---|---|---|---|---|
| D1（用户拍板） | 全量语义，砍"本次/全部" | §1.3、F03 | AC-11-05 | PASS | 变更账本不进入本模块 |
| D2（用户拍板+参照图） | 包含未暂存变更勾选 | F02/F03 | AC-11-04/07 | PASS | 空暂存双保险（UI 禁用+服务端拒绝） |
| D3（用户确认） | 一次 API 调用非 agent | TD-GC-02、F05 | AC-11-10~12 | PASS | key 解密复用既有路径 |
| D4/D5（demo 定稿） | 弹窗结构/入口/无清单无统计 | F02/F06、§3.4 | AC-11-03/13/14 | PASS | ChangedFilesCard 零改动 |
| 风险：git 身份未配置 | 首提交即失败 | F03 异常 | AC-11-06 | WARN | stderr 透传即教育，不代填 |
| 风险：hook 失败后暂存态 | add -A 已生效易困惑 | F03 规则 | AC-11-06 | WARN | 错误区如实提示"变更已暂存" |
| 风险：push 超时误报 | 慢网络 | F04 异常 | AC-11-08 | WARN | 开发期实测放宽超时 |
