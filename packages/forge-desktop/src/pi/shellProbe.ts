/**
 * pi shell 健康探测 + shellPath 自愈（forge:shell-probe 主进程侧）。
 *
 * 背景（2026-09 dev 切根事故）：agentDir 切到 <userData>/agent 后新根没有
 * settings.json，pi 的 bash 解析三级兜底（settings.shellPath → Program Files Git
 * ×2 → PATH 上的 bash.exe）在「Git 装非标准路径 + 系统存在 System32 WSL 占位
 * bash.exe」的机器上静默命中 WSL 占位——每条命令只返回一句 UTF-16 乱码的
 * 「未安装 Linux 子系统」，模型侧表现为 bash/powershell/cmd 全部被 wsl 拦截。
 *
 * 口径：与 agent-session 完全同源——SettingsManager（读同一份 settings.json，
 * 同步装载）取 shellPath → pi 导出的 getShellConfig 走同一棵解析树，
 * 探测只在其结果上追加两个异常判定：
 * - 解析抛错（含 Custom shell path not found）→ no-shell；
 * - Windows 上解析到 %SystemRoot%\System32\bash.exe（WSL 占位，真 bash 不会
 *   装在那）→ wsl-stub。
 * 非 Windows 不解析 PATH 兜底也几乎总能命中 /bin/bash，无需特殊处理。
 *
 * 自愈（ensurePiShellPath）：探测到不可用时不再只提示「请自己改 settings.json」，
 * 而是用 gitBashResolver 找出本机真 bash 并写进 shellPath（用户零配置）。写入后
 * 立刻复探一次，只有复探通过才认修复成功——避免把「找到的文件其实不能用」变成
 * 一个更隐蔽的坏配置。
 */
import path from 'node:path';

import { SettingsManager, getShellConfig } from '@earendil-works/pi-coding-agent';

import type { ShellProbeResult } from '../ipc-contract.ts';
import { isWslStubBash, resolveGitBash } from './gitBashResolver.ts';

export { isWslStubBash };

/**
 * 探测 forge agent 根下 pi 会话实际会用到的 bash。
 * @param agentDir pi 数据域根（生产 = <userData>/agent，main.ts 注入）
 * @param cwd 项目工作目录（单测注入隔离目录；生产缺省 process.cwd()——
 *            项目级 .pi/settings.json 覆盖 shellPath 属极端场景，探测以全局根口径为准）
 */
export function probePiShell(agentDir: string, cwd: string = process.cwd()): ShellProbeResult {
  const settingsPath = path.join(agentDir, 'settings.json');
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const shellPath = settingsManager.getShellPath();
  try {
    const { shell } = getShellConfig(shellPath);
    if (process.platform === 'win32' && isWslStubBash(shell)) {
      return { ok: false, reason: 'wsl-stub', shell, settingsPath };
    }
    return { ok: true, shell };
  } catch {
    return { ok: false, reason: 'no-shell', shell: shellPath ?? null, settingsPath };
  }
}

/**
 * 把解析到的 bash 写进 pi 全局 settings.json 的 shellPath。
 *
 * 走 pi 自己的 SettingsManager 而非裸写 JSON：它按「读当前文件 → 只覆盖被修改的
 * 字段 → 写回」合并落盘（packages/models/主题等既有内容原样保留），并自带写队列
 * 与文件锁，与 pi 会话侧的读写同一套存储实现。flush() 必须 await——写是排队异步的，
 * 不 await 就可能出现「已修复」但文件还没落盘、紧接着创建的 pi 会话仍读到旧值。
 */
async function persistShellPath(agentDir: string, cwd: string, bashPath: string): Promise<void> {
  // 落盘前规范化：候选可能来自 where 输出 / 注册表 / 用户手填（正斜杠、重复分隔符都合法）。
  // 不归一化就会写出 `D:////work////Git////bin////bash.exe` 这种值——Windows 会把它当合法
  // 路径（existsSync 通过、复探也过），但 spawn 时行为不稳，是最难查的一类坏配置。
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setShellPath(path.normalize(bashPath));
  await settingsManager.flush();
}

/**
 * 探测 + 失败即自愈：不可用时自动定位 Git Bash 并写入 settings.json，写后复探确认。
 *
 * 调用点有两处（都要求「先修好、再建 pi 会话」）：
 * - main.ts 启动链：splash 上屏之后、createForgeCore 之前 await 一次——这是主路径，
 *   修好的配置在首个 pi 会话创建前就已落盘，用户全程无感（连横幅都不会出现）；
 * - forge:shell-probe IPC：运行期兜底。若启动那次没修成（当时还没装 Git），用户装完
 *   点横幅上的「重新检测」即可自愈，不需要手工编辑任何文件。
 *
 * @param resolveBash 候选解析器（默认 gitBashResolver.resolveGitBash；单测注入临时目录里的
 *                    假 bash，不依赖测试机是否装了 Git）
 * @returns ok=true 且 autoFixed=true 表示「本次是自动修复后才恢复的」——配置刚落盘，
 *          已存在的 pi 会话仍持旧解析结果，UI 据此提示重启；ok=false 表示找到了
 *          Git Bash 但复探仍不过，或本机确实没有可用 bash（保留原异常，引导安装）
 */
export async function ensurePiShellPath(
  agentDir: string,
  cwd: string = process.cwd(),
  resolveBash: () => string | null = resolveGitBash,
): Promise<ShellProbeResult> {
  const probe = probePiShell(agentDir, cwd);
  if (probe.ok) return probe;

  const bashPath = resolveBash();
  if (bashPath === null) return probe;
  try {
    await persistShellPath(agentDir, cwd, bashPath);
  } catch {
    // 写配置失败（权限/磁盘）不是致命错误：返回原异常，横幅仍给手工修复入口
    return probe;
  }
  const repaired = probePiShell(agentDir, cwd);
  return repaired.ok ? { ...repaired, autoFixed: true } : probe;
}
