/**
 * createForgeCore 集成测试。
 *
 * 验证 forge-desktop 内核组装正确：组装 forge-core 5 个 service+api + mock pi adapter +
 * model mock + 统一事件汇，经 methodTable 跑通 project/session/conversation/tool/model
 * 全流程，且未知方法返回 404。这是 main.ts IPC 路由的纯 TS 契约基线。
 *
 * 使用 node:test + Node 22 --experimental-strip-types；真实文件系统用 fs.mkdtempSync
 * 临时目录并在 finally 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createForgeCore, invoke } from '../src/createForgeCore.ts';

/** 等待 mock 异步回复（replyDelayMs 默认 300） */
function waitForReply(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

/** 创建临时目录与项目子目录 */
function makeTempProject(): { root: string; storeFile: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-core-int-'));
  const storeFile = path.join(root, 'forge-store.json');
  const projectDir = path.join(root, 'my-project');
  fs.mkdirSync(projectDir, { recursive: true });
  return { root, storeFile, projectDir };
}

test('createForgeCore 全流程：project → session → conversation → tool → model 可跑通', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const { methodTable, eventBus } = createForgeCore(storeFile);

    // 监听 conversation.statusChanged 事件
    const statusEvents: { sessionId: string; status: string }[] = [];
    eventBus.on('conversation.statusChanged', (p: unknown) => {
      const e = p as { sessionId: string; status: string };
      statusEvents.push(e);
    });

    // project/addProject
    const addRes = await invoke(methodTable, 'project/addProject', { path: projectDir });
    assert.equal(addRes.code, 0, `addProject 应成功，message: ${addRes.message}`);

    // project/queryProjectList
    const listRes = await invoke(methodTable, 'project/queryProjectList', {});
    assert.equal(listRes.code, 0);
    const projects = (listRes.data as { projects: unknown[] }).projects;
    assert.equal(projects.length, 1, '应有 1 个项目');

    // session/createSession
    const createSess = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    assert.equal(createSess.code, 0, `createSession 应成功，message: ${createSess.message}`);
    const sessionId = (createSess.data as { session: { sessionId: string } }).session.sessionId;
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0);

    // conversation/sendMessage
    const sendRes = await invoke(methodTable, 'conversation/sendMessage', {
      sessionId,
      content: '你好',
    });
    assert.equal(sendRes.code, 0, `sendMessage 应成功，message: ${sendRes.message}`);

    // 等待 mock 异步回复
    await waitForReply();

    // conversation/queryHistory 应有 user + assistant 两条
    const histRes = await invoke(methodTable, 'conversation/queryHistory', { sessionId });
    assert.equal(histRes.code, 0);
    const messages = (histRes.data as { messages: { role: string; content: string }[] }).messages;
    assert.equal(messages.length, 2, '应有 user + assistant 两条消息');
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[1]?.role, 'assistant');

    // conversation.statusChanged 事件应被触发（streaming + done）
    const statuses = statusEvents.map((e) => e.status);
    assert.ok(statuses.includes('streaming'), `应触发 streaming 事件，实际: ${statuses.join(',')}`);
    assert.ok(statuses.includes('done'), `应触发 done 事件，实际: ${statuses.join(',')}`);

    // tool/queryToolEvents（空列表）
    const toolRes = await invoke(methodTable, 'tool/queryToolEvents', { sessionId });
    assert.equal(toolRes.code, 0);
    const events = (toolRes.data as { events: unknown[] }).events;
    assert.equal(events.length, 0, 'mock 下工具事件应为空');

    // model/queryProviderList（mock 空列表）
    const modelRes = await invoke(methodTable, 'model/queryProviderList', {});
    assert.equal(modelRes.code, 0);
    const providers = (modelRes.data as { providers: unknown[] }).providers;
    assert.equal(providers.length, 0, 'mock 下 provider 应为空');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invoke 未知方法返回 404 信封', async () => {
  const { root, storeFile } = makeTempProject();
  try {
    const { methodTable } = createForgeCore(storeFile);
    const res = await invoke(methodTable, 'unknown/method', {});
    assert.equal(res.code, 404);
    assert.equal(res.data, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createForgeCore 跨实例隔离：两个 store 文件互不干扰', async () => {
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-iso1-'));
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-iso2-'));
  try {
    const store1 = path.join(root1, 's.json');
    const store2 = path.join(root2, 's.json');
    const proj1 = path.join(root1, 'p1');
    const proj2 = path.join(root2, 'p2');
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    const a = createForgeCore(store1);
    const b = createForgeCore(store2);
    await invoke(a.methodTable, 'project/addProject', { path: proj1 });
    await invoke(b.methodTable, 'project/addProject', { path: proj2 });

    const la = await invoke(a.methodTable, 'project/queryProjectList', {});
    const lb = await invoke(b.methodTable, 'project/queryProjectList', {});
    const na = (la.data as { projects: unknown[] }).projects.length;
    const nb = (lb.data as { projects: unknown[] }).projects.length;
    assert.equal(na, 1, '实例 a 应只有自己的 1 个项目');
    assert.equal(nb, 1, '实例 b 应只有自己的 1 个项目');
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
