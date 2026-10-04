#!/usr/bin/env node
/**
 * forge 发布说明自动生成器：汇总上一个 tag 与目标版本之间的所有提交，排版成
 * Markdown 写入 packages/forge-desktop/release-notes.md：
 *   - electron-builder 读它填进 latest.yml 的 releaseNotes（应用内更新弹窗显示）；
 *   - GitHub Release 描述由 CI 的 release-notes job 用该文件补写
 *     （electron-builder 25.x 创建 Release 时不带 body）。
 *
 * 规则：
 *   - 范围：`git log <上一tag>..<目标>`，排除 merge 提交。
 *   - 噪音过滤：bump 版本号提交、Update package.json、临时文件删除等（见 NOISE_PATTERNS）。
 *   - 按 conventional commit 前缀分组（feat/fix/perf/refactor/style/docs/test），
 *     无前缀的提交归入「其他变更」；某组为空则整组省略。
 *   - 上一个 tag 自动探测：git describe（HEAD 已被打 tag 时回退 HEAD^）。
 *
 * 用法：
 *   node scripts/release-notes.mjs                          # 预览：上一tag..HEAD 的说明
 *   node scripts/release-notes.mjs --from v0.1.13 --to v0.1.14   # 指定范围
 *   node scripts/release-notes.mjs --write                  # 预览并写入 release-notes.md
 *   （release.mjs 发布时自动调用 buildReleaseNotes，无需手动跑）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_NOTES_REL = 'packages/forge-desktop/release-notes.md';

/** 噪音提交过滤（整条提交不进说明）。需要忽略新的噪音模式时在 这里加。 */
const NOISE_PATTERNS = [
  /^build:\s*bump\s+/i, // 版本号 bump 提交（release.mjs 产物）
  /^update\s+package\.json$/i, // 手改 package.json 的碎提交
  /^删除临时文件$/u, // 临时文件清理
];

/** 类型 → 分组标题（按此顺序输出）。不在表内且非噪音的提交归 OTHER_GROUP。 */
const GROUPS = [
  ['feat', '新功能'],
  ['fix', '问题修复'],
  ['perf', '性能优化'],
  ['refactor', '代码重构'],
  ['style', '界面样式'],
  ['docs', '文档'],
  ['test', '测试'],
];
const OTHER_GROUP = '其他变更';
// conventional commit 前缀：type(scope)!: subject（scope/! 可选）
const PREFIX_RE = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/u;

function git(args, { cwd = root } = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', cwd, timeout: 30000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（exit ${res.status}）：${(res.stderr || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

/**
 * 探测上一个发布 tag：从 toRef 沿提交历史回溯最近的 tag。
 * toRef 自身已打 tag（重跑发布场景）时回退其父提交。
 * 没有任何 tag（首次发布）返回 null。
 */
export function findPrevTag(toRef = 'HEAD') {
  let ref = toRef;
  for (let i = 0; i < 2; i++) {
    let tag;
    try {
      tag = git(['describe', '--tags', '--abbrev=0', ref]);
    } catch {
      return null; // 该 ref 及其祖先没有任何 tag（首次发布）
    }
    if (tag !== toRef || i > 0) return tag;
    ref = `${toRef}^`; // HEAD 本身是 tag：从父提交再找
  }
  return null;
}

export function isNoiseCommit(subject) {
  return NOISE_PATTERNS.some((re) => re.test(subject));
}

/** 拆 conventional 前缀。无前缀 → type=null、原文即 subject。 */
export function parseSubject(subject) {
  const m = PREFIX_RE.exec(subject);
  if (!m) return { type: null, scope: null, text: subject.trim() };
  return { type: m[1].toLowerCase(), scope: m[2] || null, text: m[3].trim() };
}

/** 收集 fromTag..toRef 的非 merge、非噪音提交：[{ hash, subject }] */
export function collectCommits(fromTag, toRef = 'HEAD') {
  const out = git(['log', `${fromTag}..${toRef}`, '--no-merges', '--format=%h%x00%s']);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => {
      const [hash, subject] = line.split('\0');
      return { hash, subject: (subject || '').trim() };
    })
    .filter((c) => c.subject && !isNoiseCommit(c.subject));
}

/** 由 origin remote 推导仓库主页 URL（https://github.com/owner/repo） */
export function repoUrl() {
  const raw = git(['remote', 'get-url', 'origin']);
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(raw);
  // (?:[^@/]+@)? 吃掉可选的凭证段（https://user@host/...）；([^/]+) 在第一个 / 前截住 host
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  const base = ssh ? `https://${ssh[1]}/${ssh[2]}` : https ? `https://${https[1]}/${https[2]}` : raw.replace(/\.git$/, '');
  return base;
}

/**
 * 排版说明。commits 已过滤噪音；prevTag/targetTag 用于生成 compare 链接。
 * 返回 Markdown（不含版本号大标题——GitHub Release 标题本身就是 tag 名）。
 */
export function formatNotes({ commits, prevTag, targetTag, url }) {
  const marker = '<!-- 本文件由 scripts/release-notes.mjs 自动生成，发布时随 bump commit 更新，请勿手改 -->\n\n';
  if (!commits.length) {
    return [marker + '_本次发布无功能性变更，详见提交历史。_', prevTag ? `\n**完整变更**：${url}/compare/${prevTag}...${targetTag}` : ''].join('\n').trim();
  }
  const buckets = new Map(GROUPS.map(([, title]) => [title, []]));
  const other = [];
  for (const { subject } of commits) {
    const { type, scope, text } = parseSubject(subject);
    const title = GROUPS.find(([t]) => t === type)?.[1];
    const line = scope ? `${text}（${scope}）` : text;
    (title ? buckets.get(title) : other).push(line);
  }
  const sections = [];
  for (const [, title] of GROUPS) {
    const items = buckets.get(title);
    if (items.length) sections.push(`### ${title}\n${items.map((t) => `- ${t}`).join('\n')}`);
  }
  if (other.length) sections.push(`### ${OTHER_GROUP}\n${other.map((t) => `- ${t}`).join('\n')}`);
  if (prevTag) sections.push(`**完整变更**：${url}/compare/${prevTag}...${targetTag}`);
  return marker + sections.join('\n\n');
}

/**
 * 发布流程入口：探测范围 → 收集 → 排版，返回 { prevTag, markdown, count }。
 * write=true 时同步写入 release-notes.md（electron-builder 发布用）。
 */
export function buildReleaseNotes({ targetTag = 'HEAD', write = false } = {}) {
  const prevTag = findPrevTag();
  if (!prevTag) {
    // 首次发布（无任何 tag）：给一份占位说明，避免 electron-builder 因缺文件报错
    const markdown = '<!-- 本文件由 scripts/release-notes.mjs 自动生成 -->\n\n_首次发布。_';
    if (write) writeFileSync(path.join(root, RELEASE_NOTES_REL), `${markdown}\n`, 'utf8');
    return { prevTag: null, markdown, count: 0 };
  }
  const commits = collectCommits(prevTag, 'HEAD');
  const markdown = formatNotes({ commits, prevTag, targetTag, url: repoUrl() });
  if (write) writeFileSync(path.join(root, RELEASE_NOTES_REL), `${markdown}\n`, 'utf8');
  return { prevTag, markdown, count: commits.length };
}

/** release.mjs 用：把当前 release-notes.md 与 HEAD 版本比较，判断是否需要提交 */
export function notesChangedVsHead() {
  const file = path.join(root, RELEASE_NOTES_REL);
  let current;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    return true; // 文件不存在（首次生成）
  }
  const res = spawnSync('git', ['show', `HEAD:${RELEASE_NOTES_REL}`], { encoding: 'utf8', cwd: root, timeout: 15000 });
  if (res.status !== 0) return true; // HEAD 里还没有这个文件
  return (res.stdout || '').replace(/\r\n/g, '\n') !== current;
}

// ---------- CLI（手动预览） ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const write = argv.includes('--write');
  const from = argOf('--from') || findPrevTag();
  const to = argOf('--to') || 'HEAD';
  const commits = collectCommits(from, to);
  const markdown = formatNotes({ commits, prevTag: from, targetTag: to, url: repoUrl() });
  console.log(`[notes] 范围 ${from}..${to}，有效提交 ${commits.length} 条\n`);
  console.log(markdown);
  if (write) {
    writeFileSync(path.join(root, RELEASE_NOTES_REL), `${markdown}\n`, 'utf8');
    console.log(`\n[notes] 已写入 ${RELEASE_NOTES_REL}`);
  }
}
