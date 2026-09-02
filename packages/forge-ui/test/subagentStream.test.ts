/**
 * 子 agent 实时过程解析纯函数单测（wu-06 v1.1 UI 改版）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts）。
 * 覆盖：assistant 文本/工具混排块顺序、toolResult 配对状态流转、
 * toolCall 行被尾部切断时从 result 合成、user/thinking 跳过、
 * 非法行（尾部切断残片/非 JSON）静默跳过、空 chunk。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSubagentStream, stripDanglingFence } from '../src/utils/subagentStream.ts';

const UID = 'a1';
const wrap = (entry: object): string => JSON.stringify({ isSidechain: true, agentId: UID, ...entry });

test('assistant 文本 + 工具混排：按块顺序输出，thinking 跳过', () => {
  const chunk = [
    wrap({ type: 'user', message: { role: 'user', content: '研究子任务' } }),
    wrap({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考' },
          { type: 'text', text: '先看目录' },
          { type: 'toolCall', id: 'call_1', name: 'ls', arguments: { path: 'packages' } },
        ],
      },
    }),
  ].join('\n');
  const items = parseSubagentStream(chunk);
  assert.deepEqual(items, [
    { kind: 'text', text: '先看目录' },
    { kind: 'tool', toolCallId: 'call_1', name: 'ls', args: '{"path":"packages"}', status: 'running' },
  ]);
});

test('toolResult 按 toolCallId 配对：isError 决定 ok/error', () => {
  const chunk = [
    wrap({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'grep', arguments: { pattern: 'x' } },
          { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'a.ts' } },
        ],
      },
    }),
    wrap({ type: 'toolResult', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'grep', content: [], isError: false } }),
    wrap({ type: 'toolResult', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [], isError: true } }),
  ].join('\n');
  const items = parseSubagentStream(chunk);
  assert.equal(items.length, 2);
  assert.equal((items[0] as { status: string }).status, 'ok');
  assert.equal((items[1] as { status: string }).status, 'error');
});

test('尾部切断 toolCall 行：从 toolResult 合成摘要行', () => {
  const chunk = wrap({
    type: 'toolResult',
    message: { role: 'toolResult', toolCallId: 'c9', toolName: 'bash', content: [], isError: false },
  });
  const items = parseSubagentStream(chunk);
  assert.deepEqual(items, [
    { kind: 'tool', toolCallId: 'c9', name: 'bash', args: '', status: 'ok' },
  ]);
});

test('同一 assistant 消息多个文本块以空行连接', () => {
  const chunk = wrap({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    },
  });
  assert.deepEqual(parseSubagentStream(chunk), [{ kind: 'text', text: '第一段\n\n第二段' }]);
});

test('非法行静默跳过（尾部切断残片 / 非 JSON / 空行）', () => {
  const chunk = [
    '286.067)\\npackages/forge-ui/src/design-tokens.css:55: --shadow-sm',
    '{"isSidechain":true,"agentId":"a1","type":"assistant","message":{"role":"assistant"',
    '',
    wrap({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '正文' }] } }),
  ].join('\n');
  assert.deepEqual(parseSubagentStream(chunk), [{ kind: 'text', text: '正文' }]);
});

test('空 chunk / 空白 → 空数组；超长参数截断', () => {
  assert.deepEqual(parseSubagentStream(''), []);
  assert.deepEqual(parseSubagentStream('\n\n'), []);
  const longArgs = { content: 'x'.repeat(200) };
  const items = parseSubagentStream(wrap({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'write', arguments: longArgs }] },
  }));
  const args = (items[0] as { args: string }).args;
  assert.ok(args.length <= 80 && args.endsWith('…'), `args 应截断: ${args.length}`);
});

test('stripDanglingFence：未闭合围栏收尾丢弃围栏行，后续内容转普通文本；配平围栏保留', () => {
  // 模型实际输出：外层 ```markdown + 内层 ```ts + 闭合 + 多余裸 ```（空框场景）
  const messy = '总结如下：\n\n```markdown\n**验证**\n```ts\nconst a = 1;\n```\n```\n';
  assert.equal(
    stripDanglingFence(messy),
    '总结如下：\n\n```markdown\n**验证**\n```ts\nconst a = 1;\n```',
  );
  // 实测场景：收尾语落在未闭合围栏内 → 丢弃围栏行，收尾语转普通文本
  const trailing = '```markdown\n示例\n```ts\nconst a = 1;\n```\n```\n\n→ 全部完成。';
  assert.equal(
    stripDanglingFence(trailing),
    '```markdown\n示例\n```ts\nconst a = 1;\n```\n\n→ 全部完成。',
  );
  // 配平围栏不动
  const ok = '```js\ncode\n```\n';
  assert.equal(stripDanglingFence(ok), ok);
  // 未闭合且有内容（半截流式输出）：同样降级为普通文本
  assert.equal(stripDanglingFence('```js\ncode'), 'code');
});

test('groupStreamNodes：连续 ≥2 工具聚组（默认收起语义，单工具/文本透传）', async () => {
  const { groupStreamNodes } = await import('../src/utils/subagentStream.ts');
  const tool = (name: string, id = name) => ({ kind: 'tool', toolCallId: id, name, args: '', status: 'ok' }) as const;
  const items = [
    { kind: 'text', text: '正文' },
    tool('ls'),
    tool('grep'),
    tool('grep'),
    { kind: 'text', text: '说明' },
    tool('read'),
  ] as Parameters<typeof groupStreamNodes>[0];
  const nodes = groupStreamNodes(items);
  assert.equal(nodes.length, 4);
  assert.deepEqual(nodes[0], { kind: 'text', text: '正文' });
  const group = nodes[1]!;
  assert.equal(group.kind, 'tool-group');
  if (group.kind === 'tool-group') {
    assert.equal(group.total, 3);
    assert.equal(group.start, 1);
    assert.deepEqual(group.counts, [{ name: 'ls', count: 1 }, { name: 'grep', count: 2 }]);
    assert.equal(group.items.length, 3);
  }
  assert.deepEqual(nodes[2], { kind: 'text', text: '说明' });
  assert.equal(nodes[3]!.kind, 'tool');
});
