# forge

forge 桌面项目工作台（npm workspaces）。

## 开发

```bash
npm run dev        # 启动开发环境
npm run build      # 构建所有 workspaces
npm run typecheck  # 类型检查
npm run test       # 运行测试
```

## 打包

```bash
node scripts/package.mjs
```

免安装目录版打包：构建 core/desktop/ui 后，手动组装 `release/` 目录（forge.exe + resources/app），双击 `release/forge.exe` 即可运行。

> 说明：不使用 electron-builder（在 npm workspaces + pi 生态的大 node_modules 上依赖扫描会卡死），打包逻辑见 `scripts/package.mjs`。
