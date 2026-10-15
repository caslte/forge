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
import { CANVAS_FENCE_LANGUAGE, CANVAS_SPEC, CANVAS_STYLE_SPEC } from '@forge/extensions';

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

test('风格规范引用的变量在宿主注入清单里（color-mix 派生色的根基，改名即翻车）', () => {
  const spec = CANVAS_STYLE_SPEC.join('\n');
  // 风格段只许从这批 token 派生：出现清单外的 --c-* 变量 = preflight 没注入 = 派生色解析失败
  const allowed = new Set([
    '--c-bg', '--c-fg', '--c-muted', '--c-muted-fg', '--c-surface', '--c-border',
    '--c-ok', '--c-warn', '--c-bad', '--c-accent',
    '--c-ok-bg', '--c-warn-bg', '--c-bad-bg',
    // porcelain 纸底/瓷墨：宿主按主题算好注入（v6.35），模型只许引用不许自建
    '--c-paper', '--c-ink',
  ]);
  const used = [...spec.matchAll(/--c-[a-z-]+/g)].map((m) => m[0]);
  assert.ok(used.length > 0, '风格段应引用语义 token');
  for (const v of used) {
    assert.ok(allowed.has(v), `风格段引用了 ${v}，但宿主 preflight 不注入它`);
  }
  assert.ok(spec.includes('--c-paper') && spec.includes('--c-ink'),
    'porcelain 两大 token 必须在场：模型不得用 color-mix 自建（跨主题不成立）');
  assert.ok(!/--c-(paper|ink)\s*:\s*color-mix/.test(spec.replace(/var\(--c-\w+\)/g, '')),
    '风格段不得教模型用 color-mix 重建 paper/ink');
});

test('契约要求禁脚本，与渲染侧判据方向一致', () => {
  // 沙箱不开 allow-scripts：模型即便违规写了 script 也不会执行；
  // 而 looksLikeHtmlCanvas 只认「有没有标签」，不会因为含 script 就拒绝渲染
  assert.ok(CANVAS_SPEC.join('\n').includes('No `<script>`'));
  assert.equal(looksLikeHtmlCanvas('<div>a</div><script>alert(1)</script>'), true);
});
