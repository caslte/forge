/**
 * 画布卡片的提示词文本（两段式注入的两段）。
 *
 * 两段式而非一整块：常驻段每轮都在（约 40 token），只负责让模型知道「图优先于编号
 * 列表」这个偏好；完整输出规范只在检测到出图意图的那一轮追加（pi 的
 * before_agent_start 返回 systemPrompt 只对本轮生效，下一轮自动消失）。
 * 一整块常驻会把 token 白花在绝大多数根本不需要画图的轮次上。
 */

/**
 * 画布围栏的语言标记名。
 *
 * 必须与 @forge/core/markdown 的 CANVAS_LANGUAGE 一致，否则围栏对不上、卡片静默
 * 退化成普通代码块（无任何报错可查）。本包不依赖 forge-core（只为一个字符串加跨包
 * 依赖不值得），一致性由 forge-desktop 的跨包回归测试兜底。
 */
export const CANVAS_FENCE_LANGUAGE = 'canvas';

/** 第一段：常驻偏好。每轮注入，极短。 */
export const CANVAS_STANZA = [
  'When explaining a mechanism, flow, architecture, or a before/after comparison,',
  'prefer drawing the structure as an HTML diagram in a ```' + CANVAS_FENCE_LANGUAGE + ' fenced block',
  'over a numbered prose list that the user has to read linearly.',
].join(' ');

/** 第二段：命中出图意图后追加的完整输出规范。仅本轮生效。 */
export const CANVAS_SPEC: readonly string[] = [
  '## Diagram output contract (this turn)',
  '',
  `The user asked for something that benefits from a diagram. Emit it as a \`\`\`${CANVAS_FENCE_LANGUAGE} fenced block containing a self-contained HTML fragment.`,
  'The host renders that fragment inside a sandboxed iframe card, inline in your reply, so the user sees the picture without leaving the conversation.',
  '',
  'Hard rules — violating any of them makes the card render as a blank box or a code block:',
  '',
  '1. No `<script>`, no inline event handlers (`onclick` and friends), no `<iframe>`. The sandbox has every permission turned off, so scripts silently do nothing; writing them only wastes output.',
  '2. No external resources: no `<link>`, no remote `<img src="http...">`, no web fonts, no CDN anything. The sandbox is cross-origin isolated and fetches nothing.',
  '3. Style with the CSS variables the host injects, never hardcoded colors, so one diagram looks right in both dark and light themes:',
  '   `--c-bg` `--c-fg` `--c-muted` `--c-muted-fg` `--c-surface` `--c-border`',
  '   `--c-ok` `--c-warn` `--c-bad` `--c-accent`',
  '   `--c-ok-bg` `--c-warn-bg` `--c-bad-bg` (tinted fills for the matching semantic color)',
  '   Use `<div style="...">` inline or one `<style>` block; both work.',
  '4. Flow layout only, `width: 100%`. No `position: fixed/absolute` tricks, no viewport units for height — the card is a fixed-size box that scrolls internally.',
  '5. The card is ~320px tall by default with its own scrollbar. Put the load-bearing comparison in the first screenful; anything below is reachable by scrolling but reads as secondary.',
  '6. Label in the user\'s language. Keep prose around the card short: the card carries the structure, so do not restate it as a list right before or after.',
  '7. One card per reply unless the request genuinely has several independent structures.',
  '',
  'If the answer is genuinely a short factual reply, skip the card and just answer in prose.',
];
