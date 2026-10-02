/**
 * 扫描本机已安装的外部代码编辑器——不写死三家，内置一个**编辑器目录**（20+ 款：
 * VS Code 家族 / Cursor / Windsurf / Trae / Zed / Sublime / Notepad++ / JetBrains 全家……），
 * 逐款走三层解析，装了什么菜单里就出现什么：
 *
 *   ① PATH：`where`/`which` 的**全部**命中行（不能只取首行——Windows 上 VS Code 的
 *      `where code` 首行是无扩展名的 sh 脚本，第二行才是 code.cmd）；
 *   ② 注册表 App Paths（HKLM + HKCU）：编辑器没进 PATH、装在自定义目录时的兜底线索；
 *   ③ 常见安装根目录扫描（%LOCALAPPDATA%\Programs / %ProgramFiles%，按目录名前缀匹配）。
 *
 * 为什么必须解析出 .exe：Node ≥18.20 的 spawn 禁止直接启动 .cmd/.bat 垫片
 * （CVE-2024-27980，同步抛 EINVAL）——旧实现拿到 code.cmd 就 spawn，在 Windows 上
 * 必然失败且被 catch 吞掉，表现为右键菜单「点了没反应」。所以 Windows 上的放行条件
 * 是**解析出一个真实存在的 GUI 主程序 .exe**：
 *   - PATH 命中 .exe → 直接用；
 *   - 命中 .cmd/.bat 垫片 → 沿垫片目录向上最多 3 层找主程序（VSCode：`<root>\bin\code.cmd`
 *     → `<root>\Code.exe`；Cursor 垫片嵌在 `resources\app\bin` 下要爬 3 层）；
 *   - 都不行 → ②③ 层兜底；再不行 → 该编辑器不进菜单（宁缺毋滥）。
 *
 * 安全边界：可执行文件**只**从本模块产出（目录白名单 + 三层解析），渲染层永远只能传
 * 编辑器 id 和文件路径，不能指定命令、不能传参数串（见 openEditorTarget.ts）。
 * 本模块只做**纯收集**（collectInstalledEditors，依赖全注入便于单测）；
 * 真实数据采集在 shell/editorProbe.ts（异步：where×N / reg query / readdir 并行）。
 */
import path from 'node:path';

export interface EditorApp {
  /** 稳定 id：渲染层菜单 key 与 openInEditor 的载荷都靠它（绝不改名） */
  id: string;
  /** 菜单展示名（已含品牌大小写，渲染层直接拼进「用 {name} 打开」） */
  label: string;
  /** PATH 上的 CLI 名（Windows 上多为 .cmd 垫片；JetBrains 这类没有 CLI 的留空） */
  cmds: string[];
  /** GUI 主程序文件名（垫片解析 / App Paths / 安装目录扫描共用） */
  exeNames: string[];
  /** 安装根目录扫描用的目录名**小写前缀**（如 'intellij idea' 命中 'IntelliJ IDEA 2024.1'） */
  installDirHints: string[];
}

export const EDITOR_APPS: readonly EditorApp[] = [
  { id: 'vscode', label: 'VS Code', cmds: ['code'], exeNames: ['Code.exe'], installDirHints: ['microsoft vs code'] },
  { id: 'vscode-insiders', label: 'VS Code Insiders', cmds: ['code-insiders'], exeNames: ['Code - Insiders.exe'], installDirHints: ['microsoft vs code insiders'] },
  { id: 'vscodium', label: 'VSCodium', cmds: ['codium'], exeNames: ['VSCodium.exe'], installDirHints: ['vscodium'] },
  { id: 'cursor', label: 'Cursor', cmds: ['cursor'], exeNames: ['Cursor.exe'], installDirHints: ['cursor'] },
  { id: 'windsurf', label: 'Windsurf', cmds: ['windsurf'], exeNames: ['Windsurf.exe'], installDirHints: ['windsurf'] },
  { id: 'trae', label: 'Trae', cmds: ['trae'], exeNames: ['Trae.exe'], installDirHints: ['trae'] },
  { id: 'zed', label: 'Zed', cmds: ['zed'], exeNames: ['zed.exe'], installDirHints: ['zed'] },
  { id: 'sublime-text', label: 'Sublime Text', cmds: ['subl'], exeNames: ['sublime_text.exe'], installDirHints: ['sublime text'] },
  { id: 'notepad-plus-plus', label: 'Notepad++', cmds: ['notepad++'], exeNames: ['notepad++.exe'], installDirHints: ['notepad++'] },
  { id: 'editplus', label: 'EditPlus', cmds: ['editplus'], exeNames: ['editplus.exe'], installDirHints: ['editplus'] },
  { id: 'emacs', label: 'Emacs', cmds: ['emacs'], exeNames: ['emacs.exe', 'runemacs.exe'], installDirHints: ['emacs'] },
  { id: 'visual-studio', label: 'Visual Studio', cmds: ['devenv'], exeNames: ['devenv.exe'], installDirHints: ['microsoft visual studio'] },
  { id: 'intellij-idea', label: 'IntelliJ IDEA', cmds: [], exeNames: ['idea64.exe'], installDirHints: ['intellij idea'] },
  { id: 'pycharm', label: 'PyCharm', cmds: [], exeNames: ['pycharm64.exe'], installDirHints: ['pycharm'] },
  { id: 'webstorm', label: 'WebStorm', cmds: [], exeNames: ['webstorm64.exe'], installDirHints: ['webstorm'] },
  { id: 'goland', label: 'GoLand', cmds: [], exeNames: ['goland64.exe'], installDirHints: ['goland'] },
  { id: 'clion', label: 'CLion', cmds: [], exeNames: ['clion64.exe'], installDirHints: ['clion'] },
  { id: 'phpstorm', label: 'PhpStorm', cmds: [], exeNames: ['phpstorm64.exe'], installDirHints: ['phpstorm'] },
  { id: 'rider', label: 'Rider', cmds: [], exeNames: ['rider64.exe'], installDirHints: ['rider'] },
  { id: 'datagrip', label: 'DataGrip', cmds: [], exeNames: ['datagrip64.exe'], installDirHints: ['datagrip'] },
  { id: 'rubymine', label: 'RubyMine', cmds: [], exeNames: ['rubymine64.exe'], installDirHints: ['rubymine'] },
  { id: 'android-studio', label: 'Android Studio', cmds: [], exeNames: ['studio64.exe'], installDirHints: ['android studio'] },
];

/** 注册表 App Paths 的一个条目（adapter 已筛过：name 是子键基名小写，exe 是默认值） */
export interface AppPathEntry {
  name: string;
  exe: string;
}

/** 安装根目录扫到的一层目录（name = 目录基名，供 installDirHints 前缀匹配） */
export interface InstallDir {
  name: string;
  path: string;
}

/** 一次扫描的全部输入（真实采集见 editorProbe.gatherScanData；测试全注入） */
export interface ScanData {
  /** cmd → where/which 的全部命中行（不保证存在/可执行，由本模块解析过滤） */
  pathHits: Map<string, string[]>;
  registeredApps: AppPathEntry[];
  installDirs: InstallDir[];
  /** 「存在且是普通文件」判定（主进程注入 lstat isFile，不跟随软链） */
  exists: (p: string) => boolean;
  isWindows: boolean;
}

/** 扫描产出的一个可用编辑器。exe 保证可直接 spawn（Windows 上必为真实 .exe）。 */
export interface InstalledEditor {
  id: string;
  label: string;
  exe: string;
}

const SHIM_EXTS = new Set(['.cmd', '.bat']);
/** 垫片 → GUI 主程序的向上搜索层数（Cursor 的 resources\app\bin 需要爬 3 层） */
const MAX_UP_LEVELS = 3;

/** Windows：沿垫片目录向上找 GUI 主程序；找不到返回 null（该命中不放行） */
function resolveExeFromShim(shimPath: string, exeNames: readonly string[], exists: (p: string) => boolean): string | null {
  let dir = path.dirname(shimPath);
  for (let up = 0; up <= MAX_UP_LEVELS; up += 1) {
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 层①：PATH 全部命中行。.exe 直接用；.cmd 垫片向上解析；无扩展名脚本跳过。 */
function resolveFromPath(app: EditorApp, data: ScanData): string | null {
  for (const cmd of app.cmds) {
    for (const hit of data.pathHits.get(cmd) ?? []) {
      if (!data.isWindows) return hit; // unix：which 命中的脚本带 shebang，可直接 spawn
      const ext = path.extname(hit).toLowerCase();
      if (ext === '.exe') {
        if (data.exists(hit)) return hit;
      } else if (SHIM_EXTS.has(ext)) {
        const exe = resolveExeFromShim(hit, app.exeNames, data.exists);
        if (exe) return exe;
      }
      // 其余扩展名（无扩展名脚本 / .ps1）无法安全 spawn，看下一条命中
    }
  }
  return null;
}

/** 层②：注册表 App Paths。只认目录白名单里的 exe 名，路径必须真实存在。 */
function resolveFromAppPaths(app: EditorApp, data: ScanData): string | null {
  if (!data.isWindows) return null;
  for (const name of app.exeNames) {
    const entry = data.registeredApps.find((e) => e.name === name.toLowerCase());
    if (entry && data.exists(entry.exe)) return entry.exe;
  }
  return null;
}

/** 层③：安装根目录扫描。目录名前缀匹配 hint 后，在根部与 bin\ 下找主程序。 */
function resolveFromInstallDirs(app: EditorApp, data: ScanData): string | null {
  if (!data.isWindows) return null;
  for (const dir of data.installDirs) {
    const base = dir.name.trim().toLowerCase();
    if (!app.installDirHints.some((hint) => base.startsWith(hint))) continue;
    for (const name of app.exeNames) {
      for (const candidate of [path.join(dir.path, name), path.join(dir.path, 'bin', name)]) {
        if (data.exists(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** 收集全部白名单编辑器，按目录顺序输出（菜单顺序稳定），装了什么出什么。 */
export function collectInstalledEditors(data: ScanData): InstalledEditor[] {
  const out: InstalledEditor[] = [];
  for (const app of EDITOR_APPS) {
    const exe =
      resolveFromPath(app, data) ??
      (data.isWindows ? resolveFromAppPaths(app, data) ?? resolveFromInstallDirs(app, data) : null);
    if (exe) out.push({ id: app.id, label: app.label, exe });
  }
  return out;
}
