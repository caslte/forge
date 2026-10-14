/**
 * 画布 IR 校验器。
 *
 * 契约与四类图的判据见 `canvasIr/schemaSpec.ts`（**唯一事实来源**），
 * 面向模型的措辞由 `canvasIr/promptSpec.ts` 从同一份 schema 派生。
 * 本文件只做一件事：**按图类型分派的结构校验**，不碰布局。
 *
 * ## v1 → v2 的取舍（2026-10-12）
 *
 * v1 只认 `architecture` / `sequence`，且把 `col`/`row` 定为**所有节点必填**。
 * 真机跑下来（阶段 1 门槛未过，见 `canvas-ir-stage1-test-design.md`）暴露两条：
 *
 * 1. **硬校验过头**。`col`/`row` 是布局意图，不是语义。模型漏给一个 `col`
 *    就被判错、要花一整轮 LLM 调用去补一个字节，而宿主本来就能推出来。
 *    v2 起 `col`/`row` 一律**可选**，缺省由布局编译器补齐。
 * 2. **图类型不够用**。用户要流程图，契约却把它硬塞进 `sequence`
 *    （原文 `流程/时序/先后/调用链 → sequence`），于是产出「合规但不符合图的逻辑」。
 *    v2 扩到四类，且判据互斥。
 *
 * 与之配套的一条反向调整：`mustBeEmpty`（例如 sequence 里不许有 nodes）
 * **不再作为硬失败**。编译器本就会忽略与当前类型无关的字段，硬失败只会白烧一轮
 * 调用换来零视觉收益——降级为提示词里的写法指导（见 schemaSpec 的字段注释）。
 *
 * 与 canvasSandbox.ts 的分工：
 * - canvasSandbox 判「这段 HTML 像不像图」——旧链路的事后形态判决
 * - canvasIr 判「这份 IR 合不合法」——新链路的事前结构校验
 * 两者并存不冲突：新链路走 canvasIr，旧链路仍由 canvasSandbox 兜底。
 *
 * 设计约束：必须是纯函数（不碰 DOM、不读时钟、不依赖随机数），
 * 因为它要能在 node:test 下回归，且结论不经任何模型判断。
 */

import {
  IR_DIAGRAM_TYPES,
  IR_FENCE_LANGUAGE,
  IR_MAX_LABEL_CHARS,
  IR_MAX_NODES,
  IR_NODE_KINDS,
  IR_SCHEMA_VERSION,
  irMaxNodesOf,
  irSpecOf,
} from './canvasIr/schemaSpec.ts';
import type { IrDiagramType, IrNodeKind } from './canvasIr/schemaSpec.ts';

/**
 * 枚举与上限一律从 schemaSpec 转出，本文件不另存一份。
 *
 * 改造前这批常量在 `canvasIr.ts` 与 `promptIr.ts` 各有一份手抄，加一类图要改三处
 * 且漂移静默。现在跨包引用仍走 `@forge/core/markdown`，取到的就是这里转出的值。
 */
export {
  IR_DIAGRAM_TYPES,
  IR_FENCE_LANGUAGE,
  IR_MAX_LABEL_CHARS,
  IR_MAX_NODES,
  IR_NODE_KINDS,
  IR_SCHEMA_VERSION,
  irMaxNodesOf,
};
export type { IrDiagramType, IrNodeKind };

export interface IrNode {
  id: string;
  label: string;
  kind: IrNodeKind;
  /**
   * 列号（从 0 起）。**可选**——v1 曾强制必填，代价见文件头。
   * 缺省时由布局编译器按同层顺序补齐（见 canvasIrRender 的 colOf）。
   */
  col?: number;
  /** 行号（从 0 起）。architecture 必填（层归属是架构语义的一部分），其余类型可省。 */
  row?: number;
}

export interface IrEdge {
  from: string;
  to: string;
  /** 可选的边语义标签，如「转发」「命中」「是」「否」。 */
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

/**
 * 时序图消息：数组顺序即时间顺序（从上往下渲染），不需要显式 seq。
 *
 * `kind: "return"` 会被画成虚线箭头（响应/回调），其余按实线调用处理。
 */
export interface IrMessage {
  from: string;
  to: string;
  label?: string;
  kind?: 'call' | 'return';
}

/** 树 / 思维导图的画法变体。`mindmap` 是根居中、分支两侧放射的观感。 */
export interface IrTreeHints {
  variant?: 'tree' | 'mindmap';
}

export interface IrDocument {
  schema_version: string;
  diagram_type: IrDiagramType;
  /**
   * 图的元信息。目前只有 `title` 有消费方（卡片标题 / 导出文件名）。
   *
   * v1 这里还有一个 `quality_profile`，声明了却从没有任何代码读过它——
   * 与 `IrEdge.label` 同一类缺陷（契约里挂着一个「写了也白写」的字段，
   * 只会诱导模型多输出几个 token）。2026-10-12 删除。
   */
  meta: { title?: string };
  /** 分层泳道。仅 architecture 使用；其余类型即使给了也会被忽略。 */
  tiers?: IrTier[];
  /** 参与者生命线。仅 sequence 使用。 */
  participants?: IrParticipant[];
  /** 按时间排序的消息。仅 sequence 使用。 */
  messages?: IrMessage[];
  /** 树的画法变体。仅 tree 使用。 */
  tree?: IrTreeHints;
  /** 校验通过时一定存在（缺失按空数组归一）。 */
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
  | 'IR007' | 'IR008' | 'IR009' | 'IR010' | 'IR011' | 'IR012' | 'IR013' | 'IR014'
  | 'IR015' | 'IR016' | 'IR017' | 'IR018';

export interface IrJudgement {
  verdict: 'ok' | 'fail';
  diagnostics: IrDiagnostic[];
  /** 仅当 verdict==='ok' 时有值；失败时为 null，调用方不得使用未校验的 IR。 */
  ir: IrDocument | null;
}

/** 修复控件文案表。集中管理便于日后加严/放宽，且单测可断言其存在。 */
const FIX = {
  addVersion: '补写 schema_version 为 ' + IR_SCHEMA_VERSION,
  fixType: '把 diagram_type 改为 ' + IR_DIAGRAM_TYPES.join(' / '),
  fixNodesArray: '把 nodes 改成数组',
  fixEdgesArray: '把 edges 改成数组',
  fixNodeEntry: '每个节点必须是对象 { id, label, kind }',
  fixEdgeEntry: '每条边必须是对象 { from, to }',
  dropEdge: '删除该边',
  addNode: '补写该节点，或删除指向它的边',
  renameId: '给节点换一个未被占用的 id',
  dropSelfLoop: '删除这条自环边',
  addLabel: '补写 label',
  fixKind: '把 kind 改为 ' + IR_NODE_KINDS.join(' / '),
  makeInt: '把 col 与 row 改成 0 或正整数，或整体删掉这两个字段',
  addRow: '补写 row，指明它属于哪一层',
  shortenLabel: '把 label 压到 ' + IR_MAX_LABEL_CHARS + ' 字以内',
} as const;

/**
 * 节点超限时的修复建议。必须**按类型**给出数字——各类型的上限不同（见 `maxNodes`），
 * 写死基准值会让模型收到「每张不超过 12 个」而校验器其实放行 16 个，白折腾一轮。
 */
function splitGraphFix(type: unknown): string {
  return '把节点拆成多张图，每张不超过 ' + irMaxNodesOf(type) + ' 个';
}

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

/** 把「数组里混进非对象」这类静默丢弃显式化——否则模型不知道自己的项被吃了。 */
function collectRecords(
  raw: unknown,
  field: string,
  fix: string,
  add: (d: IrDiagnostic) => void,
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  raw.forEach((item, i) => {
    if (isRecord(item)) out.push(item);
    else {
      add({
        code: 'IR004',
        subject: field + '[' + i + ']',
        evidence: JSON.stringify(item) ?? String(item),
        detail: field + ' 的每一项都必须是对象',
        supportedFixes: [fix, '或删除该项'],
      });
    }
  });
  return out;
}

/**
 * 校验一份 IR 源码。
 *
 * 刻意「多报不短路」：一次把所有缺陷列全，让模型一轮改完。
 * 短路会让模型来回试多个轮次，而每次修复都是真 LLM 调用。
 *
 * 同时刻意「只报语义错误，不报风格」：类型专属校验按 `irSpecOf(diagram_type)`
 * 分派，与当前类型无关的字段一律忽略（见文件头对 mustBeEmpty 的说明）。
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
  const typeOk = typeof doc.diagram_type === 'string' && types.includes(doc.diagram_type);
  if (!typeOk) {
    add({
      code: 'IR003',
      subject: 'diagram_type',
      evidence: String(doc.diagram_type ?? '(缺失)'),
      detail: '只接受 ' + types.join(' / '),
      supportedFixes: [FIX.fixType],
    });
  }
  // 类型不合法时后续的类型专属校验无从分派，跳过——避免派生出一堆误导性诊断
  const spec = typeOk ? irSpecOf(doc.diagram_type) : undefined;

  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) {
    add({
      code: 'IR004',
      subject: 'nodes',
      evidence: typeof doc.nodes,
      detail: 'nodes 必须是数组',
      supportedFixes: [FIX.fixNodesArray],
    });
  }
  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    add({
      code: 'IR004',
      subject: 'edges',
      evidence: typeof doc.edges,
      detail: 'edges 必须是数组',
      supportedFixes: [FIX.fixEdgesArray],
    });
  }

  const nodes = collectRecords(doc.nodes, 'nodes', FIX.fixNodeEntry, add);
  const edges = collectRecords(doc.edges, 'edges', FIX.fixEdgeEntry, add);

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
  const needsRow = spec?.type === 'architecture';
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
        detail: '标签过长，卡片内必然溢出',
        supportedFixes: [FIX.shortenLabel],
      });
    }

    // kind 是**可选**的：缺省按 component 处理。
    // 树/思维导图的节点本来就没有「进程/存储」这类语义，硬要它给 kind 只会让模型
    // 塞一个无意义的枚举值。给错了才报错——这才是「受控枚举」该守的边界。
    if (n.kind === undefined || n.kind === null) {
      n.kind = 'component';
    } else if (typeof n.kind !== 'string' || !kinds.includes(n.kind)) {
      add({
        code: 'IR009',
        subject: id,
        evidence: String(n.kind),
        detail: 'kind 必须是受控枚举，宿主按它决定着色与形状',
        supportedFixes: [FIX.fixKind],
      });
    }

    // col/row 是**布局意图**，不是语义：给了就要给对，不给由编译器补。
    // v1 曾无条件必填，是阶段 1 通过率的主要拖累之一（见文件头）。
    if (n.col !== undefined && !isNonNegInt(n.col)) {
      add({
        code: 'IR010',
        subject: id,
        evidence: 'col=' + String(n.col),
        detail: 'col 若给出必须是非负整数',
        supportedFixes: [FIX.makeInt],
      });
    }
    if (needsRow && n.row === undefined) {
      add({
        code: 'IR010',
        subject: id,
        evidence: 'row=(缺失)',
        detail: '架构图里每个节点都要指明属于哪一层',
        supportedFixes: [FIX.addRow],
      });
    } else if (n.row !== undefined && !isNonNegInt(n.row)) {
      add({
        code: 'IR010',
        subject: id,
        evidence: 'row=' + String(n.row),
        detail: 'row 若给出必须是非负整数',
        supportedFixes: [FIX.makeInt],
      });
    }
  }

  // ---- 类型专属校验 ----
  if (spec) {
    // 「必需字段」按 schema 分派。sequence 的 participants 有自己的码（IR015）以兼容既有回执。
    for (const field of spec.required) {
      if (field === 'participants') continue;
      const val = doc[field];
      const missing = val === undefined;
      const empty = Array.isArray(val) && val.length === 0 && field !== 'edges';
      if (missing || empty) {
        add({
          code: 'IR016',
          subject: field,
          evidence: missing ? '(缺失)' : '[]',
          detail: spec.label + '必须有非空的 ' + field,
          supportedFixes: ['补写 ' + field],
        });
      }
    }

    // 除 sequence 外，图里至少要有一条边，否则节点是散的
    if (spec.type !== 'sequence' && nodes.length >= 2 && edges.length === 0) {
      add({
        code: 'IR018',
        subject: 'edges',
        evidence: nodes.length + ' 个节点，0 条边',
        detail: '节点之间没有任何连接，画不出关系',
        supportedFixes: ['补写 edges 描述它们之间的关系', '或减少节点'],
      });
    }
  }

  // ---- architecture：泳道 ----
  if (spec?.type === 'architecture') {
    if (doc.tiers !== undefined && !Array.isArray(doc.tiers)) {
      add({
        code: 'IR013',
        subject: 'tiers',
        evidence: typeof doc.tiers,
        detail: 'tiers 必须是数组（每项 { row, name }）',
        supportedFixes: ['把 tiers 改成数组，或整体删除该字段'],
      });
    } else if (Array.isArray(doc.tiers) && doc.tiers.length > 0) {
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

  // ---- sequence：参与者与消息 ----
  if (spec?.type === 'sequence') {
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

  // ---- tree：根唯一 ----
  // 树没有「层」的概念，唯一的结构不变量是「有且只有一个根」。
  // 根不唯一（含成环导致的 0 根）就没法定位画布的起点。
  //
  // 注意这里**不能**要求 edges 非空：两个孤立节点 = 两个根，正是要拦的情况。
  if (spec?.type === 'tree' && nodes.length > 0) {
    const hasParent = new Set<string>();
    for (const e of edges) {
      if (typeof e.to === 'string') hasParent.add(e.to);
    }
    const roots = nodes
      .map((n) => (typeof n.id === 'string' ? n.id : ''))
      .filter((id) => id !== '' && !hasParent.has(id));
    if (roots.length !== 1) {
      add({
        code: 'IR017',
        subject: 'nodes',
        evidence: roots.length + ' 个根节点' + (roots.length ? '：' + roots.join(', ') : '（可能成环）'),
        detail: '树必须恰好有一个根（没有任何入边的节点）',
        supportedFixes: ['调整 edges，使只有一个节点没有入边', '或改用 flow / architecture 类型'],
      });
    }
  }

  const maxNodes = irMaxNodesOf(doc.diagram_type);
  if (nodes.length > maxNodes) {
    add({
      code: 'IR011',
      subject: 'nodes',
      evidence: nodes.length + ' 个 > 上限 ' + maxNodes + '（' + String(doc.diagram_type) + '）',
      detail: '限制规模，避免输出被截断、卡片塞不下',
      supportedFixes: [splitGraphFix(doc.diagram_type)],
    });
  }

  // ---- 结论 ----
  // 只有零缺陷才返回 ir：调用方拿到 null 时唯一该做的事就是读 diagnostics。
  if (out.length > 0) {
    return { verdict: 'fail', ir: null, diagnostics: out };
  }

  // 归一：与当前类型无关的字段按空数组补齐，让下游渲染器不必到处判 undefined。
  const ir: IrDocument = {
    schema_version: doc.schema_version as string,
    diagram_type: doc.diagram_type as IrDiagramType,
    meta: isRecord(doc.meta) ? (doc.meta as IrDocument['meta']) : {},
    tiers: Array.isArray(doc.tiers) ? (doc.tiers as IrTier[]) : [],
    participants: Array.isArray(doc.participants) ? (doc.participants as IrParticipant[]) : [],
    messages: Array.isArray(doc.messages) ? (doc.messages as IrMessage[]) : [],
    tree: isRecord(doc.tree) ? (doc.tree as IrTreeHints) : undefined,
    nodes: nodes as unknown as IrNode[],
    edges: edges as unknown as IrEdge[],
  };
  return { verdict: 'ok', ir, diagnostics: [] };
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
 * 渲染一份**用户向**的失败说明（2026-10-13 用户反馈「内部重试不该暴露给用户」）。
 *
 * 与 formatIrReceipt 的分工：后者写给模型（含 supportedFixes 修复指令、回灌用），
 * 前者写给人。判定失败时卡片仍要显示「出了什么问题」，但绝不能把内部重试机制的
 * 指令文本亮给用户——实测真机上用户看到的是「可用修复：…」「只做上述
 * supportedFixes 里的动作」这类模型向话术。
 *
 * 取舍：保留缺陷码（IR001 等）与 evidence（事实短句），丢掉 subject/detail/
 * supportedFixes（要么与 evidence 重复，要么是写给模型的指令）。条数封顶 3 条，
 * 避免模型连续跑偏时失败卡片变成一面墙的字。
 */
export function formatIrUserReceipt(judgement: IrJudgement): string {
  if (judgement.verdict === 'ok') {
    return '';
  }
  const total = judgement.diagnostics.length;
  const shown = judgement.diagnostics.slice(0, 3);
  const lines = ['共 ' + total + ' 处：'];
  for (const d of shown) {
    lines.push('- [' + d.code + '] ' + d.evidence);
  }
  if (total > shown.length) {
    lines.push('- …其余 ' + (total - shown.length) + ' 处从略');
  }
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
  /** 模型向回执文本（含修复指令）。ok/流式时为 null。宿主回灌模型用，**不写进 DOM**。 */
  receipt: string | null;
  /**
   * 用户向失败说明（无模型指令）。ok/流式时为 null。
   * 渲染层把它写进 data-md-canvas-ir-receipt 供 UI 展示——该属性唯一消费方
   * 是失败卡片的显示，模型向文本走 canvasIrRepair 的自建回执，两不相干。
   */
  userReceipt: string | null;
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
    const j = judgeIr(source);
    return { ok: false, receipt: formatIrReceipt(j), userReceipt: formatIrUserReceipt(j) };
  }
  // 以 { 开头但解析失败 ⇒ 流式未完成（模型还在写）
  if (!isCompleteJson(s)) {
    return { ok: false, receipt: null, userReceipt: null };
  }
  const j = judgeIr(s);
  return j.verdict === 'ok'
    ? { ok: true, receipt: null, userReceipt: null }
    : { ok: false, receipt: formatIrReceipt(j), userReceipt: formatIrUserReceipt(j) };
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
 * 修好被「漏出的思考标记」劈开的围栏开口行。
 *
 * ## 为什么需要（2026-10-13 门禁第 2 轮实测）
 *
 * mx 模型把 reasoning 块的起止标记**直接吐在正文流里**：26 条真实会话，26/26 的
 * assistant 正文都能看到它们。绝大多数时候标记落在围栏外的正文，无害；但落在围栏
 * 开口行内时（实测 `flow-ci`，1/26），会把 canvas-ir 劈成两半：
 *
 *   Let me finalize.```canvas（这里混进了思考块的闭合标记）紧跟一个空行
 *
 *   -ir
 *   { "schema_version": "forge-ir/2", … }
 *
 * 后果是两级、且都无声：
 *   1. 产品级——`extractIrFences` 一条都提不到 ⇒ 卡片不渲染、修复回路也看不到 ⇒
 *      既没有图也没有报错，用户只看到一堆裸文本（他要的 CI 流程图就这么消失了）；
 *   2. 度量级——采样端把「0 条围栏」读成「模型选择不画」，这条**本来合格**的样本
 *      被静默挤出分母，首次通过率虚低，而报告上看不出任何损坏迹象。
 *
 * ## 为什么限定在围栏开口行内
 *
 * 标记出现在正文里是模型的思考输出，不该由这里抹掉（那是显示层的事）。三条规则都
 * 要求标记位于 ``` 之后、开口行结束之前，因此：
 *   - 不碰围栏外的正文，也不碰围栏体内的 JSON；
 *   - 不会把 ```canvas（HTML 围栏，见 extractIrFences 注释）误判成 canvas-ir；
 *   - 幂等：修好的文本再修一次不变（没有标签可删即原样返回）。
 */
export function repairIrFenceOpeners(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  // 形状 1：语言名本身被劈断 —— ```canvas + 标记(+空白含换行) + -ir
  // 只删标记与空白，-ir 由 lookahead 保留（替换串不能再补连字符，否则拼出 canvas--ir）
  const langSplit = text.replace(/```canvas[ \t]*<\/?think>\s*(?=-ir\b)/g, '```canvas');
  // 形状 2：标记插在围栏与语言名之间 —— ``` + 标记 + canvas-ir
  const fenceSplit = langSplit.replace(/```[ \t]*<\/?think>[ \t]*\n?[ \t]*(?=canvas-ir)/g, '```');
  // 形状 3：标记插在完整语言名之后、换行之前 —— ```canvas-ir + 空白 + 标记(行尾)
  const langTail = fenceSplit.replace(/^(```canvas-ir)[ \t]*<\/?think>[ \t]*$/gm, '$1');
  // 形状 4：开口与 prose 粘连（缺换行）—— `…文字.```canvas-ir` + 换行 + `{`。
  // marked 只认**行首**围栏，开口粘在 prose 尾部会被解析成行内代码 span ⇒ 卡片不渲染。
  // 判定必须带「紧跟换行 + {」：26 条实测里散文大量用反引号**提到** canvas-ir
  // （"the diagram goes in a ```canvas-ir fence"），那种形态后面跟的是文字不是 `{`，
  // 靠这个 lookahead 才能区分「真的在开围栏」与「在说围栏的名字」。
  return langTail.replace(/([^\n`>])```canvas-ir([ \t]*\r?\n[ \t]*\{)/g, '$1\n```canvas-ir$2');
}

/**
 * 从 assistant 文本提取 canvas-ir 围栏体（修复回路的提取器，纯函数）。
 *
 * 规则：只认**闭合**的 ```canvas-ir 围栏（未闭合=流式截断，残缺 JSON 判定无意义，
 * 不提取）。语言名必须精确是 canvas-ir——canvas（HTML 围栏）不误吃。
 *
 * 提取前先过 `repairIrFenceOpeners`：思考标记漏进出图开口行时，先把围栏拼回去再
 * 提取。否则模型明明产出了合法 IR，却因为一个传输层混入的标记整条消失在
 * 「不渲染、不回执、不进分母」的三重静默里。
 */
export function extractIrFences(text: string): string[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: string[] = [];
  const re = /```canvas-ir[ \t]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  const src = repairIrFenceOpeners(text);
  while ((m = re.exec(src)) !== null) {
    out.push(m[1]!.trim());
  }
  return out;
}
