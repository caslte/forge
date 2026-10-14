/**
 * 图示 IR 的 schema —— **唯一事实来源**。
 *
 * ## 为什么要有这个文件
 *
 * 改造前的事实是：`IR_MAX_NODES` / `IR_DIAGRAM_TYPES` / `IR_NODE_KINDS` 定义在
 * `canvasIr.ts`（校验器），而同一批事实又被**手抄**进 `promptIr.ts`（提示词）的
 * `MAX_NODES` / `KINDS` 常量里。加一类图要同时改三处（schema、校验器、提示词），
 * 而且**漂移是静默的**——没有任何测试守得住。
 *
 * 这里把「有哪些图类型、每类要哪些字段、节点有哪些语义 kind、上限是多少」全部收成
 * 一份数据，然后：
 *
 * ```
 * schemaSpec.ts ──┬──→ promptSpec.ts   （渲染成给模型的契约文本）
 *                 └──→ judgeIr()        （校验器读同一份枚举与上限）
 * ```
 *
 * 于是「加一类图」= 往 `IR_DIAGRAM_SPECS` 加一条；提示词与校验器**在结构上不可能漂移**。
 *
 * ## 为什么不用 Zod
 *
 * forge-core 的依赖只有 `highlight.js` / `marked` / `sanitize-html`。引入 Zod 会打破
 * 「引擎层零额外依赖」的既有风格，而这里需要的校验强度远低于 Zod 的通用能力——
 * 一个数据表 + 一段手写纯函数就够，且回执（repair receipt）需要的是**可读的诊断码**，
 * 不是 Zod 的 issue 对象。
 *
 * 设计约束：本文件必须是纯数据 + 纯函数（不碰 DOM、不读时钟、不依赖随机数），
 * 因为它要能在 node:test 下回归。
 */

/** 当前 IR schema 版本。模型必须原样回写，宿主据此判断兼容性。 */
export const IR_SCHEMA_VERSION = 'forge-ir/2';

/**
 * IR 围栏的语言标记名。
 *
 * 与 CANVAS_LANGUAGE（'canvas'）刻意分开：两者载荷性质完全不同——
 * canvas 围栏装 HTML（宿主原样塞 iframe），canvas-ir 装 JSON（宿主校验后编译）。
 * 共用一个围栏名会导致分派歧义，且失效是静默的。
 */
export const IR_FENCE_LANGUAGE = 'canvas-ir';

/**
 * 节点数上限。
 *
 * 12 是阶段 1 定的（对标 Archify 的「at most 12 primary nodes」起步建议）。
 * 四类图共用同一上限：卡片是**概览**不是全图，超了应该分图而不是缩字。
 */
/**
 * 节点数上限的**基准值**。
 *
 * 2026-10-12 起，各类型可以覆盖它（见 `IrDiagramTypeSpec.maxNodes`）。保留这个常量是给
 * 「还不知道图类型」的场合兜底（例如 IR011 的通用修复建议），以及作为文档里的默认口径。
 *
 * ## 为什么要有「按类型」这一层
 *
 * 探针连跑三轮发现：`tree` 那三条 prompt 的节点数稳定落在 **11~13**，而当时的统一上限是 12
 * ⇒ 约 20% 的请求会**恰好超一个节点**被判 IR011、白烧一轮重出。
 * 更关键的是那个上限在这里**没有保护任何东西**：把 13 节点的思维导图直接编译出来量，
 * 画布 774×402，在卡片里按原尺寸渲染、不触发 480px 上限、不需要缩小字号。
 * 也就是说 12 这个数字对树是**拍脑袋的**，而对流程图/架构图是有依据的——
 * 后两者的边会随节点数变多而开始交叉、图会变宽变高，树则按深度分列、结构上不会交叉。
 */
export const IR_MAX_NODES = 12;

/** 单个标签的字符数上限。超长标签在卡片里必然溢出。 */
export const IR_MAX_LABEL_CHARS = 24;

/**
 * 放行的图类型。
 *
 * 收敛到 4 类（2026-10-12 用户拍板）：
 * - `flow` 流程图 —— 顺序推进 + 判定分叉 + 重试回边
 * - `architecture` 架构图 —— 带泳道（tiers），同层行号强制对齐
 * - `sequence` 时序图 —— 生命线 + 激活条 + 消息
 * - `tree` 树 / 思维导图 —— 水平树，父节点居中于子节点
 *
 * **状态机图不做**（用户明确排除）。它本可复用分层布局（允许回边 + 圆角框 +
 * 初始态标记），将来若要加，只需在此追加一条并补一个渲染器。
 */
export const IR_DIAGRAM_TYPES = ['flow', 'architecture', 'sequence', 'tree'] as const;

/**
 * 节点语义类型。kind 决定宿主如何着色与定形状，故必须是受控枚举。
 *
 * 相比改造前新增两个，都是流程图必需的表意形状：
 * - `decision` 判定分支（菱形）—— 没有它，流程图的分叉只能靠边标签硬猜
 * - `terminal` 起止（胶囊）—— 与中间的 process 区分开
 */
export const IR_NODE_KINDS = [
  'component',
  'process',
  'decision',
  'terminal',
  'boundary',
  'external',
  'storage',
  'dataflow',
] as const;

export type IrDiagramType = (typeof IR_DIAGRAM_TYPES)[number];
export type IrNodeKind = (typeof IR_NODE_KINDS)[number];

/**
 * 一类图的完整说明。提示词与校验器都从这里读，避免两处维护。
 */
export interface IrDiagramTypeSpec {
  readonly type: IrDiagramType;
  /** 人类可读名（回执与文档用）。 */
  readonly label: string;
  /**
   * 「用户要的是这类图」的判据。**直接渲染进提示词**，所以措辞要能被模型据以分类，
   * 且必须互相排斥——两条判据重叠就是让模型去猜，猜错就是「不符合图的逻辑」。
   */
  readonly when: string;
  /** 该类型必须存在且非空的顶层字段。校验器按它分派 IR016 / IR015。 */
  readonly required: readonly string[];
  /**
   * 该类型建议留空的字段。
   *
   * **只进提示词，不作硬校验**（2026-10-12 调整）。原先打算「误填即判错」，但编译器
   * 本就会忽略与当前类型无关的字段——模型在 sequence 里多带一个 `nodes` 并不影响
   * 渲染结果，判错却要白烧一整轮 LLM 调用。降级为写法指导是纯粹的净收益。
   */
  readonly mustBeEmpty: readonly string[];
  /** 该类型是否必须给 `col`/`row` 布局意图。 */
  readonly needsGrid: boolean;
  /**
   * 该类型的节点数上限。校验器按它报 IR011，提示词按它写预算。
   *
   * 允许按类型覆盖，理由见 `IR_MAX_NODES` 的注释：统一上限对树是过紧的。
   */
  readonly maxNodes: number;
  /**
   * 除 `required` 之外、该类型**还接受**的字段名（可写但不强制）。
   *
   * 存在的理由是一次真实事故：`tree.variant` 在 v2 里被校验器和布局器双双支持
   * （`layoutTree` 读 `ir.tree?.variant`），却没人把它写进 `fieldNotes`——
   * 于是提示词里根本没有这个词，模型**永远不可能**产出 mindmap。
   * 探针 17 条样本里，连「画一个思维导图」那条都只给了 `tree`、没给 variant，
   * 那条代码路径实际是死的。
   *
   * 现在把它变成**结构化的字段清单**：单测会断言 `optionalFields` 里每个名字都真的
   * 出现在渲染后的提示词里。以后往校验器加字段却忘了教模型，测试会直接失败。
   */
  readonly optionalFields: readonly string[];
  /** 该类型专属的字段写法说明（渲染进提示词）。 */
  readonly fieldNotes: readonly string[];
}

/**
 * 四类图的规格表。
 *
 * `when` 的写法是本轮改造的重点之一：改造前契约规则 3 把「流程」硬塞进 sequence
 * （原文 `流程/时序/先后/调用链 → sequence`），结果用户要流程图时拿到的是时序图——
 * **合规但不符合图的逻辑**。这里把四类判据拆开且互斥。
 */
export const IR_DIAGRAM_SPECS: readonly IrDiagramTypeSpec[] = [
  {
    type: 'flow',
    label: '流程图',
    when: '步骤有先后顺序，或需要判断分叉/失败重试（下单流程、CI 步骤、审批流、数据处理管道）。',
    required: ['nodes', 'edges'],
    mustBeEmpty: ['tiers', 'participants', 'messages'],
    needsGrid: false,
    maxNodes: 12,
    optionalFields: ['kind', 'label'],
    fieldNotes: [
      '节点用 `{"id","label","kind"}`。起止节点用 `kind:"terminal"`，判定节点用 `kind:"decision"`，其余步骤用 `kind:"process"`。',
      '边用 `{"from","to"}`；分叉条件的文字写在边的 `label` 上（如 `"是"` / `"否"` / `"命中"`）。',
      '不要给 `col`/`row`——流程图的层次由边的方向推导，你给的坐标只会干扰它。',
    ],
  },
  {
    type: 'architecture',
    label: '架构图',
    when: '要表达「谁属于哪一层」的分层结构（系统分层、模块组成、部署拓扑）。',
    // tiers 不在 required 里是**刻意**的：它是架构图的灵魂，但「漏了 tiers」不该
    // 让整张图被判废、白烧一轮模型调用。缺 tiers 时编译器会退回「按 row 分带」的网格，
    // 连 row 也没有就退回分层布局——降级但不出错。质量由提示词（fieldNotes）去要，
    // 不由校验器去卡。这是 2026-10-12「降刚性」的统一口径。
    required: ['nodes', 'edges'],
    mustBeEmpty: ['participants', 'messages'],
    needsGrid: true,
    maxNodes: 12,
    optionalFields: ['tiers', 'row', 'col'],
    fieldNotes: [
      '**务必**给 `tiers: [{"row":0,"name":"渲染层"}, …]`——每层一条，从上到下按 `row` 递增。层名是架构表达的一部分，没有它的架构图会被读成流程图。',
      '节点用 `{"id","label","kind","row","col"}`。`row` 指明属于哪一层（必须能对上某个 tier）；`col` 决定该层内从左到右的次序（从 0 起，可省）。',
      '边只写**跨层**依赖，用 `{"from","to"}`——`from` 与 `to` 必须属于**不同**的层。跨层依赖会被归并成一条「层到层」箭头，画在两层之间的留白里，不落到任何块上，所以不需要写 label 之外的信息。',
      '**层内不要写边**：同层块与块之间的依赖不画线。架构图只表达大方向——谁属于哪一层、层与层之间怎么走；给了同层边也会被略去，写了等于白写。',
    ],
  },
  {
    type: 'sequence',
    label: '时序图',
    when: '按时间排列的交互：调用链、请求/响应生命周期、握手协议、消息往返。',
    required: ['participants', 'messages'],
    mustBeEmpty: ['nodes', 'edges', 'tiers'],
    needsGrid: false,
    maxNodes: 12,
    optionalFields: ['kind', 'label'],
    fieldNotes: [
      '`participants: [{"id","label"}, …]` 至少 2 个，按从左到右的摆放顺序给出。',
      '`messages: [{"from","to","label"}, …]`。**数组顺序就是时间顺序**，序号由宿主生成，不要自己写。',
      '返回/响应类消息加 `"kind":"return"`，会被画成虚线箭头。',
      '自己调用自己就写 `from` 与 `to` 相同的 id，会画成回环。',
      '`nodes`/`edges`/`tiers` 一律留空数组。',
    ],
  },
  {
    type: 'tree',
    label: '树 / 思维导图',
    when: '表达层级归属关系：目录结构、分类体系、要点拆解、组织架构。',
    required: ['nodes', 'edges'],
    mustBeEmpty: ['tiers', 'participants', 'messages'],
    needsGrid: false,
    maxNodes: 16,
    optionalFields: ['kind', 'variant'],
    fieldNotes: [
      '节点用 `{"id","label"}`（`kind` 可省，默认 `component`）。',
      '边用 `{"from","to"}`，方向是**父 → 子**。必须只有一个根（没有任何入边的节点）。',
      '不要给 `col`/`row`——深度由父子关系推导，同层节点自动对齐。',
      '节点是「归属」不是「流程」：父子之间不要写动作性的 label。',
      '**用户说的是「思维导图 / mind map / 脑图」时，必须额外给 `"tree":{"variant":"mindmap"}`**——'
        + '画成根居中、一级分支左右交替放射的观感。说「目录 / 层级 / 分类 / 组织结构」时给 '
        + '`"tree":{"variant":"tree"}` 或整个 `tree` 字段省略，走从左到右的水平树。',
    ],
  },
];

/** 按类型取规格。未知类型返回 undefined（校验器据此报 IR003）。 */
export function irSpecOf(type: unknown): IrDiagramTypeSpec | undefined {
  return IR_DIAGRAM_SPECS.find((s) => s.type === type);
}

/**
 * 取某类型的节点数上限；类型未知时回落到基准值。
 *
 * 校验器（IR011）与提示词都必须走这个函数，否则「提示词说 16、校验器卡 12」
 * 这类漂移会重新长出来——那正是这次重构要消灭的东西。
 */
export function irMaxNodesOf(type: unknown): number {
  return irSpecOf(type)?.maxNodes ?? IR_MAX_NODES;
}
