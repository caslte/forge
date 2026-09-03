/**
 * slashCommandResources（WU-CV08-05）单元/集成测试。
 *
 * 验证草稿态轻量资源查询（docs/api/03_conversation.md §9 桥接约定）：
 * - skills 映射为 `skill:<name>`（source='skill'）"
 * - prompt 模板映射为模板名（source='prompt'）
 * - cwd=projectPath（缺省回落 process.cwd()）、agentDir 注入正确
 * - 任何失败（reload 抛错等）console.warn 后返回 []（不抛错，AC-CV-033）
 * - noExtensions/noThemes/noContextFiles 轻量化：草稿态响应不含 source=extension
 *
 * 用 node:test + Node 22 --experimental-strip-types；临时目录在 finally 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSlashCommandResources } from '../../src/pi/slashCommandResources.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sc-'));
}

/** fake loader 装配：可注入 skills/prompts/reload 行为，并记录 loader 构造参数 */
function harness(impl: {
  skills?: Array<{ name: string; description: string }>;
  prompts?: Array<{ name: string; description: string }>;
  reloadError?: Error;
}) {
  const calls: Array<{ cwd: string; agentDir: string }> = [];
  const loader = {
    async reload(): Promise<void> {
      if (impl.reloadError) throw impl.reloadError;
    },
    getSkills() {
      return { skills: impl.skills ?? [], diagnostics: [] };
    },
    getPrompts() {
      return { prompts: impl.prompts ?? [], diagnostics: [] };
    },
  };
  const resources = createSlashCommandResources({
    agentDir: 'C:/agent',
    loaderFactory: (cwd, agentDir) => {
      calls.push({ cwd, agentDir });
      return loader;
    },
  });
  return { calls, resources };
}

test('skills 映射为 skill: 前缀、prompts 映射为原名，source 正确（skill/prompt）', async () => {
  const { resources } = harness({
    skills: [{ name: 'git-push', description: '推送当前分支' }],
    prompts: [{ name: 'write-tests', description: '生成测试用例' }],
  });
  const res = await resources.listCommands('C:/proj');
  assert.deepEqual(res, [
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    { name: 'write-tests', description: '生成测试用例', source: 'prompt' },
  ]);
});

test('description 缺失归一为 null；cwd=projectPath、agentDir 注入正确', async () => {
  const { resources, calls } = harness({
    skills: [{ name: 'no-desc', description: '' }],
    prompts: [],
  });
  const res = await resources.listCommands('C:/proj');
  assert.deepEqual(res, [{ name: 'skill:no-desc', description: null, source: 'skill' }]);
  assert.deepEqual(calls, [{ cwd: 'C:/proj', agentDir: 'C:/agent' }]);
});

test('reload 抛错时 console.warn 并返回空数组（枚举失败降级，不抛错）', async () => {
  const { resources } = harness({ reloadError: new Error('resource enumeration failed') });
  const res = await resources.listCommands('C:/proj');
  assert.deepEqual(res, []);
});

test('fake loader 返回空资源时 listCommands 返回空数组（不抛错）', async () => {
  const { resources } = harness({});
  const res = await resources.listCommands('C:/proj');
  assert.deepEqual(res, []);
});

test('真实 loader + 空临时 agentDir：草稿态响应不含 source=extension（noExtensions 轻量化）', async () => {
  const root = makeTempDir();
  try {
    const resources = createSlashCommandResources({ agentDir: root });
    const res = await resources.listCommands(path.join(root, 'empty-proj'));
    assert.ok(
      res.every((c) => c.source !== 'extension'),
      `草稿态不应有 extension 来源: ${JSON.stringify(res)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实 loader：agentDir 下 skill/prompt 被发现并带 skill: 前缀，无 extension 来源', async () => {
  const root = makeTempDir();
  try {
    const agentDir = path.join(root, 'agent');
    const skillsDir = path.join(agentDir, 'skills', 'git-push');
    const promptsDir = path.join(agentDir, 'prompts');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      '---\nname: git-push\ndescription: 推送当前分支\n---\ncontent\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'write-tests.md'),
      '---\ndescription: 生成测试用例\n---\n写测试\n',
      'utf8',
    );
    const resources = createSlashCommandResources({ agentDir });
    const res = await resources.listCommands(path.join(root, 'project'));
    const bySource: Record<string, string[]> = {};
    for (const c of res) (bySource[c.source] ??= []).push(c.name);
    assert.ok(bySource.skill?.includes('skill:git-push'), `skill 资源应带 skill: 前缀: ${JSON.stringify(bySource)}`);
    assert.ok(bySource.prompt?.includes('write-tests'), `prompt 资源应按名发现: ${JSON.stringify(bySource)}`);
    assert.ok(!bySource.extension, `noExtensions 不应发现扩展: ${JSON.stringify(bySource)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});