/**
 * 架构图「标签落位」的集成回归（2026-10-13 用户两轮截图实测）。
 *
 * 用户第一轮红框标注「字遮挡」：边标签药丸压住节点盒，而节点画在药丸之后，半个字被盖掉。
 * 当时的载体是**同层边**（折行带跨子行 Z 折线，标签锚点子行间隙只有 12px）。
 *
 * ⚠ 2026-10-13 两轮规则变更后，这个载体**整体消失**：
 *   1. 「架构图层内不画线」⇒ 同层边不再绘制；
 *   2. 「每道缝隙最多一条跨层箭头」⇒ 跨层标签只出现在两道泳道之间的留白里。
 * 于是「药丸压节点」在当前几何下**结构上不可能发生**。本文件因此锁的是那条
 * **结构性原因**（标签锚点必须落在层间留白里——变异：把锚点挪进泳道带内部立刻红），
 * 外加一条真正会红的不变量（药丸渲染在节点之后）。
 *
 * 消歧器本身「能不能把压盒锚点挪开」由 `labelPlace.test.ts` 的单元用例非空转地锁住
 * （'锚点压住节点盒 ⇒ 位移到干净候选'）——集成层不再重复造一个空转的断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileIrToSvg, compileIrWithMeta } from '../../src/markdown/canvasIrRender.ts';
import { pillRect } from '../../src/markdown/canvasIr/labelPlace.ts';

/**
 * 折行带 + 跨层混合文档：tier0 有 6 个节点（折成 2 个子行）、tier1/tier2 各 2 个。
 * 依赖故意给得多且带标签——用来验证「汇总缝隙不显示标签、且每条缝隙最多一条箭头」。
 */
function mixedIr(): string {
  return JSON.stringify({
    schema_version: 'forge-ir/2',
    diagram_type: 'architecture',
    meta: { title: '折行带 + 跨层' },
    tiers: [
      { row: 0, name: '渲染层' },
      { row: 1, name: '宿主层' },
      { row: 2, name: '引擎层' },
    ],
    nodes: [
      { id: 'n0', label: '零号盒', kind: 'module', col: 0, row: 0 },
      { id: 'n1', label: '一号盒', kind: 'module', col: 1, row: 0 },
      { id: 'n2', label: '二号盒', kind: 'module', col: 2, row: 0 },
      { id: 'n3', label: '三号盒', kind: 'module', col: 3, row: 0 },
      { id: 'n4', label: '四号盒', kind: 'module', col: 4, row: 0 },
      { id: 'n5', label: '五号盒', kind: 'module', col: 5, row: 0 },
      { id: 'm0', label: '宿主甲', kind: 'process', col: 0, row: 1 },
      { id: 'm1', label: '宿主乙', kind: 'process', col: 1, row: 1 },
      { id: 'c0', label: '引擎甲', kind: 'service', col: 0, row: 2 },
      { id: 'c1', label: '引擎乙', kind: 'service', col: 1, row: 2 },
    ],
    edges: [
      { from: 'n5', to: 'm1', label: '相邻下行' },
      { from: 'm0', to: 'c1', label: '相邻下行二' },
      { from: 'c0', to: 'n2', label: '跨多层上行' },
      { from: 'n1', to: 'c1', label: '跨多层下行' },
      { from: 'm1', to: 'n4', label: '相邻上行' },
    ],
  });
}

/** 每道缝隙恰好一条依赖 ⇒ 标签一一对应、无歧义 ⇒ 保留显示（药丸落位的真实用例）。 */
function labeledIr(): string {
  return JSON.stringify({
    schema_version: 'forge-ir/2',
    diagram_type: 'architecture',
    meta: { title: '每缝隙一条' },
    tiers: [
      { row: 0, name: '上层' },
      { row: 1, name: '中层' },
      { row: 2, name: '下层' },
    ],
    nodes: [
      { id: 'a', label: '甲块', kind: 'process', col: 0, row: 0 },
      { id: 'b', label: '乙块', kind: 'process', col: 0, row: 1 },
      { id: 'c', label: '丙块', kind: 'process', col: 0, row: 2 },
    ],
    edges: [
      { from: 'a', to: 'b', label: '第一段依赖' },
      { from: 'b', to: 'c', label: '第二段依赖' },
    ],
  });
}

test('标签锚点落在两道泳道之间的留白里（这是「药丸不压节点」的结构性原因）', () => {
  const fixtures: Array<[string, string]> = [['折行带+跨层', mixedIr()], ['每缝隙一条', labeledIr()]];
  let checked = 0;
  for (const [tag, json] of fixtures) {
    const { layout } = compileIrWithMeta(JSON.parse(json));
    const tiers = layout.tiers ?? [];
    assert.ok(tiers.length >= 2, tag + '：应有泳道信息');
    for (const e of layout.edges) {
      if (!e.label) continue;
      checked++;
      const pill = pillRect(e.lx, e.ly, e.label);
      // 药丸必须整颗落在某两道相邻泳道之间的空隙里。
      // 变异：把锚点从缝隙中点挪进泳道带内部 ⇒ 这条立刻红。
      const inGap = tiers.some((t, k) => {
        const next = tiers[k + 1];
        if (!next) return false;
        return pill.y >= t.y + t.h - 0.5 && pill.y + pill.h <= next.y + 0.5;
      });
      assert.ok(inGap, `${tag}：标签「${e.label}」药丸不在层间留白里（y=${pill.y}，h=${pill.h}）`);
      // 前向守卫：既然锚点在留白里、节点只存在于泳道带内部，压盒就不可能发生。
      for (const n of layout.nodes) {
        const hit = pill.x < n.x + n.w && pill.x + pill.w > n.x && pill.y < n.y + n.h && pill.y + pill.h > n.y;
        assert.ok(!hit, `${tag}：标签「${e.label}」药丸压住节点「${n.label}」`);
      }
    }
  }
  assert.ok(checked >= 2, '应当至少检查到 2 个标签（每缝隙一条的样例必须显示标签）');
});

test('渲染顺序：边标签画在节点之后（残留碰撞也不被裁半个字）', () => {
  const svg = compileIrToSvg(JSON.parse(labeledIr()));
  const nodeIdx = svg.indexOf('甲块');
  const pillIdx = svg.indexOf('第一段依赖');
  assert.ok(nodeIdx > 0 && pillIdx > 0, '节点文本与标签文本都应出现');
  assert.ok(pillIdx > nodeIdx, '标签必须画在节点之后（图标顺序即层层序）');
});
