# 10 内嵌终端接口

> 模块：底部多 tab 交互式终端（docs/prd/10_embedded_terminal.md）。
> 实现位置：`term/create|write|kill|resize` 与 pty 注册表在 `packages/forge-desktop/src/term/ptyService.ts`
> （组装在 `createForgeCore.ts`，containment 数据源 = ProjectService 已注册项目列表；
> 生命周期兜底钩子在 `main.ts`：before-quit / 窗口 closed / did-navigate 全量回收）。
> 状态：后端已实现（forge-desktop 单测见 test/term/ptyService.test.ts）。

## 0. 业务对象与安全口径

- **TermSession** = ptyId（randomUUID）+ shell + cwd + exited 标记；主进程 Map 持全量，
  渲染层只持 ptyId 字符串，无任何路径/进程权限。
- **spawn 目标固定为系统 shell**（TD-TM-05）：Windows `%COMSPEC%`、Unix `$SHELL` 回退
  `/bin/bash`；不接受渲染层传入任何可执行路径或参数。
- **cwd containment（AC-10-06）**：入参 cwd 先过 `normalizeProjectPath`（resolve +
  realpath + 目录存在性），再比对已注册项目根集合；任一环节不过 → 1002。伪造路径、
  路径穿越、未注册目录、已删除目录全部拒绝。
- **PTY 类型**：`xterm-256color`，初始 cols/rows 由渲染层传入（缺省 80×24），
  env 继承主进程环境并钉 `TERM=xterm-256color`。
- **node-pty 动态加载**：`@lydell/node-pty` 在首次真实 spawn 时才 import
  （N-API prebuilds，spike 2026-09-23 验证 Electron 主进程免 rebuild 直用）；
  启动装配路径零原生模块成本。
- **生命周期（TM-S04）**：收起面板不 kill（pty 保活）；关 tab 即 kill（幂等）；
  窗口 closed / before-quit / 文档重载（did-navigate，含 HMR reload，孤儿对账）
  三类钩子全量回收。
- **可观测性**：主进程英文日志 `[term] pty spawned/exited/killed`（含 id/shell/cwd/pid/code）。

## 1. term/create

新建 pty（TM-F03）。**参数**：`{ "cwd": "C:/works/xxx", "cols": 120, "rows": 30 }`
（cols/rows 可省略 = 80×24）。

成功响应 `data`：

```json
{ "ptyId": "9f2c…", "shell": "C:\\Windows\\System32\\cmd.exe", "pid": 41736 }
```

失败：

| code | 条件 | message |
|---|---|---|
| 1001 | cwd 非空串缺失 / cols·rows 非正整数 | 参数错误 |
| 1002 | cwd 不存在或不是目录 / 归一后不在已注册项目集合 | 工作目录不是已注册项目根: … |
| 5000 | spawn 抛错（shell 不存在/权限/pty 分配失败） | 终端启动失败: {原生原因}（tab 内保留展示） |

## 2. term/write

用户输入下行（TM-F04）。**参数**：`{ "ptyId": "…", "data": "ls\r" }`（data 允许空串）。

**恒返回 code 0**：写已退出/未知 pty 静默丢弃（PRD F04 异常口径；竞态由日志留痕），
渲染层无需处理失败分支。1001 仅在 ptyId/data 类型非法时返回。

## 3. term/resize

xterm addon-fit 实测尺寸同步（TM-S03）。**参数**：`{ "ptyId": "…", "cols": 120, "rows": 30 }`。
同 write：死 pty 静默 0；cols/rows 非正整数 1001。

## 4. term/kill

关闭 tab（TM-S02/F03）。**参数**：`{ "ptyId": "…" }`。幂等：已退出/未知 id 也返回 0。
kill 后 pty 的 onExit 仍会触发一次 `term:exit`（tab 已关则事件被渲染层忽略）。

## 5. 事件（主进程 → 渲染进程）

均经 core eventBus → `forge:event` 转发（已登记 FORGE_EVENTS 双白名单），按 ptyId 区分归属。

### term:data

```json
{ "ptyId": "9f2c…", "data": "…pty 原始输出（含 ANSI 序列，渲染侧直接 xterm.write，不转义）" }
```

### term:exit

```json
{ "ptyId": "9f2c…", "exitCode": 0 }
```

pty 退出（用户 exit / Ctrl+D 类中断 / kill / 崩溃）都发；UI 据此在 tab 内显示
`[进程已退出 code=N]`，tab 保留至手动关闭（可回看尾部输出）。

## 6. 渲染层约定（forge-ui）

- 上行全部走 `window.forge.invoke('term/…')`；下行 `window.forge.on('term:data' | 'term:exit')`。
- 每个 tab 持有存活 xterm 实例（display 切换不销毁）；后台 tab 持续写入自身 buffer，
  切回即最新（AC-10-04）。
- 面板开关状态与高度持久化在渲染层 localStorage（usePreferences），后端无状态。
- 事件风暴（`cat 大文件`）依赖 xterm 自身吞吐（AC-10-08）；实测卡顿再加 16ms
  批量合并（PRD 预留方案，未默认启用）。
