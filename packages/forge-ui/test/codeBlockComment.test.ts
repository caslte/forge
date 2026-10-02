/**
 * 跨行块注释状态扫描单元测试（模块 12）。
 *
 * 存在的理由：hljs 是**逐行**调用的（沿用 diff 视图的 highlightDiffLine），
 * 因此跨行块注释的中间行会被 hljs 当成普通代码上色。本模块负责把这些行捞出来。
 * 判错的后果很具体：注释中间几行突然变成彩色代码，或反过来整段注释不上色。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markBlockCommentLines } from '../src/utils/codeBlockComment.ts';

test('单行闭合的块注释不污染下一行', () => {
  const m = markBlockCommentLines(['/* a */', 'const x = 1;'].join('\n'), 'typescript');
  assert.deepEqual(m, [true, false]);
});

test('跨行块注释：起始行、中间行、结束行全部标记', () => {
  const m = markBlockCommentLines(
    ['/*', ' * 说明', ' * 更多', ' */', 'const x = 1;'].join('\n'),
    'typescript',
  );
  assert.deepEqual(m, [true, true, true, true, false]);
});

test('两段独立块注释互不干扰', () => {
  const m = markBlockCommentLines(['/* a', ' b */', 'code', '/* c', ' d */', 'code2'].join('\n'), 'typescript');
  assert.deepEqual(m, [true, true, false, true, true, false]);
});

test('字符串里的 /* 不开启块注释', () => {
  const m = markBlockCommentLines(['const s = "/*";', 'const t = 1;'].join('\n'), 'typescript');
  assert.deepEqual(m, [false, false]);
});

test('单引号字符串同样不算', () => {
  const m = markBlockCommentLines(["const s = '/*'", 'const t = 1;'].join('\n'), 'typescript');
  assert.deepEqual(m, [false, false]);
});

test('转义引号不提前闭合字符串', () => {
  // 字符串内容是 "a\" 然后才是 /* ——若不处理转义，会误以为字符串已结束
  const m = markBlockCommentLines(['const s = "a\\" /*";', 'const t = 1;'].join('\n'), 'typescript');
  assert.deepEqual(m, [false, false]);
});

test('行注释之后的 /* 不开启块注释', () => {
  const m = markBlockCommentLines(['// 提示 /* 这是行注释', 'const t = 1;'].join('\n'), 'typescript');
  assert.deepEqual(m, [false, false]);
});

test('行注释先于块注释时以先出现者为准', () => {
  // "/*" 出现在 /* real 之前，但整行从行注释开始 → 不进入块注释
  const m = markBlockCommentLines(['/* " */ // 注释 /*', 'const t = 1;'].join('\n'), 'typescript');
  // 首行的 /* 在引号外且同行闭合 → true；下一行不应被标记
  assert.equal(m[1], false);
});

test('HTML 注释用 <!-- --> 而非 C 系起止符', () => {
  const m = markBlockCommentLines(['<!-- a', 'b', '-->', '<p/>'].join('\n'), 'xml');
  assert.deepEqual(m, [true, true, true, false]);
});

test('vue 文件（走 xml 语言）同样支持 HTML 注释', () => {
  const m = markBlockCommentLines(['<template>', '<!-- x', 'y', '-->', '</template>'].join('\n'), 'xml');
  assert.deepEqual(m, [false, true, true, true, false]);
});

test('无块注释的语言（json / python / yaml）返回空数组', () => {
  assert.deepEqual(markBlockCommentLines('{"a": 1}', 'json'), []);
  assert.deepEqual(markBlockCommentLines('x = 1  # 注释', 'python'), []);
  assert.deepEqual(markBlockCommentLines('a: 1', 'yaml'), []);
});

test('语言未注册/未传入时全按「无块注释」处理（交给 hljs 逐行）', () => {
  assert.deepEqual(markBlockCommentLines('/* a', undefined), []);
  assert.deepEqual(markBlockCommentLines('/* a', 'not-a-real-lang'), []);
});

test('数组长度恒等于行数（渲染层按行号直接索引，错位会串色）', () => {
  const body = 'a\nb\nc\nd';
  assert.equal(markBlockCommentLines(body, 'typescript').length, 4);
  // 末尾空行也算一行：'a\n' 切成 ['a','']
  assert.equal(markBlockCommentLines('a\n', 'typescript').length, 2);
});

test('未闭合的块注释一直标记到文件末尾（半截文件也要正确）', () => {
  const m = markBlockCommentLines(['/*', 'a', 'b'].join('\n'), 'typescript');
  assert.deepEqual(m, [true, true, true]);
});

test('PowerShell 的 <# #>', () => {
  const m = markBlockCommentLines(['<#', 'note', '#>', 'Get-Item'].join('\n'), 'powershell');
  assert.deepEqual(m, [true, true, true, false]);
});
