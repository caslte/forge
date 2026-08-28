/**
 * forge 桌面应用打包脚本（免安装目录版，双击 forge.exe 即用）。
 *
 * 背景：electron-builder 在 npm workspaces + pi 生态的大 node_modules 上依赖扫描会卡死
 * （"searching for node modules" 数十分钟无进展），本项目改用确定性手动组装：
 *   1. 构建 core/desktop/ui
 *   2. 收集 production 依赖到扁平 node_modules（scripts/collect-prod-deps.mjs）
 *   3. 组装 release/：forge.exe + resources/app（主进程 dist + UI + node_modules）
 *
 * 产物布局（对齐 src/main.ts 生产路径 ../../forge-ui/dist）：
 *   release/forge.exe
 *   release/resources/app/{package.json, dist/, node_modules/}
 *   release/resources/forge-ui/dist/            ← main.js 从 app/dist 回退两级到这里
 *
 * 用法: node scripts/package.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = (p) => path.join(root, p);
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const release = pkg('release');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log('[package] 1/4 构建 workspaces');
run(npm, ['run', 'build', '--workspaces', '--if-present']);

console.log('[package] 2/4 清理旧产物 + 收集 production 依赖');
rmSync(pkg('release/resources/app'), { recursive: true, force: true });
rmSync(pkg('release/resources/forge-ui'), { recursive: true, force: true });
run(process.execPath, ['scripts/collect-prod-deps.mjs', 'release/resources/app/node_modules',
  '@forge/core', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']);

console.log('[package] 3/4 组装 app 目录');
const appDir = pkg('release/resources/app');
mkdirSync(appDir, { recursive: true });
cpSync(pkg('packages/forge-desktop/dist'), path.join(appDir, 'dist'), { recursive: true, dereference: true });
// UI 放 resources/forge-ui/dist（main.js 从 app/dist ../../ 到此，asar 外）
cpSync(pkg('packages/forge-ui/dist'), pkg('release/resources/forge-ui/dist'), { recursive: true, dereference: true });
writeFileSync(path.join(appDir, 'package.json'),
  JSON.stringify({ name: 'forge', version: '0.1.0', main: 'dist/main.js', type: 'module' }, null, 2));

console.log('[package] 4/4 拷贝 Electron 运行时（forge.exe 免安装）');
const electronDist = pkg('packages/forge-desktop/node_modules/electron/dist');
const runtimeFiles = ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll',
  'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE', 'LICENSES.chromium.html',
  'locales', 'resources', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version',
  'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];
for (const f of runtimeFiles) {
  cpSync(path.join(electronDist, f), path.join(release, f), { recursive: true, dereference: true, errorOnExist: false });
}
cpSync(path.join(electronDist, 'electron.exe'), path.join(release, 'forge.exe'), { force: true });

console.log(`\n完成 → ${path.join(release, 'forge.exe')}（双击即用，依赖目录为 resources/）`);