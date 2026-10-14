/**
 * scripts/dev.js 端口预检逻辑的测试。
 *
 * 为什么值得单测：2026-10-13 真机故障里，端口预检的**漏判**比误判更危险——
 * 残留 vite 只 LISTEN 在 [::1]（IPv6），只探 127.0.0.1 的探测会报「空闲」，
 * 于是 electron 连到旧服务且看起来一切正常。这里用真实 socket 锁双栈探测，
 * 并用实测 netstat 行锁 PID 解析格式。
 *
 * 运行：node --test scripts/dev.test.mjs（scripts/ 不是 workspace，
 * 根 package.json 的 test 脚本里单独挂了这个 glob）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { probePort, parseListenPid } from './dev.js';

/** 起一个只监听指定地址的服务，返回 { port, close }。 */
function listen(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('空闲端口探测为未占用', async () => {
  const { port, close } = await listen('127.0.0.1');
  await close();
  // 关掉再探：极少数情况内核还没回收，重试几次兜底
  for (let i = 0; i < 10 && (await probePort(port)); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await probePort(port), false);
});

test('IPv4 占用能探到', async () => {
  const srv = await listen('127.0.0.1');
  try {
    assert.equal(await probePort(srv.port), true);
  } finally {
    await srv.close();
  }
});

test('IPv6-only 占用也能探到（残留 vite 的真实形态，漏判会连到旧服务）', async () => {
  // 2026-10-13 实测：残留 vite 只 LISTEN 在 [::1]:51731。
  let srv;
  try {
    srv = await listen('::1');
  } catch {
    // 环境不支持 IPv6（极少见）：跳过而非误绿
    return;
  }
  try {
    assert.equal(await probePort(srv.port), true);
  } finally {
    await srv.close();
  }
});

test('parseListenPid：解析实测 netstat 行（IPv6 地址形态）', () => {
  const text = [
    '  TCP    [::1]:9781             [::1]:51731            TIME_WAIT       0',
    '  TCP    [::1]:51731            [::]:0                 LISTENING       8908',
    '  TCP    127.0.0.1:51731        0.0.0.0:0              LISTENING       1234',
  ].join('\r\n');
  assert.equal(parseListenPid(text, 51731), 8908);
});

test('parseListenPid：只认 LISTENING 行，同端口的 TIME_WAIT/连接行不算占用', () => {
  const text = '  TCP    127.0.0.1:6000        1.2.3.4:80            ESTABLISHED     999';
  assert.equal(parseListenPid(text, 6000), undefined);
});

test('parseListenPid：端口不匹配或无 netstat 输出时返回 undefined（不抛）', () => {
  assert.equal(parseListenPid('', 51731), undefined);
  assert.equal(parseListenPid('  TCP    [::1]:9999            [::]:0                 LISTENING       1', 51731), undefined);
});
