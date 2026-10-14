/**
 * canvas_hint 注入逻辑（契约 docs/plan/canvas-card.md）。
 *
 * 守三件事：
 * 1. 意图判定只认显式出图请求（词表收窄于 2026-09：旧版偏松，泛主题词也命中，
 *    结果模型把纯文字说明也包进 canvas 围栏——「文字塞卡片」是实测抱怨，方向反转）；
 * 2. 两段式：常驻段永远在，完整规范只在命中的那一轮出现；
 * 3. applyCanvasHint 幂等，不随轮次累积膨胀。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCanvasHint,
  canvasHintExtension,
  registerCanvasHint,
} from '../../src/canvasHint/extension.ts';
import { looksLikeDiagramRequest } from '../../src/canvasHint/detect.ts';
import { CANVAS_SPEC, CANVAS_STANZA, CANVAS_STYLE_SPEC } from '../../src/canvasHint/prompt.ts';

const BASE = 'You are a coding agent.';

test('意图判定：中文显式出图请求命中（图的具体体裁 / 画图动词）', () => {
  assert.equal(looksLikeDiagramRequest('画个登录流程图'), true);
  assert.equal(looksLikeDiagramRequest('画一张鉴权时序图'), true);
  assert.equal(looksLikeDiagramRequest('给我画一下这套系统的架构图'), true);
  assert.equal(looksLikeDiagramRequest('把这张表可视化一下'), true);
});

test('意图判定：「画+图」动词变体正则命中（2026-09-29 真机漏网：「你画一个图」差一个字没进字面表）', () => {
  assert.equal(looksLikeDiagramRequest('你画一个图'), true);
  assert.equal(looksLikeDiagramRequest('画一个图'), true);
  assert.equal(looksLikeDiagramRequest('画幅图看看'), true);
  assert.equal(looksLikeDiagramRequest('给我画张图'), true);
  assert.equal(looksLikeDiagramRequest('画个图看看'), true); // 「画下这个流程」无「图」字，不在本表射程（体裁词才接得住）
  assert.equal(looksLikeDiagramRequest('整张图出来'), true); // 「整」锚行首
  assert.equal(looksLikeDiagramRequest('绘一张图'), true);
});

test('意图判定：含「画」「图」但不成画图短语的中文不误伤（正则枚举而非通配的钉法）', () => {
  assert.equal(looksLikeDiagramRequest('画龙点睛'), false);
  assert.equal(looksLikeDiagramRequest('图纸在哪'), false);
  assert.equal(looksLikeDiagramRequest('这个画布图的边框太粗'), false); // 「画布图」曾被 .{0,3} 方案误命中
  assert.equal(looksLikeDiagramRequest('把这张图发我'), false);
  assert.equal(looksLikeDiagramRequest('帮我整理一下这张图的说明'), false);
});

test('意图判定：泛主题词不再命中（旧版命中的正是这批，收窄记录在案）', () => {
  assert.equal(looksLikeDiagramRequest('帮我把这套鉴权机制讲清楚'), false);
  assert.equal(looksLikeDiagramRequest('这两个方案的优劣对比一下'), false);
  assert.equal(looksLikeDiagramRequest('设计一个订单状态机'), false);
  assert.equal(looksLikeDiagramRequest('帮我梳理一下登录流程'), false);
  assert.equal(looksLikeDiagramRequest('整理流程给我看'), false);
  assert.equal(looksLikeDiagramRequest('这份报告和代码实际链路对不上，核实'), false);
});

test('意图判定：英文显式出图请求命中', () => {
  assert.equal(looksLikeDiagramRequest('draw a diagram of the build pipeline'), true);
  assert.equal(looksLikeDiagramRequest('visualize the data flow'), true);
  assert.equal(looksLikeDiagramRequest('show me a flowchart of the deploy process'), true);
});

test('意图判定：英文泛词不再命中', () => {
  assert.equal(looksLikeDiagramRequest('walk me through the auth flow'), false);
  assert.equal(looksLikeDiagramRequest('explain how compaction works'), false);
  assert.equal(looksLikeDiagramRequest('compare the two approaches'), false);
});

test('意图判定：短事实问答不命中，避免白塞规范文本', () => {
  assert.equal(looksLikeDiagramRequest(''), false);
  assert.equal(looksLikeDiagramRequest('   '), false);
  assert.equal(looksLikeDiagramRequest('这个函数叫什么名字'), false);
  assert.equal(looksLikeDiagramRequest('1 + 1'), false);
});

test('两段式：未命中只追加常驻段，不含输出契约', () => {
  const out = applyCanvasHint(BASE, '这个函数叫什么名字');
  assert.ok(out.startsWith(BASE));
  assert.ok(out.includes(CANVAS_STANZA));
  assert.ok(!out.includes('## Diagram output contract'));
  assert.ok(!out.includes('Hard rules'));
});

test('常驻段自带最小画法：漏网轮也不许把围栏体幻觉成 mermaid（2026-09-29 真机）', () => {
  assert.ok(CANVAS_STANZA.includes('self-contained HTML+CSS fragment'));
  assert.ok(CANVAS_STANZA.includes('not mermaid syntax'));
});

test('两段式：命中时追加完整契约', () => {
  const out = applyCanvasHint(BASE, '画个登录流程图');
  assert.ok(out.includes(CANVAS_STANZA));
  assert.ok(out.includes('## Diagram output contract'));
  // 契约里必须含三条硬约束（沙箱不开脚本 / 不外链资源 / 只能用注入的语义色）
  assert.ok(out.includes('No `<script>`'));
  assert.ok(out.includes('--c-ok-bg'));
  // 风格规范（P0 拍板：单一「青瓷数据」风格）与硬约束同轮追加，且排在 SPEC 之后
  assert.ok(out.includes('## Card style'));
  assert.ok(out.indexOf('## Diagram output contract') < out.indexOf('## Card style'),
    '先保证能渲染（SPEC），再保证好看（STYLE）——顺序反了说明注入拼错');
});

test('风格规范只从语义 token 派生颜色（不许出现裸 hex/rgb 写死色，否则暗色主题翻车）', () => {
  const spec = CANVAS_STYLE_SPEC.join('\n');
  assert.ok(spec.includes('color-mix'), '派生色是这套风格的根基');
  // 禁止「#rgb 三位/六位 hex 字面量」出现在风格段（示例色板都不行——模型会照抄）
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(spec), '风格段不得出现写死的 hex 色');
  assert.ok(!/rgb\(|rgba\(/.test(spec), '风格段不得出现写死的 rgb()');
  // 字体三员锁死：衬线压标题数字、等宽只压标签
  assert.ok(spec.includes('Georgia'), '衬线是标题/数字的主力');
  assert.ok(spec.includes('Consolas'), '等宽只用于标签 chip');
  // 一致性声明必须在场（这是单一风格的产品理由）
  assert.ok(/one style|consistent/i.test(spec), '必须明说「只有一个风格，不许自创」');
});

test('幂等：常驻段已存在时原样返回，不随轮次累积', () => {
  const once = applyCanvasHint(BASE, '画个流程图');
  const twice = applyCanvasHint(once, '画个流程图');
  assert.equal(twice, once);
  const thrice = applyCanvasHint(twice, '再梳理一次');
  assert.equal(thrice.length, once.length);
});

test('空系统提示不崩', () => {
  assert.ok(applyCanvasHint('', '画个流程图').includes(CANVAS_SPEC[0]));
});

test('扩展注册形态：name 唯一、只挂 before_agent_start', () => {
  assert.equal(canvasHintExtension.name, 'forge-canvas-hint');
  const handlers: Array<(event: { prompt: string; systemPrompt: string }) => Promise<{ systemPrompt: string }>> = [];
  const pi = {
    on(event: string, handler: unknown) {
      if (event === 'before_agent_start') handlers.push(handler as never);
    },
    registerTool() {
      assert.fail('canvas_hint 不注册工具');
    },
  };
  registerCanvasHint(pi as never);
  assert.equal(handlers.length, 1);
});

test('钩子往返：本轮 systemPrompt 被替换，且不改写下轮基准（返回值不含入参之外的副作用）', async () => {
  let captured: ((event: { prompt: string; systemPrompt: string }) => Promise<{ systemPrompt: string }>) | null = null;
  const pi = {
    on(_event: string, handler: unknown) {
      captured = handler as never;
    },
  };
  registerCanvasHint(pi as never);
  assert.ok(captured);
  const hook = captured as (e: { prompt: string; systemPrompt: string }) => Promise<{ systemPrompt: string }>;
  const res = await hook({ prompt: '画个流程图', systemPrompt: BASE });
  assert.ok(res.systemPrompt.includes('## Diagram output contract'));
  // 入参字符串不可变：下一轮 pi 仍拿原始基准
  assert.equal(BASE, 'You are a coding agent.');
});
