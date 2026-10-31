<!-- 本文件由 scripts/release-notes.mjs 自动生成，发布时随 bump commit 更新，请勿手改 -->

### 新功能
- 插件市场暂不开放，从设置页摘除「插件」Tab 入口 (v6.40)（settings）
- 引擎 0.84.3 → 1.4.0，修通子 agent「createCodemodeExtension is not a function」；Agent 展开体限高 (v6.37~v6.39)（pi）
- 设置页新增「插件」Tab 与插件库弹窗，接入 npm registry 搜索与 CLI 安装 (v6.36)（plugin）
- P0+P1 画布单一风格定调「青瓷数据」并注入风格规范 (v6.34)（canvas）
- 新增布局层与边标签锚点消歧，修复渲染问题（canvas-ir）
- 项目树项目文件夹默认全部收起（v6.26）
- 接入 pi-goal 目标管理功能，新增 IR 画布契约与修复回路
- 新增首次使用指引和会话导出功能
- 重构模型选择为别名锚点存储，支持配置模型 ID 自动跟随
- 新增 Git 提交历史浏览与差异查看（code-explorer）
- 新增键盘快捷键系统与设置面板，支持代码浏览器右键复制（forge-ui）
- 选区复制浮窗补右键触发，浮窗落在光标处（forge-ui）

### 问题修复
- 暗色主题 porcelain 派生色翻车，paper/ink 上收宿主按主题计算 (v6.35)（canvas）
- 拦截非法模型 ID 并自愈悬空会话模型（model）

### 代码重构
- 移除 IR 链路，canvas 直出 HTML 成为唯一画布通路 (v6.33)（canvas）

**完整变更**：https://github.com/caslte/forge/compare/v0.2.3...v0.2.4
