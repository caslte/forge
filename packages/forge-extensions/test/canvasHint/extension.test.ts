/**
 * canvas_hint 注入逻辑（契约 docs/plan/canvas-card.md）。
 *
 * 守三件事：
 * 1. 意图判定偏松不漏（「讲清楚机制」这类没有「流程」二字的请求也必须命中）；
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
import { CANVAS_SPEC, CANVAS_STANZA } from '../../src/canvasHint/prompt.ts';

const BASE = 'You are a coding agent.';

test('意图判定：中文显式词命中', () => {
  assert.equal(looksLikeDiagramRequest('帮我梳理一下登录流程'), true);
  assert.equal(looksLikeDiagramRequest('整理流程给我看'), true);
  assert.equal(looksLikeDiagramRequest('设计一个订单状态机'), true);
});

test('意图判定：不含「流程」二字但明显该画图的请求要命中（漏判是主要风险）', () => {
  assert.equal(looksLikeDiagramRequest('帮我把这套鉴权机制讲清楚'), true);
  assert.equal(looksLikeDiagramRequest('这份报告和代码实际链路对不上，核实'), true);
  assert.equal(looksLikeDiagramRequest('这两个方案的优劣对比一下'), true);
});

test('意图判定：英文请求命中', () => {
  assert.equal(looksLikeDiagramRequest('walk me through the auth flow'), true);
  assert.equal(looksLikeDiagramRequest('explain how compaction works'), true);
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

test('两段式：命中时追加完整契约', () => {
  const out = applyCanvasHint(BASE, '梳理一下登录流程');
  assert.ok(out.includes(CANVAS_STANZA));
  assert.ok(out.includes('## Diagram output contract'));
  // 契约里必须含三条硬约束（沙箱不开脚本 / 不外链资源 / 只能用注入的语义色）
  assert.ok(out.includes('No `<script>`'));
  assert.ok(out.includes('--c-ok-bg'));
});

test('幂等：常驻段已存在时原样返回，不随轮次累积', () => {
  const once = applyCanvasHint(BASE, '梳理流程');
  const twice = applyCanvasHint(once, '梳理流程');
  assert.equal(twice, once);
  const thrice = applyCanvasHint(twice, '再梳理一次');
  assert.equal(thrice.length, once.length);
});

test('空系统提示不崩', () => {
  assert.ok(applyCanvasHint('', '梳理流程').includes(CANVAS_SPEC[0]));
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
  const res = await hook({ prompt: '梳理流程', systemPrompt: BASE });
  assert.ok(res.systemPrompt.includes('## Diagram output contract'));
  // 入参字符串不可变：下一轮 pi 仍拿原始基准
  assert.equal(BASE, 'You are a coding agent.');
});
