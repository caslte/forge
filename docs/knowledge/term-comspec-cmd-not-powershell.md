# 内嵌终端是 cmd.exe 不是 PowerShell：`./` 前缀与直跑 .ps1 必失败，Tab 补全跟 cmd 自己的 cwd

- 日期：2026-10-02 ｜ 来源：用户反馈「终端执行不了 ./scripts/release.ps1」「Tab 联想不跟我目录挂钩、像是从项目根联想」

## 反直觉根因

模块 10 内嵌终端 spawn 目标固定取 `%COMSPEC%`（`forge-desktop/src/term/ptyService.ts` `resolveSystemShell`，TD-TM-05 方案 A「系统 shell，不做选择 UI」）。Windows 默认 = **cmd.exe**，不是 PowerShell。于是三件事全部反直觉：

1. cmd 把 `/` 当开关前缀，`./scripts/release.ps1` 的命令名被解析成 `.` → `'.' 不是内部或外部命令`。同一条命令在独立 PowerShell 里能跑（PS 认 `./` 且原生执行 .ps1），用户会误以为「终端坏了」。
2. 即使写对 `.\scripts\release.ps1` 也未必能跑：cmd 只认 PATHEXT 可执行扩展 + 文件关联；本机 `assoc .ps1` 为空（无关联），cmd 无法 ShellExecute → 同样报「不是内部或外部命令」。cmd 里跑 ps1 只有 `pwsh -NoProfile -File` / `powershell -NoProfile -ExecutionPolicy Bypass -File` 一条路。
3. Tab 补全没有自定义实现（TerminalPanel 只拦 Ctrl+C 复制，其余按键原样进 pty），完全由 cmd 自己完成：按 **cmd 当前目录**枚举。新 tab cwd 恒为会话项目根（TerminalPanel `createTab`：`cwd = props.projectPath` ← App.vue `currentProjectPath`），cd 后跟随；不会跟随代码浏览器正在看的目录。与 pwsh PSReadLine 的菜单式补全是两个引擎 + 两个 cwd，对比必然「联想出的不是一个文件」。

## 排查路径

- 判断当前 shell：报错 `'xxx' 不是内部或外部命令`、提示符 `D:\...>` 无 PS 前缀、`Terminate batch job (Y/N)?` = cmd；提示符 `PS D:\...>` = PowerShell。
- cmd 里跑 ps1：`pwsh -NoProfile -File .\scripts\xxx.ps1`。
- 隐藏坑：cmd 停在被删除/移动的目录（幽灵 cwd）时，提示符仍显示旧路径、Tab 补全无可枚举。见到「提示符路径不像真的」先验证目录是否存在。
- 若要把内嵌终端换成 PowerShell：改 `resolveSystemShell` 优先 `pwsh.exe`——属 PRD 决策（方案 A 刻意选 %COMSPEC%），需同步 PRD，不是 bug 修复。

## 2026-10-02 落地记录

用户确认后已修订为优先级链：Windows `pwsh → powershell → %COMSPEC%`（spawn 前存在性探测 + 结果缓存；PowerShell 系带 `-NoLogo`，故意不加 `-NoProfile` 保住用户 profile 体验）。`resolveSystemShell`/`windowsShellCandidates`/`shellSpawnArgs`（ptyService.ts），测试 13 用例全绿，PRD TD-TM-05 与 docs/api/10_terminal.md 已同步。本篇其余内容（cmd 语法差异、幽灵 cwd、`pwsh -File` 用法）对外部 cmd 终端仍然有效。
