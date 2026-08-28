/**
 * 收集 production 依赖到目标 node_modules（绕过 electron-builder 在 npm workspaces 上的扫描卡死）。
 * 用法: node scripts/collect-prod-deps.mjs <目标node_modules目录> <包名1> [包名2...]
 * 从入口包开始，按 package.json "dependencies" 递归解析（不收集 devDependencies），
 * 拷贝真实内容（穿透 symlink/junction）。
 *
 * 版本策略（对齐 npm 行为）：
 *   - 跳过 @types/* 纯类型包（无运行时代码，且会把旧版本依赖带进扁平层）
 *   - 同名同版本只拷贝一份（拍平到目标 node_modules）
 *   - 同名不同版本时，冲突副本嵌套拷贝到依赖方包自己的 node_modules 下，
 *     保证运行时 Node 解析规则能找到正确版本（如 htmlparser2 需要 entities@^8）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [targetRaw, ...entries] = process.argv.slice(2);
const target = path.resolve(root, targetRaw);

/** 按 node_modules 查找规则向上解析包目录（不走 exports，@forge/core 有 exports 挡 package.json） */
function realPkgDir(name, fromDir) {
  const sub = name.split('/');
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...sub);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`找不到包: ${name} (from ${fromDir})`);
    dir = parent;
  }
}

const flat = new Map(); // name -> { version, dest }（扁平层已放置的包）
const copied = new Set(); // 已拷贝的目标路径（防环）

function walk(pkgName, fromDir, destScope) {
  // @types/* 是纯类型包，无运行时代码，跳过
  if (pkgName.startsWith('@types/')) return;
  const dir = realPkgDir(pkgName, fromDir);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const version = manifest.version ?? '0.0.0';

  const placed = flat.get(pkgName);
  const dest = !placed
    ? path.join(target, ...pkgName.split('/')) // 首份放扁平层
    : placed.version === version
      ? placed.dest // 同版本已收集，跳过
      : path.join(destScope, 'node_modules', ...pkgName.split('/')); // 版本冲突 → 嵌套到依赖方
  if (copied.has(dest)) return;
  copied.add(dest);
  if (!placed) flat.set(pkgName, { version, dest });

  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(dir, dest, { recursive: true, dereference: true, errorOnExist: false });

  for (const dep of Object.keys(manifest.dependencies ?? {})) walk(dep, dir, dest);
}

for (const entry of entries) walk(entry, root, target);

console.log(`copied ${copied.size} packages -> ${target}`);
