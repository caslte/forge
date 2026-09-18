# 打包与自动更新

> 本文覆盖本地打包、安装包形态、发版流程、更新源（feed）配置与更新调试。
> 多平台 CI 发布的完整说明与故障排查见 [release.md](release.md)。

## 本地打包

```bash
npm run dist -w @forge/desktop      # 完整安装包：forge-<版本>-x64-setup.exe + latest.yml + app-update.yml
npm run dist:dir -w @forge/desktop  # 免安装目录版：release/win-unpacked/forge.exe
```

产物位于 `packages/forge-desktop/release/`。本地构建带 `--publish never`（脚本已内置），不会误传 GitHub。

### 安装包形态

配置见 `packages/forge-desktop/electron-builder.yml`：

- **NSIS 一键安装器**：安装/更新全程无向导页、零点击；per-user 免管理员
- 自动更新时退出 App → 安装器显示进度窗（应用图标 + 进度动画）→ 装完自动重启（`main.ts` quitAndInstall 非静默；不要把 `isSilent` 改成 `true`，用户会只看到应用消失又突然跳出）
- v1 不做代码签名：Windows SmartScreen 会警告但不阻塞安装与更新；mac 未签名（`identity: null`），首次打开需「右键 → 打开」或 `xattr -cr`，且 mac 端自动更新不可用（Squirrel.Mac 要求签名）
- 平台产物：Windows NSIS（本地默认当前架构）；mac 出 dmg + zip（zip 是 electron-updater 的 mac 更新载体）；Linux 出 AppImage + deb。多平台完整产物由 CI 出，见下节

## 每次发版

**主流程：CI 标签发布**（打 `v` 标签即自动出 6 平台产物并挂到 Releases）：

1. **改版本号**：`packages/forge-desktop/package.json` 的 `version` 改成与本次标签一致（electron-builder 定位 Release 用「v + 包版本号」，对不上会静默跳过上传）
2. **提交推送**：日常提交推送不触发打包
3. **打标签推送**：`git tag v<版本>` → `git push origin v<版本>`，约 10~15 分钟后产物自动挂到 Releases，无需手动 Publish

详细步骤、测试版标签（rc 后缀）、结果判读与历史事故见 [release.md](release.md)。

**备选：本地手动发布**（CI 不可用时）：

1. **改版本号**：`packages/forge-desktop/package.json` 的 `version` 递增（应用按此版本判断更新）
2. **打包**：`npm run dist -w @forge/desktop`
3. **上传 GitHub Releases**：建 tag `v<版本>`，**同时上传**安装包与 `latest.yml`（latest.yml 必须与安装包同处发布）

用户侧全自动：应用检查 → 发现新版提示 → 手动下载 → 重启安装。

## 更新源（feed）

- `electron-builder.yml` 的 `publish.owner/repo` 决定安装包内 `app-update.yml` 的内置更新源（当前 `caslte/forge`）
- 运行时可用环境变量 `FORGE_GH_OWNER` / `FORGE_GH_REPO` 覆盖；未设置时打包产物自动回退内置 feed；dev（未打包）不检查（6003 静默）
- **当前默认私有仓库**（`publish.private: true`）：electron-updater 仅在 `private: true` 时读取 `GH_TOKEN`/`GITHUB_TOKEN` 走带认证的 GitHub API；私有仓库用户必须配置 token 才能检查更新
- **公开后切回公开**：删除 `electron-builder.yml` 的 `private: true` 与 `main.ts` `setFeedURL` 的 `private: true`，无 token 用户即可自动检查下载（无 token 时 electron-updater 自动回退公开 feed）

### 私有仓库测试（仅本机）

```powershell
# 生成带 repo 权限的 PAT 后，持久化设置（应用从开始菜单启动也能读到）
[Environment]::SetEnvironmentVariable('GH_TOKEN', 'ghp_...', 'User')
```

注意：**设置后必须从开始菜单/资源管理器重启应用**（新进程才会继承 User 级变量，旧进程读不到）。

测试时把安装包 + latest.yml 传到私有仓库的 Releases 即可，应用会带 token 检查。

## 更新调试控制台

调试日志入口默认对用户隐藏，本机排查看失败原因时开启：

- 在**应用数据目录**（userData）创建 `updater-debug.json`——打包版位于 `%APPDATA%\@forge\desktop\updater-debug.json`（dev 模式为 `%APPDATA%\forge\`）：

```json
{ "enabled": true }
```

- 重新打开 设置 → 关于，点「展开调试日志」，可见每次状态迁移与失败原因（如 401/404/更新源未配置）
- 关闭：删掉文件或把 `enabled` 改 `false`（应用实时读取，无需重启）

## 旧打包方式（免安装目录版，已废弃入口）

```bash
node scripts/package.mjs
```

构建 core/desktop/ui 后手动组装 `release/`（forge.exe + resources/app）。模块 07 已改为 electron-builder 流程，此脚本仅作历史保留。
