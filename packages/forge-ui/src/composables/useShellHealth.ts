/**
 * 全局 shell 健康状态（模块级单例，一次探测 + 可手动重测）。
 *
 * 背景（2026-09 WSL 占位事故）：pi 的 bash 解析三级兜底可能命中 System32 的 WSL
 * 占位 bash.exe 或彻底落空——届时会话里每条 bash 命令只返回乱码的「未安装 Linux
 * 子系统」，模型持续报告「bash 工具不可用」却无人知道原因。探测在主进程完成
 * （与 pi 会话同一解析口径，见 @forge/desktop pi/shellProbe.ts），ok=false 时
 * 对话视图渲染常驻横幅给出可操作的修复路径。
 *
 * 自愈后置（2026-09）：主进程在探测失败时会自动定位本机 Git Bash 写进 settings.json
 * 的 shellPath 再复探，多数「Git 装了但路径非标准」的机器到这里已经是 ok=true（根本
 * 不会出横幅）。留给 UI 的两种情况：
 * - autoFixed=true：本次是刚写配置后恢复的，已存在会话仍用旧 shell → 提示重启；
 * - broken 非空：本机确实没有可用 bash（或写配置失败）→ 横幅给安装指引 + 重新检测。
 *
 * 状态不隔离会话：shell 健康是机器属性，全会话同生共死。
 */
import { computed, ref } from 'vue';

import type { ShellProbeResult } from '../bridge.ts';

const result = ref<ShellProbeResult | null>(null);
/** 探测进行中（横幅「重新检测」按钮的忙碌态） */
const busy = ref(false);
/** 探测去重：多会话视图共用同一次在途请求（失败也置位，不反复打主进程） */
let inFlight: Promise<void> | null = null;

/** 真正打一次主进程（成功/失败都落到 result；bridge 异常静默=不弹横幅） */
function runProbe(): Promise<void> {
  busy.value = true;
  return window.forge.shell
    .shellProbe()
    .then((r) => {
      result.value = r;
    })
    .catch(() => {
      result.value = null;
    })
    .finally(() => {
      busy.value = false;
      inFlight = null;
    });
}

export function useShellHealth() {
  /** 首挂载触发：幂等。bridge 异常（理论不可能，preload 常驻）静默=不弹横幅 */
  function ensureProbed(): void {
    if (inFlight !== null) return;
    inFlight = runProbe();
  }

  /**
   * 用户点「重新检测」：绕过幂等闸门强制重探。
   * 场景＝横幅提示「装 Git 后重试」——用户装完 Git 不必重启应用，点一下即走主进程的
   * 自动定位 + 写配置链路（装的是默认路径时也能被 where git.exe 反推出来）。
   */
  async function reprobe(): Promise<void> {
    await runProbe();
  }

  /** 异常结果（healthy / 未探明 / 探测失败时为 null，横幅 v-if 用） */
  const broken = computed(() => (result.value !== null && !result.value.ok ? result.value : null));

  /** 刚被自动修复（配置已落盘但需重启生效时提示一次） */
  const autoFixed = computed(() => (result.value !== null && result.value.ok && result.value.autoFixed === true ? result.value : null));

  return { broken, autoFixed, busy, ensureProbed, reprobe };
}
