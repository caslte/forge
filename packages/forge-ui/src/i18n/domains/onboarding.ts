/**
 * 首次使用指引（蒙层聚光灯 tour，形态 A 已由 demo 拍板）：六步逐点高亮。
 * 键前缀 onboarding.（域间不重名纪律，见 i18n/index.ts）。
 *
 * 步骤顺序与锚点在 OnboardingTour.vue 里定义（锚点 = 真实元素上的 data-onboarding 标记），
 * 本域只放文案。缺锚点的步骤自动跳过（全新装通常还没有更新入口行，见 UpdateEntry.vue
 * 的 v-if），所以步数不是写死的 6，计数文案别在字典里硬编码总步数。
 *
 * 注意字宽敏感：卡片定宽 296px、随洞落位。第 2 步（浏览目录）是最长的一条——中文卡高
 * 159px，英文实测涨到 222px（六步里唯一超两行的），再加字就会顶到窗口下沿（demo rect 量过）。
 * 它那一套的零项目备用文案（step.code.empty.*）刻意写得比主文案短，别在扩写时反超。
 */
export const zhOnboarding = {
  'onboarding.eyebrow': '首次使用指引',
  'onboarding.skip': '跳过',
  'onboarding.prev': '上一步',
  'onboarding.next': '下一步',
  'onboarding.done': '开始使用',

  'onboarding.step.tree.title': '项目与会话都在这里',
  'onboarding.step.tree.desc': '一个项目下可以开多个平行会话。右键项目或会话能重命名、移出、清空历史。',
  'onboarding.step.code.title': '项目行尾能浏览目录',
  'onboarding.step.code.desc': '点这个 <> 图标，左栏整栏切成文件树：看文件、本次变更和 Git 提交历史，点返回就回会话树。',
  // 零项目新装专用一套：<> 还没长出来，只能先讲「怎么让它出现」
  'onboarding.step.code.empty.title': '浏览目录要先有项目',
  'onboarding.step.code.empty.desc': '添加项目后，它的行尾会出现 <> 图标：点一下，左栏整栏切成文件树，看文件和 Git 提交历史。',
  'onboarding.step.new.title': '随时开新会话',
  'onboarding.step.new.desc': '互不相干的任务分开问，上下文不会互相污染。旧的随时回来接着聊。',
  'onboarding.step.term.title': '终端在工具条右端',
  'onboarding.step.term.desc': '这个图标开关唤出内置终端，可以在里面自己跑命令、看输出，再点一次收起。',
  'onboarding.step.settings.title': '设置里有什么',
  'onboarding.step.settings.desc': '模型、技能、快捷键、个性化都收在这里。快捷键 Tab 列出本版全部键位。',
  'onboarding.step.update.title': '新版本从这里提示',
  'onboarding.step.update.desc': '有更新时这一行会出现，点开看更新说明再决定装不装。',

  'onboarding.replay.title': '重看使用指引',
  'onboarding.replay.desc': '全屏蒙层，逐个高亮侧栏与工具条上的入口。',
  'onboarding.replay.action': '开始指引',
} as const;

export const enOnboarding: Record<string, string> = {
  'onboarding.eyebrow': 'GETTING STARTED',
  'onboarding.skip': 'Skip',
  'onboarding.prev': 'Back',
  'onboarding.next': 'Next',
  'onboarding.done': 'Start using',

  'onboarding.step.tree.title': 'Projects and sessions live here',
  'onboarding.step.tree.desc': 'One project can hold several parallel sessions. Right-click a project or session to rename it, remove it, or clear its history.',
  'onboarding.step.code.title': 'Browse the folder from the project row',
  'onboarding.step.code.desc': 'That <> icon turns the whole left column into a file tree — files, current changes and Git commit history. Back returns to the session tree.',
  'onboarding.step.code.empty.title': 'Folder browsing needs a project',
  'onboarding.step.code.empty.desc': 'Add one and its row grows a <> icon: click it and this column becomes a file tree with commit history.',
  'onboarding.step.new.title': 'Start a new session any time',
  'onboarding.step.new.desc': 'Unrelated tasks stay in separate sessions so their context never bleeds. Come back to an old one whenever you like.',
  'onboarding.step.term.title': 'The terminal sits at the right end',
  'onboarding.step.term.desc': 'This toggle opens the built-in terminal so you can run commands and read their output yourself.',
  'onboarding.step.settings.title': 'What is in Settings',
  'onboarding.step.settings.desc': 'Models, skills, keyboard shortcuts and appearance all live here. The Shortcuts tab lists every binding in this build.',
  'onboarding.step.update.title': 'Updates are announced here',
  'onboarding.step.update.desc': 'This row appears when a new build is available. Open it to read the release notes before installing.',

  'onboarding.replay.title': 'Replay the getting-started tour',
  'onboarding.replay.desc': 'Full-screen overlay that highlights the sidebar and toolbar entry points one by one.',
  'onboarding.replay.action': 'Start tour',
};
