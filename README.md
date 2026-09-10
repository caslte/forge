# forge

forge 桌面项目工作台（npm workspaces）。

## 开发

```bash
npm run dev        # 启动开发环境
npm run build      # 构建所有 workspaces
npm run typecheck  # 类型检查
npm run test       # 运行测试
```

## 打包安装包（NSIS per-user，模块 07）

```bash
npm run dist -w @forge/desktop      # 完整安装包：forge-<版本>-x64-setup.exe + latest.yml + app-update.yml
npm run dist:dir -w @forge/desktop  # 免安装目录版：release/win-unpacked/forge.exe
```

产物位于 `packages/forge-desktop/release/`。本地构建加 `--publish never`（脚本已内置），不会误传 GitHub。

> 说明：electron-builder 配置见 `packages/forge-desktop/electron-builder.yml`——NSIS **安装向导**（非一键，可选安装目录）、per-user 免管理员、不签名 v1。自动更新时退出 App 并弹出安装器窗口显示安装进度，装完自动重启（`main.ts` quitAndInstall 非静默）。

## 每次发版（三步）

1. **改版本号**：`packages/forge-desktop/package.json` 的 `version` 递增（应用按此版本判断更新）
2. **打包**：`npm run dist -w @forge/desktop`
3. **上传 GitHub Releases**：建 tag `v<版本>`，**同时上传** `release/forge-<版本>-x64-setup.exe` 与 `release/latest.yml`（latest.yml 必须与安装包同处发布）

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
