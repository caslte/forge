import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripThinkingContent } from '../../src/pi/thinkingFilter.ts';

// ===== 真实格式：MiniMax-M3 输出 DeepSeek 风格 相当于/相当于 标签 =====
// 注意：本文件源码中 think 标签需用拼接构造（T_OPEN/T_CLOSE），直接写字面量会被
// 工具链当 HTML 标签剥离（与生产观察到的显示层剥离同源）。
const T_OPEN = '<th' + 'ink>';
const T_CLOSE = '</th' + 'ink>';

test('stripThinkingContent：剥离成对 相当于…相当于', () => {
  assert.equal(
    stripThinkingContent(T_OPEN + 'The user just said "你好". Simple greeting. Be brief.' + T_CLOSE + '\n\n你好！有什么可以帮你的？'),
    '你好！有什么可以帮你的？',
  );
});

test('stripThinkingContent：相当于 标签后直接跟正文（无空行）', () => {
  assert.equal(
    stripThinkingContent(T_OPEN + '先想清楚再回答。' + T_CLOSE + '你好，这里是正式回答'),
    '你好，这里是正式回答',
  );
});

test('stripThinkingContent：相当于 未闭合（流式进行中/思考中）截断到开标签，思考不外漏', () => {
  assert.equal(stripThinkingContent(T_OPEN + 'The user is asking about images'), '');
});

test('stripThinkingContent：相当于 未闭合且前有正文，保留开标签之前的正文', () => {
  assert.equal(stripThinkingContent('正文在前' + T_OPEN + '思考未结束的内容'), '正文在前');
});

test('stripThinkingContent：相当于 块内含代码块/换行，整块剥离', () => {
  assert.equal(
    stripThinkingContent(T_OPEN + '\n```js\nconst a = 1;\n```\n多行思考' + T_CLOSE + '\n\n答案'),
    '答案',
  );
});

test('stripThinkingContent：大小写不敏感的 相当于 变体', () => {
  assert.equal(stripThinkingContent('<THINK>小写闭合</Think>答案'), '答案');
});

test('stripThinkingContent：剥离 <thinking> 包裹块', () => {
  assert.equal(
    stripThinkingContent('答案在前<thinking>思考过程</thinking>，结论在后'),
    '答案在前，结论在后',
  );
});

test('stripThinkingContent：剥离 <reasoning> / [thinking] / [reasoning] 包裹块', () => {
  assert.equal(
    stripThinkingContent('a<reasoning>r1</reasoning>b[thinking]t1[/thinking]c[reasoning]r2[/reasoning]d'),
    'abcd',
  );
});

test('stripThinkingContent：大小写不敏感', () => {
  assert.equal(stripThinkingContent('x<THINKING>深</THINKING>y<Thinking>浅</Thinking>z'), 'xyz');
});

test('stripThinkingContent：跨多行内容整块剥离', () => {
  const input = '正文\n<thinking>\n第一行思考\n第二行思考\n</thinking>\n正文结束';
  assert.equal(stripThinkingContent(input), '正文\n\n正文结束');
});

test('stripThinkingContent：不成对（未闭合）标签截断到开标签处（流式安全语义）', () => {
  // 未闭合 = 思考进行中，其后内容一律视为思考不外漏
  assert.equal(stripThinkingContent('正文<thinking>没有闭合的块'), '正文');
});

test('stripThinkingContent：孤立闭合标签（无开标签）保留原文', () => {
  const input = '正文</thinking>孤立闭合</reasoning>正文';
  assert.equal(stripThinkingContent(input), input);
});

test('stripThinkingContent：多组标签全部剥离', () => {
  assert.equal(
    stripThinkingContent('<thinking>一</thinking>正文<thinking>二</thinking>尾'),
    '正文尾',
  );
});

test('stripThinkingContent：无 thinking 内容的普通文本原样返回', () => {
  assert.equal(stripThinkingContent('普通正文，无思考内容'), '普通正文，无思考内容');
});

test('stripThinkingContent：空串与空白串原样返回', () => {
  assert.equal(stripThinkingContent(''), '');
  assert.equal(stripThinkingContent('   '), '   ');
});

test('stripThinkingContent：MiniMax 混流 ` thinking…response` 保留正式回答', () => {
  assert.equal(
    stripThinkingContent(' thinkingThe user said hi. Be brief. response\n\n你好！有什么可以帮你的？'),
    '你好！有什么可以帮你的？',
  );
});

test('stripThinkingContent：`<thinking…response` 未闭合形态截断（思考不外漏）', () => {
  assert.equal(stripThinkingContent('<thinking关键发现: 先按声明缺失修。 response\n\n已修复，请重试'), '');
});

test('stripThinkingContent：纯思考（`thinking` 起手无 `response` 收尾）整体置空', () => {
  assert.equal(stripThinkingContent(' thinking这是一段没有收尾标记的内心独白，不该展示'), '');
});

test('stripThinkingContent：思考内的 `response.` 词尾不当作收尾（不截断正式回答）', () => {
  assert.equal(
    stripThinkingContent(' thinking目标已明确 response. 继续执行 response\n\n最终答案'),
    '最终答案',
  );
});

test('stripThinkingContent：大写 Thinking 开头的正常回复不被误删', () => {
  const text = 'Thinking about your error, the log shows auth failed. 请检查 API Key。';
  assert.equal(stripThinkingContent(text), text);
});

test('stripThinkingContent：正文夹带 `thinking` 词（非起手）不触发清洗', () => {
  const text = '你说 thinking 这个词是模型思考标记，明白。';
  assert.equal(stripThinkingContent(text), text);
});