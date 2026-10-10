/**
 * 图示 IR 的提示词契约（阶段 1）。
 *
 * 与 canvasHint/prompt.ts 的关系（勿混淆）：
 * - prompt.ts是**现状链路**的契约：教模型怎么写 HTML+CSS
 * - 本文件是**新链路**的契约：让模型改产出 JSON IR，样式与排版全部不管
 *
 * 两段式沿用 prompt.ts 的既有设计（常驻段极短 + 命中出图意图才追加完整契约），
 * 理由与代价见 prompt.ts 文件头，本文件不重复论证。
 *
 * 与prompt.ts 的关键差别（这正是方案 A 的本质）：
 * prompt.ts 有 9 条规则在**教排版**（禁 position:absolute、禁硬编码色、限首屏 320px…）；
 * 本文件**一条排版规则都没有**——因为模型不再负责排版。
 * 这是「用结构化替代提示词约束」的落地点，不是新增另一套规则。
 */

/** 围栏语言标记名。与 canvasIr 的 IR 区分开，避免模型混淆两种载荷。 */
export const IR_FENCE_LANGUAGE = 'canvas-ir';

/** 当前 schema 版本。写进契约，避免模型硬编码版本号。 */
const IR_VERSION = 'forge-ir/1';

const MAX_NODES = 12;
const MAX_LABEL = 24;

const KINDS = ['component', 'process', 'boundary', 'external', 'storage', 'dataflow'];

/**
 * 第一段：常驻偏好。每轮注入，控制在几十 token。
 *
 * 只做一件事：告诉模型「有IR 这条路，且它比写 HTML 更可靠」。
 * 不教细节——完整契约只在命中出图意图的那一轮追加。
 */
export const IR_STANZA = [
  'When the user asks for a diagram (boxes connected by arrows, a state machine, a layered architecture),',
  'emit a ` ```' + IR_FENCE_LANGUAGE + ' ` fenced block containing a **typed JSON IR** instead of hand-written HTML.',
  'The host compiles that IR into a polished layout deterministically — you declare *what* the nodes and relationships are,',
  'never *how* they look. Do not write HTML, CSS, colors, coordinates, or pixel values in this fence.',
  'It must be written in your reply text. Never produce a diagram via a file write, command line, or any other tool —',
  'the user sees only what is in your reply, and tool-produced output is invisible to them.',
  'Plain markdown remains right for prose, lists, and tables.',
].join(' ');

/**
 * 第二段：命中出图请求后追加的完整契约。仅本轮生效。
 *
 * 措辞原则：**全部用禁令陈述「不做什么」，而不是教怎么做。**
 * 因为模型在新链路里的全部职责就是「描述结构」，任何排版指导都是噪音，
 * 且会诱使它退回写HTML。
 */
export const IR_SPEC: readonly string[] = [
  '## Diagram IR contract (this turn)',
  '',
  'The user asked for a diagram. Emit ONE `' + '```' + IR_FENCE_LANGUAGE + '`' + ' fenced block whose body is a single JSON object.',
  'This replaces HTML authoring entirely. The host parses the JSON, computes the layout, and renders it.',
  'When to draw: the answer is about components, layers, states, steps, or how things connect —',
  'then the card IS the answer; do not write the same content as a list and also emit a card.',
  '',
  'Hard rules — each violation makes the diagram fail validation and be sent back to you:',
  '',
  '1. The body is **raw JSON only**: no HTML tags, no CSS, no comments, no markdown, no prose before or after.',
  '2. Top level must have exactly: `schema_version` ("' + IR_VERSION + '"), `diagram_type`,',
  '   `meta` (object, may carry `title`), `nodes` (array), `edges` (array).',
  '3. Pick `diagram_type` by WHAT the user wants to see:',
  '   - "architecture": layered structure (who lives in which layer). Add',
  '     `tiers: [ { "row": 0, "name": "渲染层" }, … ]` — one per horizontal layer, in your language.',
  '     Each node\'s `row` MUST match a tier. The tier name IS part of the architecture;',
  '     a diagram without tiers reads as a flowchart, not an architecture.',
  '   - "sequence": a time-ordered flow (call chains, request/response lifecycles, step protocols).',
  '     Use `participants: [ { "id": "ui", "label": "UI" }, … ]` (>= 2) and',
  '     `messages: [ { "from": "ui", "to": "main", "label": "sendMessage" }, … ]`.',
  '     The ARRAY ORDER of messages is the time order (rendered top to bottom);',
  '     sequence numbers (1,2,3…) are added automatically.',
  '     For sequence do NOT emit nodes/edges/col/row/tiers — empty arrays are fine.',
  '     Rule of thumb: 流程/时序/先后/调用链 → sequence; 层/架构/组成 → architecture + tiers.',
  '4. For architecture, each node: `{ "id": string, "label": string, "kind": one of ' + KINDS.map(k => '"' + k + '"').join(', ') + ', "col": int>=0, "row": int>=0 }`.',
  '   `row` selects the tier (layer); `col` orders nodes left-to-right within that layer.',
  '5. For architecture, each edge: `{ "from": id, "to": id, "label"?: string }`. Both endpoints MUST exist in `nodes`.',
  '6. `id` values must be unique and short (lowercase, no spaces).',
  '7. At most ' + MAX_NODES + ' nodes and at most ' + MAX_LABEL + ' characters per `label` — longer labels are rejected.',
  '8. `col` and `row` express **layout intent only** (which column/row this node belongs in).',
  '   The host converts them to pixel positions. Never compute pixel coordinates yourself.',
  '9. No colors, no fonts, no sizes, no margins, no styling of any kind anywhere in the JSON.',
  '10. Do not add a node for every concept you can think of. Pick the ones the user actually asked about.',
  '   If the picture needs more than ' + MAX_NODES + ' nodes, draw fewer and say what you left out in prose.',
  '',
  'Where the content must go — this is not optional:',
  '',
  '- Put the diagram in a fenced block IN THIS REPLY. The user reads the card inline, where you wrote it.',
  '- Do NOT write the diagram to a file, do NOT use a tool, command line, shell, or terminal to produce it,',
  '  and do NOT tell the user to open some other artifact to see it.',
  '  Anything produced by a tool lives outside the conversation: the user sees nothing and no error is reported.',
  '  A diagram only exists to the user if it is in the fenced block of your reply.',
  '',
  'Labels belong in the user\'s language.',
  '',
  'If the answer genuinely has no structure to draw (a plain fact, a single number, a definition), skip the block and answer in markdown.',
];