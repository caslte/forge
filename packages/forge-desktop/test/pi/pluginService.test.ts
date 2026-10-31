/**
 * pluginService 单测（docs/prd/07_installer_update.md 插件市场扩展）。
 *
 * 覆盖四类关键口径：
 * 1. spec 规范化：只认 npm 包名，统一补 npm: 前缀（裸名会被引擎当本地路径 → 误导性报错）
 * 2. list：settings.packages ∪ 内置清单，内置项实体缺失也要出现
 * 3. install/remove：幂等与内置保护；CLI 命令形态与预装完全一致
 * 4. 错误翻译：`Path does not exist` 必须被翻成人话
 *
 * 全部走注入端口（runCli / fetchJson），不碰真实 CLI 与网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPluginMethods,
  humanizeInstallError,
  normalizePackageSpec,
  splitPackageSpec,
} from '../../src/pi/pluginService.ts';

/** 建临时 agent 目录：settings.json + 若干已装实体 */
function makeAgentDir(settings: string, installed: Array<{ name: string; version: string }> = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-svc-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), settings, 'utf8');
  for (const { name, version } of installed) {
    const pkgDir = path.join(dir, 'npm', 'node_modules', ...name.split('/'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8');
  }
  return dir;
}

/** 捕获 CLI 调用的假端口 */
function makeRunCli(ok = true, output = 'added 1 package') {
  const calls: string[][] = [];
  const runCli = async (args: string[]): Promise<{ ok: boolean; output: string }> => {
    calls.push(args);
    return { ok, output };
  };
  return { calls, runCli };
}

const BUILTINS = ['pi-web-access', '@tintinweb/pi-subagents'];

test('normalizePackageSpec：只接受 npm 包名，统一剥前缀，拒绝路径', () => {
  assert.equal(normalizePackageSpec('pi-web-access'), 'pi-web-access');
  assert.equal(normalizePackageSpec('  pi-web-access  '), 'pi-web-access');
  assert.equal(normalizePackageSpec('@scope/name'), '@scope/name');
  assert.equal(normalizePackageSpec('pi-web-access@1.2.3'), 'pi-web-access@1.2.3');
  // 用户可能从 README 复制带前缀的形式：剥掉后仍要能过
  assert.equal(normalizePackageSpec('npm:pi-web-access'), 'pi-web-access');
  // 路径 / 上级目录 / 空串一律拒绝（堵死「本地目录伪装成包名」）
  assert.equal(normalizePackageSpec('C:\\tmp\\evil'), null);
  assert.equal(normalizePackageSpec('../evil'), null);
  assert.equal(normalizePackageSpec(''), null);
  assert.equal(normalizePackageSpec('/abs/path'), null);
});

test('splitPackageSpec：scope 包与版本号分离正确', () => {
  assert.deepEqual(splitPackageSpec('pi-web-access'), { name: 'pi-web-access', version: null });
  assert.deepEqual(splitPackageSpec('@scope/name'), { name: '@scope/name', version: null });
  assert.deepEqual(splitPackageSpec('pi-web-access@1.2.3'), { name: 'pi-web-access', version: '1.2.3' });
  assert.deepEqual(splitPackageSpec('@scope/name@2.0.0'), { name: '@scope/name', version: '2.0.0' });
});

test('plugin/list：packages ∪ 内置清单，内置项实体缺失也要出现', async () => {
  const dir = makeAgentDir('{"packages":["npm:pi-tool-display"]}', [
    { name: 'pi-tool-display', version: '0.3.1' },
    { name: '@tintinweb/pi-subagents', version: '0.9.2' },
  ]);
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS });
  const res = await methods['plugin/list']!({});
  assert.equal(res.code, 0);
  const plugins = (res.data as { plugins: Array<{ name: string; version: string | null; builtin: boolean }> }).plugins;
  const byName = new Map(plugins.map((p) => [p.name, p]));
  // 用户装的：非内置
  assert.deepEqual(byName.get('pi-tool-display'), { name: 'pi-tool-display', version: '0.3.1', builtin: false });
  // 内置且已装实体
  assert.deepEqual(byName.get('@tintinweb/pi-subagents'), {
    name: '@tintinweb/pi-subagents',
    version: '0.9.2',
    builtin: true,
  });
  // 内置但实体缺失：仍要列出（让用户看到「列了但没装上」），version 为 null
  assert.deepEqual(byName.get('pi-web-access'), { name: 'pi-web-access', version: null, builtin: true });
});

test('plugin/install：命令与预装同形（npm: 前缀 + --no-approve）', async () => {
  const dir = makeAgentDir('{"packages":[]}');
  const { calls, runCli } = makeRunCli(true, 'added 1 package in 6s');
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, runCli });

  const res = await methods['plugin/install']!({ name: 'pi-web-access' });
  assert.equal(res.code, 0);
  assert.deepEqual(calls, [['install', 'npm:pi-web-access', '--no-approve']]);
  assert.match((res.data as { output: string }).output, /added 1 package/);
});

test('plugin/install：已安装返回 4090，不调 CLI', async () => {
  const dir = makeAgentDir('{"packages":["npm:pi-web-access"]}', [{ name: 'pi-web-access', version: '1.0.0' }]);
  const { calls, runCli } = makeRunCli(true);
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, runCli });

  const res = await methods['plugin/install']!({ name: 'pi-web-access' });
  assert.equal(res.code, 4090);
  assert.equal(calls.length, 0);
});

test('plugin/install：非法包名 1001，不调 CLI', async () => {
  const dir = makeAgentDir('{"packages":[]}');
  const { calls, runCli } = makeRunCli(true);
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, runCli });

  const res = await methods['plugin/install']!({ name: '../evil' });
  assert.equal(res.code, 1001);
  assert.equal(calls.length, 0);
});

test('plugin/install：CLI 失败时把 Path does not exist 翻成人话', async () => {
  const dir = makeAgentDir('{"packages":[]}');
  const { runCli } = makeRunCli(false, 'Error: Path does not exist: D:\\tmp\\pi-web-access');
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, runCli });

  const res = await methods['plugin/install']!({ name: 'pi-web-access' });
  assert.equal(res.code, 6002);
  assert.match(res.message, /包名格式不对/);
});

test('plugin/remove：内置项拒绝卸载，不调 CLI', async () => {
  const dir = makeAgentDir('{"packages":["npm:pi-web-access"]}', [{ name: 'pi-web-access', version: '1.0.0' }]);
  const { calls, runCli } = makeRunCli(true);
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, runCli });

  const res = await methods['plugin/remove']!({ name: 'pi-web-access' });
  assert.equal(res.code, 1001);
  assert.match(res.message, /内置插件/);
  assert.equal(calls.length, 0);
});

test('plugin/remove：未安装 1002；正常卸载调 pi remove', async () => {
  const dir = makeAgentDir('{"packages":["npm:pi-tool-display"]}', [{ name: 'pi-tool-display', version: '0.3.1' }]);
  const { calls, runCli } = makeRunCli(true, 'removed 1 package');
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, runCli });

  const missing = await methods['plugin/remove']!({ name: 'pi-nothing' });
  assert.equal(missing.code, 1002);

  const ok = await methods['plugin/remove']!({ name: 'pi-tool-display' });
  assert.equal(ok.code, 0);
  assert.deepEqual(calls, [['remove', 'npm:pi-tool-display', '--no-approve']]);
});

test('plugin/search：默认按 pi-package 检索，字段映射正确', async () => {
  const dir = makeAgentDir('{"packages":[]}');
  let requested = '';
  const fetchJson = async (url: string): Promise<unknown> => {
    requested = url;
    return {
      total: 12206,
      objects: [
        {
          package: {
            name: '@narumitw/pi-goal',
            version: '0.54.12',
            description: 'Goal completion',
            keywords: ['pi-package', 'goal'],
            links: { homepage: 'https://x', repository: 'git+https://y' },
            date: '2026-10-17T10:47:19.000Z',
          },
        },
      ],
    };
  };
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, fetchJson });
  const res = await methods['plugin/search']!({});
  assert.equal(res.code, 0);
  assert.match(requested, /keywords%3Api-package/);
  const data = res.data as { total: number; items: Array<Record<string, unknown>>; error: string | null };
  assert.equal(data.total, 12206);
  assert.equal(data.error, null);
  assert.equal(data.items[0]!.name, '@narumitw/pi-goal');
  assert.equal(data.items[0]!.updatedAt, '2026-10-17T10:47:19.000Z');
});

test('plugin/search：网络失败不抛错，回 error 字段让 UI 降级', async () => {
  const dir = makeAgentDir('{"packages":[]}');
  const fetchJson = async (): Promise<unknown> => {
    throw new Error('fetch failed');
  };
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, fetchJson });
  const res = await methods['plugin/search']!({});
  assert.equal(res.code, 0);
  const data = res.data as { items: unknown[]; error: string | null };
  assert.deepEqual(data.items, []);
  assert.match(data.error!, /无法连接 npm registry/);
});

test('plugin/inspect：体积取自版本级 dist（包级是空的），scope 包名要编码', async () => {
  const dir = makeAgentDir('{"packages":[]}');
  let requested = '';
  const fetchJson = async (url: string): Promise<unknown> => {
    requested = url;
    return {
      'dist-tags': { latest: '0.54.12' },
      versions: {
        '0.54.12': {
          name: '@narumitw/pi-goal',
          version: '0.54.12',
          description: 'Goal completion',
          license: 'MIT',
          keywords: ['pi-package'],
          dist: { unpackedSize: 836087 },
        },
      },
      time: { '0.54.12': '2026-10-17T10:47:19.000Z' },
    };
  };
  const methods = createPluginMethods({ agentDir: dir, builtinPlugins: BUILTINS, fetchJson });
  const res = await methods['plugin/inspect']!({ name: '@narumitw/pi-goal' });
  assert.equal(res.code, 0);
  assert.match(requested, /@narumitw%2fpi-goal/);
  const data = res.data as { version: string; unpackedSize: number; license: string; installed: boolean };
  assert.equal(data.version, '0.54.12');
  assert.equal(data.unpackedSize, 836087);
  assert.equal(data.license, 'MIT');
  assert.equal(data.installed, false);
});

test('humanizeInstallError：常见失败翻成可读文案', () => {
  assert.match(humanizeInstallError('Path does not exist: /x'), /包名格式不对/);
  assert.match(humanizeInstallError('npm error 404 Not Found'), /找不到这个包/);
  assert.match(humanizeInstallError('ETIMEDOUT'), /网络/);
  assert.match(humanizeInstallError('EACCES: permission denied'), /写入权限/);
  assert.match(humanizeInstallError('something odd'), /详情见下方输出/);
});
