/**
 * 编辑器扫描的**真实数据采集层**（shell/editorScan.ts 的注入依赖来自这里）。
 *
 * 三层并行采集，单次右键的扫描开销控制在几十毫秒级：
 *   ① PATH：目录里每个 CLI 名一次 `where`/`which`（并发）；
 *   ② 注册表 App Paths（HKLM + HKCU）：先枚举子键，**只对基名命中目录白名单的**
 *      子键再查默认值——不能给每个子键都发一次 reg query，那是 40+ 次子进程；
 *   ③ 安装根目录（%LOCALAPPDATA%\Programs / %ProgramFiles% / %ProgramFiles(x86)%）
 *      向下两层 readdir，产出目录清单，匹配交给 editorScan（按目录名前缀）。
 *
 * reg 的输出是控制台代码页（中文 Windows 是 GBK/936），用 TextDecoder('gbk') 解，
 * 解不出再退 utf8——exe 路径含中文安装目录名时不至于乱码。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EDITOR_APPS, type AppPathEntry, type InstallDir, type ScanData } from './editorScan.ts';
import { whichAll } from './whichCommand.ts';

const IS_WIN = process.platform === 'win32';

/** 主进程注入的存在判定：lstat 判普通文件（不跟随软链，与 openEditorTarget 同口径） */
function existsFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/** PATH 层：目录里出现过的所有 CLI 名，逐个并发解析 */
async function collectPathHits(): Promise<Map<string, string[]>> {
  const cmds = [...new Set(EDITOR_APPS.flatMap((a) => a.cmds))];
  const lists = await Promise.all(cmds.map((cmd) => whichAll(cmd)));
  const map = new Map<string, string[]>();
  cmds.forEach((cmd, i) => map.set(cmd, lists[i] ?? []));
  return map;
}

/** 子进程跑 reg（execFile 数组参数、windowsHide、短超时；失败返回 null） */
function regQuery(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', args, { encoding: 'buffer', timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? null : decodeConsoleOutput(stdout as Buffer));
    });
  });
}

/** reg 输出按控制台代码页解码（中文 Windows GBK），解不出退 utf8 */
function decodeConsoleOutput(buf: Buffer): string {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** App Paths 两个蜂窝的注册表路径 */
const APP_PATH_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
];

/** 注册表层：枚举 App Paths 子键，只对基名命中目录白名单的再查默认值 */
async function collectRegisteredApps(): Promise<AppPathEntry[]> {
  const wanted = new Set(EDITOR_APPS.flatMap((a) => a.exeNames).map((n) => n.toLowerCase()));
  const out: AppPathEntry[] = [];
  for (const key of APP_PATH_KEYS) {
    const listed = await regQuery(['query', key]);
    if (listed === null) continue;
    const subkeys = listed
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('HKEY_'));
    for (const subkey of subkeys) {
      const name = path.basename(subkey).toLowerCase();
      if (!wanted.has(name)) continue;
      const detail = await regQuery(['query', subkey, '/ve']);
      if (detail === null) continue;
      // 取值行形如「    (默认)    REG_SZ    D:\...\Code.exe」——取最后一个 REG_SZ 之后的路径
      const line = detail.split(/\r?\n/).find((l) => l.includes('REG_SZ'));
      if (!line) continue;
      const exe = line.slice(line.lastIndexOf('REG_SZ') + 'REG_SZ'.length).trim().replace(/^"|"$/g, '');
      if (exe !== '') out.push({ name, exe });
    }
  }
  return out;
}

/** 安装根目录向下两层的目录清单（JetBrains 独立安装 = 根/JetBrains/<IDE> 正好两层） */
function collectInstallDirs(): InstallDir[] {
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs'),
    process.env.ProgramFiles ?? '',
    process.env['ProgramFiles(x86)'] ?? '',
  ].filter((r) => r !== '');
  const out: InstallDir[] = [];
  const push = (p: string) => {
    if (out.length < 2000) out.push({ name: path.basename(p), path: p });
  };
  for (const root of roots) {
    let level1: string[];
    try {
      level1 = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
    } catch {
      continue;
    }
    for (const dir of level1) {
      push(dir);
      try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          if (d.isDirectory()) push(path.join(dir, d.name));
        }
      } catch {
        // 子目录读不进就跳过（权限/长路径），不影响其余
      }
    }
  }
  return out;
}

/** 采集一次完整 ScanData（三层并行；非 Windows 只有 PATH 层） */
export async function gatherScanData(): Promise<ScanData> {
  const [pathHits, registeredApps, installDirs] = await Promise.all([
    collectPathHits(),
    IS_WIN ? collectRegisteredApps() : Promise.resolve([]),
    IS_WIN ? Promise.resolve(collectInstallDirs()) : Promise.resolve([]),
  ]);
  return { pathHits, registeredApps, installDirs, exists: existsFile, isWindows: IS_WIN };
}
