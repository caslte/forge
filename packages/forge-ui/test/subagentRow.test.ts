/**
 * Agent 行绑定的纯函数单测（v6.37 子 Agent「工具行化」改造）。
 *
 * 覆盖配对的三条路径：描述精确匹配、顺序兜底、孤儿记录，以及描述提取的入参兼容。
 * 这些是本改造唯一有分支推理的地方（其余是渲染），用 node:test 直接锁住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentCallDescription,
  reconcileAgentBindings,
  unboundSubagents,
  type AgentCallRef,
  type SubagentRef,
} from '../src/utils/subagentRow.ts';

function call(id: string, description: string | null): AgentCallRef {
  return { toolEventId: id, description };
}

function sub(agentId: string, description: string, startedAt: string): SubagentRef {
  return { agentId, description, startedAt };
}

test('描述精确匹配优先：乱序事件也能配上', () => {
  const calls = [call('t1', '研究定价'), call('t2', '修登录')];
  const subs = [sub('a2', '修登录', '2026-10-01T00:00:02Z'), sub('a1', '研究定价', '2026-10-01T00:00:01Z')];
  const map = reconcileAgentBindings(calls, subs);
  assert.equal(map.get('t1'), 'a1');
  assert.equal(map.get('t2'), 'a2');
});

test('描述对不上时按派发顺序兜底（调用序 ↔ startedAt asc）', () => {
  // 模型把描述改写/截断了：两路文字不同，仍应按先后配对上
  const calls = [call('t1', '研究国产LLM定价'), call('t2', '修复登录超时')];
  const subs = [
    sub('a1', '研究国产大模型定价', '2026-10-01T00:00:01Z'),
    sub('a2', '修复登录超时问题', '2026-10-01T00:00:02Z'),
  ];
  const map = reconcileAgentBindings(calls, subs);
  assert.equal(map.get('t1'), 'a1');
  assert.equal(map.get('t2'), 'a2');
});

test('部分匹配：先按描述吃掉能配的，剩余再顺序补位', () => {
  const calls = [call('t1', '甲'), call('t2', '描述已改写')];
  const subs = [
    sub('a1', '描述已改写-完整版', '2026-10-01T00:00:01Z'),
    sub('a2', '甲', '2026-10-01T00:00:02Z'),
  ];
  const map = reconcileAgentBindings(calls, subs);
  assert.equal(map.get('t1'), 'a2', '描述精确匹配不被顺序兜底抢走');
  assert.equal(map.get('t2'), 'a1');
});

test('同名多开：按 startedAt asc 依次分配，不重复绑定同一记录', () => {
  const calls = [call('t1', '同名任务'), call('t2', '同名任务')];
  const subs = [
    sub('a2', '同名任务', '2026-10-01T00:00:09Z'),
    sub('a1', '同名任务', '2026-10-01T00:00:03Z'),
  ];
  const map = reconcileAgentBindings(calls, subs);
  assert.equal(map.get('t1'), 'a1');
  assert.equal(map.get('t2'), 'a2');
});

test('调用多于记录：多余的调用不绑定（降级为普通工具行）', () => {
  const calls = [call('t1', '有记录的'), call('t2', '没记录的')];
  const subs = [sub('a1', '有记录的', '2026-10-01T00:00:01Z')];
  const map = reconcileAgentBindings(calls, subs);
  assert.equal(map.size, 1);
  assert.equal(map.get('t1'), 'a1');
  assert.equal(map.has('t2'), false);
});

test('记录多于调用：多出的记录即孤儿，不会被漏掉', () => {
  const calls = [call('t1', '甲')];
  const subs = [
    sub('a1', '甲', '2026-10-01T00:00:01Z'),
    sub('a2', '乙', '2026-10-01T00:00:02Z'),
  ];
  const map = reconcileAgentBindings(calls, subs);
  assert.equal(map.get('t1'), 'a1');
  const orphans = unboundSubagents(subs, map);
  assert.deepEqual(
    orphans.map((o) => o.agentId),
    ['a2'],
  );
});

test('无子 agent / 无调用：返回空而不抛（扩展缺失的静默降级路径）', () => {
  assert.equal(reconcileAgentBindings([], []).size, 0);
  assert.equal(reconcileAgentBindings([call('t1', '甲')], []).size, 0);
  assert.equal(reconcileAgentBindings([], [sub('a1', '甲', 'x')]).size, 0);
  assert.deepEqual(unboundSubagents([sub('a1', '甲', 'x')], new Map()), [
    sub('a1', '甲', 'x'),
  ]);
});

test('agentCallDescription：description 优先、回退 prompt 首行、其余回空串', () => {
  assert.equal(agentCallDescription({ description: '  研究定价  ' }), '研究定价');
  assert.equal(agentCallDescription({ prompt: '第一行任务\n第二行细节' }), '第一行任务');
  assert.equal(agentCallDescription({ description: '  ', prompt: '回退用 prompt' }), '回退用 prompt');
  assert.equal(agentCallDescription({}), '');
  assert.equal(agentCallDescription(null), '');
  assert.equal(agentCallDescription('not-an-object'), '');
  // 超长首行截断到 60 字符（含省略号）
  const long = 'x'.repeat(120);
  assert.equal(agentCallDescription({ prompt: long }).length, 60);
});
