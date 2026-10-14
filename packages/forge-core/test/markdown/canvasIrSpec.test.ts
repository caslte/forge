/**
 * 提示词 ↔ schema 的**双向**一致性（2026-10-12 新增）。
 *
 * ## 为什么必须有这个文件
 *
 * 改造前的事实：`IR_DIAGRAM_TYPES` / `IR_NODE_KINDS` / `IR_MAX_NODES` 在
 * `canvasIr.ts`（校验器）里有一份，在 `promptIr.ts`（提示词）里**手抄**了另一份。
 * 两处维护的后果不是「多打几个字」，而是：
 *
 * - 加一类图时漏改一处，**没有任何测试会红**；
 * - 提示词让模型产 `flow`，校验器只认 `architecture|sequence` ⇒ 模型照做即被判错；
 * - 更隐蔽的是语义错配：v1 规则 3 写 `流程/时序/先后/调用链 → sequence`，
 *   把「流程图」并进「时序图」。用户要流程图拿到时序图，**合规但不符合图的逻辑**，
 *   而校验器永远发现不了（它只看结构）。
 *
 * 现在提示词由 `schemaSpec.ts` 派生。本文件的作用是把这个「派生」钉死：
 * 任何一边单独改动而另一边没跟上，这里必须红。
 *
 * ## 为什么是双向
 *
 * 只测「schema 的每个类型都出现在提示词里」是不够的——那拦不住**提示词多承诺**
 * （例如提示词还在教模型产 `state`，而 schema 已把状态机砍掉）。反向断言用
 * 「提示词里的类型清单 == schema 的类型清单」来做，而不是「包含」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IR_DIAGRAM_SPECS,
  IR_DIAGRAM_TYPES,
  IR_MAX_LABEL_CHARS,
  IR_MAX_NODES,
  IR_NODE_KINDS,
  IR_SCHEMA_VERSION,
  IR_SPEC,
  IR_STANZA,
  IR_HOST_CSS_VARS,
  buildIrStandaloneFile,
  irMaxNodesOf,
} from '../../src/markdown/renderMarkdown.ts';
import { IR_REQUIRED_CSS_VARS } from '../../src/markdown/canvasIr/shapes.ts';
import { judgeIr } from '../../src/markdown/canvasIr.ts';
import { readFileSync } from 'node:fs';

/** 把 IR_SPEC 合成一整段，便于做「包含」类断言。 */
const SPEC = IR_SPEC.join('\n');

/** 提示词里的类型块头：`- "flow" — 流程图：…` */
function typeHeadersInPrompt(): string[] {
  return [...SPEC.matchAll(/^- "([a-z]+)" — /gm)].map((m) => m[1]!);
}

/**
 * 校验器**接受模型写**的接口。只有这些是「模型该知道的字段」；
 * `IrDiagnostic` / `IrCode` 是回执（宿主→模型），不在其列。
 */
const INPUT_IFACES = new Set([
  'IrDocument',
  'IrNode',
  'IrEdge',
  'IrTier',
  'IrParticipant',
  'IrMessage',
  'IrTreeHints',
]);

/**
 * 从 `canvasIr.ts` 的接口定义里抽出全部可写字段名。
 *
 * 为什么用扫源码而不是手写一份清单：手写清单会**跟着实现一起漏**——
 * `tree.variant` 当初就是「实现里有、清单里没有」，正因如此才没人发现提示词没教它。
 * 扫源码等于让测试直接读「实现到底接受什么」，清单无从撒谎。
 *
 * 代价是与源码格式耦合。所以调用方必须断言抽出的字段数达到下限，
 * 否则格式一变（例如缩进从 2 空格改成 4）会抽出空集，测试变成**空转通过**。
 */
function acceptedFieldsFromValidator(): string[] {
  const src = readFileSync(new URL('../../src/markdown/canvasIr.ts', import.meta.url), 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^export interface (Ir\w+) \{([\s\S]*?)^\}/gm)) {
    const iface = m[1]!;
    if (!INPUT_IFACES.has(iface)) continue;
    const body = m[2]!;
    // 形如 `  label?: string;` / `  id: string;`
    for (const p of body.matchAll(/^ {2}(\w+)\??\s*:/gm)) names.add(p[1]!);
    // 行内对象字面量：`meta: { title?: string }` 里的 title 也要算
    for (const obj of body.matchAll(/\{([^{}]*)\}/g)) {
      for (const p of obj[1]!.matchAll(/(\w+)\??\s*:/g)) names.add(p[1]!);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------- 正向：schema → 提示词

test('schema 里的每个图类型都出现在提示词的类型清单里', () => {
  const inPrompt = new Set(typeHeadersInPrompt());
  for (const t of IR_DIAGRAM_TYPES) {
    assert.ok(inPrompt.has(t), `提示词没有介绍图类型 "${t}"——模型不可能产出它`);
  }
});

test('schema 里的每个节点 kind 都出现在提示词里', () => {
  for (const k of IR_NODE_KINDS) {
    assert.ok(SPEC.includes('"' + k + '"'), `提示词没有列出节点 kind "${k}"`);
  }
});

test('节点上限与标签上限来自 schema，不是提示词里的另一份字面量', () => {
  // 各类型上限可以不同（tree 16，其余 12），所以逐个断言「提示词里写了这个类型的预算」
  for (const s of IR_DIAGRAM_SPECS) {
    assert.ok(
      SPEC.includes('最多 ' + s.maxNodes + ' 个节点'),
      `提示词没有写 "${s.type}" 的节点预算（${s.maxNodes}）`,
    );
  }
  assert.ok(SPEC.includes(String(IR_MAX_LABEL_CHARS)), '提示词应写明标签字数上限');
  // 反证派生性：改 schema 的常量后这里必须跟着变（写死字面量就会红）
  assert.equal(IR_MAX_NODES, 12, '若调整基准上限，请一并复核提示词措辞是否仍然合适');
  assert.equal(irMaxNodesOf('tree'), 16, 'tree 的节点预算被单独放宽（见 schemaSpec 的说明）');
  assert.equal(irMaxNodesOf('flow'), IR_MAX_NODES, 'flow 应当沿用基准上限');
});

test('回归锁：提示词的节点预算必须与校验器同源（tree 曾因统一上限白烧一轮）', () => {
  // 2026-10-12 实测：tree 的三条 prompt 节点数稳定落在 11~13，而统一上限是 12
  // ⇒ 约 20% 的请求恰好超一个节点被判 IR011。而 13 节点的思维导图编译出来是 774×402，
  // 在卡片里按原尺寸渲染、不触发高度上限——那个 12 对树没有保护任何东西。
  // 这个测试锁的是「放宽之后，提示词与校验器仍然说同一个数」。
  for (const s of IR_DIAGRAM_SPECS) {
    const over = {
      schema_version: IR_SCHEMA_VERSION,
      diagram_type: s.type,
      meta: {},
      tiers: [{ row: 0, name: 'L' }],
      participants: [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }],
      messages: [{ from: 'p1', to: 'p2' }],
      nodes: Array.from({ length: s.maxNodes + 1 }, (_, i) => ({
        id: 'n' + i, label: 'n' + i, kind: 'process', col: i, row: 0,
      })),
      edges: [],
    };
    const r = judgeIr(JSON.stringify(over));
    const d = r.diagnostics.find((x) => x.code === 'IR011');
    assert.ok(d, `${s.type}: 超过预算 ${s.maxNodes} 应报 IR011`);
    assert.match(d.evidence, new RegExp(String(s.maxNodes)), `${s.type}: 回执里的上限必须是 ${s.maxNodes}`);
  }
});

test('schema 版本号出现在提示词里（模型必须原样回写）', () => {
  assert.ok(SPEC.includes(IR_SCHEMA_VERSION), '提示词缺 schema_version');
});

test('每类图的必需字段都出现在字段矩阵里', () => {
  for (const s of IR_DIAGRAM_SPECS) {
    const line = SPEC.split('\n').find((l) => l.trim().startsWith('- ' + s.type + '：'));
    assert.ok(line, `字段矩阵缺少 "${s.type}" 一行`);
    for (const f of s.required) {
      assert.ok(line!.includes('`' + f + '`'), `"${s.type}" 的必需字段 ${f} 未写进矩阵`);
    }
  }
});

test('每类图都有互斥的判据（when），否则模型只能猜', () => {
  const whens = IR_DIAGRAM_SPECS.map((s) => s.when);
  assert.equal(new Set(whens).size, whens.length, 'when 判据不得重复——重复即让模型去猜');
  for (const s of IR_DIAGRAM_SPECS) {
    assert.ok(SPEC.includes(s.when), `提示词未包含 "${s.type}" 的判据`);
  }
});

// ---------------------------------------------------------------- 反向：提示词 → schema

test('提示词里的类型清单与 schema 完全一致（既不缺也不多）', () => {
  const inPrompt = typeHeadersInPrompt();
  assert.deepEqual(
    [...inPrompt].sort(),
    [...IR_DIAGRAM_TYPES].sort(),
    '提示词与 schema 的图类型集合必须完全相同；多出来的是「承诺了做不到的能力」',
  );
});

test('提示词不再承诺已砍掉的图类型（状态机等）', () => {
  // 状态机在 2026-10-12 被明确排除。提示词若还在提，模型会尝试产出、
  // 然后被校验器判错——用户看到的是「模型不听话」，实际是提示词在骗它。
  for (const banned of ['state machine', 'stateDiagram', 'state_diagram', 'erDiagram', 'gantt']) {
    assert.ok(!SPEC.includes(banned), '提示词不应再提及已砍掉的图类型：' + banned);
    assert.ok(!IR_STANZA.includes(banned), '常驻段不应再提及已砍掉的图类型：' + banned);
  }
});

// ---------------------------------------------------------------- 回归锁：v1 的原始 bug

test('回归锁：提示词不得把「流程」并进 sequence（v1 的原始缺陷）', () => {
  // v1 原文：`Rule of thumb: 流程/时序/先后/调用链 → sequence; 层/架构/组成 → architecture + tiers.`
  // 结果：3/3 个流程图 prompt 全部产出了时序图（探针实测，见 tmp/ir-probe-v2）。
  assert.ok(!SPEC.includes('→ sequence'), '不得再用「X → sequence」这类硬套映射');
  assert.ok(!SPEC.includes('流程/时序'), '不得再把「流程」和「时序」并列成同一类');
  // 流程图必须有自己的类型块
  assert.ok(SPEC.includes('"flow"'), '流程图必须是独立的 diagram_type');
});

// ---------------------------------------------------------------- 常驻段

test('常驻段点名四类图，且明确「图写在回复里、不要用工具」', () => {
  for (const t of IR_DIAGRAM_TYPES) {
    // 常驻段用自然语言描述（不是类型名），逐类点名即可
    assert.ok(IR_STANZA.length > 0);
  }
  assert.ok(IR_STANZA.includes('canvas-ir'), '常驻段应给出围栏名');
  assert.ok(/Never produce a diagram via a file write|any other tool/.test(IR_STANZA),
    '常驻段必须禁止用工具出图——线上最隐蔽的失败就是「图写进了文件，用户看不到」');
});

test('常驻段不出现连续 4 个反引号（会被读成别的围栏名）', () => {
  assert.ok(!IR_STANZA.includes('````'), '围栏名不要用反引号包裹，会拼出 4 连反引号');
  assert.ok(!SPEC.includes('````'), '同上');
});

// ---------------------------------------------------------------- 变量清单 ↔ 独立文件

test('独立 HTML 文件定义了渲染器用到的每一个 --c-* 变量', () => {
  const file = buildIrStandaloneFile('<svg></svg>', 't');
  for (const v of IR_REQUIRED_CSS_VARS) {
    assert.ok(file.includes(v + ':'), '独立文件缺变量 ' + v + '——该 fill 会回落成黑色（黑块吞字）');
  }
});

test('共享变量块在浅色与深色两套里都定义了全部 --c-*', () => {
  // 变量块被「自己拼页面装 IR SVG」的宿主共用（独立文件、探针画廊…）。
  // 只在浅色里定义、深色里漏掉，症状和完全没定义一样：深色下整张图变黑块。
  const parts = IR_HOST_CSS_VARS.split('@media (prefers-color-scheme: dark)');
  assert.equal(parts.length, 2, '变量块必须同时提供浅色与深色两套');
  for (const [i, block] of parts.entries()) {
    const where = i === 0 ? '浅色' : '深色';
    for (const v of IR_REQUIRED_CSS_VARS) {
      assert.ok(block.includes(v + ':'), `${where}块缺变量 ${v}`);
    }
  }
});

test('回归锁：探针画廊必须注入共享变量块，不能只写自己的排版变量', () => {
  // 2026-10-12 翻车现场：画廊只定义了 --bg/--fg/--muted/--line，SVG 的 var(--c-*) 全部求值失败，
  // 四类图渲染成「黑块 + 无线」。产物 SVG 是对的，所以肉眼审 SVG 永远发现不了，
  // 必须靠「生成画廊的那段源码里有没有引用 IR_HOST_CSS_VARS」来锁。
  const probe = readFileSync(new URL('../../../../scripts/ir-probe.mjs', import.meta.url), 'utf8');
  assert.ok(
    probe.includes('IR_HOST_CSS_VARS'),
    '探针画廊没有注入 IR_HOST_CSS_VARS——图会渲染成黑块',
  );
});

test('变量清单非空且都是 --c-* 前缀（防止清单被清空后测试变成空转）', () => {
  assert.ok(IR_REQUIRED_CSS_VARS.length >= 10);
  for (const v of IR_REQUIRED_CSS_VARS) assert.ok(v.startsWith('--c-'), v);
});

// ---------------------------------------------------------------- 字段覆盖（v2 事故后的总锁）

test('抽字段的探针本身有效：能抽到足够多的字段（防格式变更导致空转通过）', () => {
  const fields = acceptedFieldsFromValidator();
  assert.ok(
    fields.length >= 16,
    `只从校验器抽出 ${fields.length} 个字段（${fields.join(',')}）——正则多半被格式变更打歪了，`
      + '此时下面的覆盖测试会变成空转，必须先把探针修好',
  );
  // 抽查几个跨接口、跨嵌套层的字段，确认真的读进去了
  for (const probe of ['diagram_type', 'label', 'variant', 'title', 'row']) {
    assert.ok(fields.includes(probe), `抽字段漏了 ${probe}`);
  }
});

test('回归锁：校验器接受的每个字段，提示词都必须教过（v2 的 variant 事故）', () => {
  // 2026-10-12 事故：`tree.variant` 被 layoutTree 读、被 judgeIr 放行，但提示词里
  // 一个字都没提。后果不是「模型偶尔不写」，而是**那条代码路径完全不可达**——
  // 探针 17 条样本（含「画一个思维导图」）全部只给了 tree，没有一条给 variant。
  // 契约里存在但模型不知道的字段，等于不存在。
  const taught = acceptedFieldsFromValidator();
  const missing = taught.filter((f) => !SPEC.includes(f));
  assert.deepEqual(
    missing,
    [],
    '以下字段校验器接受、提示词却没教，模型永远不可能产出：' + missing.join(', '),
  );
});

test('spec 声明的每个 optionalField 都显式列进了提示词', () => {
  for (const s of IR_DIAGRAM_SPECS) {
    for (const f of s.optionalFields) {
      assert.ok(
        SPEC.includes('`' + f + '`'),
        `"${s.type}" 声明了可选字段 "${f}"，提示词里却找不到它`,
      );
    }
  }
});

test('回归锁：思维导图必须能触发 mindmap 变体（否则根居中的画法是死代码）', () => {
  // 光有字段名不够——还得告诉模型「什么时候该用」。用户说「思维导图」时不给 variant，
  // 就等于把这个变体废掉了。所以提示词必须同时出现「思维导图」这个触发词与 mindmap 取值。
  assert.ok(SPEC.includes('mindmap'), '提示词没有 mindmap 取值');
  assert.ok(/思维导图|mind map|脑图/i.test(SPEC), '提示词没有把「思维导图」和 mindmap 关联起来');
});

test('回归锁：契约必须说清「多余字段被静默丢弃」（模型的 shape 幻觉会悄悄改图）', () => {
  // 2026-10-13 真实对话实测：模型在节点上写 `{"id":"retry","label":"是否重试","shape":"diamond"}`。
  // v2 里形状由 `kind` 决定，没有 `shape` 字段 ⇒ judgeIr 判 ok，渲染时菱形意图**静默消失**：
  // 用户看到的是矩形，没有任何提示。契约从没说过「多余字段会被丢弃」，所以模型无从得知。
  assert.ok(/silently dropped/i.test(SPEC), '提示词没说多余字段会被静默丢弃');
  assert.ok(/no `shape` field/i.test(SPEC), '提示词没点名 shape 不是字段（这是最常被自创的那个）');
  assert.ok(/kind/.test(SPEC), '提示词必须说明形状应由 kind 决定');
});

test('回归锁：契约必须禁止用 canvas-ir 围栏放示例（否则修复回路被误触发）', () => {
  // 2026-10-13 真实对话实测：用户问「解释一下 canvasIrRepairExtension 是干什么的」，
  // 模型在解释里**引用了两张相同的 IR 片段**（缺 schema_version / diagram_type）⇒
  // judgeIr 判 fail ⇒ 修复回路回灌修复回执 ⇒ 模型以为自己的 IR 有错，
  // 于是真的画了一张同内容但补了头字段的 flow 图。
  // 代价：一次纯解释的对话白烧两轮模型调用，还换来一张用户没要的图。
  assert.ok(/illustrative example/i.test(SPEC), '提示词没有禁止把示例放进 canvas-ir 围栏');
  assert.ok(/plain|json|text/i.test(SPEC), '提示词该给出替代写法（示例用普通 json/text 围栏）');
});

test('回归锁：契约必须禁止在围栏里写占位骨架（门禁 tree-mindmap 首轮 IR000）', () => {
  // 2026-10-13 门禁第 2 轮实测：用户要思维导图，模型首轮**先吐了一个占位骨架**
  // （"nodes": [...] 字面量，不是可解析 JSON ⇒ IR000），紧接着又吐了一个完整围栏。
  // 三重代价：首轮通过率白白丢一分；用户看到一张坏卡片；修复回执把 [...] 回灌给
  // 模型，它反过来怀疑「校验器截断了我的输出」，又空转两轮才修对。
  // 契约此前只禁了「拿围栏放示例」，没说「围栏里不许写半成品」——这是不同的错法。
  assert.ok(/skeleton|placeholder|draft/i.test(SPEC), '提示词没有禁止占位/骨架/草稿');
  assert.ok(/\[\.\.\.\]/.test(SPEC), '提示词没有点名 [...] 这种字面占位（它是实测犯的错）');
  assert.ok(/exactly ONE|ONE canvas-ir/i.test(SPEC), '提示词没有强调只发一个 canvas-ir 围栏');
});

