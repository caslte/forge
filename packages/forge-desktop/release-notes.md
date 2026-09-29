<!-- 本文件由 scripts/release-notes.mjs 自动生成，发布时随 bump commit 更新，请勿手改 -->

### ✨ 新功能
- 统一错误分类并完善重试与状态恢复（conversation）
- 重做右下角 Toast 通知，对齐系统通知交互样式（toast）
- 支持清理项目全部会话（project）
- 为所有 Markdown 代码块添加一键复制功能
- 新增系统通知弹窗功能及对话内容宽度偏好设置
- 实现项目信任门禁与多层安全防线

### 🐛 问题修复
- 修复 Windows 下 pi 插件更新时弹出控制台窗口的问题
- 修复 ResizeObserver 下字标漂移和顶部裁切问题
- 修复项目名截断时英文字母被裁切的问题

### 📝 文档
- 统一 README 中项目名称的大小写为 Forge
- 删除过期的安全扫描报告文件

**完整变更**：https://e/forge/compare/v0.1.15...v0.1.16
