/**
 * 画布围栏名的跨包一致性契约（docs/plan/canvas-card.md）。
 *
 * 为什么单独一条测试、且放在 forge-desktop：围栏名有两处定义——
 *   - forge-core canvasSandbox.CANVAS_LANGUAGE（渲染层认这个语言名才出占位）
 *   - forge-extensions canvasHint/prompt（提示词里写给模型用哪个围栏）
 * forge-extensions 不依赖 forge-core（只为一个字符串加跨包依赖不值得），所以编译器
 * 不会替我们盯住它们相等。而两边不一致的后果是**静默**的：模型照常输出 ```canvas，
 * 渲染层当普通代码块处理，卡片永远出不来，没有任何报错可查。
 *
 * 本包同时依赖两者，是唯一能一眼看住这条契约的地方。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANVAS_LANGUAGE, looksLikeHtmlCanvas } from '@forge/core/markdown';
import { CANVAS_FENCE_LANGUAGE, CANVAS_SPEC } from '@forge/extensions';

test('提示词里的围栏名 == 渲染层认的围栏名（不一致则卡片静默失效）', () => {
  assert.equal(CANVAS_FENCE_LANGUAGE, CANVAS_LANGUAGE);
});

test('输出契约文本里出现的围栏与注入的语义色，渲染层都认', () => {
  const spec = CANVAS_SPEC.join('\n');
  assert.ok(spec.includes('```' + CANVAS_LANGUAGE));
  // 契约要求模型只用注入变量取色：preflight 若改名而契约未改，卡片会全黑/全白
  assert.ok(spec.includes('--c-ok-bg'));
  assert.ok(spec.includes('--c-muted-fg'));
});

test('契约要求禁脚本，与渲染侧判据方向一致', () => {
  // 沙箱不开 allow-scripts：模型即便违规写了 script 也不会执行；
  // 而 looksLikeHtmlCanvas 只认「有没有标签」，不会因为含 script 就拒绝渲染
  assert.ok(CANVAS_SPEC.join('\n').includes('No `<script>`'));
  assert.equal(looksLikeHtmlCanvas('<div>a</div><script>alert(1)</script>'), true);
});
