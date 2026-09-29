/**
 * 内嵌终端（模块 10，docs/prd/10_embedded_terminal.md）：面板/tab/终端内提示文案。
 * 键前缀 terminal.（域间不重名纪律，见 i18n/index.ts）。
 * 注意字宽敏感控件（tab/按钮）中英双查（模块 08 经验，PRD §3.5 i18n）。
 */
export const zhTerminal = {
  'terminal.toggle': '终端 (Ctrl+`)',
  'terminal.add': '新建终端（自动使用当前项目目录）',
  'terminal.addNoProject': '先打开一个项目',
  'terminal.empty': '（无终端 — 点 ＋ 新建）',
  'terminal.connecting': '连接中…',
  'terminal.closeTab': '关闭终端',
  'terminal.hidePanel': '收起终端面板',
  'terminal.tintToDark': '终端切换为暗色',
  'terminal.tintToLight': '终端切换为亮色',
  'terminal.exited': '[进程已退出 code={code}]',
  'terminal.spawnFailed': '[终端启动失败] {message}',
  'terminal.tooMany': '终端标签已有 {n} 个，建议关闭不再使用的标签',
} as const;

export const enTerminal: Record<string, string> = {
  'terminal.toggle': 'Terminal (Ctrl+`)',
  'terminal.add': 'New terminal (uses current project directory)',
  'terminal.addNoProject': 'Open a project first',
  'terminal.empty': '(No terminal — click + to create one)',
  'terminal.connecting': 'Connecting…',
  'terminal.closeTab': 'Close terminal',
  'terminal.hidePanel': 'Hide terminal panel',
  'terminal.tintToDark': 'Switch terminal to dark',
  'terminal.tintToLight': 'Switch terminal to light',
  'terminal.exited': '[Process exited code={code}]',
  'terminal.spawnFailed': '[Terminal failed to start] {message}',
  'terminal.tooMany': 'There are {n} terminal tabs. Consider closing unused ones.',
};
