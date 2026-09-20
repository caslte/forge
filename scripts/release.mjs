#!/usr/bin/env node
/**
 * forge 发布脚本：bump packages/forge-desktop/package.json 版本号 → commit → tag → push。
 *
 * 版本推进规则（2026-09-20 与维护者对齐）：
 *   - 智能检测：当前版本号已有对应 tag（本地或 origin）→ 视为已发布，自动递增；
 *     没有对应 tag（提前改好版本号攒着的场景）→ 直接使用当前版本号发布。
 *   - 进位规则：某一位到 20 后，下次递增该位归 0、上一位 +1。
 *       0.1.10 → 0.1.11 → ... → 0.1.20 → 0.2.0
 *       0.20.5 → 0.20.6 → ... → 0.20.20 → 1.0.0
 *     主版本号（第一位）不设上限。
 *   - tag 格式：v 前缀（v0.1.11），与历史 tag 惯例一致。
 *   - commit 信息沿用历史惯例：build: bump forge-desktop version to x.y.z
 *
 * 用法：
 *   node scripts/release.mjs             # 正常发布（智能检测版本号）
 *   node scripts/release.mjs 0.2.0-rc.1  # 指定确切版本号（跳过递增，tag 已存在则报错）
 *   node scripts/release.mjs --dry-run   # 预演：只打印将执行的步骤，不落盘不上传
 *
 * 安全检查：
 *   - package.json 除 version 外存在其他在途改动 → 拒绝执行（防止误提交）。
 *   - commit 只包含 packages/forge-desktop/package.json，不碰工作区其他改动。
 *   - 发布前校验版本号格式为 x.y.z（主版本不限位）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_REL = 'packages/forge-desktop/package.json';
const PKG_PATH = path.join(root, PKG_REL);
const TAG_PREFIX = 'v';
const SEGMENT_MAX = 20; // 每一段版本号的上限：到 20 后进位

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const explicitVersion = argv.find((a) => !a.startsWith('--'));

function log(step, msg) {
  console.log(`[release] ${step} ${msg}`);
}
function die(msg) {
  console.error(`[release] ✗ ${msg}`);
  process.exit(1);
}

// ---------- git 工具 ----------
function git(args, { capture = false, timeout } = {}) {
  const res = spawnSync('git', args, capture ? { encoding: 'utf8', timeout } : { stdio: 'inherit', timeout });
  if (res.status !== 0) {
    const err = (res.stderr || '').trim();
    die(`git ${args.join(' ')} 失败（exit ${res.status}）${err ? `\n${err}` : ''}`);
  }
  return capture ? (res.stdout || '').trim() : undefined;
}
/** 容错版 git：失败返回 null（用于探测类查询） */
function gitTry(args, { capture = true, timeout = 15000 } = {}) {
  const res = spawnSync('git', args, capture ? { encoding: 'utf8', timeout } : { stdio: 'inherit', timeout });
  if (res.status !== 0) return null;
  return capture ? (res.stdout || '').trim() : true;
}

// ---------- 版本工具 ----------
/** 校验 x.y.z（主版本不限位），合法返回 [maj, min, pat] */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) die(`版本号 "${v}" 不符合 x.y.z 格式`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 进位规则：某位到 SEGMENT_MAX(20) 后，下次递增该位归 0、上一位 +1 */
function nextVersion(v) {
  let [maj, min, pat] = parseVersion(v);
  pat += 1;
  if (pat > SEGMENT_MAX) { pat = 0; min += 1; }
  if (min > SEGMENT_MAX) { min = 0; maj += 1; }
  return `${maj}.${min}.${pat}`;
}

// 稳定序列化（key 排序），用于忽略 version 的深比较
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const omitVersion = (obj) => {
  const { version, ...rest } = obj;
  return rest;
};

// ---------- 主流程 ----------
const pkgRaw = readFileSync(PKG_PATH, 'utf8');
const pkg = JSON.parse(pkgRaw);
let currentVersion = pkg.version;

log('1/6', `当前 @forge/desktop 版本：${currentVersion}`);

let targetVersion;
if (explicitVersion) {
  // 指定版本模式：跳过智能检测，但要求该 tag 不存在
  targetVersion = explicitVersion;
  parseVersion(targetVersion.replace(new RegExp(`^${TAG_PREFIX}`), ''));
  if (targetVersion.startsWith(TAG_PREFIX)) targetVersion = targetVersion.slice(TAG_PREFIX.length);
} else {
  // 智能检测：当前版本已有 tag（本地或远程）→ 自动递增；否则直接使用
  const tag = `${TAG_PREFIX}${currentVersion}`;
  const localHit = gitTry(['tag', '-l', tag]);
  const remoteHit = gitTry(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  const released = Boolean((localHit && localHit.length) || (remoteHit && remoteHit.length));
  if (released) {
    targetVersion = nextVersion(currentVersion);
    log('1/6', `v${currentVersion} 已发布 → 自动递增为 ${targetVersion}`);
  } else {
    targetVersion = currentVersion;
    log('1/6', `v${currentVersion} 未发布过（无对应 tag）→ 直接使用`);
  }
}

// 校验目标版本格式
parseVersion(targetVersion);
const targetTag = `${TAG_PREFIX}${targetVersion}`;

// 安全检查：package.json 除 version 外不得有在途改动
const headRaw = gitTry(['show', `HEAD:${PKG_REL}`]);
if (headRaw === null) die(`无法读取 HEAD 中的 ${PKG_REL}（未提交过？仓库异常？）`);
const headPkg = JSON.parse(headRaw);
if (stableStringify(omitVersion(pkg)) !== stableStringify(omitVersion(headPkg))) {
  die(`${PKG_REL} 存在版本号以外的在途改动，请先提交或还原，再运行发布脚本`);
}

// 是否需要 commit：目标版本与 HEAD 中的版本不同才提交
const needCommit = targetVersion !== headPkg.version;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });

if (dryRun) {
  log('预演', '以下为将执行的步骤（未实际执行）：');
  console.log(`  1. 写 ${PKG_REL}  version: ${currentVersion} → ${targetVersion}`);
  if (needCommit) {
    console.log(`  2. git add ${PKG_REL}`);
    console.log(`  3. git commit -m "build: bump forge-desktop version to ${targetVersion}"`);
  } else {
    console.log('  2-3. （版本号改动已在 HEAD，跳过 commit）');
  }
  console.log(`  4. git tag ${targetTag}`);
  console.log(`  5. git push origin ${branch}`);
  console.log(`  6. git push origin ${targetTag}`);
  process.exit(0);
}

// 1. 写版本号（保持 2 空格缩进 + 末尾换行）
const updated = { ...pkg, version: targetVersion };
writeFileSync(PKG_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
log('2/6', `${PKG_REL} version → ${targetVersion}`);

// 2. commit（仅这一个文件；版本号改动已在 HEAD 时跳过）
if (needCommit) {
  git(['add', '--', PKG_REL]);
  git(['commit', '-m', `build: bump forge-desktop version to ${targetVersion}`]);
  log('3/6', `已提交 bump commit（仅 ${PKG_REL}）`);
} else {
  log('3/6', '版本号改动已在 HEAD，跳过 commit');
}

// 3. 打 tag
git(['tag', targetTag]);
log('4/6', `已打 tag ${targetTag}`);

// 4. push 分支（bump commit 进远程分支历史）
git(['push', 'origin', branch]);
log('5/6', `已推送分支 ${branch}`);

// 5. push tag（CI 由此触发发布）
git(['push', 'origin', targetTag]);
log('6/6', `已推送 tag ${targetTag}`);

console.log(`\n[release] 完成：v${targetVersion}（tag ${targetTag}）已在 origin/${branch} 上触发发布。`);
