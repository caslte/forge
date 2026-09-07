/**
 * IPC 事件转发契约测试。
 *
 * main.ts 只把 FORGE_EVENTS 白名单内的事件转发给渲染进程（registerIpc 遍历注册）。
 * forge-core 新增 events.emit 通道若漏登白名单，事件在真实 Electron 主进程中静默丢失
 * （mock-bridge 不经 IPC，浏览器 dev/e2e 测不出——CV-S09 queueUpdated 徽标即此因）。
 * 本测试静态扫描 forge-core 源码的全部 events.emit('<channel>') 字面量，
 * 断言每个通道都已登记 FORGE_EVENTS，守住 ipc-contract 顶部注释声明的一致性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORGE_EVENTS } from '../src/ipc-contract.ts';

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 递归收集目录下全部 .ts 源文件（不含 .d.ts） */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('forge-core 发出的全部事件通道均已登记 FORGE_EVENTS 转发白名单', () => {
  const coreSrc = path.resolve(desktopRoot, '../forge-core/src');
  assert.equal(fs.existsSync(coreSrc), true, `forge-core 源码目录不存在: ${coreSrc}`);

  const emitted = new Set<string>();
  const re = /events\.emit\(\s*'([^']+)'/g;
  for (const file of collectTsFiles(coreSrc)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) emitted.add(m[1]!);
  }
  assert.ok(emitted.size > 0, '未扫描到任何 events.emit 通道，正则或目录可能失效');

  const registered = new Set<string>(FORGE_EVENTS);
  const missing = [...emitted].filter((ch) => !registered.has(ch));
  assert.deepEqual(
    missing,
    [],
    `forge-core 发出但未登记 FORGE_EVENTS 的通道（主进程不转发，渲染进程收不到）: ${missing.join(', ')}`,
  );
});
