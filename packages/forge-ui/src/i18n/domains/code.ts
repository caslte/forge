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
  'code.loadMore': '再显示 {n} 行',

  // ===== 布局 =====
  'code.layoutDegraded': '窗口过窄，已临时改用整屏模式（偏好：左右分割）',
  'code.widthPct': '宽度 {n}',
  'code.splitterHint': '拖动中间的分割线调整宽度，双击复位，←/→ 微调',

  // ===== Git 变更视图 + 提交条（2026-10-03） =====
  'code.viewFiles': '文件',
  'code.viewChanges': '变更',
  // CE-S11：Git 提交历史视图（PRD 12 §3.7）
  'code.viewHistory': '历史',
  'code.groupChanged': '本次变更',
  'code.changesViewModes': '变更清单形态',
  'code.changesFlat': '平铺',
  'code.changesTree': '级联',
  'code.changesFlatTitle': '平铺清单：全部变更文件一列排开',
  'code.changesTreeTitle': '按目录分层，默认展开；点目录折叠',
  'code.gitLoading': '正在读取 Git 状态…',
  'code.notGitRepo': '此项目不是 Git 仓库',
  'code.noChanges': '没有未提交的变更',
  'code.noChangesHint': '工作区与 HEAD 一致。新增、修改或删除文件后会自动刷新。',
  'code.gitChangedCount': '{n} 个未提交变更',
  'code.gitPendingFiles': '{n} 个文件待提交',
  'code.commitOrPush': '提交或推送',

  // ===== 并排 diff（模块 12 P2，2026-10-03） =====
  'code.modeSwitcher': '正文形态',
  'code.modeFile': '文件',
  'code.modeInline': '行内',
  'code.modeDiff': '并排',
  'code.delBlockBar': '此处删除了 {n} 行（点击展开）',
  'code.diffOmitted': '未变更 {n} 行',
  'code.diffNoChangesTitle': '此文件没有未提交的改动',
  'code.diffBinaryTitle': '二进制文件不显示对比',
  'code.diffBinaryHint': '内容无法按行对比，可用右侧菜单在外部工具中查看。',
  'code.diffFailTitle': '对比加载失败',
  'code.diffFailHint': 'git diff 没有返回结果，可稍后重试。',
  'code.diffVsHead': '相对 HEAD',

  // ===== CE-S11 Git 提交历史视图 =====
  'code.historyFilterPlaceholder': '按说明 / 作者筛选',
  'code.historyFilterHint': '仅筛选已加载的提交（当前页），不搜索更早的历史',
  'code.historyLoading': '正在读取提交历史…',
  'code.historyNotGitRepo': '此项目不是 Git 仓库',
  'code.historyNotGitRepoHint': '没有版本历史可看。',
  'code.historyEmpty': '还没有任何提交',
  'code.historyEmptyHint': '在终端里完成第一次提交后，这里会出现记录。',
  'code.historyNoMatch': '没有匹配的提交',
  'code.historyNoMatchHint': '试试作者名或说明里的关键词。',
  'code.historyLoadMore': '加载更多提交',
  'code.historyMergeTag': '合并',
  'code.historyFirstCommitTag': '首次提交',
  'code.historyCommitSha': '复制 SHA',
  'code.historyShaCopied': '已复制',
  'code.historyNoFiles': '此提交没有文件变更',
  'code.historyBinaryFile': '二进制文件不显示差异',
  'code.historyBinaryHint': '内容无法按行对比，可用外部工具查看。',
  'code.historyNoLineChange': '此文件在该提交中没有行级变化（纯重命名或仅改权限）',
  'code.historyDiffFail': '差异加载失败',
  'code.historyFilesTitle': '{n} 个文件',
  'code.pickCommitTitle': '选择左侧的一条提交',
  'code.pickCommitHint': '点开提交即可查看谁写的、改了哪些文件。',
  'code.historyExpandBody': '展开完整提交说明',
};
