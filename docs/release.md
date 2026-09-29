# 发布流程（多平台打包）

> 核心机制：仓库里的 `.github/workflows/release.yml` 是 GitHub Actions 的自动打包说明书。
> **日常提交推送不触发任何打包；只有推送 `v` 开头的标签才会。**
> 触发后 GitHub 自动租 6 台不同平台的机器并行打包，产物自动挂到仓库 Releases 页面。

## 产物一览

| job | 机器 | 产物 |
|---|---|---|
| win-x64 | windows-latest | `Forge-<版本>-x64-setup.exe` |
| win-arm64 | windows-11-arm | `Forge-<版本>-arm64-setup.exe` |
| mac-arm64 | macos-14 | `.dmg` + `.zip`（Apple Silicon） |
| mac-x64 | macos-15-intel | `.dmg` + `.zip`（Intel） |
| linux-x64 | ubuntu-latest | `.AppImage` + `.deb` |
| linux-arm64 | ubuntu-24.04-arm | `.AppImage` + `.deb`（ARM） |

同时自动生成 `latest.yml` / `latest-mac.yml` / `latest-linux.yml` 三个更新清单（electron-updater 用）。

---

## 一、一次性准备

### 1. 设置 Actions 写权限（网页）

打开 `https://github.com/caslte/forge/settings/actions`，拉到最底下
**Workflow permissions** → 选 **Read and write permissions** → Save。

> 不做这步：6 个 job 构建全部成功，但最后上传 Release 时报 403，白跑十几分钟。

### 2. 确认发布相关文件已在仓库

涉及文件（均已提交）：

- `.github/workflows/release.yml` —— 自动打包说明书
- `packages/forge-desktop/electron-builder.yml` —— 各平台产物格式定义
- `packages/forge-desktop/package.json` —— `dist:ci` 脚本（CI 专用，不带 `--publish never`）

本机日常打包仍用原来的 `npm run dist`，与 CI 互不干扰。

### 3. 首次先手动试跑（强烈建议，别直接打标签）

打开 `https://github.com/caslte/forge/actions` → 左侧选 **release** 工作流 →
右侧 **Run workflow** 按钮 → 选默认分支 → 运行。

确认 6 个 job 全绿、Releases 页面产物齐全后，再走正式发版流程。

---

## 二、日常发版流程（每次发版就这三条命令）

```bash
# 0. 【必须先做】把 packages/forge-desktop/package.json 的 version 改成与本次标签一致
#    electron-builder 定位 Release 用的是「v + 包版本号」，不是 git 标签本身。
#    版本号对不上有两种后果（都真实发生过）：
#    a) 同名旧 Release 已存在（releaseType: release 下类型兼容）→ 产物被上传进
#       旧 Release：构建显示成功，但新版本的 Release 根本不会创建，旧 Release
#       被新文件名的资产污染；需到旧 Release 编辑页删掉混入的资产再重发。
#    b) 类型不兼容时 → 产物被静默跳过上传（构建全绿但 Release 里没有新资产）。
#    例：发 v0.1.8 → version 改为 "0.1.8"

# 1. 提交代码（日常开发随便推分支，不会触发打包）
git add -A
git commit -m "feat: xxx"
git push

# 2. 打版本标签（标签名必须以 v 开头）
git tag v0.1.7

# 3. 推送标签 —— 这一步触发 GitHub 自动打包全部 6 个平台的安装包
git push origin v0.1.7
```

推完标签后约 1 分钟内 Actions 开始跑，全部完成约 10~15 分钟。
产物直接以**正式 Release** 挂在 `https://github.com/caslte/forge/releases` 对应标签下——
**不需要、也不要手动点 Publish**（配置已是 `releaseType: release`，见下方事故说明）。

> ⚠ 为什么不要在中途手动点 Publish（2026-09-16 事故）：
> 各平台 job 完成有先后（win 双架构最慢）。若在部分 job 完成后把草稿 Publish 成正式
> Release，最后完成的 job 以 draft 类型上传时会发生「existing type not compatible
> with publishing type」→ 该 job 的全部产物被**静默跳过**（构建依然全绿，极难察觉）。
> `releaseType: release` 让所有 job 类型一致，Publish 时机不再影响结果。

> 标签打错/想重打：先删本地和远程标签，再重来。
> ```bash
> git tag -d v0.1.7
> git push origin :refs/tags/v0.1.7
> ```
> 注意：若该标签的 Release 已生成，需到 Releases 页面把那条 Release 也删掉——
> 已发布（非草稿）的同版本 Release 会导致新产物被跳过上传。

---

## 三、测试版标签（不占用正式版本号）

首次跑 CI 或想先验证再正式发布时，用 rc 后缀：

```bash
git tag v0.1.7-rc.1
git push origin v0.1.7-rc.1
```

跑通后正式发版再打 `v0.1.7`。

---

## 四、结果判读与常见问题

**全绿** → Releases 页面检查产物即可。

**win-arm64 / linux-arm64 报「runner 不可用」**
私有仓库免费版不一定放行 arm runner，属预期内（2026-09-16 起工作流已改为
win/mac 单 job 双架构，现在矩阵里只剩 linux-arm64 一项可能遇到）。处理：删掉
`release.yml` 矩阵里 `linux-arm64` 那一项，提交推送，其余平台照常。

**linux-arm64 报 fpm/ruby「Exec format error」**
electron-builder 内置的 fpm 只有 x86 版，arm64 机器无法执行。workflow 已内置解法：
arm64 Linux runner 会自动安装系统 ruby + fpm 并设 `USE_SYSTEM_FPM=true`。
若要手动在 arm64 机器上打 deb，先执行
`sudo apt install ruby ruby-dev build-essential && sudo gem install fpm`。

**所有 job 上传 Release 时 403**
Workflow permissions 没设置成 Read and write，回第一节第 1 步。

**构建中途失败（npm ci 或 electron-builder 阶段）**
点进失败的 job，复制日志最后一段报错来排查。已知风险点：
npm workspaces 依赖扫描（本机历史上遇到过）、平台原生依赖缺失。

**用户应用内自动更新装到了错误架构（严重，2026-09-16 事故）**
症状：x64 机器被推送 arm64 安装包，NSIS 半安装后应用损坏（安装目录只剩
卸载器，桌面快捷方式失效）。根因：同一平台的双架构若拆成两个 job 并行构建，
各自上传的 `latest.yml` 同名互相覆盖，updater 拉到的 feed 只含最后完成那个
架构。**已于 2026-09-16 修复：win / mac 均为单 job 双架构构建，latest.yml
天然含全部架构条目**。注意两条铁律：
1. 不要再把同平台双架构拆回多个 job；
2. linux 仍是两个 job（x64 无法交叉构建 arm64 AppImage），其 latest-linux.yml
   只保证「最后完成的架构」正确 —— linux 对外发布前需加 finalize 合并 job。

**job 全绿但 Release 里缺少某个平台的产物（2026-09-16 事故）**
日志特征：`skipped publishing … existing type not compatible with publishing type
… existingType=release publishingType=draft`。原因：部分 job 完成后 Release 被
手动 Publish 成正式状态，后完成的 job 以 draft 类型上传被全部静默跳过。
已修复：`electron-builder.yml` 设 `releaseType: release`，各 job 类型一致。
**发版后不要在 Actions 跑完之前碰 Release 页面的 Publish 按钮**（现在也无需点）。

**作废一次发布**
到 Releases 页面删除该 Release 和标签即可，不影响其他版本。

---

## 五、已知边界（v1 阶段）

- **mac 包未签名**：用户首次打开需「右键 → 打开」或 `xattr -cr`；mac 端自动更新不可用（Squirrel.Mac 要求签名）。拿到 Apple Developer 账号后删掉 `electron-builder.yml` 里的 `identity: null` 即可解锁。
- **Windows 未签名**：SmartScreen 会警告，但不阻塞安装与更新。
- **仓库私有**：`publish.private: true` 未改，用户侧自动更新拉不到 feed，需仓库转公开或配置 token。
- **无应用图标**：三平台退回 Electron 默认图标。放一个
  `packages/forge-desktop/build/icon.png`（1024×1024）即可自动派生各平台格式。
