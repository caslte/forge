# 找不到 bash 时要自动识别 Git Bash 写配置，而不是让用户去改 settings.json

- 日期：2026-09-26 ｜ 来源：shell 健康横幅（用户反馈「自动识别 Git Bash 可以做到吗，然后填到配置中」）
- 适用：所有「探测到环境不可用 → 提示用户手工配置」的场景（shellPath 是第一个，同类问题还有编辑器路径、npm 命令等）

## 反直觉根因

pi 的 bash 解析只有三级兜底（`utils/shell.js` `getShellConfig`）：

1. `settings.shellPath`（用户显式配置）
2. `%ProgramFiles%\Git\bin\bash.exe` 与 `%ProgramFiles(x86)%\Git\bin\bash.exe`（**只有这两个标准路径**）
3. `where bash.exe`（PATH 上第一个）

于是「装了 Git 但没配」的机器分两类：

- **能自愈**：Git 装默认位置 → 第 2 级直接命中；
- **静默失败**：Git 装到自定义目录（`D:\tools\Git`、解压版 PortableGit）且 PATH 只挂了 `<root>\cmd` —— 该目录里有 `git.exe`（所以 `git` 命令能用，用户以为环境没问题），**没有 `bash.exe`**（它在 `<root>\bin\` 或 `<root>\usr\bin\`）→ 第 2、3 级全落空，pi 抛 `No bash shell found`。

后者的用户没有任何线索能自己想到「要把 shellPath 指向 `<root>\bin\bash.exe`」，横幅提示「请自己编辑 settings.json」等于把问题丢回给用户。

## 修复模式

**探测失败即自动修复，用户零配置**（`pi/gitBashResolver.ts` + `ensurePiShellPath`）：

候选链按「命中概率 × 稳定性」排序：

1. `where git.exe` **反推安装根** —— 覆盖面最大。对每个 `git.exe` 逐级上溯试 `<dir>\bin\bash.exe` 与 `<dir>\usr\bin\bash.exe`（三级足够：`cmd\git.exe` 一级、`mingw64\bin\git.exe` 两级）。不依赖目录名约定，PortableGit 的 `versions\<ver>\mingw64\bin\git.exe` 形态同样命中。
2. 注册表 `HKLM|HKCU\SOFTWARE\GitForWindows` 的 `InstallPath` —— Git 完全不在 PATH 上时的唯一线索。
3. 常见安装位置（`ProgramFiles` / `x86` / `LOCALAPPDATA\Programs` / scoop）。
4. `where bash.exe`（Cygwin / MSYS2 / 解压版）——**必须过滤 WSL 占位**。

写配置用 pi 的 `SettingsManager.setShellPath()` + `await flush()`，不裸写 JSON：它按「读当前文件 → 只覆盖被修改字段 → 写回」合并，`packages`/`models` 等既有内容原样保留，且与 pi 会话侧是同一套存储实现。

## 关键坑

- **WSL 占位必须排除**：`%SystemRoot%\System32\bash.exe` 是 Windows 自带的 WSL 启动器，`where bash.exe` 常常第一个命中它。它「存在」，但对没装 WSL 的机器只会返回一句 UTF-16 乱码的「未安装 Linux 子系统」。判定比 pi 宽：`/[\\/](system32|syswow64)[\\/]/i`。**绝不能把它写进 shellPath**——那正是 2026-09 事故本身。
  - 连带：`where bash.exe` 可能返回多个（占位在前、真 bash 在后），必须逐个过滤而不是取第一个。
- **修复时机必须在 pi 会话创建之前**：`shellPath` 是会话创建时解析的，写完配置后已存在的会话不会改。forge 把 `ensurePiShellPath()` 放在 `splash 上屏之后、createForgeCore 之前` await 一次——修好的值对之后所有会话立即生效，用户全程无感（连横幅都不会出现）。放在窗口创建之前会卡首帧，放在 core 之后则首个会话可能已经用旧值跑起来了。
- **写后必须复探**：只信 `probePiShell()` 的第二次结果，失败就返回原异常。否则「解析器找到了一个其实不能用的文件」会变成一个更隐蔽的坏配置（横幅消失、命令照挂）。
- **`flush()` 必须 await**：pi 的写是排队异步的，不 await 就会出现「代码认为已修复、文件还没落盘、紧接着创建的会话读到旧值」。
- **启动链成本**：`probePiShell` 先读 settings.json，解析成功（绝大多数机器）直接返回；只有真不可用时才 spawn `where git.exe` / `reg query`。所以「已正常」的机器零额外开销，不需要额外加开关或缓存。
- **落盘前必须 `path.normalize`**：候选可能带重复分隔符（`D:////a////b`）。Windows 把它当合法路径，`existsSync` 通过、复探也通过——**看起来修好了，spawn 时却不稳**。这是「探测口径只做存在性判定」的固有盲区，只能在写入侧归一化兜住（真机验证时实际踩到过）。

## 验证

- `test/pi/gitBashResolver.test.ts`：候选链 10 例，全部经依赖注入驱动（`findOnPath`/`registryInstallPath`/`env`/`platform`），不依赖测试机装没装 Git —— 含「占位在前、真 bash 在后须跳过占位」「where git 优先于注册表」两条易错断言。
- `test/pi/shellProbe.test.ts`：`ensurePiShellPath` 4 例 —— 已可用时零副作用（候选解析器不被调用）、解析不到时不动配置、修复成功时 `autoFixed=true` 且既有 `packages` 不丢、候选不可用时回原异常不谎报。
