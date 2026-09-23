/**
 * Git 提交与推送（模块 11，GC-S11）：状态行/浮窗双入口 + 提交弹窗 + toast 文案。
 * 分支徽标/切换相关键在 project.ts（PM-S05 存量），本域只收新增键。
 */
export const zhGit = {
  'git.entryLabel': '提交或推送',
  'git.entryTooltip': '提交或推送当前项目变更',
  'git.branchEntry': '提交或推送…',
  'git.title': '提交或推送',
  'git.subPre': '提交 ',
  'git.subPost': ' 中的变更。',
  'git.detachedSuffix': '（分离 HEAD）',
  'git.msgPlaceholder': '输入提交说明（可点「AI 生成」自动补充）…',
  'git.aiGenerate': 'AI 生成',
  'git.includeUnstaged': '包含未暂存变更',
  'git.push': '推送',
  'git.commitAndPush': '提交并推送',
  'git.commit': '提交',
  'git.stagedEmptyTip': '暂存区为空，勾选「包含未暂存变更」或先 git add',
  'git.commitOkPushFail': '提交成功（{hash}），但推送失败：',
  'git.doingCommit': '提交中…',
  'git.doingPush': '推送中…',
  'git.toastCommitted': '已提交 {hash} · {count} 个文件',
  'git.toastPushed': '已推送到 {remote}/{branch}',
  'git.toastCommittedPushed': '已提交 {hash} · {count} 个文件，并已推送到 {remote}/{branch}',
} as const;

export const enGit: Record<string, string> = {
  'git.entryLabel': 'Commit or Push',
  'git.entryTooltip': 'Commit or push current project changes',
  'git.branchEntry': 'Commit or Push…',
  'git.title': 'Commit or Push',
  'git.subPre': 'Commit changes in ',
  'git.subPost': '.',
  'git.detachedSuffix': ' (detached HEAD)',
  'git.msgPlaceholder': 'Enter a commit message, or click "AI generate"…',
  'git.aiGenerate': 'AI generate',
  'git.includeUnstaged': 'Include unstaged changes',
  'git.push': 'Push',
  'git.commitAndPush': 'Commit & Push',
  'git.commit': 'Commit',
  'git.stagedEmptyTip': 'Nothing staged — tick "Include unstaged changes" or git add first',
  'git.commitOkPushFail': 'Committed ({hash}), but push failed:',
  'git.doingCommit': 'Committing…',
  'git.doingPush': 'Pushing…',
  'git.toastCommitted': 'Committed {hash} · {count} files',
  'git.toastPushed': 'Pushed to {remote}/{branch}',
  'git.toastCommittedPushed': 'Committed {hash} · {count} files, pushed to {remote}/{branch}',
};
