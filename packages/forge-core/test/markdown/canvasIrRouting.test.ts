/**
 * 布线不变量：**任何连线都不得从节点框内部穿过去**。
 *
 * ## 为什么单独一个文件
 *
 * 2026-10-12 用户在真机上给的反馈是「流程图重叠的线要清晰一些，现在有的重叠了看不清方向」。
 * 追下去发现那不是「线画得不够漂亮」，而是**一个会吃掉信息的渲染缺陷**：
 *
 *   渲染顺序是「先连线、后节点」，所以一旦连线从某个节点框里穿过，那段线就被节点**盖住**。
 *   读者看到的不是「一条被挡住的线」，而是「这条线从那个被穿过的节点出发」——
 *   连线的真实起点被彻底改写，且产物 SVG 本身完全合法，任何结构校验都发现不了。
 *
 * 用探针的 17 条真实样本做体检，一次抓出 3 处（三处成因各不相同）：
 *
 *   1. flow  回边 `M A.x Acy H laneX …`——第一段横线走在 A 所在层的**节点中线**上，
 *      横穿同层左侧的兄弟节点。实测 flow-branch 的 `重新处理→接收数据` 穿过 `写入存储`。
 *   2. arch  跨多层箭头 `M spineX yFrom V yTo`——中轴竖线穿过**中间那一层**的节点。
 *      实测 arch-processes 的 row0→row2 穿过 row1 的 `gpu`。
 *      ⚠ 2026-10-13 起这条分支也不存在了：跨层依赖按**相邻层缝隙**归并（每道缝隙一条
 *      短线，§2 现在锁的是「最多一条 + 都是短线 + 折算记 issue」）。当初的修法是「绕右侧
 *      留白通道」，那正是后来用户嫌「这么乱」的那捆线——**绕开缺陷 ≠ 消除缺陷**。
 *   3. arch  同层箭头直接交给 `routeOrtho`——它只保证两端接得上，**不看中间有没有东西**。
 *      实测 arch-modules 的 page→html 穿过 `store`、main→ipc 穿过 `win`。
 *      ⚠ 2026-10-13：**这条分支已不存在**——用户裁定「架构图层内不画线」，同层边整体
 *      不再绘制（§3 现在锁的是「不画 + 记 issue」，以及流程图不受此约束的反向锁）。
 *      保留这条历史记录是为了说明：一个「连线被节点盖住」的几何缺陷，被连续修了两轮
 *      之后发现方向本身错了——规则要改的不是画法，而是「要不要画」。
 *
 * ## 为什么是「性质测试」而不是「断言某条线的坐标」
 *
 * 三处 bug 的共同点是「布局算法里某个函数只对了一半」——断言坐标只能锁住当下这一条线。
 * 所以这里改成不变量：把每条边的 d 采样成点列，逐个节点框做包含判定。
 * 任何**未来的**新布线分支只要穿过节点，这里就会红，不需要提前想到那种走法。
 *
 * 采样必须**按线段插值**（不是只看折点）：本次三处 bug 的折点全都在框外，
 * 只有线段横穿框——只看折点的检查会全部漏掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeIr } from '../../src/markdown/canvasIr.ts';
import { compileIrToSvg, layoutIr } from '../../src/markdown/canvasIrRender.ts';

/** 把 SVG path 的 d 采样成点列（只认 M/L/H/V，本项目的布线只用这几种绝对命令）。 */
function samplePath(d: string, step = 1): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const re = /([MLHV])\s*(-?[\d.]+)?(?:\s+(-?[\d.]+))?/g;
  let cx = 0;
  let cy = 0;
  let m: RegExpExecArray | null;
  const push = (x: number, y: number): void => { out.push({ x, y }); };
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1]!;
    const p1 = m[2] !== undefined ? Number(m[2]) : undefined;
    const p2 = m[3] !== undefined ? Number(m[3]) : undefined;
    if (cmd === 'M' || cmd === 'L') {
      cx = p1!; cy = p2!; push(cx, cy);
    } else if (cmd === 'H') {
      const target = p1!;
      const dir = Math.sign(target - cx) || 1;
      for (let x = cx; Math.abs(x - target) > step; x += dir * step) push(x, cy);
      cx = target; push(cx, cy);
    } else if (cmd === 'V') {
      const target = p1!;
      const dir = Math.sign(target - cy) || 1;
      for (let y = cy; Math.abs(y - target) > step; y += dir * step) push(cx, y);
      cy = target; push(cx, cy);
    }
  }
  return out;
}

/**
 * 不变量：没有任何连线从节点框内部穿过。
 *
 * 容差 INSET=2：连线本来就该接到节点边框上，贴着边走不算穿过。
 * 端点判定：连线的起终点落在框内是正常的（它就是要插进去），不算「穿过」。
 */
function assertNoEdgeCrossesNode(irJson: string, tag: string): void {
  const judged = judgeIr(irJson);
  assert.equal(judged.verdict, 'ok', `${tag}: 样例本身不合法，${judged.diagnostics.map((x) => x.code).join(',')}`);
  const lay = layoutIr(judged.ir!);

  const INSET = 2;
  const violations: string[] = [];
  for (const e of lay.edges) {
    const pts = samplePath(e.d);
    if (pts.length === 0) continue;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    for (const n of lay.nodes) {
      const inside = (p: { x: number; y: number }): boolean =>
        p.x > n.x + INSET && p.x < n.x + n.w - INSET
        && p.y > n.y + INSET && p.y < n.y + n.h - INSET;
      const hits = pts.filter(inside);
      if (hits.length === 0) continue;
      // 整条线只在端点处进入本节点 ⇒ 是「接入」，不是「穿过」
      const allAtStart = hits.every((p) => Math.hypot(p.x - first.x, p.y - first.y) <= 2);
      const allAtEnd = hits.every((p) => Math.hypot(p.x - last.x, p.y - last.y) <= 2);
      if (allAtStart || allAtEnd) continue;
      violations.push(`边 ${e.d} 穿过节点 ${n.id}（框 x[${n.x},${n.x + n.w}] y[${n.y},${n.y + n.h}]）`);
    }
  }
  assert.deepEqual(violations, [], `${tag}: 连线被节点盖住，读者会看错起点/终点`);
}

const flow = (nodes: unknown[], edges: unknown[], extra?: Record<string, unknown>): string =>
  JSON.stringify({
    schema_version: 'forge-ir/2', diagram_type: 'flow', meta: { title: 't' }, nodes, edges, ...extra,
  });

const arch = (nodes: unknown[], edges: unknown[], tiers: unknown[]): string =>
  JSON.stringify({
    schema_version: 'forge-ir/2', diagram_type: 'architecture', meta: { title: 't' }, nodes, edges, tiers,
  });

// ---------------------------------------------------------------- 1. 回边

test('回边不得横穿同层兄弟节点（flow-branch 实测的回归锁）', () => {
  // 关键几何：回边的**起点 b** 在同一层里位于 `a` 的右侧。旧写法从 b 的左边框
  // 直接水平出发，这条横线正好走在 b 所在层的中线上，于是从 `a` 身上穿过去。
  assertNoEdgeCrossesNode(
    flow(
      [
        { id: 's', label: '开始', kind: 'terminal' },
        { id: 'd', label: '校验', kind: 'decision' },
        { id: 'a', label: '通过', kind: 'process' },
        { id: 'b', label: '不通过', kind: 'process' },
        { id: 'e', label: '完成', kind: 'terminal' },
      ],
      [
        { from: 's', to: 'd' },
        { from: 'd', to: 'a', label: '通过' },
        { from: 'd', to: 'b', label: '不通过' },
        { from: 'b', to: 'e' },
        { from: 'b', to: 's', label: '重试' }, // ← 回边，旧写法会穿过 a
      ],
    ),
    '回边',
  );
});

test('回边仍然画成虚线，且确实回到目标节点（别为了绕路把语义绕没了）', () => {
  const judged = judgeIr(
    flow(
      [
        { id: 's', label: '开始', kind: 'terminal' },
        { id: 'a', label: '处理', kind: 'process' },
        { id: 'b', label: '复核', kind: 'process' },
        { id: 'e', label: '完成', kind: 'terminal' },
      ],
      [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'e' },
        { from: 'b', to: 's', label: '退回' },
      ],
    ),
  );
  const lay = layoutIr(judged.ir!);
  const back = lay.edges.filter((e) => e.dash);
  assert.equal(back.length, 1, '应当恰好有一条回边');
  // 终点必须落在 s 的框上（y 在 s 的纵向范围内）
  const s = lay.nodes.find((n) => n.id === 's')!;
  const pts = samplePath(back[0]!.d);
  const end = pts[pts.length - 1]!;
  assert.ok(
    end.y >= s.y - 2 && end.y <= s.y + s.h + 2,
    `回边终点 y=${end.y} 不在目标节点 s 的纵向范围 [${s.y},${s.y + s.h}] 内`,
  );
});

// ---------------------------------------------------------------- 2. 架构：跨层箭头按缝隙归并

/** 从 `M x y V y2` 取出竖线长度（用于断言「箭头是层间短线」）。 */
function vertLen(d: string): number {
  const m = /^M[\d.]+ ([\d.]+) V([\d.]+)$/.exec(d);
  assert.ok(m, '应当是单段竖线：' + d);
  return Math.abs(Number(m[2]) - Number(m[1]));
}

test('架构图跨层箭头：每道缝隙最多一条短竖线（跨多层不再绕右侧通道）', () => {
  // 用户第二轮原话：「你这个箭头是什么意思，这么乱，层和层之间需要这么多箭头吗」。
  // 旧写法按「层对」画：ui→bridge 与 ui→os 是两个不同层对 ⇒ 两条箭头，后者还要绕
  // 右侧留白走长折线。现在按**相邻层缝隙**归并：两道缝隙各一条，都是层间短线。
  const judged = judgeIr(
    arch(
      [
        { id: 'ui', label: '渲染进程', kind: 'component', row: 0, col: 0 },
        { id: 'bridge', label: '预加载桥', kind: 'component', row: 1, col: 0 },
        { id: 'os', label: '系统能力', kind: 'process', row: 2, col: 0 },
      ],
      [
        { from: 'ui', to: 'bridge' },
        { from: 'ui', to: 'os' }, // ← 跨两层：折算到 0-1、1-2 两道缝隙
      ],
      [
        { row: 0, name: '渲染层' },
        { row: 1, name: '预加载层' },
        { row: 2, name: '系统能力层' },
      ],
    ),
  );
  const lay = layoutIr(judged.ir!);
  assert.equal(lay.edges.length, 2, '3 层 ⇒ 最多 2 道缝隙 ⇒ 最多 2 条箭头');
  for (const e of lay.edges) {
    const len = vertLen(e.d);
    assert.ok(len > 0 && len < 60, '箭头必须是层间短线，实际长度 ' + len + '：' + e.d);
  }
  // 跨多层折算过 ⇒ 必须记一条 issue（可被门禁看见）
  assert.ok(
    lay.issues.some((i) => i.includes('跨越了中间层') && i.includes('折算')),
    '跨层依赖被折算时应记 issue：' + JSON.stringify(lay.issues),
  );
  // 折算后仍然不得有任何线穿过节点
  assertNoEdgeCrossesNode(
    arch(
      [
        { id: 'ui', label: '渲染进程', kind: 'component', row: 0, col: 0 },
        { id: 'bridge', label: '预加载桥', kind: 'component', row: 1, col: 0 },
        { id: 'os', label: '系统能力', kind: 'process', row: 2, col: 0 },
      ],
      [{ from: 'ui', to: 'bridge' }, { from: 'ui', to: 'os' }],
      [
        { row: 0, name: '渲染层' },
        { row: 1, name: '预加载层' },
        { row: 2, name: '系统能力层' },
      ],
    ),
    '跨多层折算',
  );
});

test('双向依赖合成一条双向箭头：一条线两个头（不再两条线各偏 7px）', () => {
  const judged = judgeIr(
    arch(
      [
        { id: 'a', label: '甲块', kind: 'process', row: 0, col: 0 },
        { id: 'b', label: '乙块', kind: 'process', row: 1, col: 0 },
      ],
      [
        { from: 'a', to: 'b', label: '下行调用' },
        { from: 'b', to: 'a', label: '上行回执' },
      ],
      [{ row: 0, name: '上层' }, { row: 1, name: '下层' }],
    ),
  );
  const lay = layoutIr(judged.ir!);
  assert.equal(lay.edges.length, 1, '上下依赖同在一道缝隙 ⇒ 合成一条');
  assert.equal(lay.edges[0]!.bidir, true, '双向依赖应标 bidir');
  // 渲染层要真的画出两个头：marker-start + marker-end
  const svg = compileIrToSvg(judged.ir!).replace(/<defs>[\s\S]*?<\/defs>/, '');
  const path = svg.match(/<path d="M[^"]*"[^>]*/)![0]!;
  assert.ok(path.includes('marker-start'), '双向箭头缺 marker-start：' + path);
  assert.ok(path.includes('marker-end'), '双向箭头缺 marker-end：' + path);
});

test('汇总缝隙不显示标签，单条缝隙保留标签（汇总标签是歧义来源）', () => {
  // 一道缝隙上两条依赖 ⇒ 任何一个标签都只代表其中一部分 ⇒ 不显示。
  const many = judgeIr(
    arch(
      [
        { id: 'a', label: '甲块', kind: 'process', row: 0, col: 0 },
        { id: 'b', label: '乙块', kind: 'process', row: 1, col: 0 },
        { id: 'c', label: '丙块', kind: 'process', row: 1, col: 1 },
      ],
      [
        { from: 'a', to: 'b', label: '甲依赖' },
        { from: 'a', to: 'c', label: '乙依赖' },
      ],
      [{ row: 0, name: '上层' }, { row: 1, name: '下层' }],
    ),
  );
  const manyLay = layoutIr(many.ir!);
  assert.equal(manyLay.edges.length, 1);
  assert.equal(manyLay.edges[0]!.label, undefined, '汇总缝隙不该显示任何单个标签');

  // 一道缝隙恰好一条依赖 ⇒ 标签一一对应、无歧义 ⇒ 保留
  const one = judgeIr(
    arch(
      [
        { id: 'a', label: '甲块', kind: 'process', row: 0, col: 0 },
        { id: 'b', label: '乙块', kind: 'process', row: 1, col: 0 },
      ],
      [{ from: 'a', to: 'b', label: '唯一依赖' }],
      [{ row: 0, name: '上层' }, { row: 1, name: '下层' }],
    ),
  );
  const oneLay = layoutIr(one.ir!);
  assert.equal(oneLay.edges.length, 1);
  assert.equal(oneLay.edges[0]!.label, '唯一依赖');
});

// ---------------------------------------------------------------- 3. 架构：同层边不画

test('架构图同层依赖不画线，只记 issue（2026-10-13 用户规则：层内不画线）', () => {
  // arch-modules 的场景（page 与 html 同层、store 夹在中间）。前两轮都在修
  // 「同层边怎么画才不难看」（夹块穿越 → 加挡路检测 → 补 y 分量），用户看修复后的
  // 43 节点图仍判「完全看不懂」，规则本身被推翻。现在这条边既不该出现连线，
  // 也不该留下任何几何问题，只留一条 issue 说明它被略去了。
  const judged = judgeIr(
    arch(
      [
        { id: 'page', label: '页面', kind: 'component', row: 0, col: 0 },
        { id: 'store', label: '状态仓库', kind: 'component', row: 0, col: 1 },
        { id: 'html', label: '视图层', kind: 'component', row: 0, col: 2 },
      ],
      [{ from: 'page', to: 'html' }], // ← 同层依赖
      [{ row: 0, name: '渲染层' }],
    ),
  );
  assert.equal(judged.verdict, 'ok', '同层边结构上仍合法：IR 只卡结构，不卡表达取舍');
  const lay = layoutIr(judged.ir!);
  assert.equal(lay.edges.length, 0, '同层边不得画出来');
  assert.ok(
    lay.issues.some((i) => i.includes('同层依赖') && i.includes('已略去')),
    '必须记一条 issue 说明同层边被略去（模型给了边却看不到线时，得有归因）：' + JSON.stringify(lay.issues),
  );
});

test('架构图同层相邻两块也不画线（相邻与否无关）', () => {
  // 相邻（中间不夹块）是同层边里最「无害」的一种，旧写法会画成一条干净横线。
  // 新规则下它同样不画——判据只有「是否同层」，没有「中间有没有块」。
  const judged = judgeIr(
    arch(
      [
        { id: 'page', label: '页面', kind: 'component', row: 0, col: 0 },
        { id: 'store', label: '状态仓库', kind: 'component', row: 0, col: 1 },
      ],
      [{ from: 'page', to: 'store' }],
      [{ row: 0, name: '渲染层' }],
    ),
  );
  const lay = layoutIr(judged.ir!);
  assert.equal(lay.edges.length, 0);
  assert.ok(lay.issues.some((i) => i.includes('1 条同层依赖')), JSON.stringify(lay.issues));
});

test('架构图混合场景：同层被略去，跨层照画（别误伤跨层）', () => {
  const judged = judgeIr(
    arch(
      [
        { id: 'page', label: '页面', kind: 'component', row: 0, col: 0 },
        { id: 'store', label: '状态仓库', kind: 'component', row: 0, col: 1 },
        { id: 'main', label: '主进程', kind: 'process', row: 1, col: 0 },
      ],
      [
        { from: 'page', to: 'store' }, // 同层 → 略去
        { from: 'page', to: 'main', label: 'invoke' }, // 跨层 → 画
      ],
      [{ row: 0, name: '渲染层' }, { row: 1, name: '主进程层' }],
    ),
  );
  const lay = layoutIr(judged.ir!);
  assert.equal(lay.edges.length, 1, '只有跨层那条该被画出来');
  assert.equal(lay.edges[0]!.label, 'invoke');
  assert.match(lay.edges[0]!.d, /^M[\d.]+ [\d.]+ V[\d.]+$/, '相邻层跨层箭头仍是单段竖线');
});

test('反向锁：流程图的边一条都不略去（层内不画线只约束架构图）', () => {
  // 「略去同层边」的逻辑写在 layoutArchitecture 里。若哪天有人把它挪进共用路径
  // （layoutLayered 的公共部分），流程图会被一起误伤——这条锁住那个可能性。
  // 流程图本来就不该有同层边（层次由拓扑推导），所以这里断言的是「边的条数不缩水」。
  const judged = judgeIr(
    flow(
      [
        { id: 's', label: '开始', kind: 'terminal' },
        { id: 'd', label: '校验', kind: 'decision' },
        { id: 'a', label: '通过', kind: 'process' },
        { id: 'b', label: '不通过', kind: 'process' },
        { id: 'e', label: '完成', kind: 'terminal' },
      ],
      [
        { from: 's', to: 'd' },
        { from: 'd', to: 'a', label: '通过' },
        { from: 'd', to: 'b', label: '不通过' },
        { from: 'b', to: 'e' },
        { from: 'b', to: 's', label: '重试' },
      ],
    ),
  );
  const lay = layoutIr(judged.ir!);
  assert.equal(lay.edges.length, 5, '流程图的边一条都不该被略去');
  assert.equal(
    lay.issues.filter((i) => i.includes('同层')).length, 0,
    '流程图不该出现「同层依赖已略去」的 issue',
  );
});

// ---------------------------------------------------------------- 4. 树

test('树的父子连线不得穿过任何节点', () => {
  assertNoEdgeCrossesNode(
    JSON.stringify({
      schema_version: 'forge-ir/2',
      diagram_type: 'tree',
      meta: { title: 't' },
      nodes: [
        { id: 'r', label: 'root' },
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
        { id: 'a1', label: 'a1' },
        { id: 'a2', label: 'a2' },
        { id: 'b1', label: 'b1' },
      ],
      edges: [
        { from: 'r', to: 'a' }, { from: 'r', to: 'b' },
        { from: 'a', to: 'a1' }, { from: 'a', to: 'a2' },
        { from: 'b', to: 'b1' },
      ],
    }),
    '树',
  );
});

test('思维导图两侧的连线也不得穿过节点', () => {
  assertNoEdgeCrossesNode(
    JSON.stringify({
      schema_version: 'forge-ir/2',
      diagram_type: 'tree',
      meta: { title: 't' },
      tree: { variant: 'mindmap' },
      nodes: [
        { id: 'r', label: '中心' },
        { id: 'a', label: '分支一' }, { id: 'b', label: '分支二' }, { id: 'c', label: '分支三' },
        { id: 'a1', label: '子一' }, { id: 'b1', label: '子二' },
      ],
      edges: [
        { from: 'r', to: 'a' }, { from: 'r', to: 'b' }, { from: 'r', to: 'c' },
        { from: 'a', to: 'a1' }, { from: 'b', to: 'b1' },
      ],
    }),
    '思维导图',
  );
});
