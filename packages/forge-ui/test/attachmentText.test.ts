import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseUserContent } from '../src/attachmentText.ts';

test('parseUserContent：尾部图片路径行 → images，不出现在正文', () => {
  const r = parseUserContent('看看\nC:\\Users\\x\\Desktop\\a.png');
  assert.equal(r.body, '看看');
  assert.deepEqual(r.images, ['C:\\Users\\x\\Desktop\\a.png']);
  assert.deepEqual(r.files, []);
});

test('parseUserContent：尾部非图片路径行 → files', () => {
  const r = parseUserContent('看下\nC:\\a\\build.sh');
  assert.equal(r.body, '看下');
  assert.deepEqual(r.files, ['C:\\a\\build.sh']);
  assert.deepEqual(r.images, []);
});

test('parseUserContent：markdown 链接图片（file:/// URL）任意位置提取为 images，正文移除', () => {
  const content = '[Image #1](file:///C:/Users/x/.pi/agent/image-view/blocks/abc129464.png)\n正文说明\n[Image #2](file:///C:/Users/x/.pi/agent/image-view/blocks/def575.png)';
  const r = parseUserContent(content);
  assert.deepEqual(r.images, [
    'C:/Users/x/.pi/agent/image-view/blocks/abc129464.png',
    'C:/Users/x/.pi/agent/image-view/blocks/def575.png',
  ]);
  assert.equal(r.body, '正文说明');
});

test('parseUserContent：双层方括号链接 [[Image #N]](file:///) 也能提取', () => {
  const content = '正文\n[[Image #3]](file:///C:/Users/x/.pi/agent/image-view/blobs/082e08b7.png)';
  const r = parseUserContent(content);
  assert.deepEqual(r.images, ['C:/Users/x/.pi/agent/image-view/blobs/082e08b7.png']);
  assert.equal(r.body, '正文');
});

test('parseUserContent：stripImageMarkers 时移除裸 [Image #N] 占位行（pi 会话格式，图已另行渲染）', () => {
  const content = '能看见，这张“附件类型”四个字…\n[Image #1]\n[Image #2]';
  const r = parseUserContent(content, { hasEmbeddedImages: true });
  assert.equal(r.body, '能看见，这张“附件类型”四个字…');
  assert.deepEqual(r.images, []);
  assert.deepEqual(r.files, []);
});

test('parseUserContent：消息已含 base64 图 part 时，文本里的链接图片不重复提取（同一张图渲染两遍的回归）', () => {
  const content = '不对，我马上在测试一下，这条消息只发送了一个图片\n[[Image #7]](file:///C:/Users/chenmo/.pi/agent/image-view/blobs/b1de943b.png)';
  const r = parseUserContent(content, { hasEmbeddedImages: true });
  assert.equal(r.body, '不对，我马上在测试一下，这条消息只发送了一个图片', '链接引用随 base64 缩略图展示，正文剥离');
  assert.deepEqual(r.images, [], '链接不进缩略图列表，否则同一张图渲染两遍');
});

test('parseUserContent：@[[]] 链接（forge @ 前缀 + 扩展改写）不残留孤立 @', () => {
  // 真实场景：forge 粘贴图发 `@C:\…png`，pi-image-view 把路径改写为 [[Image #N]](file:///) 链接，
  // @ 前缀残留成孤立行，气泡正文尾巴会多出一个 @
  const content = '背景颜色淡一点\n@[[Image #1]](file:///C:/Users/chenmo/.pi/agent/image-view/blobs/348ff566.png)';
  const r = parseUserContent(content, { hasEmbeddedImages: true });
  assert.equal(r.body, '背景颜色淡一点');
  assert.deepEqual(r.images, []);
});

test('parseUserContent：裸 @[Image #N] 占位行（@ 前缀残留）一并剥离', () => {
  const r = parseUserContent('看图\n@[Image #2]', { hasEmbeddedImages: true });
  assert.equal(r.body, '看图');
  assert.deepEqual(r.images, []);
});

test('parseUserContent：无 base64 part 时 @[[]] 链接照常提取缩略图且不留 @', () => {
  const r = parseUserContent('看这张\n@[[Image #1]](file:///C:/x/logo.png)');
  assert.deepEqual(r.images, ['C:/x/logo.png']);
  assert.equal(r.body, '看这张');
});

test('parseUserContent：无 base64 part 时链接图片照常提取（forge 路径消息 / 粘贴文本）', () => {
  const content = '看这张\n[Image #1](file:///C:/x/logo.png)';
  const r = parseUserContent(content);
  assert.deepEqual(r.images, ['C:/x/logo.png']);
  assert.equal(r.body, '看这张');
});

test('parseUserContent：http 图片链接不提取（保留正文原样）', () => {
  const content = '看这个 [图](https://example.com/a.png) 与 [文档](https://example.com/doc)';
  const r = parseUserContent(content);
  assert.equal(r.images.length, 0);
  assert.equal(r.body, content);
});

test('parseUserContent：混排——链接图片 + 尾部文件路径行同时提取', () => {
  const content = '截图和日志\n[Image #1](file:///C:/x/s1.png)\n\nC:\\logs\\run.log';
  const r = parseUserContent(content);
  assert.deepEqual(r.images, ['C:/x/s1.png']);
  assert.deepEqual(r.files, ['C:\\logs\\run.log']);
  assert.equal(r.body, '截图和日志');
});

test('parseUserContent：普通消息原样返回', () => {
  const r = parseUserContent('普通一句话');
  assert.equal(r.body, '普通一句话');
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.images, []);
});

test('parseUserContent：正文中间的裸路径不提取（只认尾部连续路径行）', () => {
  const content = '看下 C:\\a\\b.ts 然后继续\n普通说明文字';
  const r = parseUserContent(content);
  assert.equal(r.body, content);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.images, []);
});

test('parseUserContent：单行消息路径开头+中文正文不整行吞成 chip（回归）', () => {
  const content = 'C:\\works\\edu-community 帮我分析这个项目很多文字在中间 C:\\works\\edu-community';
  const r = parseUserContent(content);
  assert.equal(r.body, content, '整行保留为正文，不出 chip');
  assert.deepEqual(r.files, []);
});

test('parseUserContent：含空格的英文路径尾行仍提取（C:\\Program Files）', () => {
  const r = parseUserContent('装一下\nC:\\Program Files\\app\\run.exe');
  assert.deepEqual(r.files, ['C:\\Program Files\\app\\run.exe']);
  assert.equal(r.body, '装一下');
});

test('parseUserContent：无空白的中文路径尾行仍提取', () => {
  const r = parseUserContent('看下文档\nC:\\资料\\需求文档.docx');
  assert.deepEqual(r.files, ['C:\\资料\\需求文档.docx']);
  assert.equal(r.body, '看下文档');
});

test('parseUserContent：@前缀附件行提取为附件（@ 剥离，v3.27 协议）', () => {
  const r = parseUserContent('看下这两个文件\n@C:\\a\\b.ts\n@C:\\x\\截图.png');
  assert.equal(r.body, '看下这两个文件');
  assert.deepEqual(r.files, ['C:\\a\\b.ts']);
  assert.deepEqual(r.images, ['C:\\x\\截图.png']);
});

test('parseUserContent：@后非路径形状不提取（@mention 是正文）', () => {
  const content = '提醒 @张三 明天看下';
  const r = parseUserContent(content);
  assert.equal(r.body, content);
  assert.deepEqual(r.files, []);
});

test('parseUserContent：裸路径行兕底仍提取（旧会话兼容）', () => {
  const r = parseUserContent('看下\nC:\\a\\b.ts');
  assert.deepEqual(r.files, ['C:\\a\\b.ts']);
  assert.equal(r.body, '看下');
});
