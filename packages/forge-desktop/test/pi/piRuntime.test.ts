/**
 * piRuntime 单测（docs/api/07_pi.md）：
 * - readPiExtensionList：settings.json（含 JSONC 注释）解析 + npm 实体版本回读 + 缺失静默降级
 * - createForgeCore pi/getInfo：forgeVersion 注入 + 插件清单透传（deps.piAgentDir 隔离真实目录）
 * - buildPiCliEnv：内置 CLI 子进程 env 必须把 agent 根钉死到 forge 自有目录（防裂脑）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPiCliEnv, readPiExtensionList } from '../../src/pi/piRuntime.ts';
import { createForgeCore, invoke } from '../../src/createForgeCore.ts';

/** 建临时 agent 目录并写入 settings.json + 可选 npm 实体 */
function makeAgentDir(settings: string, installed: Array<{ name: string; version: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-runtime-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), settings, 'utf8');
  for (const { name, version } of installed) {
    const pkgDir = path.join(dir, 'npm', 'node_modules', ...name.split('/'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8');
  }
  return dir;
}

test('readPiExtensionList：npm: 前缀剥离 + 实体版本回读 + 未安装为 null', () => {
  const dir = makeAgentDir(
    [
      '{',
      '  // pi settings（JSONC 注释应被忽略）',
      '  "defaultModel": "ark-code-latest",',
      '  "packages": ["npm:@tintinweb/pi-subagents", "npm:pi-mcp-adapter", "npm:@gone/missing"]',
      '}',
    ].join('\n'),
    [
      { name: '@tintinweb/pi-subagents', version: '0.19.0' },
      { name: 'pi-mcp-adapter', version: '2.32.1' },
    ],
  );
  const plugins = readPiExtensionList(dir);
  assert.deepEqual(plugins, [
    { name: '@tintinweb/pi-subagents', version: '0.19.0' },
    { name: 'pi-mcp-adapter', version: '2.32.1' },
    { name: '@gone/missing', version: null },
  ]);
});

test('readPiExtensionList：settings.json 缺失/损坏返回空数组（静默降级）', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-runtime-'));
  assert.deepEqual(readPiExtensionList(missing), []);
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-runtime-'));
  fs.writeFileSync(path.join(broken, 'settings.json'), '{ packages: [broken', 'utf8');
  assert.deepEqual(readPiExtensionList(broken), []);
});

test('createForgeCore pi/getInfo：仅返回 forgeVersion（组件明细不回传 UI，走日志与 updater-state）', async () => {
  const agentDir = makeAgentDir('{"packages":["npm:pi-web-access"]}', [
    { name: 'pi-web-access', version: '0.27.0' },
  ]);
  const { methodTable } = createForgeCore(path.join(agentDir, 'forge-store.json'), {
    piAgentDir: agentDir,
    forgeVersion: '1.2.3',
  });
  const res = await invoke(methodTable, 'pi/getInfo');
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, { forgeVersion: '1.2.3' });
});

test('createForgeCore pi/updatePlugins：更新失败返回 6002 + 输出尾部（注入 mock 更新器，不碰真实 CLI）', async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-runtime-'));
  const { methodTable } = createForgeCore(path.join(agentDir, 'forge-store.json'), {
    piAgentDir: agentDir,
    piUpdateExtensions: async () => ({
      ok: false,
      output: 'npm error code E404\nnpm error 404 Not Found',
    }),
  });
  const res = await invoke(methodTable, 'pi/updatePlugins');
  assert.equal(res.code, 6002);
  assert.equal(res.message, '组件更新失败');
  assert.match((res.data as { output: string }).output, /E404/);
});

test('createForgeCore pi/updatePlugins：更新成功透传输出尾部', async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-runtime-'));
  const { methodTable } = createForgeCore(path.join(agentDir, 'forge-store.json'), {
    piAgentDir: agentDir,
    piUpdateExtensions: async () => ({ ok: true, output: 'updated 3 packages' }),
  });
  const res = await invoke(methodTable, 'pi/updatePlugins');
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, { output: 'updated 3 packages' });
});

test('buildPiCliEnv：PI_CODING_AGENT_DIR 钉到入参 agent 根，覆盖继承的同名 env', () => {
  process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), 'stray-agent');
  try {
    const env = buildPiCliEnv('C:\\fake\\userData\\agent');
    assert.equal(env.PI_CODING_AGENT_DIR, 'C:\\fake\\userData\\agent');
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});
