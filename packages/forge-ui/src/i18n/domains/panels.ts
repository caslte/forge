export const zhPanels = {
  // ===== Todo 面板（TodoPanel.vue / utils/todoPanel.ts）=====
  'panels.todo.completedPrefix': '已完成',
  'panels.todo.totalSuffix': ' / 共 {total} 个',
  'panels.todo.untitled': '（无标题）',

  // ===== 子 Agent 面板（SubagentResultView.vue / SubagentTabBar.vue）=====
  'panels.subagent.statusQueued': '排队中',
  'panels.subagent.statusRunning': '运行中',
  'panels.subagent.statusCompleted': '已完成',
  'panels.subagent.statusFailed': '失败',
  'panels.subagent.statusStopped': '已终止',
  'panels.subagent.elapsedSeconds': '{seconds} 秒',
  'panels.subagent.elapsedMinutes': '{minutes} 分 {seconds} 秒',
  'panels.subagent.elapsedHours': '{hours} 小时 {minutes} 分',
  'panels.subagent.thinking': '正在思考…',
  'panels.subagent.outputting': '正在输出…',
  'panels.subagent.stop': '终止',
  'panels.subagent.stopTooltip': '终止此子 Agent（不可逆，需二次确认）',
  'panels.subagent.toolCalls': '工具调用',
  'panels.subagent.toolCallCount': '{count} 次',
  'panels.subagent.noResult': '无结果输出',
  'panels.subagent.execFailed': '执行失败',
  'panels.subagent.noError': '无错误信息',
  'panels.subagent.usageInput': '输入 {tokens} tokens',
  'panels.subagent.usageOutput': '输出 {tokens} tokens',
  'panels.subagent.tabbarAria': '子 Agent Tab 栏',
  'panels.subagent.mainSession': '主会话',
  'panels.subagent.closeTabAria': '关闭 Tab',
  'panels.subagent.runningTabCloseAria': '运行中 Tab 不可关闭',
  'panels.subagent.clearAllTooltip': '清除全部终态 Tab',

  // ===== 多窗口画布（MultiWindowCanvas.vue）=====
  'panels.multiwin.session': '会话 {id}',
  'panels.multiwin.sessionFallback': '会话',
  'panels.multiwin.canvasHint': '把左侧会话拖到画布开窗，多个会话可并排观察。',
  'panels.multiwin.openInSingle': '在单视图打开',
  'panels.multiwin.closeWindow': '关闭窗口',
} as const;

export const enPanels: Record<string, string> = {
  // ===== Todo panel =====
  'panels.todo.completedPrefix': 'Completed',
  'panels.todo.totalSuffix': ' / {total} total',
  'panels.todo.untitled': '(Untitled)',

  // ===== Subagent panels =====
  'panels.subagent.statusQueued': 'Queued',
  'panels.subagent.statusRunning': 'Running',
  'panels.subagent.statusCompleted': 'Completed',
  'panels.subagent.statusFailed': 'Failed',
  'panels.subagent.statusStopped': 'Stopped',
  'panels.subagent.elapsedSeconds': '{seconds}s',
  'panels.subagent.elapsedMinutes': '{minutes}m {seconds}s',
  'panels.subagent.elapsedHours': '{hours}h {minutes}m',
  'panels.subagent.thinking': 'Thinking…',
  'panels.subagent.outputting': 'Writing…',
  'panels.subagent.stop': 'Stop',
  'panels.subagent.stopTooltip': 'Stop this subagent (irreversible, requires confirmation)',
  'panels.subagent.toolCalls': 'Tool calls',
  'panels.subagent.toolCallCount': '{count} runs',
  'panels.subagent.noResult': 'No result output',
  'panels.subagent.execFailed': 'Execution failed',
  'panels.subagent.noError': 'No error message',
  'panels.subagent.usageInput': 'Input {tokens} tokens',
  'panels.subagent.usageOutput': 'Output {tokens} tokens',
  'panels.subagent.tabbarAria': 'Subagent tab bar',
  'panels.subagent.mainSession': 'Main session',
  'panels.subagent.closeTabAria': 'Close tab',
  'panels.subagent.runningTabCloseAria': 'Running tabs cannot be closed',
  'panels.subagent.clearAllTooltip': 'Clear all finished tabs',

  // ===== Multi-window canvas =====
  'panels.multiwin.session': 'Session {id}',
  'panels.multiwin.sessionFallback': 'Session',
  'panels.multiwin.canvasHint': 'Drag sessions from the left onto the canvas to open windows; multiple sessions can be observed side by side.',
  'panels.multiwin.openInSingle': 'Open in single view',
  'panels.multiwin.closeWindow': 'Close window',
};
