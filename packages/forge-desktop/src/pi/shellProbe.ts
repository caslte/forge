/**
 * pi shell 健康探测（forge:shell-probe 主进程侧）。
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
 */
import path from 'node:path';

import { SettingsManager, getShellConfig } from '@earendil-works/pi-coding-agent';

import type { ShellProbeResult } from '../ipc-contract.ts';

/**
 * Windows WSL 占位 bash.exe 特征：位于 <windir>\System32（含 SysWOW64）下。
 * Git Bash / MSYS2 / Cygwin 都不会安装到该目录，命中即认定占位（调用必挂）。
 */
export function isWslStubBash(shell: string): boolean {
  return /[\\/](system32|syswow64)[\\/]/i.test(shell);
}

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
