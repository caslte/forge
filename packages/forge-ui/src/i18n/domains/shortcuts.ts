/**
 * 快捷键（模块 13，docs/prd/13_keyboard_shortcuts.md）：设置页「快捷键」Tab 的清单文案。
 * 键前缀 shortcuts.（域间不重名纪律，见 i18n/index.ts）。
 *
 * 只放文案，**不放键位**：键帽字符由 SettingsPanel.vue 经 utils/platformKey.ts 按平台渲染
 * （Mac ⌘ 连写、其他平台 Ctrl 加号），避免重蹈 terminal.toggle 把 "Ctrl+`" 写死在字典里、
 * Mac 上显示就错的覆辙。
 *
 * 注意字宽敏感：本 Tab 每行右侧是键帽组，中英双查标题不得越过键帽左沿（PRD 13 §6）。
 */
export const zhShortcuts = {
  'shortcuts.hint': '快捷键暂不支持自定义，后续版本开放改键。',

  'shortcuts.group.global': '全局快捷键',
  'shortcuts.group.input': '输入与发送',
  'shortcuts.group.dismiss': '打断与关闭',

  'shortcuts.item.term.title': '开合终端面板',
  'shortcuts.item.term.desc': '显示或隐藏底部终端。',
  'shortcuts.item.sidebar.title': '显示 / 隐藏侧栏',
  'shortcuts.item.sidebar.desc': '折叠或展开左侧项目与会话列表。',
  'shortcuts.item.newSession.title': '新建会话',
  'shortcuts.item.newSession.desc': '当前会话的草稿会保留，切回去自动回填。',

  'shortcuts.item.send.title': '发送消息',
  'shortcuts.item.newline.title': '换行',
  'shortcuts.item.atFile.title': '选择文件',
  'shortcuts.item.atFile.desc': '在输入框键入此符号唤起文件选择。',
  'shortcuts.item.slash.title': '斜杠命令',
  'shortcuts.item.slash.desc': '在输入框键入此符号唤起命令列表。',
  'shortcuts.item.thinking.title': '调整思考等级',
  'shortcuts.item.thinking.desc': '展开下拉后可用方向键逐项移动。',

  'shortcuts.item.stopStream.title': '打断流式输出',
  'shortcuts.item.stopStream.desc': '连按两次以确认，防止误触。',
  'shortcuts.item.dismissLayer.title': '关闭当前浮层或弹窗',
  'shortcuts.item.dismissLayer.desc': '图片灯箱、提交弹窗、分支面板、树菜单、消息全屏、变更文件菜单、画布放大、提问面板、历史浮窗。',
  'shortcuts.item.exitCode.title': '退出代码浏览器',
  'shortcuts.item.exitCode.desc': '逐级退出：先关当前文件，再退代码态。',
  'shortcuts.item.dismissSelection.title': '关闭划词复制浮窗',
  'shortcuts.item.dismissSelection.desc': '选中正文文字后出现的浮动按钮。',
} as const;

export const enShortcuts: Record<string, string> = {
  'shortcuts.hint': 'Shortcuts aren’t customizable yet; remapping comes in a later release.',

  'shortcuts.group.global': 'Global shortcuts',
  'shortcuts.group.input': 'Input & sending',
  'shortcuts.group.dismiss': 'Interrupt & dismiss',

  'shortcuts.item.term.title': 'Toggle terminal panel',
  'shortcuts.item.term.desc': 'Show or hide the bottom terminal.',
  'shortcuts.item.sidebar.title': 'Show / hide sidebar',
  'shortcuts.item.sidebar.desc': 'Collapse or expand the project and session list.',
  'shortcuts.item.newSession.title': 'New session',
  'shortcuts.item.newSession.desc': 'The current draft is kept and restored when you switch back.',

  'shortcuts.item.send.title': 'Send message',
  'shortcuts.item.newline.title': 'New line',
  'shortcuts.item.atFile.title': 'Attach a file',
  'shortcuts.item.atFile.desc': 'Type this symbol in the composer to pick a file.',
  'shortcuts.item.slash.title': 'Slash command',
  'shortcuts.item.slash.desc': 'Type this symbol in the composer to list commands.',
  'shortcuts.item.thinking.title': 'Change thinking level',
  'shortcuts.item.thinking.desc': 'Move through options once the picker is open.',

  'shortcuts.item.stopStream.title': 'Stop streaming',
  'shortcuts.item.stopStream.desc': 'Press twice to confirm, so a stray tap won’t cut it off.',
  'shortcuts.item.dismissLayer.title': 'Dismiss the open popover or dialog',
  'shortcuts.item.dismissLayer.desc': 'Image lightbox, commit dialog, branch panel, tree menu, message fullscreen, changed-files menu, canvas zoom, question panel, history popover.',
  'shortcuts.item.exitCode.title': 'Exit code viewer',
  'shortcuts.item.exitCode.desc': 'Steps out: closes the open file first, then leaves code view.',
  'shortcuts.item.dismissSelection.title': 'Close the selection toolbar',
  'shortcuts.item.dismissSelection.desc': 'The floating bar after selecting message text.',
};
