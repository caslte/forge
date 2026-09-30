/**
 * zh-CN 合并字典：界面文案唯一事实来源（键集为 MessageKey 类型基准）。
 * 键按域拆分在 ./domains/*.ts（迁移批次见 docs/prd/08_ui_i18n.md I18N-F03）；
 * 域间键名前缀即域名，禁止跨域重名（spread 后写覆盖静默生效，靠纪律防范）。
 */
import { zhCommon } from './domains/common.ts';
import { zhApp } from './domains/app.ts';
import { zhDialogs } from './domains/dialogs.ts';
import { zhInput } from './domains/input.ts';
import { zhChat } from './domains/chat.ts';
import { zhTool } from './domains/tool.ts';
import { zhSettings } from './domains/settings.ts';
import { zhProject } from './domains/project.ts';
import { zhPanels } from './domains/panels.ts';
import { zhSkills } from './domains/skills.ts';
import { zhGit } from './domains/git.ts';
import { zhTerminal } from './domains/terminal.ts';

export const zhCN = {
  ...zhCommon,
  ...zhApp,
  ...zhDialogs,
  ...zhInput,
  ...zhChat,
  ...zhTool,
  ...zhSettings,
  ...zhProject,
  ...zhPanels,
  ...zhSkills,
  ...zhGit,
  ...zhTerminal,
} as const;

export type MessageKey = keyof typeof zhCN;
