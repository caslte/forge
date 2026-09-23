/**
 * 斜杠命令基础层纯函数（CV-S08，AC-CV-026~030，U-CV-011/012）。
 *
 * 设计约束（docs/api/03_conversation.md §9「斜杠命令清单」）：
 * - 纯 TS、运行时依赖仅 ../i18n（展示文案 SOURCE_LABELS 惰性取字典；逻辑函数零依赖），
 *   Node type stripping 可直跑（先例 utils/conversationTimeline.ts）；
 * - 匹配/过滤一律按原始 name（skill 命令带 `skill:` 前缀，不含 `/`）；
 *   选中后经 buildInsertion 以 `/` + 原始名 + 尾随空格替换 [lineStart, prefixEnd)
 *   区间，美化名（formatCommandLabel 产物）绝不进入输入框（AC-CV-029）；
 * - 激活条件（AC-CV-026）：光标所在行行首为 `/` 且 `/` 后至光标无空白；
 *   行内空格后关闭（AC-CV-030）；
 * - 全部函数对畸形输入（非字符串、光标越界/负数/非整数等）不抛异常、
 *   不产生 undefined/NaN。
 */
import type { SlashCommand } from '../bridge';
import { i18n } from '../i18n/index.ts';

/** 激活态：光标所在行行首为 `/` 且 `/` 后至光标无空白 */
export interface ActiveSlashContext {
  active: true;
  /** 过滤串：`/` 后至光标的文本（空串 = 刚输入 `/`，列全量命令） */
  filter: string;
  /** 光标所在行行首偏移（= 待替换区间起点） */
  lineStart: number;
  /** 光标偏移（= 待替换区间终点，exclusive） */
  prefixEnd: number;
}

/** 未激活态 */
export interface InactiveSlashContext {
  active: false;
}

/** 斜杠上下文检测结果（判别联合，按 active 收窄） */
export type SlashContext = ActiveSlashContext | InactiveSlashContext;

const INACTIVE: InactiveSlashContext = { active: false };

/**
 * 检测光标处是否处于斜杠命令上下文（AC-CV-026 触发 / AC-CV-030 关闭）。
 *
 * 激活 → { filter, lineStart, prefixEnd }：filter 为 `/` 后至光标的文本，
 * [lineStart, prefixEnd) 即浮窗确认后待替换的原始区间。
 * 不激活：句中 `/`、行内空格之后、空文本、光标在行首 `/` 之前、
 * caret 越界/负数/非整数等一律返回 { active: false }。
 */
export function detectSlashContext(text: string, caret: number): SlashContext {
  if (typeof text !== 'string' || text === '') return INACTIVE;
  if (typeof caret !== 'number' || !Number.isFinite(caret) || !Number.isInteger(caret)) return INACTIVE;
  if (caret < 0 || caret > text.length) return INACTIVE;
  // 行首 = 光标前文本中最后一个换行之后（光标前无换行则为 0）
  const before = text.slice(0, caret);
  const nl = before.lastIndexOf('\n');
  const lineStart = nl === -1 ? 0 : nl + 1;
  if (text[lineStart] !== '/') return INACTIVE;
  // 光标须在行首 '/' 之后：压在 '/' 上（其前）说明命令尚未进入光标左侧
  if (caret <= lineStart) return INACTIVE;
  const filter = text.slice(lineStart + 1, caret);
  if (/\s/.test(filter)) return INACTIVE; // 行内空格后关闭（AC-CV-030）
  return { active: true, filter, lineStart, prefixEnd: caret };
}

/**
 * 构建选中命令的插入串（AC-CV-029）：`/` + 原始命令名 + 尾随空格。
 * 用于替换输入文本的 [lineStart, prefixEnd) 区间；美化名绝不进入。
 */
export function buildInsertion(commandName: string): string {
  const name = typeof commandName === 'string' ? commandName : '';
  return '/' + name + ' ';
}

/**
 * 按过滤串模糊匹配命令（AC-CV-028，用户裁定 2026-09-03：由前缀匹配放宽为包含
 * 匹配——只记得命令名中间文字或描述关键词时也能命中）：匹配键为原始 name
 * （含 `skill:` 前缀）或描述，大小写不敏感；空串返回全量副本；无匹配返回空
 * 数组；不修改入参、保持清单原序（不做相关度排序）。
 */
export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  if (!Array.isArray(commands)) return [];
  const f = typeof filter === 'string' ? filter.toLowerCase() : '';
  return commands.filter((c) => {
    if (!c || typeof c.name !== 'string') return false;
    if (c.name.toLowerCase().includes(f)) return true;
    return typeof c.description === 'string' && c.description.toLowerCase().includes(f);
  });
}

/** camel 分段：在小写/数字 → 大写转换处切开（writeTests → write|Tests） */
function splitCamel(seg: string): string[] {
  return seg.split(/(?<=[a-z0-9])(?=[A-Z])/);
}

/** 首字母大写、其余小写（git → Git；Tests → Tests） */
function capitalize(word: string): string {
  if (word === '') return '';
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * 命令显示名美化（AC-CV-027）：剥 `/` 与 `skill:` 前缀后，按 kebab/snake/camel
 * 分段、各段首字母大写（git-push → Git Push；skill:git-push → Git Push；
 * writeTests → Write Tests；review-pr → Review Pr）。
 * 空串/纯符号等畸形输入返回原串或空串，不抛异常。
 */
export function formatCommandLabel(name: string): string {
  if (typeof name !== 'string') return '';
  let s = name;
  if (s.startsWith('/')) s = s.slice(1);
  if (s.startsWith('skill:')) s = s.slice('skill:'.length);
  if (s === '') return '';
  const segments = s
    .split(/[-_]/)
    .flatMap((seg) => (seg === '' ? [] : splitCamel(seg)))
    .map(capitalize);
  if (segments.length === 0) return s; // 纯符号等畸形：原样返回
  return segments.join(' ');
}

/** 来源标签映射（AC-CV-027 副标签）：skill=技能；extension=命令；prompt=模板。
 *  展示文案走 i18n 字典（模块 08）：getter 惰性取值，保持对象访问形态与 zh 值逐字不变 */
export const SOURCE_LABELS: Record<SlashCommand['source'], string> = {
  get skill() {
    return i18n.t('input.slash.sourceSkill');
  },
  get extension() {
    return i18n.t('input.slash.sourceExtension');
  },
  get prompt() {
    return i18n.t('input.slash.sourcePrompt');
  },
};

/** 消息气泡里的命令展示段（用户消息美化渲染用） */
export interface MessageCommandDisplay {
  /** 原始命令名（不带前导 /；skill 命令带 skill: 前缀），美化名经 formatCommandLabel 派生 */
  name: string;
  /** 来源；原始串无法判定（无 skill: 前缀）时为 null，不渲染标签 */
  source: SlashCommand['source'] | null;
  /** 命令后的剩余正文（无则为空串） */
  rest: string;
}

/** pi 技能展开持久化形态：<skill name="x" location="...">指令文档</skill> + 尾部用户正文 */
const SKILL_BLOCK_RE =
  /^<skill name="([^"]+)" location="[^"]*">[\s\S]*?<\/skill>\s*([\s\S]*)$/;

/**
 * 从用户消息内容识别斜杠命令展示段（两种形态，供消息气泡美化）：
 * - 原始串（发送时内存态）：`/skill:gen-doc-all 正文` / `/review-pr`——行首 / + 无空白 token，
 *   与浮窗插入语法一致；token 含 / 或空格即不算命令（/usr/bin/x 不误伤）。
 *   ponytail: /etc hosts 这类小写标识符开头的普通文本会误美化为命令名，纯外观影响，接受。
 * - pi 展开持久化（历史重载态）：<skill> 指令文档整块收起不展示，只留尾部用户正文。
 * 非命令消息返回 null；非字符串/空串不抛异常。
 */
export function extractCommandFromMessage(content: string): MessageCommandDisplay | null {
  if (typeof content !== 'string' || content === '') return null;
  const expanded = SKILL_BLOCK_RE.exec(content);
  if (expanded !== null) {
    return { name: expanded[1] ?? '', source: 'skill', rest: (expanded[2] ?? '').trim() };
  }
  const raw = /^\/([A-Za-z][\w:-]*)(?:[ \t]+([\s\S]*))?$/.exec(content);
  if (raw === null) return null;
  const name = raw[1] ?? '';
  return {
    name,
    source: name.startsWith('skill:') ? 'skill' : null,
    rest: (raw[2] ?? '').trim(),
  };
}

/** 正文分段（用户消息气泡渲染用）：文本段原样展示；skill 段渲染为浮窗同款美化 */
export interface MessageBodySegment {
  kind: 'text' | 'skill';
  /** text 段 = 原文片段；skill 段 = 技能名（不含 /skill: 前缀） */
  text: string;
}

/** 技能引用 token：/skill: + 技能名字符集（字母/数字/下划线/连字符），中文标点、/ 等不吞 */
const SKILL_REF_RE = /\/skill:([A-Za-z0-9_-]+)/g;

/**
 * 把正文里全部 /skill:name 引用切段供逐段美化（用户裁定：样式归 forge，
 * 执行语义归 pi——美化不代表该引用会被 pi 展开，pi 仅认领消息开头的第一个命令）。
 * 无引用返回单 text 段；空串/非字符串返回 []，不抛异常。
 */
export function splitSkillRefs(body: string): MessageBodySegment[] {
  if (typeof body !== 'string' || body === '') return [];
  const segments: MessageBodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(SKILL_REF_RE)) {
    const idx = m.index;
    if (idx > last) segments.push({ kind: 'text', text: body.slice(last, idx) });
    segments.push({ kind: 'skill', text: m[1] ?? '' });
    last = idx + m[0].length;
  }
  if (last < body.length) segments.push({ kind: 'text', text: body.slice(last) });
  return segments;
}
