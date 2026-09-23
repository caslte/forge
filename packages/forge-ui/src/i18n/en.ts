/**
 * en 合并字典：允许缺键（回退 zh-CN），迁移推进中逐批补齐。
 */
import type { MessageKey } from './zh-CN.ts';
import { enCommon } from './domains/common.ts';
import { enApp } from './domains/app.ts';
import { enDialogs } from './domains/dialogs.ts';
import { enInput } from './domains/input.ts';
import { enChat } from './domains/chat.ts';
import { enTool } from './domains/tool.ts';
import { enSettings } from './domains/settings.ts';
import { enProject } from './domains/project.ts';
import { enPanels } from './domains/panels.ts';
import { enSkills } from './domains/skills.ts';
import { enGit } from './domains/git.ts';

export const en: Partial<Record<MessageKey, string>> = {
  ...enCommon,
  ...enApp,
  ...enDialogs,
  ...enInput,
  ...enChat,
  ...enTool,
  ...enSettings,
  ...enProject,
  ...enPanels,
  ...enSkills,
  ...enGit,
};
