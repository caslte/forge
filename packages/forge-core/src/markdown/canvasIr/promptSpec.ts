/**
 * 把 schema 渲染成给模型的提示词契约。
 *
 * ## 为什么是「派生」而不是「手写」
 *
 * 改造前 `promptIr.ts` 手写了 `MAX_NODES = 12`、`KINDS = [...]`、
 * `diagram_type` 的两个取值——同一批事实在 `canvasIr.ts` 里还有一份。两处维护的
 * 后果不是「多打几个字」，而是**加一类图时漏改一处、且没有任何测试报错**：
 * 提示词让模型产 `flow`，校验器却只认 `architecture|sequence`，模型照做即被判错。
 *
 * 本文件不存任何事实，只把 `schemaSpec.ts` 渲染成文字。加一类图 = 改 schemaSpec 一处，
 * 提示词自动跟上。
 *
 * ## 两段式沿用既有设计
 *
 * - `IR_STANZA` 常驻（每轮注入，几十 token）：只说「有 IR 这条路，它比写 HTML 可靠」
 * - `IR_SPEC` 命中出图意图才追加：完整契约，仅本轮生效
 *
 * 理由与代价见 `canvasHint/prompt.ts` 文件头，此处不重复论证。
 *
 * ## 措辞原则（本轮收紧）
 *
 * 改造前契约的一条规则是 `流程/时序/先后/调用链 → sequence`——把「流程」和「时序」
 * 并成一类，于是用户要流程图拿到时序图（**合规但不符合图的逻辑**）。
 * 现在四类判据由 `IR_DIAGRAM_SPECS[].when` 各自给出，且**互相排斥**。
 */
import {
  IR_DIAGRAM_SPECS,
  IR_FENCE_LANGUAGE,
  IR_MAX_LABEL_CHARS,
  IR_NODE_KINDS,
  IR_SCHEMA_VERSION,
} from './schemaSpec.ts';

const FENCE = '```' + IR_FENCE_LANGUAGE;

/**
 * 第一段：常驻偏好。每轮注入。
 *
 * 只做一件事：告诉模型「有 IR 这条路，且它比写 HTML 更可靠」。
 * 不教细节——完整契约只在命中出图意图的那一轮追加。
 */
export const IR_STANZA = [
  'When the user asks for a diagram (boxes connected by arrows, a flowchart, a layered architecture,',
  'a sequence of calls, a tree or mind map),',
  // 围栏名不加反引号包裹：'` ```canvas-ir `' 拼出来是 4 个连续反引号，模型容易读成
  // 别的围栏名（真机表现为「卡片不出现」，且没有任何报错）。直接写名字最稳。
  'emit a fenced code block tagged ' + FENCE + ' containing a **typed JSON IR** instead of hand-written HTML.',
  'The host compiles that IR into a polished layout deterministically — you declare *what* the nodes and relationships are,',
  'never *how* they look. Do not write HTML, CSS, colors, coordinates, or pixel values in this fence.',
  'It must be written in your reply text. Never produce a diagram via a file write, command line, or any other tool —',
  'the user sees only what is in your reply, and tool-produced output is invisible to them.',
  'Plain markdown remains right for prose, lists, and tables.',
].join(' ');

/**
 * 每类图一段：由 `when` + `fieldNotes` + `optionalFields` 派生。加类型不用改这里。
 *
 * `optionalFields` 单独列一行，是因为它曾经**只存在于校验器里**：`tree.variant`
 * 被 `layoutTree` 读、被 `judgeIr` 放行，却从没进过提示词，模型因此永远产不出 mindmap。
 * 现在把它显式念给模型听，并由单测断言「声明过的字段一定出现在提示词里」。
 */
function renderTypeBlocks(): string[] {
  const out: string[] = [];
  for (const s of IR_DIAGRAM_SPECS) {
    out.push(`- "${s.type}" — ${s.label}：${s.when}`);
    for (const n of s.fieldNotes) out.push(`    ${n}`);
    if (s.optionalFields.length) {
      out.push(`    optional fields: ${s.optionalFields.map((f) => `\`${f}\``).join(', ')}`);
    }
  }
  return out;
}

/** 每类图的必填字段与节点预算，由 `required` / `mustBeEmpty` / `maxNodes` 派生。 */
function renderFieldMatrix(): string[] {
  const out: string[] = [];
  for (const s of IR_DIAGRAM_SPECS) {
    const empty = s.mustBeEmpty.length ? `；${s.mustBeEmpty.map((f) => `\`${f}\``).join(' / ')} 必须是空数组` : '';
    out.push(
      `   - ${s.type}：必须给 ${s.required.map((f) => `\`${f}\``).join(' + ')}${empty}`
      + `；最多 ${s.maxNodes} 个节点`,
    );
  }
  return out;
}

/**
 * 第二段：命中出图请求后追加的完整契约。仅本轮生效。
 *
 * 措辞原则：**全部用禁令陈述「不做什么」，而不是教怎么做。**
 * 因为模型在新链路里的全部职责就是「描述结构」，任何排版指导都是噪音，
 * 且会诱使它退回写 HTML。
 */
export const IR_SPEC: readonly string[] = [
  '## Diagram IR contract (this turn)',
  '',
  `The user asked for a diagram. Emit ONE fenced block tagged ${FENCE} whose body is a single JSON object.`,
  'This replaces HTML authoring entirely. The host parses the JSON, computes the layout, and renders it.',
  'When to draw: the answer is about components, layers, states, steps, or how things connect —',
  'then the card IS the answer; do not write the same content as a list and also emit a card.',
  '',
  'Hard rules — each violation makes the diagram fail validation and be sent back to you:',
  '',
  '1. The body is **raw JSON only**: no HTML tags, no CSS, no comments, no markdown, no prose before or after.',
  `2. Top level must have exactly: \`schema_version\` ("${IR_SCHEMA_VERSION}"), \`diagram_type\`,`,
  '   `meta` (object, may carry `title`), plus the fields your `diagram_type` requires (see the matrix below).',
  '   Always include `nodes` and `edges` as arrays, even if empty for your type.',
  '3. Choose `diagram_type` by WHAT THE USER WANTS TO SEE. These four are mutually exclusive —',
  '   pick the one that matches, do not fall back to another:',
  ...renderTypeBlocks(),
  '4. Required fields per type (anything else must be an empty array, never omitted):',
  ...renderFieldMatrix(),
  '5. `id` values must be unique and short (lowercase, no spaces). Every edge endpoint MUST exist in `nodes`',
  '   (or in `participants` for sequence).',
  `6. Respect the per-type node budget in the matrix above, and keep every \`label\` under ${IR_MAX_LABEL_CHARS} characters — longer labels are rejected.`,
  '7. No colors, no fonts, no sizes, no margins, no styling of any kind anywhere in the JSON.',
  '8. Do not add a node for every concept you can think of. Pick the ones the user actually asked about.',
  '   Count your nodes before emitting. If the picture needs more than the budget, draw fewer and say what you left out in prose.',
  '9. If the request does not fit any of the four types above, do NOT force it into the closest one.',
  '   Answer in markdown instead and say what you would have needed. A wrong diagram is worse than no diagram.',
  '10. Do not invent fields. Anything not listed above is **silently dropped** — the diagram will not',
  '    show what you intended and no error is reported. In particular there is no `shape` field:',
  '    shape comes from `kind` ("decision" draws a diamond, "terminal" a capsule, "storage" a cylinder).',
  `11. Never use the ${FENCE} fence for an illustrative example. If your answer needs to *show* what`,
  '    the IR format looks like (e.g. when explaining this contract itself), copy it into a plain',
  '    json or text fence instead. A canvas-ir fence is reserved for a diagram you actually intend to be',
  '    rendered: an example placed there is judged as a real diagram, which burns a repair round and',
  '    shows the user a card they never asked for.',
  '12. Never emit a skeleton, placeholder, or first draft inside the fence: no `[...]`, no `…`, no `TODO`,',
  '    no half-written rows you mean to fill in later, and no "a draft block followed by the real one".',
  '    Emit exactly ONE canvas-ir block and make that block complete — every canvas-ir block you write',
  '    is judged as a diagram, so a placeholder there is not a harmless sketch: it fails validation,',
  '    burns a repair round, and shows the user a broken card.',
  '',
  'Where the content must go — this is not optional:',
  '',
  '- Put the diagram in a fenced block IN THIS REPLY. The user reads the card inline, where you wrote it.',
  '- Do NOT write the diagram to a file, do NOT use a tool, command line, shell, or terminal to produce it,',
  '  and do NOT tell the user to open some other artifact to see it.',
  '  Anything produced by a tool lives outside the conversation: the user sees nothing and no error is reported.',
  '  A diagram only exists to the user if it is in the fenced block of your reply.',
  '',
  `Node \`kind\` must be one of: ${IR_NODE_KINDS.map((k) => `"${k}"`).join(', ')}.`,
  'Labels belong in the user\'s language.',
  '',
  'If the answer genuinely has no structure to draw (a plain fact, a single number, a definition), skip the block and answer in markdown.',
];
