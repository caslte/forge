import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPiAgentSessionFactory,
  type PiSessionHandle,
} from '../../src/pi/createPiAgentSessionFactory.ts';
import { PiConversationAdapter } from '../../src/pi/piConversationAdapter.ts';

test('按 forge 会话 ID 创建并恢复持久化 pi 会话', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-factory-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const first = await createPiAgentSessionFactory({ agentDir })({
      cwd: projectDir,
      sessionId: 'forge-session-1',
    });

    assert.equal(first.session.sessionId, 'forge-forge-session-1');
    const sessionFile = first.handle.sessionFile;
    assert.ok(sessionFile && fs.existsSync(sessionFile));

    const second = await createPiAgentSessionFactory({ agentDir })({
      cwd: projectDir,
      sessionId: 'forge-session-1',
    });

    assert.equal(second.session.sessionId, 'forge-forge-session-1');
    assert.equal(second.handle.sessionFile, sessionFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工厂可注入 PiConversationAdapter 并完成一次文本流映射', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-adapter-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const adapter = new PiConversationAdapter(createPiAgentSessionFactory({ agentDir }));
    let final = '';
    adapter.onMessage('session-id-2', (message) => {
      if (message.role === 'assistant') final = message.content;
    });

    try {
      await adapter.sendMessage('session-id-2', '只回复 OK', { cwd: projectDir });
    } catch (error) {
      assert.match(
        String(error),
        /No API key found for the selected model/,
        '无模型凭据时应由 pi 抛出可识别错误',
      );
      return;
    }

    assert.equal(final.toUpperCase().includes('OK'), true, `应包含 OK，实际：${final}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
