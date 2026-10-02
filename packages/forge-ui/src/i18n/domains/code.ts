/**
 * 内置代码浏览器（模块 12，docs/prd/12_code_explorer.md）。
 *
 * 独立成域而不是并入 panels/project：这个功能的入口在项目树、出口在对话区，
 * 归属谁都别扭；且 i18n 域间键名前缀即域名，独立前缀能避免与 project.* 撞车。
 */
export const zhCode = {
  // ===== 入口与面板 =====
  'code.entryTooltip': '浏览目录',
  'code.backToProjects': '返回项目',
  'code.hiddenIgnored': '已忽略 {n} 项',
  'code.groupRecent': '最近打开',
  'code.groupFiles': '文件',
  'code.groupDirs': '目录',
  'code.tabMoveLeft': '标签页左移',
  'code.tabMoveRight': '标签页右移',
  'code.tabClose': '关闭标签页',
  'code.treeEmpty': '此项目没有可显示的文件',
  'code.treeEmptyHint': 'node_modules、.git、dist 等目录已按规则隐藏。',
  'code.treeError': '此目录无法读取',
  'code.retry': '重试',
  'code.dirOpenFailed': '无法打开目录',
  'code.dirLoadFailed': '目录读取失败',

  // ===== 文件过滤（只搜文件名）=====
  'code.filterPlaceholder': '按文件名过滤',
  'code.filterClear': '清除过滤',
  'code.filterSearching': '搜索中…',
  'code.filterNone': '没有匹配的文件',
  'code.filterTruncated': '结果过多，仅显示前 {n} 个',
  'code.filterHint': '仅按文件名匹配，不搜索文件内容',
  'code.treeItems': '共 {n} 项',
  'code.filterCount': '{n} 个结果',

  // ===== 标签与面包屑 =====
  'code.closeTab': '关闭 {name}',
  'code.noFile': '未选择文件',

  // ===== 查看器状态 =====
  'code.pickFileTitle': '在左侧选择一个文件',
  'code.pickFileHint': '展开目录后点击文件，即可在站内只读查看代码。',
  'code.loading': '读取中…',
  'code.binaryTitle': '二进制文件，无法在站内预览',
  'code.binaryHint': '图片、音视频、压缩包等没有文本内容，请用系统默认程序或编辑器打开。',
  'code.tooBigTitle': '文件过大，已截断显示',
  'code.tooBigHint': '已显示前 {shown} 行，共 {total} 行。完整内容请用编辑器打开。',
  'code.missingTitle': '文件已删除或移动',
  'code.missingHint': '路径在磁盘上已不存在，可能是刚被删除、重命名或尚未保存。',
  'code.emptyTitle': '空文件',
  'code.emptyHint': '文件大小为 0 字节。',
  'code.readFailed': '读取失败',
  'code.errorHint': '可重试；若持续失败请检查文件权限，或用外部编辑器打开。',
  'code.nonText': '非文本',
  'code.readOnly': '只读',
  'code.roHint': '内置查看器不支持编辑与保存',
  'code.lines': '行',
  'code.shownLines': '显示 {n} 行（已截断）',
  'code.eolMixed': '混合行尾',
  'code.gitBadge': 'Git 状态：{s}',
  'code.loadMore': '再显示 {n} 行',

  // ===== 布局 =====
  'code.layoutDegraded': '窗口过窄，已临时改用整屏模式（偏好：左右分割）',
  'code.widthPct': '宽度 {n}',
  'code.splitterHint': '拖动中间的分割线调整宽度，双击复位，←/→ 微调',
};
