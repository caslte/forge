/**
 * 会话输入草稿仓库（utils/composerDrafts）单测。
 *
 * 背景：草稿从「一块全局缓冲区、切会话即清空」改为按会话 key 隔离持久存仓。
 * 行为契约：
 * - draftKeyOf：有会话用会话 id；null/undefined（草稿态/落地 hero）归一到固定 key；
 * - saveDraft：空草稿（无文本且无附件）删条目；非空存快照（防外部数组引用漂移）；
 * - loadDraft：恒返回可回填值；返回副本，改动不污染仓库；
 * - dropDraft：按会话 id 清理（会话删除路径用）。
 *
 * 运行：node --test（Node type stripping 直跑 .ts，先例 slashCommand.test.ts）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEW_SESSION_DRAFT_KEY,
  draftKeyOf,
  dropDraft,
  loadDraft,
  saveDraft,
} from '../src/utils/composerDrafts.ts';

test('draftKeyOf：会话 id 直用；null/undefined 归一到草稿态 key', () => {
  assert.equal(draftKeyOf('sess-1'), 'sess-1');
  assert.equal(draftKeyOf(null), NEW_SESSION_DRAFT_KEY);
  assert.equal(draftKeyOf(undefined), NEW_SESSION_DRAFT_KEY);
});

test('loadDraft：未知 key 返回空草稿（text 空串 + attachments 空数组）', () => {
  assert.deepEqual(loadDraft('never-saved'), { text: '', attachments: [] });
});

test('saveDraft/loadDraft：往返一致，附件一并保留', () => {
  saveDraft('s-a', {
    text: 'A 会话未发送',
    attachments: [{ path: 'C:/tmp/x.png', name: 'x.png', flagged: false, dataUrl: 'data:,' }],
  });
  assert.deepEqual(loadDraft('s-a'), {
    text: 'A 会话未发送',
    attachments: [{ path: 'C:/tmp/x.png', name: 'x.png', flagged: false, dataUrl: 'data:,' }],
  });
});

test('saveDraft：空文本但有附件也要存（附件本身就是草稿）', () => {
  saveDraft('s-att', {
    text: '',
    attachments: [{ path: 'D:/doc.md', name: 'doc.md', flagged: false }],
  });
  assert.equal(loadDraft('s-att').attachments.length, 1);
});

test('saveDraft：空草稿即删（发送/清空后回不来）', () => {
  saveDraft('s-b', { text: '旧草稿', attachments: [] });
  saveDraft('s-b', { text: '', attachments: [] });
  assert.deepEqual(loadDraft('s-b'), { text: '', attachments: [] });
});

test('loadDraft 返回副本：改返回值不污染仓库；save 后改原数组也不影响仓库', () => {
  const atts: { path: string; name: string; flagged: boolean }[] = [
    { path: 'p1', name: 'p1', flagged: false },
  ];
  saveDraft('s-c', { text: 't', attachments: atts });
  atts.push({ path: 'p2', name: 'p2', flagged: false }); // 快照隔离：外部 push 不进仓
  const got = loadDraft('s-c');
  got.text = '改过了';
  got.attachments.push({ path: 'p3', name: 'p3', flagged: false });
  assert.deepEqual(loadDraft('s-c'), {
    text: 't',
    attachments: [{ path: 'p1', name: 'p1', flagged: false }],
  });
});

test('dropDraft：按会话 id 清理', () => {
  saveDraft(NEW_SESSION_DRAFT_KEY, { text: '全局草稿', attachments: [] });
  saveDraft('s-d', { text: '待删会话草稿', attachments: [] });
  dropDraft('s-d');
  assert.deepEqual(loadDraft('s-d'), { text: '', attachments: [] });
  assert.equal(loadDraft(NEW_SESSION_DRAFT_KEY).text, '全局草稿'); // 不误伤其他 key
});
