/**
 * Git Bash 自动识别（shellPath 自愈的候选解析层）。
 *
 * 背景（接 shellProbe.ts 的 2026-09 dev 切根事故）：pi 的 bash 三级兜底只覆盖
 * 两类机器——「Git 装在 %ProgramFiles%\Git」与「bash.exe 已进 PATH」。装到自定义
 * 目录（D:\tools\Git、PortableGit 解压目录）而 PATH 只挂了 `<root>\cmd`（有
 * git.exe、没有 bash.exe）的机器三级全落空，用户必须自己翻 settings.json 手写
 * shellPath 才能用 bash 工具。
 *
 * 本模块负责「把用户手工配置这件事自动化」的前半程：按下列顺序找出真正可用的
 * bash.exe，交给 shellProbe.ensurePiShellPath 落盘。
 *   1. where git.exe 反推同安装根（<root>\cmd\git.exe → <root>\bin\bash.exe）——
 *      覆盖面最大的一类，几乎所有「装了但没配」的机器都在这级命中；
 *   2. 注册表 HKLM/HKCU\SOFTWARE\GitForWindows 的 InstallPath（Git 完全不在
 *      PATH 上时 where 找不到，注册表仍留着安装根）；
 *   3. 常见安装位置（Program Files / x86 / LOCALAPPDATA\Programs / scoop）；
 *   4. PATH 上现成的 bash.exe（Cygwin / MSYS2 / 解压版 PortableGit）。
 *
 * 有效性判定只有两条：文件真实存在 + 不是 Windows 自带的 WSL 占位
 * （%SystemRoot%\System32\bash.exe，真 bash 不会装在那里，见 isWslStubBash）。
 * 反推一律向上逐级试 `<dir>\bin\bash.exe` 与 `<dir>\usr\bin\bash.exe`，不依赖
 * 目录名约定（Git for Windows 的 git.exe 在 cmd\ 或 mingw64\bin\，两种都覆盖）。
 *
 * 零 pi 依赖：纯 fs + child_process，单测可直接跑，不需要加载 pi SDK。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows WSL 占位 bash.exe 特征：位于 <windir>\System32（含 SysWOW64）下。
 * Git Bash / MSYS2 / Cygwin / PortableGit 都不会安装到该目录，命中即认定占位
 * （调用只会返回「未安装 Linux 子系统」乱码）。判定与 pi getShellConfig 的
 * isLegacyWslBashPath 同向，但更宽（pi 只认 C:\Windows\System32，本函数连
 * SysWOW64 与非 C 盘 windir 一起拒）。
 */
export function isWslStubBash(shell: string): boolean {
  return /[\\/](system32|syswow64)[\\/]/i.test(shell);
}

/** 非 Windows 上的 bash 候选（顺序即优先级；这些机器几乎不会走到自愈路径） */
const UNIX_BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];

/**
 * PATH 查询：Windows 走 where、其余走 which，单次同步调用。
 * 超时 5s 与 pi 自己的 findExecutableOnPath 对齐（where 查询是毫秒级，超时只为兜住
 * 异常 PATH/网络盘）。失败/无命中一律返回空数组——候选解析是「多级兜底」，任何一级
 * 出错都不该中断后续级别。
 */
export function queryPath(executable: string): string[] {
  try {
    const result =
      process.platform === 'win32'
        ? spawnSync('where', [executable], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
        : spawnSync('which', [executable], { encoding: 'utf-8', timeout: 5000 });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** Git for Windows 的注册表安装根键（HKLM 系统级 + WOW6432Node 32 位视图 + HKCU 用户级） */
const GIT_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
  'HKCU\\SOFTWARE\\GitForWindows',
];

/**
 * 读注册表 InstallPath（仅 Windows；缺失/被安全策略拦截/reg.exe 不可用都返回 null）。
 * 这是 where git.exe 之外的独立信息源：Git 完全不在 PATH 上时仍能定位安装根。
 */
export function readGitInstallPathFromRegistry(): string | null {
  if (process.platform !== 'win32') return null;
  for (const key of GIT_REGISTRY_KEYS) {
    try {
      const result = spawnSync('reg', ['query', key, '/v', 'InstallPath'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0 || !result.stdout) continue;
      // 形如：`    InstallPath    REG_SZ    D:\work\tools\Git`
      const matched = result.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/);
      const value = matched?.[1]?.trim();
      if (value) return value;
    } catch {
      // 忽略：注册表只是候选来源之一，读失败不影响其它级别
    }
  }
  return null;
}

/** 由 git.exe 路径反推同安装根下的 bash.exe（向上逐级试 bin\ 与 usr\bin\） */
function bashCandidatesFromGitExe(gitExe: string): string[] {
  const candidates: string[] = [];
  let dir = path.dirname(gitExe);
  // 三级上溯足够覆盖 cmd\git.exe（一级）、mingw64\bin\git.exe（两级）、bin\git.exe（一级）
  for (let depth = 0; depth < 3; depth += 1) {
    candidates.push(path.join(dir, 'bin', 'bash.exe'), path.join(dir, 'usr', 'bin', 'bash.exe'));
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到盘根，停止上溯
    dir = parent;
  }
  return candidates;
}

/** 由 Git 安装根展开 bash.exe 候选（bin\ 是 pi 的默认口径，usr\bin\ 为同安装根的等价入口） */
function bashCandidatesFromRoot(root: string): string[] {
  return [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')];
}

/** 常见 Git for Windows 安装根（系统级 / 用户级 / scoop；env 由调用方注入便于单测） */
function fixedGitRoots(env: Record<string, string | undefined>): string[] {
  const roots: string[] = [];
  if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, 'Git'));
  if (env['ProgramFiles(x86)']) roots.push(path.join(env['ProgramFiles(x86)'], 'Git'));
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  if (env.USERPROFILE) roots.push(path.join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current'));
  return roots;
}

/** resolveGitBash 的可注入依赖（单测用临时目录/假 PATH 结果，不依赖测试机真实安装） */
export interface ResolveGitBashOptions {
  /** 目标平台，默认当前平台 */
  platform?: NodeJS.Platform;
  /** 环境变量表（ProgramFiles / LOCALAPPDATA / USERPROFILE 等），默认 process.env */
  env?: Record<string, string | undefined>;
  /** 文件存在判定，默认 fs.existsSync */
  exists?: (candidate: string) => boolean;
  /** PATH 查询，默认 queryPath */
  findOnPath?: (executable: string) => string[];
  /** 注册表安装根读取，默认 readGitInstallPathFromRegistry */
  registryInstallPath?: () => string | null;
}

/**
 * 解析本机可用的 bash.exe 绝对路径；找不到返回 null（调用方保留原异常提示，引导安装 Git）。
 *
 * 注意：返回值直接写进 settings.json 的 shellPath，故每级候选都过 usable()——只接受
 * 真实存在且非 WSL 占位的文件，绝不把 System32\bash.exe 写进配置（那正是事故本身）。
 */
export function resolveGitBash(options: ResolveGitBashOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const findOnPath = options.findOnPath ?? queryPath;
  const registryInstallPath = options.registryInstallPath ?? readGitInstallPathFromRegistry;

  /** 候选有效性：文件真实存在，且不是 Windows 自带的 WSL 占位 bash.exe */
  const usable = (candidate: string): boolean => exists(candidate) && !isWslStubBash(candidate);

  if (platform !== 'win32') {
    for (const candidate of UNIX_BASH_CANDIDATES) {
      if (usable(candidate)) return candidate;
    }
    return findOnPath('bash').find(usable) ?? null;
  }

  // 1. where git.exe 反推安装根：装到自定义路径（PATH 里有 <root>\cmd 无 bash.exe）的机器在这级命中
  for (const gitExe of findOnPath('git.exe')) {
    for (const candidate of bashCandidatesFromGitExe(gitExe)) {
      if (usable(candidate)) return candidate;
    }
  }
  // 2. 注册表安装根：Git 完全不在 PATH 上时的唯一线索
  const registryRoot = registryInstallPath();
  if (registryRoot) {
    for (const candidate of bashCandidatesFromRoot(registryRoot)) {
      if (usable(candidate)) return candidate;
    }
  }
  // 3. 常见安装位置（默认路径安装但 PATH 未生效，如装完未重启资源管理器）
  for (const root of fixedGitRoots(env)) {
    for (const candidate of bashCandidatesFromRoot(root)) {
      if (usable(candidate)) return candidate;
    }
  }
  // 4. PATH 上现成的 bash.exe（Cygwin / MSYS2 / 解压版 PortableGit；System32 占位被 usable 滤掉）
  return findOnPath('bash.exe').find(usable) ?? null;
}
