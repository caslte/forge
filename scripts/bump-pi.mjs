#!/usr/bin/env node
/**
 * pi 引擎依赖升级脚本：把 forge-desktop 的 @earendil-works/pi-ai 与
 * @earendil-works/pi-coding-agent 升到 npm registry 最新版（两者必须同版本）。
 *
 * 流程：查询最新版 → 写回 package.json → npm install（刷新根 lock）→ typecheck → test。
 * 任一环节失败即中止；改动作为普通 commit 由开发者提交，release.mjs 不参与
 * （其「除 version 外不得有在途改动」的保护正是为此保留）。
 *
 * 用法：
 *   node scripts/bump-pi.mjs              # 升到 registry 最新
 *   node scripts/bump-pi.mjs 0.85.0       # 升到指定版本（跳过查询）
 *   node scripts/bump-pi.mjs --dry-run    # 只查询并打印，不落盘不安装
 *   node scripts/bump-pi.mjs --no-check   # 升完跳过 typecheck/test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_REL = 'packages/forge-desktop/package.json';
const PKG_PATH = path.join(root, PKG_REL);
/** 两个包必须同版本（运行时 pi-coding-agent 引 pi-ai，混版本会产生双份装载/不兼容） */
const PI_PACKAGES = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const noCheck = argv.includes('--no-check');
const explicitVersion = argv.find((a) => !a.startsWith('--'));

function log(msg) {
  console.log(`[bump-pi] ${msg}`);
}
function die(msg) {
  console.error(`[bump-pi] ✗ ${msg}`);
  process.exit(1);
}

/** 跑子命令，失败即退出（透传输出） */
function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    ...(capture ? {} : { stdio: 'inherit' }),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    die(`${cmd} ${args.join(' ')} 失败（exit ${res.status}）\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return capture ? (res.stdout || '').trim() : undefined;
}

function latestVersion(pkg) {
  const out = spawnSync('npm', ['view', pkg, 'version'], {
    cwd: root,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 60000,
  });
  if (out.status !== 0) {
    die(`npm view ${pkg} version 失败：${(out.stderr || out.stdout || '').trim()}`);
  }
  const v = (out.stdout || '').trim().split('\n').pop();
  if (!/^\d+\.\d+\.\d+/.test(v)) die(`npm view ${pkg} 返回异常版本号："${v}"`);
  return v;
}

// ---------- 读当前版本 ----------
const pkgRaw = readFileSync(PKG_PATH, 'utf8');
const pkg = JSON.parse(pkgRaw);
const current = PI_PACKAGES.map((name) => {
  const pinned = pkg.dependencies?.[name];
  if (!pinned) die(`${PKG_REL} 的 dependencies 中缺少 ${name}`);
  return { name, pinned };
});
log(`当前锁定：${current.map((c) => `${c.name}@${c.pinned}`).join('、')}`);

// ---------- 目标版本 ----------
let target;
if (explicitVersion) {
  if (!/^\d+\.\d+\.\d+[.\-\w]*$/.test(explicitVersion)) {
    die(`指定版本 "${explicitVersion}" 格式不合法（应为 x.y.z）`);
  }
  target = explicitVersion;
  log(`使用指定版本：${target}`);
} else {
  const latest = PI_PACKAGES.map((name) => ({ name, v: latestVersion(name) }));
  target = latest[0].v;
  const diverged = latest.filter((l) => l.v !== target);
  if (diverged.length > 0) {
    die(
      `两个 pi 包最新版不一致（${latest.map((l) => `${l.name}@${l.v}`).join('、')}）。\n` +
        `  两者必须同版本——确认引擎侧发版情况后，用 "node scripts/bump-pi.mjs <x.y.z>" 显式指定。`,
    );
  }
  log(`registry 最新版：${target}`);
}

const alreadyAtTarget = current.every((c) => c.pinned === target);
if (alreadyAtTarget) {
  log('已是目标版本，无需升级。');
  process.exit(0);
}

// ---------- 落盘 ----------
if (dryRun) {
  console.log('[bump-pi] 预演（未执行）：');
  for (const c of current) console.log(`  ${c.name}: ${c.pinned} → ${target}`);
  console.log('  npm install → typecheck → test');
  process.exit(0);
}

for (const c of current) {
  pkg.dependencies[c.name] = target;
  log(`${c.name}: ${c.pinned} → ${target}`);
}
// 与 release.mjs 同款写回：2 空格缩进 + 末尾换行
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
log(`1/3 已写 ${PKG_REL}`);

run('npm', ['install']);
log('2/3 npm install 完成（lock 已刷新）');

if (noCheck) {
  log('3/3 跳过 typecheck/test（--no-check）');
} else {
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'test']);
  log('3/3 typecheck + test 通过');
}

console.log(`\n[bump-pi] 完成：pi → ${target}。请自测真机后作为普通 commit 提交，再跑 release。`);
