/**
 * SafeStorageKeychainAdapter（P3-D）单元测试。
 *
 * 用可编程 fake SafeStorageLike 验证：
 * - storeKey：加密写 vault 文件 + 明文仅进 process.env + 返回 $ENV_VAR 引用
 * - restoreEnv：重启后从 vault 解密回填 env（模拟重启新建适配器）
 * - isAvailable：safeStorage 不可用 / null 时返回 false
 * - vault 损坏：readVault 容错返回空，不抛错
 * - 多 provider 互不覆盖
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeStorageKeychainAdapter, type SafeStorageLike } from '../../src/pi/keychainAdapter.ts';

/** fake safeStorage：XOR 加密（足够验证存储/恢复链路） */
class FakeSafeStorage implements SafeStorageLike {
  available = true;

  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plain: string): Buffer {
    return Buffer.from(plain.split('').map((c) => c.charCodeAt(0) ^ 0x5a).join(','), 'utf8');
  }
  decryptString(encrypted: Buffer): string {
    return encrypted
      .toString('utf8')
      .split(',')
      .map((n) => String.fromCharCode(Number(n) ^ 0x5a))
      .join('');
  }
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-key-'));
}

test('P3-D：storeKey 加密写 vault + 明文仅进 env + 返回 $ENV_VAR 引用', async () => {
  const dir = makeDir();
  try {
    const vault = path.join(dir, 'forge-keyvault.json');
    const adapter = new SafeStorageKeychainAdapter(vault, () => new FakeSafeStorage());
    assert.equal(await adapter.isAvailable(), true);
    const ref = await adapter.storeKey('openai', 'sk-secret-123');
    assert.equal(ref, '$FORGE_OPENAI_API_KEY');
    // vault 落盘的是加密内容（不含明文）
    const raw = fs.readFileSync(vault, 'utf8');
    assert.ok(!raw.includes('sk-secret-123'), 'vault 不得含明文');
    assert.ok(raw.includes('openai'), 'vault 含 providerId 键');
    // env 存明文（pi 按引用读取）
    assert.equal(process.env.FORGE_OPENAI_API_KEY, 'sk-secret-123');
  } finally {
    delete process.env.FORGE_OPENAI_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P3-D：restoreEnv 重启后从 vault 解密回填 env', async () => {
  const dir = makeDir();
  try {
    const vault = path.join(dir, 'forge-keyvault.json');
    const first = new SafeStorageKeychainAdapter(vault, () => new FakeSafeStorage());
    await first.storeKey('openai', 'sk-secret-456');
    delete process.env.FORGE_OPENAI_API_KEY; // 模拟重启：env 清空
    const restarted = new SafeStorageKeychainAdapter(vault, () => new FakeSafeStorage());
    restarted.restoreEnv();
    assert.equal(process.env.FORGE_OPENAI_API_KEY, 'sk-secret-456', '重启后应解密回填');
  } finally {
    delete process.env.FORGE_OPENAI_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P3-D：safeStorage 不可用 / null 时 isAvailable 为 false，storeKey 抛错', async () => {
  const dir = makeDir();
  try {
    const vault = path.join(dir, 'forge-keyvault.json');
    const unavail = new FakeSafeStorage();
    unavail.available = false;
    const adapter = new SafeStorageKeychainAdapter(vault, () => unavail);
    assert.equal(await adapter.isAvailable(), false);
    await assert.rejects(adapter.storeKey('x', 'key'), /密钥链不可用/);
    const nullAdapter = new SafeStorageKeychainAdapter(vault, () => null);
    assert.equal(await nullAdapter.isAvailable(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P3-D：vault 损坏时 readVault 容错返回空，不抛错', async () => {
  const dir = makeDir();
  try {
    const vault = path.join(dir, 'forge-keyvault.json');
    fs.writeFileSync(vault, '{corrupt!!!', 'utf8');
    const adapter = new SafeStorageKeychainAdapter(vault, () => new FakeSafeStorage());
    // 读损坏 vault 不抛错，storeKey 仍可继续工作
    const ref = await adapter.storeKey('openai', 'key-ok');
    assert.equal(ref, '$FORGE_OPENAI_API_KEY');
    assert.ok(fs.readFileSync(vault, 'utf8').includes('openai'));
  } finally {
    delete process.env.FORGE_OPENAI_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P3-D：多 provider 互不覆盖，env 各自独立', async () => {
  const dir = makeDir();
  try {
    const vault = path.join(dir, 'forge-keyvault.json');
    const adapter = new SafeStorageKeychainAdapter(vault, () => new FakeSafeStorage());
    await adapter.storeKey('anthropic', 'sk-ant-789');
    await adapter.storeKey('deepseek', 'sk-deep-1');
    assert.equal(process.env.FORGE_ANTHROPIC_API_KEY, 'sk-ant-789');
    assert.equal(process.env.FORGE_DEEPSEEK_API_KEY, 'sk-deep-1');
  } finally {
    delete process.env.FORGE_ANTHROPIC_API_KEY;
    delete process.env.FORGE_DEEPSEEK_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});