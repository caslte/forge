# 12 内置代码浏览器 · 单元设计用例（unit）

> 扩展：CE-S11 Git 提交历史视图 + 模块 12 既有纯逻辑。
> **扩张触发**：命中「>3 状态状态机」（diff 加载 idle/loading/binary/fail × 视图三档）与「fixture 数据」（diff 文本）。
> 运行时 `node --experimental-strip-types --test`，纯逻辑不挂载组件。

---

## A. CE-S11 纯逻辑

### U-CE-03 · 头像派生（提交人首字母与色相）

- **关联 AC**：AC-CE-033 ｜ **风险维度**：字段边界 / 内容正确性
- **测试对象**：`avatarOf(authorName, authorEmail)`（纯函数）
- **前置**：无 ｜ **输入**：`('陈默','chenmo@kibo.com.cn')`、`('王工','ligang@kibo.com.cn')`、`('李工','lihua@kibo.com.cn')`、`('John Doe','jd@x.com')`
- **操作**：逐个求初值与色相
- **预期结果**：`'陈' '王' '李' 'J'`
- **负向断言**：
  - **三个中文名的初值必须两两不同** —— 原型首版取末字时「王工」「李工」双双得到「工」，两个人在列表里长得完全一样，恰好毁掉「按作者视觉成串」的设计意图
  - 同一 email 两次调用色相**全等**（稳定性）
  - 不同 email 色相不同（区分度）—— 概率碰撞可容忍，但 `王工`/`李工` 这类样本必须不同
- **边界补充**：空 name、单字符 name、全西文 name、emoji name（取首 code unit）

### U-CE-13 · 历史列表筛选

- **关联 AC**：AC-CE-034 ｜ **风险维度**：查询/筛选视图
- **输入**：8 条提交 fixture（多作者、中英混排说明）
- **操作**：分别以说明子串、作者名、`authorEmail` 局部片段过滤
- **预期结果**：命中项按原顺序返回；大小写不敏感；空查询返回全量
- **负向断言**：无匹配返回 `[]` 而非 `null`；空字符串查询等价全量（不是「匹配空串得 0 条」）

### U-CE-14 · 日期分组

- **关联 AC**：AC-CE-035 ｜ **风险维度**：内容正确性
- **输入**：跨 今天/昨天/前天/同月其他日/跨年 的提交列表
- **预期结果**：分组标签为 `今天`/`昨天`/`M月D日`；同组提交聚在一起；组间按时间倒序
- **负向断言**：未来时间戳不得归到负数天（后端时钟超前场景）；跨年日期带年份

### U-CE-15 · 两级取数的调用编排

- **关联 AC**：AC-CE-037 ｜ **风险维度**：资源生命周期 / 性能
- **测试对象**：历史视图的取数编排（不触网，只断言调用序列）
- **前置**：mock 三个 bridge 方法并记录调用序列
- **操作**：① 选中一条提交；② 不展开任何文件；③ 展开文件 A；④ 展开文件 B；⑤ 折叠 A；⑥ 再展开 A
- **预期结果**：
  1. 选中 → 调 `getCommitDetail` ×1，**未调** `getCommitFileDiff`
  2. 展开 A → `getCommitFileDiff(A)` ×1
  3. 展开 B → `getCommitFileDiff(B)` ×1（A 不重复调）
  4. 折叠再展开 A → **命中缓存，不再调**（幂等）
- **负向断言**：**任何时候都不得调「一次性取全量 patch」的方法**（该方法在契约中不存在；若有人加了，此断言即红）
- **边界补充**：同一文件路径重复展开不得重复 IPC；切换提交后前一提交的 diff **不得**串到新提交（竞态，用 seq 号防护）

### U-CE-16 · diff 基线分派（merge / root / 普通）

- **关联 AC**：AC-CE-038、AC-CE-039、AC-CE-042、AC-CE-043 ｜ **风险维度**：数据一致性
- **测试对象**：`resolveDiffBaseline(sha, parentCount)` → git 命令参数
- **预期结果**：

  | parentCount | 参数 |
  |---|---|
  | `0`（root） | `show <sha>` —— **不得**用 `diff <sha>^1`（会 fatal） |
  | `1`（普通） | `diff <sha>^1 <sha>` |
  | `>=2`（merge） | `diff <sha>^1 <sha>`（第一父）—— **不得**用 `show <sha>`（返 0 行） |

- **负向断言**：merge 走 `show` 即红；root 走 `diff ^1` 即红。这两条是本用例的全部价值，**必做双向探针**

### U-CE-17 · 空仓库判空

- **关联 AC**：AC-CE-040 ｜ **风险维度**：异常失败
- **测试对象**：`isUnbornHeadError(stderr)`（识别 git 的 exit 128 文案）
- **输入**：`'fatal: your current branch 'master' does not have any commits yet'`
- **预期结果**：判为「空仓库」→ 上层归一为 `{ commits: [], hasMore: false }` + `code=0`
- **负向断言**：
  - 相似的**其它** 128 错误（如 `bad revision`）**不得**被误判为空仓库
  - 该函数**不得**吞掉其他 git 错误（其他 stderr 仍走 6001）

### U-CE-18 · 分页状态

- **关联 AC**：AC-CE-044 ｜ **风险维度**：查询组合
- **测试对象**：`{ limit, skip, hasMore, commits }` 的推进与拼接
- **预期结果**：`hasMore=true` 时滚动到底追加下一页；追加后**不重复、不打乱顺序**；已加载集合按 sha 去重
- **负向断言**：翻页途中切项目 → 旧项目数据必须清空，**不得串到新项目**

---

## B. 模块 12 既有纯逻辑（设计侧登记，实现已在 `packages/forge-ui/test/`）

| 用例 ID | 关联 AC | 测试对象 | 关键断言 | 对应既有测试 |
|---|---|---|---|---|
| U-CE-01 | AC-CE-025/026 | `buildChangedTree` / `gitStatusUi` | 目录聚合角标；冲突 `U` 压一切；状态色映射 | `test/changedTree.test.ts`、`test/gitStatusUi.test.ts` |
| U-CE-04 | AC-CE-007 | `clampCodeSplitPct` / `effectiveCodeLayout` | 两侧保底 320px；窄窗降级**不改偏好** | `test/codeViewerLayout.test.ts` |
| U-CE-05 | AC-CE-009 | `codeLayoutDegraded` | 降级判定与恢复 | `test/codeViewerLayout.test.ts` |
| U-CE-06 | AC-CE-010 | 过滤与 ignore 规则 | 只匹配文件名；`node_modules`/`.git`/`dist` 排除 | `test/changedTree.test.ts` |
| U-CE-08 | AC-CE-015 | 最近打开去重与上限 | 上限 5；头部插入去重；关签不删除 | 设计已登记，实现随 `useCodeExplorer` |
| U-CE-09 | AC-CE-016 | `readSelection` / `placeAtPoint` | 右键锚点落光标处且钳进视口；`Ctrl+A` 无 mouseup 仍可复制 | 实现见 `selectionPopover.ts` |
| U-CE-10 | AC-CE-018 | 菜单落位与 150ms 宽限期 | 溢出钳位；打开后的 scroll 不立即关闭 | 实现见 `ContextMenu.vue` |
| U-CE-11 | AC-CE-021 | `OpenFileWatcher` 去抖与回收 | 300ms 防抖；关签后 watcher 释放；同目录共享 | `packages/forge-core/test/file/` |
| U-CE-12 | AC-CE-023 | `aggregateGitDirStatus` | 子树聚合与自身透传 | `test/gitTreeStatus.test.ts` |
| U-CE-02 | AC-CE-019 | 编辑器三层扫描 | PATH 全部命中行 / App Paths / 安装根；**仅放行真实 .exe** | `packages/forge-desktop/test/shell/editorScan.test.ts`（12 例） |
| U-CE-03b | AC-CE-011/028 | `parseGitUnifiedDiff` | hunk 内外 `---`/`+++` 区分；未变更分隔条 | `test/gitDiffRows.test.ts` |

---

## 边界与隔离

- 全部为纯函数或模块级单例（`useCodeExplorer` 状态按项目 key 隔离），**不挂载 Vue 组件**，无需 jsdom
- `U-CE-15` 用注入式 fake bridge 记录调用序列，**不 mock git 本身**（git 的真实行为由 `api.md` 的真仓库用例守住）
- 时间相关用例（`U-CE-14`/`U-CE-18`）**必须注入固定 `now`**，不得读系统时钟 —— 否则跨日边界会让用例随机红