/**
 * utils/queueText.ts 单元测试（node --experimental-strip-types --test）。
 *
 * 覆盖重点在「不该切等宽的别切」——误切比漏切更伤，普通中文句子被渲染成
 * 等宽才是真的丑。路径 / 代码的漏切只是少个视觉优化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksMonospace, isQueueItemClamped, QUEUE_TEXT_CLAMP_LINES } from '../src/utils/queueText.ts';

test('looksMonospace：Windows 盘符路径 → 等宽', () => {
  assert.equal(looksMonospace('C:\\Users\\chenmo\\AppData\\Local\\Temp\\forge-paste-194849.png'), true);
  assert.equal(looksMonospace('D:/work/aiwork/forge/packages/forge-ui'), true);
  // 前导空白（粘贴常带）不影响判定
  assert.equal(looksMonospace('   @C:\\Users\\a\\b.txt'), true);
});

test('looksMonospace：POSIX 路径（≥3 段）→ 等宽', () => {
  assert.equal(looksMonospace('/usr/local/lib/node_modules/vite/bin'), true);
  assert.equal(looksMonospace('./packages/forge-ui/src/main.ts'), true);
  assert.equal(looksMonospace('../forge-core/src/index.ts'), true);
});

test('looksMonospace：源码扩展名 → 等宽', () => {
  assert.equal(looksMonospace('packages/forge-ui/index.html'), true);
  assert.equal(looksMonospace('error.log'), true);
  assert.equal(looksMonospace('config.yaml'), true);
});

test('looksMonospace：代码结构 → 等宽', () => {
  assert.equal(looksMonospace('async function withRetry(fn, times = 3) {'), true);
  assert.equal(looksMonospace('const x = items.map((i) => i.id);'), true);
  assert.equal(looksMonospace('{"sessionId":"x"}'), true);
});

test('looksMonospace：含 CJK 一律不等宽（混排中文在等宽下更难扫）', () => {
  assert.equal(looksMonospace('看下 main.go 里 401 分支的处理'), false);
  assert.equal(looksMonospace('报错在 C:\\Users\\chenmo\\a.ts 第 42 行'), false);
  assert.equal(looksMonospace('查看 /usr/local/lib 下的配置'), false);
});

test('looksMonospace：普通句子与短消息 → 不等宽', () => {
  assert.equal(looksMonospace(''), false);
  assert.equal(looksMonospace('   '), false);
  assert.equal(looksMonospace('ok'), false);
  assert.equal(looksMonospace('排队一'), false);
  // 单段斜杠不成路径：单双斜杠（URL 片段、单层目录）不切，避免误伤
  assert.equal(looksMonospace('and/or maybe'), false);
  assert.equal(looksMonospace('src/main.ts 改好了吗'), false);
});

test('QUEUE_TEXT_CLAMP_LINES：收趟态一行（2026-09-29 用户定调「不要换行」）', () => {
  assert.equal(QUEUE_TEXT_CLAMP_LINES, 1);
});

/** 伪造元素：只需 scrollWidth/clientWidth/scrollHeight/clientHeight 四个量 */
function fakeEl(over: Partial<{ sw: number; cw: number; sh: number; ch: number }>): HTMLElement {
  const { sw, cw, sh, ch } = { sw: 100, cw: 100, sh: 20, ch: 20, ...over };
  return { scrollWidth: sw, clientWidth: cw, scrollHeight: sh, clientHeight: ch } as HTMLElement;
}

test('isQueueItemClamped：收趟态横向溢出（nowrap + 省略号）算截断', () => {
  assert.equal(isQueueItemClamped(fakeEl({ sw: 420, cw: 300 })), true);
  // 纵向也看：展开态是 pre-wrap，两个方向任一溢出都要给「展开」
  assert.equal(isQueueItemClamped(fakeEl({ sh: 90, ch: 20 })), true);
  // 恰好一行放得下 → 不给「展开」，短消息不许多出一行底栏
  assert.equal(isQueueItemClamped(fakeEl({ sw: 100, cw: 100 })), false);
});

test('isQueueItemClamped：已展开的条目恒为 true（否则「收起」按钮会自己消失）', () => {
  assert.equal(isQueueItemClamped(fakeEl({ sw: 100, cw: 100 }), true), true);
});
