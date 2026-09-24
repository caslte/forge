/**
 * 全局 shell 健康状态（模块级单例，一次探测）。
 *
 * 背景（2026-09 WSL 占位事故）：pi 的 bash 解析三级兜底可能命中 System32 的 WSL
 * 占位 bash.exe 或彻底落空——届时会话里每条 bash 命令只返回乱码的「未安装 Linux
 * 子系统」，模型持续报告「bash 工具不可用」却无人知道原因。探测在主进程完成
 * （与 pi 会话同一解析口径，见 @forge/desktop pi/shellProbe.ts），ok=false 时
 * 对话视图渲染常驻横幅给出可操作的修复路径。
 *
 * 状态不隔离会话：shell 健康是机器属性，全会话同生共死。
 */
import { computed, ref } from 'vue';

import type { ShellProbeResult } from '../bridge.ts';

const result = ref<ShellProbeResult | null>(null);
/** 探测去重：多会话视图共用一次结果（失败也置位，不反复打主进程） */
let probing: Promise<void> | null = null;

export function useShellHealth() {
  /** 首挂载触发：幂等。bridge 异常（理论不可能，preload 常驻）静默=不弹横幅 */
  function ensureProbed(): void {
    if (probing !== null) return;
    probing = window.forge.shell
      .shellProbe()
      .then((r) => {
        result.value = r;
      })
      .catch(() => {
        result.value = null;
      });
  }

  /** 异常结果（healthy / 未探明 / 探测失败时为 null，横幅 v-if 用） */
  const broken = computed(() => (result.value !== null && !result.value.ok ? result.value : null));

  return { broken, ensureProbed };
}
