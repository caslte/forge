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

/**
 * 第一段：常驻偏好。每轮注入，极短。
 *
 * 旧版写的是「解释机制/流程/架构/对比时优先画图」——技术问答的默认形态几乎全被
 * 覆盖，模型于是把纯文字说明也包进 canvas 围栏，产出大量「文字塞卡片」的伪图示
 * （用户实测抱怨的就是这个）。价值排序因此反转：markdown 是默认，canvas 是例外，
 * 且把「纯文字卡片」直接定义为缺陷。
 */
export const CANVAS_STANZA = [
  'Use a ```' + CANVAS_FENCE_LANGUAGE + ' fenced block only when you will actually draw a layout:',
  'boxes connected by arrows, a state machine, or a side-by-side multi-column grid.',
  'A flow you would write as sentences, numbered steps, or inline "A → B → C" is ordinary markdown, not a diagram —',
  'never wrap prose in a canvas block; a card containing only paragraphs of text is a defect.',
].join(' ');

/**
 * 第二段：命中显式出图请求后追加的完整输出规范。仅本轮生效。
 *
 * 开头是条件式而非指令式：detect 命中只说明用户话里出现了「图」这个字，不保证
 * 答案真有空间结构，所以规范本身必须留「markdown 照样能答就别画」的出口——否则
 * 契约的存在本身就是把模型往画图上压（旧版「文字塞卡片」的推手之一）。
 */
export const CANVAS_SPEC: readonly string[] = [
  '## Diagram output contract (this turn)',
  '',
  `The user asked for a diagram. Emit a \`\`\`${CANVAS_FENCE_LANGUAGE} fenced block containing a self-contained HTML fragment — but only if the answer has a genuinely visual structure (boxes, arrows, lanes, timelines, grids).`,
  'Plain markdown — headings, lists, tables — is the default and carries most answers; when it does, skip the card and write markdown instead.',
  'The host renders the fragment inside a sandboxed iframe card, inline in your reply, so the user sees the picture without leaving the conversation.',
  '',
  'Hard rules — violating any of them makes the card render as a blank box, a plain-text block, or a code block:',
  '',
  '1. The fragment must be a drawn layout: flex/grid boxes with borders, an SVG, or a table — with SHORT labels inside the boxes. A grid of styled paragraphs is still prose; sentences and numbered steps belong in markdown, not inside the card. The host detects paragraph-only fragments and long sentences and degrades them to plain text.',
  '2. No `<script>`, no inline event handlers (`onclick` and friends), no `<iframe>`. The sandbox has every permission turned off, so scripts silently do nothing; writing them only wastes output.',
  '3. No external resources: no `<link>`, no remote `<img src="http...">`, no web fonts, no CDN anything. The sandbox is cross-origin isolated and fetches nothing.',
  '4. Style with the CSS variables the host injects, never hardcoded colors, so one diagram looks right in both dark and light themes:',
  '   `--c-bg` `--c-fg` `--c-muted` `--c-muted-fg` `--c-surface` `--c-border`',
  '   `--c-ok` `--c-warn` `--c-bad` `--c-accent`',
  '   `--c-ok-bg` `--c-warn-bg` `--c-bad-bg` (tinted fills for the matching semantic color)',
  '   Use `<div style="...">` inline or one `<style>` block; both work.',
  '5. Flow layout only, `width: 100%`. No `position: fixed/absolute` tricks, no viewport units for height — the card is a fixed-size box that scrolls internally.',
  '6. The card is ~320px tall by default with its own scrollbar. Put the load-bearing comparison in the first screenful; anything below is reachable by scrolling but reads as secondary.',
  '7. Label in the user\'s language. Keep prose around the card short: the card carries the structure, so do not restate it as a list right before or after.',
  '8. One card per reply unless the request genuinely has several independent structures.',
  '',
  'If the answer turns out to be plain facts, a short list, or a table, skip the card and answer in markdown.',
];
