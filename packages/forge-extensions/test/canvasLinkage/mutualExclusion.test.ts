/**
 * 两套画布契约的互斥与工具禁令（2026-10-10 真机问题驱动）。
 *
 * ## 为什么要有这份测试
 *
 * 真机观察（用户提供截图）暴露两个问题：
 *
 * 1. **模型会用工具绕过卡片链路**：截图里模型执行 `cat > /tmp/arch.html`
 *    把图写进文件，而卡片链路只能渲染对话流里的围栏 ⇒ **界面上什么都不显示，
 *    零报错**。这是静默失效，比「画得丑」严重得多。
 * 2. **两套契约同时注入**：canvasHint 说「写 HTML+CSS，遵守 9 条排版规则」，
 *    canvasIrHint 说「别写 HTML/CSS，只给结构」。同时注入等于给模型矛盾指令。
 *
 * 这两条都属于「提示词写了但没人保证模型真的照做」的层级，所以必须有测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCanvasHint,
  canvasHintExtension,
} from '../../src/canvasHint/extension.ts';
import {
  applyIrHint,
  canvasIrHintExtension,
  isIrExtensionEnabled,
  IR_EXTENSION_ENV,
} from '../../src/canvasIrHint/extension.ts';
import { CANVAS_SPEC, CANVAS_STANZA } from '../../src/canvasHint/prompt.ts';
import { IR_SPEC, IR_STANZA } from '../../src/canvasIrHint/promptIr.ts';

// ---------------------------------------------------------------- 默认关闭（2026-10-10 回退裁定）

test('默认关闭：环境变量未设置时 IR 链路不生效（回退裁定，原「默认开」已撤销）', () => {
  // 轨迹：默认关 → 用户要求默认开（真机验证）→ 真机结论「不可用，不如 html 直出」
  // → 回退默认关。IR 保留为可显式开启的实验特性，调优达标后再考虑默认。
  assert.equal(isIrExtensionEnabled({}), false, '未设变量应视为关闭');
});

test('显式 1/on/true 可开启（调优后灰度用）', () => {
  for (const v of ['1', 'on', 'true', 'TRUE']) {
    assert.equal(isIrExtensionEnabled({ [IR_EXTENSION_ENV]: v }), true, v);
  }
});

test('显式 0 / off / false / 乱填均为关闭（拼写错误倾向关闭而非误开）', () => {
  for (const v of ['0', 'off', 'false', 'no', 'yes', '']) {
    assert.equal(isIrExtensionEnabled({ [IR_EXTENSION_ENV]: v }), false, v);
  }
});

// ---------------------------------------------------------------- 契约互斥

test('IR 开启时 canvasHint 不注入任何内容（避免两套互斥契约同时下发）', () => {
  const env = { [IR_EXTENSION_ENV]: '1' };
  const out = applyCanvasHint('BASE', '梳理一下项目架构图', env);
  assert.equal(out, 'BASE', 'IR 开启时 canvasHint 必须完全让位');
});

test('IR 关闭（默认）时 canvasHint 照旧注入（现状 HTML 链路完好）', () => {
  const out = applyCanvasHint('BASE', '梳理一下项目架构图', {});
  assert.ok(out !== 'BASE', '默认（未设变量）canvasHint 应注入');
  assert.ok(out.includes(CANVAS_STANZA.slice(0, 40)), '应含常驻段');
  assert.ok(out.includes('## Diagram output contract'), '命中出图意图应含完整契约');
});

test('两个扩展名不同，不会互相覆盖注册', () => {
  assert.equal(canvasHintExtension.name, 'forge-canvas-hint');
  assert.equal(canvasIrHintExtension.name, 'forge-canvas-ir-hint');
});

// ---------------------------------------------------------------- 工具禁令

test('canvas 契约禁止用工具/文件产出图示（真机静默失效点）', () => {
  const spec = (CANVAS_SPEC.join('\n') + ' ' + CANVAS_STANZA).toLowerCase();
  // 必须明确禁止：写文件、命令行产出、让用户去别处看
  assert.ok(/must not|never|do not/.test(spec), '契约需有明确的禁止句式');
  assert.ok(
    /file|filesystem|command line|shell|bash|terminal|tool call|write/i.test(spec),
    '契约必须点名「不要写文件/不要用命令产出图」',
  );
});

test('IR 契约同样禁止用工具/文件产出图示', () => {
  const spec = (IR_SPEC.join('\n') + ' ' + IR_STANZA).toLowerCase();
  assert.ok(
    /file|filesystem|command line|shell|bash|terminal|tool call|write/i.test(spec),
    'IR 契约也必须禁止绕道工具产出',
  );
});

test('工具禁令提到了「只在回复里」这一正向落点', () => {
  // 只写禁令不给落点，模型可能不知道怎么正常产出。两条契约都应点明：
  // 图示内容必须出现在本条回复正文的围栏里。
  for (const spec of [CANVAS_SPEC.join('\n'), IR_SPEC.join('\n')]) {
    assert.ok(
      /in (this|the) (reply|response|message)/i.test(spec),
      '契约应说明图示写在回复正文的围栏里',
    );
  }
});

// ---------------------------------------------------------------- 退路措辞

test('canvas 契约的退路不再劝退到 markdown（真机模型倾向不画）', () => {
  const spec = CANVAS_SPEC.join('\n');
  // 原措辞：'Plain markdown ... is the default and carries most answers'
  //          'skip the card and write markdown instead'
  // 这两句让模型在「梳理架构」这种本该出图的请求上选择不画（真机已发生）。
  assert.ok(
    !/carries most answers/i.test(spec),
    '不该再说 markdown 承载大多数答案',
  );
  assert.ok(
    !/skip the card and write markdown instead/i.test(spec),
    '不该再明写「跳过卡片改写 markdown」',
  );
});

test('IR 契约同样不劝退（真机同因）', () => {
  const spec = IR_SPEC.join('\n');
  assert.ok(!/carries most answers/i.test(spec));
});