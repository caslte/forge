# 共享 ContextMenu 的「选中即关」会杀死两阶段确认：keepOpen 必须显式声明

## 现象

项目「更多操作」菜单里的**清理所有会话 / 删除项目**点了没反应：第一次点击后菜单直接关闭，确认文案（确认清理/确认删除）永远看不到，操作永远发不出。单段操作（打开目录/重命名）正常。

## 根因

这两个操作是**两阶段确认**：首次点击只切确认文案，菜单保持打开等第二次点击，`closeMenu()` 由消费方 handler 在确认后的收尾路径自己调。

旧内联菜单（c75dbbb 之前）的按钮直接绑 handler，**点完关不关菜单是每个 handler 自己决定的**。抽成共享 ContextMenu 时把 `emit('select') → close()` 固化进了 `onItemClick`，等于替所有消费方做了「选中即关」的决定——第一次点击 select 先跑（置确认态），紧接着 close 触发消费方 `closeMenu()` 把确认态清空、菜单卸载。两阶段流程被从中间截断。

教训：**抽共享组件时，「谁负责关」是逐条目语义，不是组件级语义**。头部注释写「行为逐条对齐，不要顺手改」，但 close 时机恰恰没有逐条对齐——静默的语义合并比改代码更难发现。

## 修复

`ContextMenuItem` 增加 `keepOpen?: boolean`：置位后 `onItemClick` 只 `emit('select')` 不自动 close，收尾关闭仍归消费方 handler。两阶段确认项（ProjectTree 清理会话/删除项目）必须置位；其余消费方（ChangedFilesCard / CodeTreePanel / CodeViewer）不置位，行为不变。

## 排查路径（可复用）

1. 症状是「危险项点了没反应、普通项正常」→ 先看两类项的差别：单段执行 vs 多阶段保持菜单。
2. `git log` 找共享组件抽取点，`git show <commit>~1:<file>` 对比旧实现的点击绑定与关闭时机。
3. e2e 断言「首次点击后 `.ctx-menu` 仍 visible + 文案切换」即可钉住本回归（`e2e/projectMenu.spec.ts`）。

## 关联

- `packages/forge-ui/src/components/ContextMenu.vue` 的 keepOpen 注释
- `e2e/projectMenu.spec.ts`（PROJECT-MENU-001/002）
