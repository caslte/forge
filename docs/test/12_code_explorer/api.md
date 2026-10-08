# 12 内置代码浏览器 · 接口设计用例（api）

> 扩展：CE-S11 Git 提交历史视图。契约见 `docs/api/11_git_commit_push.md` §6~§8。
> **扩张触发**：集成完整性维度涉及真实外部依赖（git CLI 子进程）→ 本文件**不使用 mock git**，全部用真实临时仓库。
> 仓库构造沿用 `packages/forge-core/test/git/gitService.test.ts` L31-42 的 `makeRepo()` 范式（`os.tmpdir()` 建真仓库、`finally` `rmSync` 清理）。

---

## 测试仓库 fixture

单一 fixture 仓库覆盖全部边界，每条用例只取用所需部分：

| 提交 | 构造 | 覆盖边界 |
|---|---|---|
| `c1` root | 首个提交 | **root commit**（无 `<sha>^1`） |
| `c2` rename | `git mv a.txt sub/renamed.txt`（纯重命名，相似度 100%） | rename `oldPath`/`newPath`；纯重命名 patch 为「无行级变化」 |
| `c3` binary | `head -c 100 /dev/urandom > bin.dat` | binary `additions=-1` |
| `c4` 中文 | 新增 `中文文件.md` + `文档目录/说明.md` | **中文路径不经八进制转义** |
| `c5` merge | 建分支 → 各改 → merge | **merge commit**（`git show` 会返 0 行 patch） |
| （无提交） | 空仓库（unborn HEAD） | `git log` exit 128 判空 |

---

## A-CE-02 · git/getCommitLog 基本契约与提交人字段

- **关联 AC**：AC-CE-033、AC-CE-044
- **接口**：`git/getCommitLog`；**鉴权**：path 须为已注册项目（单用户本地，无角色概念）
- **前置**：注册 fixture 仓库到 ProjectService；仓库含 c1~c5
- **请求**：`{ path: <repo>, limit: 100, skip: 0 }`
- **预期响应**：`code=0`，`data.commits` 长度 = 提交总数，按时间倒序
- **断言点**：
  1. 每条含 `sha`(40 位)/`shortSha`(7 位)/`subject`/`authorName`/`authorEmail`/`authoredAt`/`parentCount`/`isMerge`
  2. **`authoredAt` 为 epoch 秒（整数）**，不是格式化字符串 —— 时区归 UI 层
  3. `isMerge` 对 merge 提交为 `true`，`parentCount >= 2`；其余为 `false` / `1`
  4. `authorName` 为提交者姓名（**作者**而非 committer —— 这是「提交人」诉求的核心）
- **数据落地/回滚**：只读，无落地
- **负向断言**：
  - `limit` 传 0 / 负数 / 超 500 → `code=1001`，**不得**静默夹取
  - 未注册 path → `code=1002`
  - git 不可执行时 → `code=6001` 且 `data.stderr` 非空（**不得**返回 `code=0` 空列表冒充成功）

---

## A-CE-03 · 分页与深翻页

- **关联 AC**：AC-CE-044
- **前置**：fixture 仓库 ≥ 30 次提交
- **请求**：`{ limit: 10, skip: 0 }`、`{ limit: 10, skip: 10 }`、`{ limit: 10, skip: 20 }`
- **断言点**：
  1. 三页 sha 集合**两两无交集**，合起来等于前 30 条全序（不重不漏）
  2. `hasMore` 在末页为 `false`，其余为 `true`
  3. 连续两次相同请求返回**完全相同**（只读幂等）
- **性能基线**：`skip=150` 时实测 ≈98ms，**不得显著退化**（>1s 视为回归）
- **负向断言**：`skip` 超出提交总数 → `code=0` + 空数组 + `hasMore:false`（**不得报错**）

---

## A-CE-04 · git/getCommitDetail 契约与「不含 patch」

- **关联 AC**：AC-CE-036、AC-CE-037
- **请求**：`{ path: <repo>, sha: <c4 sha> }`
- **断言点**：
  1. `code=0`，含 `subject`/`body`/`authorName`/`authorEmail`/`authoredAt`/`committedAt`/`committerName`/`committerEmail`/`parentCount`/`isMerge`/`isRoot`
  2. `files[]` 含 `path`/`status`/`additions`/`deletions`/`binary`/`oldPath`
  3. **响应 JSON 中不存在 `diff` 字段** —— 这是两级取数的契约断言，用 `Object.keys()` 精确断言，不靠“没看到”判断
  4. `authoredAt` 与 `committedAt` **同时存在**（rebase 场景下二者不等，只返一个就答不了「谁在何时写的」）
- **负向断言**：不存在的 sha → `code=6001` + `data.stderr`；空 sha → `code=1001`

---

## A-CE-05 · merge commit 的 patch 与统计

- **关联 AC**：AC-CE-038
- **请求**：`{ path, sha: <merge sha> }` 取详情，再对其中某文件 `{ path, sha: <merge sha>, file: <f> }` 取 diff
- **断言点**：
  1. 详情的 `files[]` **非空**且 `additions/deletions` 为正数（第一父口径）
  2. 单文件 `getCommitFileDiff` 返回 `diff` **非空**
- **RED 探针（必须做）**：把基线改成 `git show <sha>`（不加 `-m/--first-parent`）→ `git show` 对 merge 输出 **0 行 patch**，
  `files[]` 的行级统计随之失真，用例必须转红。**这是本条唯一的回归保险**，不做探针等于没测。

---

## A-CE-06 · root commit 的 patch

- **关联 AC**：AC-CE-039
- **请求**：`{ path, sha: <c1 root sha> }` 与 `{ ..., file: 'a.txt' }`
- **断言点**：详情 `files[]` 非空；单文件 diff 非空且全为新增行
- **RED 探针**：基线改成 `git diff <sha>^1 <sha>` → git `fatal: ambiguous argument`，`run()` 返 `ok:false` → 用例必须红

---

## A-CE-07 · 空仓库与非 Git 目录

- **关联 AC**：AC-CE-040、AC-CE-041
- **前置**：① `git init` 后无任何提交；② 非 git 的普通目录（两者均注册为项目）
- **请求**：`getCommitLog` × 2
- **断言点**：
  1. 空仓库 → **`code=0`**，`data.commits=[]`，`hasMore=false`
  2. 非 git 目录 → `code=0`，空数组（与 `git/getStatus` 的 `isGitRepo:false` 同口径）
- **负向断言（关键）**：`git log` 在空仓库实际 **exit 128**、stderr 为 `does not have any commits yet`。
  **必须断言此 stderr 未被当作错误上抛**（若实现漏了识别，用例红）。这正是「判空不报错」这条 AC 的全部意义。

---

## A-CE-08 · 文件路径逃逸与字段边界

- **关联 AC**：AC-CE-034（接口侧）
- **请求**：`{ path, sha, file }` 中 `file` 分别取 `'../secrets'`, `'/etc/passwd'`, `'a/../../b'`, `''`
- **断言点**：四种**全部** `code=1001`（与 `git/getFileDiff` 同码拒绝）
- **负向断言**：不得有任何一种读出仓库外文件内容 —— 这是本模块唯一把用户可控路径交给主进程读盘的地方

---

## A-CE-09 · 中文路径与 quotepath

- **关联 AC**：AC-CE-043、AC-CE-021（跨模块）
- **请求**：对含 `中文文件.md` 的提交取详情
- **断言点**：`files[].path === '中文文件.md'`（**全等，不是包含**）
- **RED 探针**：去掉 `-c core.quotepath=false` → 路径变成 `"\344\270\255\346\226\207\346\226\207\344\273\266.md"`，用例必须红。
- **附带价值**：该修复同时消除模块 12「变更视图」在**默认 `core.quotepath=true` 机器**上的同类隐患（用户本机全局配了 `false` 才没暴露）

---

## A-CE-10 · git/getStatus 与变更视图回归（既有）

- **关联 AC**：AC-CE-023、AC-CE-024
- **断言点**：`getStatus` 的 `files[]` 状态标注与 `git status --porcelain` 逐行一致；`quotepath` 改动**不得**影响既有返回结构（回归护栏）

---

## A-CE-11 · rename 与 binary 的解析

- **关联 AC**：AC-CE-042
- **请求**：c2（纯重命名）与 c3（二进制）的详情
- **断言点**：
  1. c2：`files[0].status === 'R'`，`oldPath === 'a.txt'`，`newPath/path === 'sub/renamed.txt'`
     —— **不是** `'a.txt => sub/renamed.txt'` 这种字符串（不带 `-z` 时 git 就是这么给的）
  2. c3：`binary === true`，`additions === -1` 且 `deletions === -1`（**不是 0**：0 表示「真的没改行」）
  3. c2 走 `getCommitFileDiff` 返回 `""`（纯重命名无行级变化），**不得**返回 `null`（`null` 专指二进制）
- **RED 探针**：去掉 `-z` → `oldPath` 解析成含 `=>` 的歧义串，用例红

---

## A-CE-12 · 后端健康（每接口通用断言）

- **关联 AC**：AC-CE-037、AC-CE-040
- **断言点**：全部合法路径返回 `code=0` 且**有实际数据**（不得「成功但什么都没做」）；全部失败路径 `code != 0` 且有可读 message；无未捕获异常冒泡到 RPC 层之外

---

## 清理

每条用例 `finally { rmSync(repoDir, { recursive: true, force: true }) }`，与既有 `gitService.test.ts` 一致。临时仓库不得落在项目目录内。