# 11 Git 提交与推送接口

> 模块：提交或推送弹窗后端（docs/prd/11_git_commit_push.md）。
> 实现位置：`getStatus/commit/push` 在 `packages/forge-core/src/git/gitService.ts`（RPC 壳 `rpc/gitMethods.ts`，PM-S05 git 底座顺延）；
> `generateCommitMessage` 在 `packages/forge-desktop/src/git/commitMessageService.ts`（需 provider 配置与密钥解密，组装在 `createForgeCore.ts`）。
> 状态：后端已实现（forge-core 单测：服务层 17 例 + RPC 层 7 例；forge-desktop 单测 9 例）。

## 0. 业务对象与口径

- **全量语义（D1）**：提交目标 = 仓库工作区变更（`git add -A` 文件级），无"仅本会话"账本。
- **写操作安全（PRD §3.5）**：message 经 execFile 参数数组传入，绝不拼接 shell；提交身份交给用户
  git config（未配置透传 git 报错，不代填）；无 force push 能力面；不存储任何远端凭据。
- **超时口径**：只读查询沿用 gitService 现值 5s；`add/commit/push/diff` 用放宽的 30s
  （pre-commit hook 与网络往返，PRD F04"开发期实测放宽"落地值）。
- **失败回显形态（TD-GC-04）**：6006/6007/6001 同款信封——`data.stderr` 附 git 原始输出，
  UI 弹窗内错误区展示、不关闭（BranchBadge 既有模式）。
- **apiKey 纪律**：解密即用即弃，绝不入日志、不进错误消息（provider 非 2xx 只记状态码，刻意不记响应体）。

## 1. git/getStatus

提交弹窗数据源 + 暂存空判定（GC-F01，只读幂等）。**参数**：`{ "path": "D:/work/xxx" }`（须已注册项目，否则 1002）。

成功响应 `data`：

```json
{
  "isGitRepo": true,
  "branch": "main",
  "detached": false,
  "fileCount": 3,
  "added": 44,
  "removed": 11,
  "stagedEmpty": false,
  "stagedCount": 2,
  "unpushedCount": 5,
  "hasHead": true,
  "files": [
    { "path": "src/a.ts", "status": "M", "staged": false, "added": 12, "removed": 3 },
    { "path": "src/b.vue", "status": "?", "staged": false, "added": 46, "removed": 0 }
  ]
}
```

| 字段 | 口径 |
|---|---|
| fileCount | `status --porcelain=v1 --untracked-files=all` 行数（含未跟踪；重命名计 1） |
| added/removed | `diff HEAD --numstat` 汇总（无 HEAD 退 `--cached`）；二进制行 `-\t-` 不计；未跟踪文件不进 numstat |
| files[] | **模块 12（2026-10-03 追加）**逐文件状态与行数。`path`/`status`/`staged` 为原有字段；`added`/`removed` 为**本次新增的纯字段**：跟踪文件取 `--numstat` 逐行拆分，未跟踪文件由服务层读文件数行（git 对未跟踪文件不报行数），二进制一律 0。⚠ **口径与上一行的汇总不同**：`files[].added` **含未跟踪文件**，而 `added/removed` **不含**。所以「files 逐项之和 == 汇总」是**错的**，正确关系是「非未跟踪项之和 == 汇总」；界面要「这次一共改了多少行」应自行汇总 `files[]` |
| stagedEmpty | porcelain X 列全为空格或 `?`（D2 勾选不勾时提交/禁用判据，UI 禁用+服务端拒绝双保险） |
| stagedCount | porcelain X 列非空格非 `?` 的行数（不勾「包含未暂存」时的待提交文件数，弹窗计数用） |
| unpushedCount | 未推送提交涉及的文件数，三级判据：有 upstream 比 `upstream...HEAD`；无 upstream 比 `origin/<分支>...HEAD`；分支从未推送则数 `HEAD --not --remotes`（本地有、任何远端分支没有的提交，显式 HEAD 防零远端引用时输出为空）。仅无远端 / detached / 无 HEAD → `null`（UI 不显示） |
| hasHead | 空仓库（无 commit）= false；弹窗仍可用，diff 基线自动退 `--cached`（AC-11-02） |
| branch/detached | 与 getBranchInfo 五态口径一致：detached 时 branch=短 SHA |
| 非 git 目录 | `isGitRepo:false` 全空值（不报错，与 §10 既有语义一致） |

## 2. git/getFileDiff

单文件 unified diff（模块 12 代码查看器「并排 diff」的数据源，2026-10-03 追加，只读幂等）。
实现位置与 getStatus 同在 `gitService.ts` / `rpc/gitMethods.ts`。

**参数**：`{ "path": "D:/work/xxx", "relPath": "src/a.ts" }`（path 须已注册项目；relPath 为相对仓库根的 POSIX 路径）。

成功响应 `data`：

```json
{ "diff": "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.txt\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n hello\n+world\n" }
```

| 取值 | 口径 |
|---|---|
| 非空文本 | 相对基线的 unified diff。基线与 getStatus 的 numstat 同口径：有 HEAD 比 `diff HEAD`，无 HEAD 空仓库比 `diff --cached`。二进制变更原样返回 git 的 `Binary files … differ` 提示行（解析层识别，不在服务层特判） |
| `""`（空串） | 跟踪文件相对基线无差异 |
| `null` | 不可对比：未跟踪文件（git 不给它产出 diff）/ 非 git 目录（与 NOT_A_STATUS 同口径返回空值不报错）。UI 对未跟踪文件用已加载正文合成「全新增」视角 |

空输出的二义性（无差异 vs 未跟踪）由服务层用 `ls-files --error-unmatch` 消解，且只在 diff 为空时才多这一次调用。
失败：1001（path/relPath 非空校验；relPath 逃逸——绝对路径 / `..` / 空段——由服务层同码拒绝）；1002 项目未注册；
6001 git diff 失败（`data.stderr` 附 git 原始输出，信封形态与 §11 git/switchBranch 一致）。

## 3. git/commit

**参数**：

```json
{ "path": "D:/work/xxx", "message": "feat: …", "includeUnstaged": true }
```

| 步骤 | 失败响应 |
|---|---|
| path/message 非空（message 无默认兜底文案） | 1001 |
| 项目未注册 | 1002 |
| includeUnstaged=true → `git add -A` | 6006 + stderr（`git add 失败`） |
| **暂存非空服务端二次校验**（AC-11-07，绕过 UI 直调也拒绝） | 6006 `暂存区为空，无变更可提交` |
| `git commit -m <message>`（数组化传参） | 6006 + git 原始 stderr（身份未配置/hook 拒绝/index.lock） |

hook 失败时 add 的暂存**不回退**（UI 错误区如实提示"变更已暂存"）。
成功响应 `data`：`{ "shortHash": "abc1234", "fileCount": 2 }`（fileCount=本次提交涉及文件数，toast 数据源）。
日志：`[git] commit ok cwd=… hash=… files=… msg=<前 60 字符>`。

## 4. git/push

**参数**：`{ "path": "D:/work/xxx" }`。

流程：`branch --show-current` → 空（分离 HEAD/不可解析）拒绝 6007；
`rev-parse --abbrev-ref --symbolic-full-name @{upstream}` 判定——有 upstream 直接 `git push`，
无则 `git push -u origin <branch>`（GC-S04 口径；认证失败/non-fast-forward/无远端一律
6007 + stderr 原文，不自动 pull，AC-11-09）。

成功响应 `data`：`{ "branch": "main", "remote": "origin" }`（remote 取 `branch.<b>.remote` 配置，自动 -u 时即 origin）。

## 5. git/generateCommitMessage

AI 一键生成提交说明（GC-F05）。**参数**：

```json
{ "path": "D:/work/xxx", "sessionId": "…", "lang": "zh" }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| path | 是 | 项目根（containment 沿用注册判定 1002） |
| sessionId | 否 | 会话模型优先；缺省/会话无覆盖 → 全局默认模型；均无 → 6008 `未配置模型…` |
| lang | 否 | `en` 走英文提示词，缺省中文（TD-GC-05；语言由 UI 传 app locale，主进程无 locale 概念） |

流程（顺序即短路，失败均不发请求）：

1. `collectCommitDiff`（TD-GC-03 截断）：文件清单全量（tracked numstat + 未跟踪 `new(untracked)`、
   二进制 `bin` 只列名）+ `git diff HEAD`（无 HEAD 退 `--cached`）按文件分段、每段前 40 行、
   总预算约 30k 字符；`hasChanges:false` → 6008 `无变更可总结`。
2. provider 解析（createForgeCore 闭包）：模型 → `queryProviderList` 归属 provider →
   baseUrl 非空 + type 以 `openai` 开头（其它协议 6008 明示暂不支持）→ apiKey 明文
   （`queryProviderList` 已经 keychain 尝试解析 `$VAR`/`!cmd`；仍为 `$VAR` 时兜底查一次
   进程环境变量；未命中或 `!cmd` → 6008 引导重新保存）。
3. **单次** 非流式 `{baseUrl}/chat/completions` fetch（TD-GC-02，不起 agent）：
   `temperature 0.2`、`max_tokens 1024`（原 300，思考型模型 reasoning 吃预算致空正文，
   2026-09-23 真机反馈修正）、`AbortSignal.timeout(30s)`；baseUrl 尾斜杠归一。
4. 响应后处理（`extractCommitMessage`）：剥 ``` 围栏、取首段非空、首尾 trim（PRD 口径不二次加工）。
5. 网关形态兜底：HTTP 200 但 body 带 `base_resp.status_code≠0`（MiniMax 等）→ 6008 透传
   码与 status_msg，不误报「空内容」；正文空但有 `reasoning_content` → 6008 明示
   「只输出了思考内容没有正文」；真空内容分支打诊断日志（model/finish_reason/content 类型/
   reasoning 字符数，只记形状不记内容）。

成功响应 `data`：`{ "message": "feat: …" }`。失败统一 6008 + 可读 message；
HTTP 非 2xx 日志只记状态码与模型名（响应体可能回显请求内容，刻意不记）。

## 6. 错误码汇总（本模块）

| code | 语义 |
|---|---|
| 0 | 成功 |
| 1001 | 参数错误（path/message 空白） |
| 1002 | 项目未注册 |
| 6001 | git 命令执行失败（data.stderr；getFileDiff 复用，语义同 §11 api/01） |
| 6006 | git 提交失败（data.stderr；含暂存空拒绝） |
| 6007 | git 推送失败（data.stderr；含分离 HEAD 拒绝） |
| 6008 | AI 生成失败（无变更/未配置模型/不支持协议/网络/非 2xx/空内容） |
| 5000 | 内部错误 |

## 7. 白名单与 UI 侧约定（forge-ui）

- 双白名单已登记：`forge-desktop/src/ipc-contract.ts` ForgeMethod +4；`forge-ui/src/bridge.ts` 同名并集 +4
  （preload 无运行期方法白名单，零改动）。事件零新增（提交/推送不广播，弹窗打开时重查 getStatus）。
- UI 已交付（2026-09-23）：`GitCommitDialog.vue`（App 根常驻，`composables/useGitCommitDialog.ts` 模块级单例开合）；
  双入口=InstructionInput 状态行 meta-link + BranchBadge 浮窗「提交或推送…」（BranchBadge `git-repo` 事件驱动非 git 项目两处均不渲染）；
  6006/6007/6008 失败信封走 `invokeRaw`（弹窗内展示 stderr 不关窗）；i18n 新域 `domains/git.ts`；
  `mock-bridge.ts` 内存实现 4 方法（含 stagedEmpty 演示态与 `__fail__` 提交失败模拟）供浏览器 dev 预览。
- 组件、入口与 mock-bridge 承接属前端任务（模块 11 前端 GitCommitDialog，PRD F02/F06）。
