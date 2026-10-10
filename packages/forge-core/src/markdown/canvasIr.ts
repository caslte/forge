/**
 * 画布 IR 校验器（阶段 1）。
 *
 * 契约见 docs/plan/canvas-ir-archify-analysis.md。对标 Archify 的 schema validation 层。
 *
 * 定位（阶段 1 的关键取舍）：
 * 本文件**只做结构校验，不做布局计算**。布局是阶段 2 的活。
 * 阶段 1 故意留空布局，是要先回答唯一真风险——「模型能否稳定产出合规 IR」。
 * 若模型连结构都产不对，排版算法做得再好也无物可算。
 *
 * 与 canvasSandbox.ts 的分工：
 * - canvasSandbox 判「这段 HTML 像不像图」——现状链路的事后形态判决
 * - canvasIr 判「这份 IR 合不合法」——本轮新增的事前结构校验
 * 两者并存不冲突：新链路走 canvasIr，旧链路仍由 canvasSandbox 兜底。
 *
 * 设计约束：必须是纯函数（不碰 DOM、不读时钟、不依赖随机数），
 * 因为它要能在 node:test 下回归，且结论不经任何模型判断。
 */

/** 当前 IR schema 版本。模型必须原样回写，宿主据此判断兼容性。 */
export const IR_SCHEMA_VERSION = 'forge-ir/1';

/**
 * IR 围栏的语言标记名。
 *
 * 与 CANVAS_LANGUAGE（'canvas'）刻意分开：两者载荷性质完全不同——
 * canvas 围栏装 HTML（宿主原样塞 iframe），canvas-ir 装 JSON（宿主校验后编译）。
 * 共用一个围栏名会导致分派歧义，且失效是静默的。
 */
export const IR_FENCE_LANGUAGE = 'canvas-ir';

/**
 * 阶段 1 的节点数上限。
 *
 * 取 12 是有意的：阶段 1 要测的是「模型能否稳定产出合规 IR」，
 * 节点越多越容易触发截断与省略。Archify 的 SKILL.md 同样建议
 * 「at most 12 primary nodes」起步。规模问题是阶段 2 之后才该碰的。
 */
export const IR_MAX_NODES = 12;

/** 单个节点标签的字符数上限。超长标签在 320px 卡片里必然溢出。 */
export const IR_MAX_LABEL_CHARS = 24;

/** 放行的图类型。architecture=分层拓扑；sequence=按时间排序的消息流（2026-10-10 加）。 */
export const IR_DIAGRAM_TYPES = ['architecture', 'sequence'] as const;

/** 节点语义类型。kind 决定宿主如何着色与定形状，故必须是受控枚举。 */
export const IR_NODE_KINDS = [
  'component',
  'process',
  'boundary',
  'external',
  'storage',
  'dataflow',
] as const;

export type IrDiagramType = (typeof IR_DIAGRAM_TYPES)[number];
export type IrNodeKind = (typeof IR_NODE_KINDS)[number];

export interface IrNode {
  id: string;
  label: string;
  kind: IrNodeKind;
  /** 列号（从0 起）。布局由宿主计算，模型只给意图。 */
  col: number;
  /** 行号（从 0 起）。 */
  row: number;
}

export interface IrEdge {
  from: string;
  to: string;
  /** 可选的边语义标签，如「转发」「命中」。 */
  label?: string;
}

/** 一条分层泳道：row 是层号（与节点 row 对应），name 是层名。 */
export interface IrTier {
  row: number;
  name: string;
}

/** 时序图参与者（生命线顶端的名字框）。 */
export interface IrParticipant {
  id: string;
  label: string;
}

/** 时序图消息：数组顺序即时间顺序（从上往下渲染），不需要显式 seq。 */
export interface IrMessage {
  from: string;
  to: string;
  label?: string;
}

export interface IrDocument {
  schema_version: string;
  diagram_type: IrDiagramType;
  meta: { title?: string; quality_profile?: 'showcase' | 'standard' };
  /** 可选分层。给了 → 渲染为泳道（架构图视觉语言）；缺省 → 纯网格（流程图观感）。 */
  tiers?: IrTier[];
  /** sequence 专用：参与者生命线。architecture 下忽略。 */
  participants?: IrParticipant[];
  /** sequence 专用：按时间排序的消息。architecture 下忽略。 */
  messages?: IrMessage[];
  nodes: IrNode[];
  edges: IrEdge[];
}

/**
 * 单条诊断。
 *
 * supportedFixes 是刻意设计的：它是「模型能用的修复控件」白名单，
 * 而非自然语言建议。宿主只回灌这些控件，避免模型收到「请修好它」这类
 * 无法执行的话后自由发挥。对标 Archify 的 repair receipt。
 */
export interface IrDiagnostic {
  code: IrCode;
  /** 出问题的具体字段/节点/边 id，便于模型定位。 */
  subject: string;
  /** 实测证据（不是描述，是数值）。 */
  evidence: string;
  detail: string;
  supportedFixes: string[];
}

export type IrCode =
  | 'IR000' | 'IR001' | 'IR002' | 'IR003' | 'IR004' | 'IR005' | 'IR006'
  | 'IR007' | 'IR008' | 'IR009' | 'IR010' | 'IR011' | 'IR012' | 'IR013' | 'IR014' | 'IR015';

export interface IrJudgement {
  verdict: 'ok' | 'fail';
  diagnostics: IrDiagnostic[];
  /** 仅当 verdict==='ok' 时有值；失败时为 null，调用方不得使用未校验的 IR。 */
  ir: IrDocument | null;
}

/** 修复控件文案表。集中管理便于日后加严/放宽，且单测可断言其存在。 */
const FIX = {
  addVersion: '补写 schema_version 为 ' + IR_SCHEMA_VERSION,
  fixType: '把 diagram_type 改为 ' + IR_DIAGRAM_TYPES.join(' 或 '),
  fixNodesArray: '把 nodes 改成数组',
  fixEdgesArray: '把 edges 改成数组',
  dropEdge: '删除该边',
  addNode: '补写该节点，或删除指向它的边',
  renameId: '给节点换一个未被占用的 id',
  dropSelfLoop: '删除这条自环边',
  addLabel: '补写 label',
  fixKind: '把 kind 改为 ' + IR_NODE_KINDS.join(' / '),
  makeInt: '把 col 与 row 改成 0 或正整数',
  splitGraph: ['把节点拆成多张图，每张不超过 ' + IR_MAX_NODES + ' 个'].join('，'),
  shortenLabel: '把 label 压到 ' + IR_MAX_LABEL_CHARS + ' 字以内',
} as const;

/** 解析 JSON；失败返回 null。纯函数，不抛。 */
export function parseIr(source: string): unknown | null {
  if (typeof source !== 'string' || source.trim() === '') return null;
  try {
    const v: unknown = JSON.parse(source);
    return typeof v === 'object' && v !== null ? v : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * 校验一份 IR 源码。
 *
 * 刻意「多报不短路」：一次把所有缺陷列全，让模型一轮改完。
 * 短路会让模型来回试多个轮次，而每次修复都是真 LLM 调用。
 */
export function judgeIr(source: string): IrJudgement {
  const parsed = parseIr(source);
  if (!parsed) {
    return {
      verdict: 'fail',
      ir: null,
      diagnostics: [{
        code: 'IR000',
        subject: 'source',
        evidence: source.length > 80 ? source.slice(0, 80) + '…' : source,
        detail: '不是可解析的 JSON 对象',
        supportedFixes: ['输出纯 JSON，不要包在代码围栏里', '不要加任何解释文字'],
      }],
    };
  }

  const doc = parsed as Record<string, unknown>;
  const out: IrDiagnostic[] = [];
  const add = (d: IrDiagnostic) => out.push(d);

  // ---- 顶层结构 ----
  if (doc.schema_version !== IR_SCHEMA_VERSION) {
    add({
      code: 'IR001',
      subject: 'schema_version',
      // 实测证据要同时含实际值与期望值：只给实际值，模型无从判断该改成什么
      evidence: String(doc.schema_version ?? '(缺失)') + ' ≠ ' + IR_SCHEMA_VERSION,
      detail: 'schema_version 缺失或与当前版本不符',
      supportedFixes: [FIX.addVersion],
    });
  }

  const types = IR_DIAGRAM_TYPES as readonly string[];
  if (typeof doc.diagram_type !== 'string' || !types.includes(doc.diagram_type)) {
    add({
      code: 'IR003',
      subject: 'diagram_type',
      evidence: String(doc.diagram_type ?? '(缺失)'),
      detail: '阶段 1 只接受 ' + types.join(' / '),
      supportedFixes: [FIX.fixType],
    });
  }

  if (!Array.isArray(doc.nodes)) {
    add({
      code: 'IR004',
      subject: 'nodes',
      evidence: typeof doc.nodes,
      detail: 'nodes 必须是数组',
      supportedFixes: [FIX.fixNodesArray],
    });
  }
  if (!Array.isArray(doc.edges)) {
    add({
      code: 'IR004',
      subject: 'edges',
      evidence: typeof doc.edges,
      detail: 'edges 必须是数组',
      supportedFixes: [FIX.fixEdgesArray],
    });
  }

  const nodes: Record<string, unknown>[] = Array.isArray(doc.nodes)
    ? (doc.nodes as Record<string, unknown>[]).filter(isRecord)
    : [];
  const edges: Record<string, unknown>[] = Array.isArray(doc.edges)
    ? (doc.edges as Record<string, unknown>[]).filter(isRecord)
    : [];

  // ---- 引用完整性（先建 id 集合，供节点与边共用） ----
  const idSet = new Set<string>();
  const dupIds = new Set<string>();
  for (const n of nodes) {
    const id = typeof n.id === 'string' ? n.id : '';
    if (!id) continue;
    if (idSet.has(id)) dupIds.add(id);
    else idSet.add(id);
  }
  for (const id of dupIds) {
    add({
      code: 'IR006',
      subject: id,
      evidence: 'id "' + id + '" 出现多次',
      detail: '节点 id 必须唯一，否则边无法解析',
      supportedFixes: [FIX.renameId],
    });
  }

  for (const e of edges) {
    const from = typeof e.from === 'string' ? e.from : '';
    const to = typeof e.to === 'string' ? e.to : '';
    if (!from || !to) {
      add({
        code: 'IR005',
        subject: 'edge',
        evidence: JSON.stringify(e),
        detail: '边必须同时有 from 与 to',
        supportedFixes: ['补写 from 与 to', '或删除该边'],
      });
      continue;
    }
    // 自环：即使节点存在也要报（无意义且会污染布局）
    if (from === to) {
      add({
        code: 'IR007',
        subject: from,
        evidence: from + ' -> ' + to,
        detail: '不允许自环',
        supportedFixes: [FIX.dropSelfLoop],
      });
    }
    for (const [end, val] of [['from', from], ['to', to]] as const) {
      if (!idSet.has(val)) {
        add({
          code: 'IR002',
          subject: val,
          evidence: 'edge.' + end + ' 指向不存在的节点',
          detail: '悬空边：端点不在 nodes 中',
          supportedFixes: [FIX.dropEdge, FIX.addNode + ' ' + val],
        });
      }
    }
  }

  // ---- 节点内容约束 ----
  const kinds = IR_NODE_KINDS as readonly string[];
  for (const n of nodes) {
    const id = typeof n.id === 'string' ? n.id : '(无 id)';

    if (typeof n.label !== 'string' || n.label.trim() === '') {
      add({
        code: 'IR008',
        subject: id,
        evidence: String(n.label ?? '(缺失)'),
        detail: '节点必须有非空 label',
        supportedFixes: [FIX.addLabel],
      });
    } else if (n.label.length > IR_MAX_LABEL_CHARS) {
      add({
        code: 'IR012',
        subject: id,
        evidence: n.label.length + ' 字 > 上限 ' + IR_MAX_LABEL_CHARS,
        detail: '标签过长，在 320px 卡片内必然溢出',
        supportedFixes: [FIX.shortenLabel],
      });
    }

    if (typeof n.kind !== 'string' || !kinds.includes(n.kind)) {
      add({
        code: 'IR009',
        subject: id,
        evidence: String(n.kind ?? '(缺失)'),
        detail: 'kind 必须是受控枚举，宿主按它决定着色',
        supportedFixes: [FIX.fixKind],
      });
    }

    if (!isNonNegInt(n.col) || !isNonNegInt(n.row)) {
      add({
        code: 'IR010',
        subject: id,
        evidence: 'col=' + String(n.col) + ' row=' + String(n.row),
        detail: 'col 与 row 必须是非负整数（只需意图，坐标由宿主算）',
        supportedFixes: [FIX.makeInt],
      });
    }
  }

  // ---- sequence 专属校验（participants/messages；按 diagram_type 分派，不影响 architecture）----
  if (doc.diagram_type === 'sequence') {
    const parts = doc.participants;
    if (!Array.isArray(parts)) {
      add({
        code: 'IR015',
        subject: 'participants',
        evidence: typeof parts,
        detail: 'sequence 必须有 participants 数组（生命线至少两条）',
        supportedFixes: ['补写 participants: [{ id, label }, …]，至少 2 项'],
      });
    } else {
      const okParts = parts.filter(isRecord);
      const ids = new Set<string>();
      for (const t of okParts) {
        const id = typeof t.id === 'string' ? t.id.trim() : '';
        const label = typeof t.label === 'string' ? t.label.trim() : '';
        if (!id || !label) {
          add({
            code: 'IR015',
            subject: id || '(无 id)',
            evidence: 'id=' + String(t.id ?? '(缺失)') + ' label=' + String(t.label ?? '(缺失)'),
            detail: '每个参与者必须有非空 id 与 label',
            supportedFixes: ['补写 id 与 label'],
          });
          continue;
        }
        ids.add(id);
      }
      if (ids.size < 2) {
        add({
          code: 'IR015',
          subject: 'participants',
          evidence: String(ids.size) + ' 个有效参与者',
          detail: '生命线至少两条（一条自己发消息给自己不成时序）',
          supportedFixes: ['补参与者到至少 2 个'],
        });
      }
      // 消息端点引用校验（复用 IR002 悬空引用码）
      if (Array.isArray(doc.messages)) {
        for (const m of (doc.messages as unknown[]).filter(isRecord)) {
          const from = typeof m.from === 'string' ? m.from : '';
          const to = typeof m.to === 'string' ? m.to : '';
          for (const [end, val] of [['from', from], ['to', to]] as const) {
            if (val && !ids.has(val)) {
              add({
                code: 'IR002',
                subject: val,
                evidence: 'message.' + end + ' 不在 participants 中',
                detail: '时序消息端点必须是已声明的参与者',
                supportedFixes: ['在 participants 中补写 ' + val, '或修正该消息的 ' + end],
              });
            }
          }
        }
      }
    }
  }

  // ---- tiers（可选分层，架构图的泳道语言；2026-10-10 用户指出「画的是流程图不是架构图」）----
  if (doc.tiers !== undefined) {
    if (!Array.isArray(doc.tiers)) {
      add({
        code: 'IR013',
        subject: 'tiers',
        evidence: typeof doc.tiers,
        detail: 'tiers 必须是数组（每项 { row, name }）',
        supportedFixes: ['把 tiers 改成数组，或整体删除该字段'],
      });
    } else {
      const tiers = (doc.tiers as unknown[]).filter(isRecord);
      const seenRows = new Set<number>();
      tiers.forEach((t, i) => {
        const row = t.row;
        const name = typeof t.name === 'string' ? t.name.trim() : '';
        if (!isNonNegInt(row) || name === '') {
          add({
            code: 'IR014',
            subject: String(i),
            evidence: 'row=' + String(row) + ' name=' + String(t.name ?? '(缺失)'),
            detail: '每条 tier 必须有非负整数 row 和非空 name',
            supportedFixes: ['补写 name，或把 row 改成 0 或正整数'],
          });
          return;
        }
        if (seenRows.has(row as number)) {
          add({
            code: 'IR014',
            subject: String(i),
            evidence: 'row=' + String(row) + ' 重复',
            detail: 'tier 的 row 不能重复（一行一条泳道）',
            supportedFixes: ['去掉重复 row 的 tier，或换一个 row'],
          });
          return;
        }
        seenRows.add(row as number);
      });
      // 有 tiers 时，节点 row 必须被覆盖 —— 强迫模型把「每层叫什么」想清楚
      if (seenRows.size > 0 && Array.isArray(doc.nodes)) {
        for (const n of nodes) {
          const row = n.row;
          if (isNonNegInt(row) && !seenRows.has(row as number)) {
            add({
              code: 'IR013',
              subject: typeof n.id === 'string' ? n.id : '(无 id)',
              evidence: 'row=' + row + ' 不在 tiers 中',
              detail: '声明了 tiers 后，每个节点的 row 必须对应一条 tier（层名是架构表达的一部分）',
              supportedFixes: ['为 row=' + row + ' 补一条 tier 并命名', '或删除 tiers 字段退回纯网格'],
            });
          }
        }
      }
    }
  }

  if (nodes.length > IR_MAX_NODES) {
    add({
      code: 'IR011',
      subject: 'nodes',
      evidence: nodes.length + ' 个 > 上限 ' + IR_MAX_NODES,
      detail: '阶段 1 限制规模，避免模型输出被截断',
      supportedFixes: [FIX.splitGraph],
    });
  }

  // ---- 结论 ----
  // 只有零缺陷才返回 ir：调用方拿到 null 时唯一该做的事就是读 diagnostics。
  if (out.length > 0) {
    return { verdict: 'fail', ir: null, diagnostics: out };
  }
  return { verdict: 'ok', ir: doc as unknown as IrDocument, diagnostics: [] };
}

/** 渲染一份修复回执，供宿主回灌给模型（对标 Archify 的 repair receipt）。 */
export function formatIrReceipt(judgement: IrJudgement): string {
  if (judgement.verdict === 'ok') {
    return 'IR 校验通过（0 错误 0 警告），可直接渲染。';
  }
  const lines = ['IR 校验未通过，共 ' + judgement.diagnostics.length + ' 处，按下列修复：'];
  for (const d of judgement.diagnostics) {
    lines.push(
      '- [' + d.code + '] subject=' + d.subject + ' | evidence=' + d.evidence +
      ' |问题：' + d.detail + ' | 可用修复：' + d.supportedFixes.join('、'),
    );
  }
  lines.push('只做上述 supportedFixes 里的动作，不要改动其他部分。');
  return lines.join('\n');
}

/**
 * 渲染层用的判定结果：IR 在渲染期就该被定性。
 *
 * 与 judgeIr 的区别：judgeIr 返回结构化结果供逻辑判断，
 * 本函数直接把「能不能渲染 / 该显示什么」固化成两个可序列化字段，
 * 让渲染层不必理解诊断语义。
 */
export interface IrFenceOutcome {
  ok: boolean;
  /** 回执文本。ok 时为 null。 */
  receipt: string | null;
}

/**
 * 围栏分派用的判定入口。
 *
 * ## 如何区分「流式未完成」与「模型跑偏」
 *
 * 两者都表现为「JSON 解析失败」，但必须区别对待：
 * - 流式未完成：模型正在逐字输出，判定必然误报 ⇒ 应出骨架，**且不能闪错误态**
 * - 模型跑偏：围栏已闭合但压根不是 JSON ⇒ 模型确实写错了 ⇒ **必须出回执**，
 *   否则模型永远不知道自己跑偏，会反复重犯
 *
 * 判据用「是否以 `{` 开头」：IR 契约要求正文是 JSON 对象，模型写到一半也一定
 * 已吐出 `{`。若连 `{` 都没有，说明它压根没在写 JSON，属于跑偏。
 *
 * 不用 marked 的围栏闭合行为作判据：实测它会把未闭合围栏送进 codeRenderer
 * （加 sanitize 属性后行为变化），假设不可靠。
 */
export function judgeIrFence(source: string): IrFenceOutcome {
  const s = source.trim();
  if (!s.startsWith('{')) {
    // 连对象都没开始 ⇒ 不是流式，是跑偏（正文根本不是 JSON 对象）
    return { ok: false, receipt: formatIrReceipt(judgeIr(source)) };
  }
  // 以 { 开头但解析失败 ⇒ 流式未完成（模型还在写）
  if (!isCompleteJson(s)) {
    return { ok: false, receipt: null };
  }
  const j = judgeIr(s);
  return j.verdict === 'ok'
    ? { ok: true, receipt: null }
    : { ok: false, receipt: formatIrReceipt(j) };
}

/** JSON 是否完整可解析。 */
function isCompleteJson(source: string): boolean {
  try {
    JSON.parse(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 assistant 文本提取 canvas-ir 围栏体（修复回路的提取器，纯函数）。
 *
 * 规则：只认**闭合**的 ```canvas-ir 围栏（未闭合=流式截断，残缺 JSON 判定无意义，
 * 不提取）。语言名必须精确是 canvas-ir——canvas（HTML 围栏）不误吃。
 */
export function extractIrFences(text: string): string[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: string[] = [];
  const re = /```canvas-ir[ \t]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]!.trim());
  }
  return out;
}
