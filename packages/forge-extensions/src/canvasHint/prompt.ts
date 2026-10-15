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
 *
 * 末两句是 2026-09-29 补的最小画法：detect 漏网轮（如「你画一个图」）模型只有
 * 这一段，它知道有 canvas 却不知道卡里放什么，于是幻觉出「pi 原生 canvas 内部
 * 渲染 mermaid 成 ASCII」交了裸 mermaid 文本。只钉「围栏体是 HTML+CSS、不是
 * mermaid、没有别的渲染器」这一件事——不教细节，不构成「每轮都画」的推力。
 */
export const CANVAS_STANZA = [
  'Use a ```' + CANVAS_FENCE_LANGUAGE + ' fenced block whenever you would otherwise write the structure out as a list:',
  'boxes connected by arrows, a state machine, a layered architecture, or a side-by-side multi-column grid.',
  'The fence body is a self-contained HTML+CSS fragment (inline styles or one <style> block) —',
  'not mermaid syntax, and there is no built-in renderer: only the host card displays it.',
  'It must be written in your reply text. Never produce a diagram via a file write, command line, or any other tool —',
  'the user sees only what is in your reply, and tool-produced output is invisible to them.',
].join(' ');

/**
 * 第二段：命中显式出图请求后追加的完整输出规范。仅本轮生效。
 *
 * 开头是条件式而非指令式：detect 命中只说明用户话里出现了「图」这个字，不保证
 * 答案真有空间结构，所以规范本身必须留「markdown 照样能答就别画」的出口——否则
 * 契约的存在本身就是把模型往画图上压（旧版「文字塞卡片」的推手之一）。
 *
 * 规则 2/5 是 2026-09-29 真机补的：MiniMax 把「画布卡片」直译成 HTML <canvas>
 * 元素、又写死 background:#fff，暗色主题下糊出一大块白底死图。
 */
export const CANVAS_SPEC: readonly string[] = [
  '## Diagram output contract (this turn)',
  '',
  `The user asked for a diagram. Emit a \`\`\`${CANVAS_FENCE_LANGUAGE} fenced block containing a self-contained HTML fragment.`,
  'When to draw: the answer is about components, layers, states, steps, or how things connect — that is the same answer as a picture.',
  'In that case a card IS the answer; do not write the same content as a list and also add a card.',
  'The host renders the fragment inside a sandboxed iframe card, inline in your reply, so the user sees the picture without leaving the conversation.',
  '',
  'Hard rules — violating any of them makes the card render as a blank box, a plain-text block, or a code block:',
  '',
  '1. The fragment must be a drawn layout: flex/grid boxes with borders, an SVG, or a table — with SHORT labels inside the boxes. A grid of styled paragraphs is still prose; sentences and numbered steps belong in markdown, not inside the card. The host detects paragraph-only fragments and long sentences and degrades them to plain text.',
  '2. Never use the HTML `<canvas>` element — the fence name refers to the host card, not that tag. Scripts are off in the sandbox, so `<canvas>` renders blank and its fallback text loses all monospace alignment.',
  '3. No `<script>`, no inline event handlers (`onclick` and friends), no `<iframe>`. The sandbox has every permission turned off, so scripts silently do nothing; writing them only wastes output.',
  '4. No external resources: no `<link>`, no remote `<img src="http...">`, no web fonts, no CDN anything. The sandbox is cross-origin isolated and fetches nothing.',
  '5. Style with the CSS variables the host injects, never hardcoded colors — no `white`, no `#fff`/`#ffffff`/`#f5f5f5`-class light literals, even though your own examples often look right in a light browser: the user may be on a dark theme and only the variables adapt. Use:',
  '   `--c-bg` `--c-fg` `--c-muted` `--c-muted-fg` `--c-surface` `--c-border`',
  '   `--c-ok` `--c-warn` `--c-bad` `--c-accent`',
  '   `--c-ok-bg` `--c-warn-bg` `--c-bad-bg` (tinted fills for the matching semantic color)',
  '   Use `<div style="...">` inline or one `<style>` block; both work.',
  '6. Flow layout only, `width: 100%`. No `position: fixed/absolute` tricks, no viewport units for height — the card is a fixed-size box that scrolls internally.',
  '7. The card is ~320px tall by default with its own scrollbar. Put the load-bearing comparison in the first screenful; anything below is reachable by scrolling but reads as secondary.',
  '8. Label in the user\'s language. Keep prose around the card short: the card carries the structure, so do not restate it as a list right before or after.',
  '9. One card per reply unless the request genuinely has several independent structures.',
  '',
  'Where the content must go — this is not optional:',
  '',
  '- Put the diagram in a fenced block IN THIS REPLY. The user reads the card inline, where you wrote it.',
  '- Do NOT write the diagram to a file, do NOT use a tool, command line, shell, or terminal to produce it,',
  '  and do NOT tell the user to open some other artifact to see it.',
  '  Anything produced by a tool lives outside the conversation: the user sees nothing and no error is reported.',
  '  A diagram only exists to the user if it is in the fenced block of your reply.',
  '',
  'If the answer genuinely has no visual structure at all (a plain fact, a single number, a definition), skip the card and answer in markdown.',
];

/**
 * 第三段：风格规范（命中出图意图时与 CANVAS_SPEC 一起追加）。
 *
 * 定调 2026-10-15（P0 demo 用户拍板）：forge 画布固定一种风格 ——「青瓷数据」
 * （porcelain-data，图例 prototypes/canvas-style-candidates-v2.html 第三列），
 * 不做多风格并立。单一风格是填空题不是选择题：模型不再需要「选一种好看」，
 * 只需要把给定的语法用对 —— 一致性（每张卡都像同一个产品画的）是主要收益。
 *
 * 全部技法零脚本零外链，真机 sandbox="" 下原样可用：
 * - color-mix 派生色（从语义 token 低比例混出暖纸底/瓷青墨），深浅主题自动成立
 * - 纯 CSS 纹理（repeating-gradient 纸纹、radial-gradient 光晕）
 * - 系统字体三员（衬线 Georgia/Songti 压标题与数字、等宽 Consolas 压标签）
 *
 * 与 CANVAS_SPEC 的关系：SPEC 管「能不能渲染出来」（硬约束，违规=白框/代码块），
 * 本段管「渲染出来好不好看」（软约束，违规=卡片平庸但不坏）。两者同轮追加，
 * 风格段放在 SPEC 之后 —— 先能活，再好看。
 */
export const CANVAS_STYLE_SPEC: readonly string[] = [
  '## Card style — "porcelain data" (mandatory, one style for all cards)',
  '',
  'Every card uses this one style. Do not invent your own palette or pick another aesthetic:',
  'consistent-looking cards are the product goal. The two porcelain tokens below (--c-paper,',
  '--c-ink) are computed BY THE HOST per theme — never rebuild them with color-mix yourself,',
  'the same recipe does not hold across light/dark and the result turns muddy.',
  '',
  '1. Paper base: the card sits on warm paper, not a flat background —',
  '   `background: var(--c-paper)`, plus one soft glow layered under it:',
  '   `radial-gradient(100% 70% at 0% 100%, color-mix(in oklab, var(--c-accent) 6%, transparent), transparent 60%)`',
  '   (glow at a corner, never centered).',
  '2. Porcelain ink: headings and key numbers use `color: var(--c-ink)`.',
  '   Body text stays `var(--c-fg)`.',
  '3. Type staff (exactly three roles, nothing else):',
  '   - Serif for the card title and big numbers: `font-family: Georgia, "Songti SC", "SimSun", serif`.',
  '   - Sans (default body font) for explanatory text.',
  '   - Monospace ONLY for small tag chips / data labels: `Consolas, monospace`.',
  '   Big numbers: serif, `font-variant-numeric: tabular-nums`, 22-27px. Section keys: 9.5-10.5px,',
  '   `letter-spacing: .16em`, uppercase, `var(--c-muted-fg)`.',
  '4. Hierarchy by brightness, not hue: the most important element is the darkest ink / largest serif number;',
  '   secondary content steps down in size and lightness. Do not introduce a second accent hue —',
  '   semantic colors (`--c-ok/warn/bad`) appear only as tiny 6-8px dots or +delta text, never as large fills.',
  '5. Structure lines: one hairline `border-top: 1px solid color-mix(in oklab, var(--c-accent) 30%, transparent)`',
  '   under the header. Nodes/panels: `border: 1px solid color-mix(in oklab, var(--c-accent) 35%, transparent)`,',
  '   `border-radius: 8px`, fill `color-mix(in oklab, var(--c-bg) 40%, transparent)`;',
  '   the ONE load-bearing node may take `color-mix(in oklab, var(--c-accent) 10%, var(--c-bg))`.',
  '6. Accent discipline: all accent usage (left border bars, dashed badges, chips, the progress bar)',
  '   stays in the SAME family as `--c-accent`. A dashed pill badge (`border: 1px dashed`,',
  '   `border-radius: 20px`, uppercase, `letter-spacing: .2em`) above the title is the signature opener.',
  '7. Flow arrows between nodes: plain `▼` text, centered, 9px,',
  '   `color: color-mix(in oklab, var(--c-accent) 60%, var(--c-muted-fg))`. No SVG arrows needed.',
  '8. Source line last: 8.5px, uppercase, `letter-spacing: .2em`,',
  '   `color: color-mix(in oklab, var(--c-accent) 45%, var(--c-muted-fg))`, top hairline at 18% accent.',
  '',
  'Reference implementation (open it in a browser to see the target look):',
  '`prototypes/canvas-style-porcelain.html` — the legend page for this style.',
];
