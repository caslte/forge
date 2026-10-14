/**
 * IR 编译器：IR → SVG（阶段 1 收尾 · 排版算法的最小可用版）。
 *
 * 定位（重要）：这是**第 2 层排版算法**的起点，但刻意只做最小版本。
 * 因为阶段 1 的出口判据是「模型能否稳定产出合规 IR」，不是「图有多好看」。
 * 布局质量是阶段 2 的主战场；这里只保证「合规 IR 能变成正确、可读的图」，
 * 并用门禁暴露明显问题（重叠、溢出）。
 *
 * 与 canvasSandbox.ts 的分工：
 * - canvasSandbox：HTML 字符串 → 沙箱文档（模型写排版）
 * - canvasIrRender：IR → SVG（**宿主算排版**，本文件是唯一权威口径）
 *
 * 设计约束：
 * - 纯函数、无 DOM 依赖 ⇒ 可在 node:test 回归
 * - 输出用 CSS 变量取色 ⇒ 深浅色自动适配，不硬编码颜色
 * - 中文字宽按 1 单位估、英文 0.55 单位估（阶段 2 要换成真实测量）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IR_CARD_HEIGHT,
  IR_MAX_CANVAS_W,
  compileIrToSvg,
  layoutIr,
  measureTextUnits,
} from '../../src/markdown/canvasIrRender.ts';

const IR = {
  schema_version: 'forge-ir/2',
  diagram_type: 'architecture',
  meta: { title: '链路图' },
  nodes: [
    { id: 'a', label: '渲染进程', kind: 'component' as const, col: 0, row: 0 },
    { id: 'b', label: 'IPC 边界', kind: 'boundary' as const, col: 1, row: 0 },
    { id: 'c', label: '主进程', kind: 'process' as const, col: 2, row: 0 },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ],
};

/**
 * 跨层边样例——**数连线条数的用例必须用它**。
 *
 * `IR` 的三个节点同在第 0 行，它的两条边都是同层边；自 2026-10-13 起架构图同层边
 * 不再绘制（用户裁定「层内不画线」），拿 `IR` 去数 `<path>` 会得到 0 条。
 * 这里改成三层各一个节点、两条相邻层边：跨层边会被归并成「层到层」箭头，
 * 而 (0→1)、(1→2) 是两对不同的层，所以恰好两条 path。
 */
const IR_X = {
  ...IR,
  nodes: [
    { id: 'a', label: '渲染进程', kind: 'component' as const, col: 0, row: 0 },
    { id: 'b', label: 'IPC 边界', kind: 'boundary' as const, col: 0, row: 1 },
    { id: 'c', label: '主进程', kind: 'process' as const, col: 0, row: 2 },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ],
};

// ---------------------------------------------------------------- 文本宽度

test('中文字宽按 1 单位、英文按 0.55 单位估算', () => {
  assert.equal(measureTextUnits('中文'), 2);
  assert.ok(Math.abs(measureTextUnits('ab') - 1.1) < 0.001);
});

test('中英混排宽度为两者之和', () => {
  assert.ok(Math.abs(measureTextUnits('中文ab') - 3.1) < 0.001);
});

test('空串宽度为 0', () => {
  assert.equal(measureTextUnits(''), 0);
});

// ---------------------------------------------------------------- 布局

test('布局按 col/row 定位，同行节点 y 相同', () => {
  const lay = layoutIr(IR);
  const a = lay.nodes.find(n => n.id === 'a')!;
  const b = lay.nodes.find(n => n.id === 'b')!;
  const c = lay.nodes.find(n => n.id === 'c')!;
  assert.equal(a.y, b.y);
  assert.equal(b.y, c.y);
  assert.ok(a.x < b.x && b.x < c.x, 'col 越大 x 越大');
});

test('行不同则 y 不同', () => {
  const lay = layoutIr({
    ...IR,
    nodes: [
      { id: 'a', label: 'A', kind: 'process', col: 0, row: 0 },
      { id: 'b', label: 'B', kind: 'process', col: 0, row: 1 },
    ],
    edges: [],
  });
  const a = lay.nodes.find(n => n.id === 'a')!;
  const b = lay.nodes.find(n => n.id === 'b')!;
  assert.ok(b.y > a.y, 'row 越大 y 越大');
});

test('标签越长节点越宽', () => {
  const lay = layoutIr({
    ...IR,
    nodes: [
      { id: 's', label: '短', kind: 'process', col: 0, row: 0 },
      { id: 'l', label: '这是一个很长的标签', kind: 'process', col: 1, row: 0 },
    ],
    edges: [],
  });
  const s = lay.nodes.find(n => n.id === 's')!;
  const l = lay.nodes.find(n => n.id === 'l')!;
  assert.ok(l.w > s.w, '长标签节点应更宽：' + l.w + ' vs ' + s.w);
});

test('节点有最小宽度，短标签不会被压扁', () => {
  const lay = layoutIr({
    ...IR,
    nodes: [{ id: 'a', label: 'A', kind: 'process', col: 0, row: 0 }],
    edges: [],
  });
  assert.ok(lay.nodes[0]!.w >= 80, '应满足最小宽度');
});

test('同格占用（同 col 同 row）导致节点被错开而不是重叠', () => {
  const lay = layoutIr({
    ...IR,
    nodes: [
      { id: 'a', label: 'A', kind: 'process', col: 0, row: 0 },
      { id: 'b', label: 'B', kind: 'process', col: 0, row: 0 },
    ],
    edges: [],
  });
  const a = lay.nodes.find(n => n.id === 'a')!;
  const b = lay.nodes.find(n => n.id === 'b')!;
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.equal(overlap, false, '同格节点不得重叠');
});

test('布局输出画布尺寸能容纳全部节点', () => {
  const lay = layoutIr(IR);
  for (const n of lay.nodes) {
    assert.ok(n.x + n.w <= lay.width, '节点右边界超出画布');
    assert.ok(n.y + n.h <= lay.height, '节点下边界超出画布');
  }
});

// ---------------------------------------------------------------- SVG 输出

test('编译产出完整 SVG 标签', () => {
  const out = compileIrToSvg(IR);
  assert.ok(out.startsWith('<svg'), '应输出 svg 开头');
  assert.ok(out.endsWith('</svg>'), '应以 svg 结尾');
  assert.ok(out.includes('viewBox='), '缺viewBox，无法自适应');
});

test('SVG 内每个节点一个 rect，且数量一致', () => {
  const out = compileIrToSvg(IR);
  const rects = out.match(/<rect/g) ?? [];
  assert.equal(rects.length, IR.nodes.length);
});

test('SVG 内每条边一个 path，且数量一致', () => {
  const out = compileIrToSvg(IR_X);
  // 只数连线：defs 里marker 自身也含一个 <path>，必须先剥掉 defs 再数，
  // 否则永远多1 条（首版就这么写错了）。
  // 本样例每对层各一条边 ⇒ path 数 = 边数（归并见下一条用例）。
  const body = out.replace(/<defs>[\s\S]*?<\/defs>/, '');
  const paths = body.match(/<path/g) ?? [];
  assert.equal(paths.length, IR_X.edges.length, '实际连线数 ' + paths.length);
});

test('架构图：同一对层之间的多条边归并成一条箭头（不是每条边一条线）', () => {
  // 归并是「层到层」的设计前提：同层的块级差异不再出现在线上，只保留「层与层有依赖」
  // 这个方向性事实。两条 a→c、b→c 同属 (row0 → row1)，只应画出一条线。
  const merged = {
    ...IR_X,
    nodes: [
      { id: 'a', label: '渲染进程', kind: 'component' as const, col: 0, row: 0 },
      { id: 'b', label: 'IPC 边界', kind: 'boundary' as const, col: 1, row: 0 },
      { id: 'c', label: '主进程', kind: 'process' as const, col: 0, row: 1 },
    ],
    edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }],
  };
  const body = compileIrToSvg(merged).replace(/<defs>[\s\S]*?<\/defs>/, '');
  assert.equal((body.match(/<path/g) ?? []).length, 1, '同一对层的两条边应归并成一条');
});

test('所有连线 path 都带 fill=none（避免连线被填充成怪形块）', () => {
  // ⚠ 先剥 defs：箭头 marker 自身的 path 是**实心**的（空心箭头在细线上看不出朝向，
  // 用户明确要求「方向要看得清」）。本用例针对的是连线，不是箭头。
  const out = compileIrToSvg(IR_X).replace(/<defs>[\s\S]*?<\/defs>/, '');
  const paths = [...out.matchAll(/<path[^>]*>/g)];
  assert.ok(paths.length > 0, '应至少有一条连线');
  for (const m of paths) {
    assert.ok(m[0]!.includes('fill="none"'), '连线 path 必须 fill=none：' + m[0]!.slice(0, 60));
  }
});

test('颜色全部走 CSS 变量，不含硬编码色值', () => {
  const out = compileIrToSvg(IR);
  // 硬编码色会破坏深浅色切换（现状链路的老问题）
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(out), 'SVG 不应含硬编码十六进制色');
  assert.ok(!/\brgb\(/.test(out), 'SVG 不应含 rgb()');
  assert.ok(out.includes('var(--c-'), '应使用 --c-* 变量');
});

test('节点标签文本进入 SVG（中文不转义成实体外）', () => {
  const out = compileIrToSvg(IR);
  assert.ok(out.includes('渲染进程'), '缺节点标签文本');
  assert.ok(out.includes('>渲染进程<'), '标签应为直接文本节点');
});

test('HTML 特殊字符被转义（防标签注入）', () => {
  const out = compileIrToSvg({
    ...IR,
    nodes: [{ id: 'x', label: '<script>alert(1)</script>', kind: 'process', col: 0, row: 0 }],
    edges: [],
  });
  assert.ok(!out.includes('<script>'), '不得输出未转义的 script 标签');
  assert.ok(out.includes('&lt;script&gt;'), '应转义为实体');
});

test('单节点无边时也能正常编译', () => {
  const out = compileIrToSvg({
    schema_version: 'forge-ir/2', diagram_type: 'architecture', meta: {},
    nodes: [{ id: 'solo', label: '独点', kind: 'process', col: 0, row: 0 }],
    edges: [],
  });
  assert.ok(out.includes('<svg'));
  const body = out.replace(/<defs>[\s\S]*?<\/defs>/, '');
  assert.equal((body.match(/<path/g) ?? []).length, 0, '无边则无连线');
});

// ---------------------------------------------------------------- 溢出

test('超宽图自动折行，宽度回到卡片可视范围内', () => {
  const many = {
    schema_version: 'forge-ir/2', diagram_type: 'architecture', meta: {},
    nodes: Array.from({ length: 12 }, (_, i) => ({
      id: 'n' + i, label: '节点' + i, kind: 'process' as const, col: i, row: 0,
    })),
    edges: [],
  };
  const lay = layoutIr(many);
  // 12 列必然超宽 → 必须折行，且 x 必须按「折行后列」重算。
  // 首版只改了 row 没改 col，width 仍 1268px —— 这条锁住该bug。
  assert.ok(lay.width <= IR_MAX_CANVAS_W,
    '折行后宽度应回到 ' + IR_MAX_CANVAS_W + ' 内，实际 ' + lay.width);
  assert.ok(lay.issues.some(i => i.includes('折为')), '应报告发生了折行');
  // 折行后仍不得有节点重叠
  for (let i = 0; i < lay.nodes.length; i++) {
    for (let j = i + 1; j < lay.nodes.length; j++) {
      const a = lay.nodes[i]!, b = lay.nodes[j]!;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, a.id + ' 与 ' + b.id + ' 重叠');
    }
  }
});

test('卡片高度是常量（骨架与终态同高，零跳变）', () => {
  assert.equal(IR_CARD_HEIGHT, 320, '与既有 canvas 卡片同高是硬要求');
});
// ---------------------------------------------------------------- 另存自含 HTML

test('另存产物：自含 HTML，内嵌 SVG 与双主题变量（脱离 forge 可直接打开）', async () => {
  const { buildIrStandaloneFile } = await import('../../src/markdown/canvasIrRender.ts');
  const ir = {
    schema_version: 'forge-ir/2', diagram_type: 'architecture', meta: { title: '分层' },
    nodes: [{ id: 'a', label: '节点A', kind: 'process' as const, col: 0, row: 0 }],
    edges: [],
  };
  const j = (await import('../../src/markdown/canvasIr.ts')).judgeIr(JSON.stringify(ir));
  const svg = compileIrToSvg(j.ir!);
  const file = buildIrStandaloneFile(svg, '分层');

  assert.ok(file.startsWith('<!DOCTYPE html>'), '应是完整 HTML 文档');
  assert.ok(file.includes(svg.slice(0, 60)), '应内嵌编译出的 SVG');
  assert.ok(file.includes('prefers-color-scheme'), '应含系统主题自适应（独立文件没有宿主主题可跟随）');
  assert.ok(file.includes('--c-ok-bg'), '应定义 SVG 依赖的 --c-* 变量');
  // 独立文件只能跟随系统主题，不允许写死单一浅色（现状链路的老坑）
  assert.ok(!/<body[^>]*style="[^"]*background:\s*#fff/i.test(file), '不得写死浅色底');
  assert.ok(!file.includes('<script'), '自含文件不需要脚本');
});

test('另存产物：title 被转义（防注入 <title>）', async () => {
  const { buildIrStandaloneFile } = await import('../../src/markdown/canvasIrRender.ts');
  const file = buildIrStandaloneFile('<svg></svg>', '<script>x</script>');
  assert.ok(!file.includes('<title><script>'), 'title 必须转义');
  assert.ok(file.includes('&lt;script&gt;'), '应转义为实体');
});
