/**
 * 真实 pi 项目信任端口（P2-A）。
 *
 * 把 pi 的 `hasTrustRequiringProjectResources`（检测 .pi 项目资源 / .agents/skills）
 * 与 `ProjectTrustStore`（权威信任决策持久化）适配为 forge-core 的 TrustStorePort：
 * - hasTrustRequiringResources：交给 pi 检测（覆盖 .pi + .agents/skills）
 * - getDecision / setDecision：读写 pi 信任存储（agentDir 下），forge store 只缓存展示状态
 *
 * 未决决策（null 表示从未询问）→ forge 端进入 asking 状态并弹出信任询问。
 */
import {
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
} from '@earendil-works/pi-coding-agent';
import type { TrustStorePort } from '@forge/core';

export class PiTrustStoreAdapter implements TrustStorePort {
  private readonly store: ProjectTrustStore;

  constructor(agentDir: string) {
    this.store = new ProjectTrustStore(agentDir);
  }

  hasTrustRequiringResources(cwd: string): boolean {
    try {
      return hasTrustRequiringProjectResources(cwd);
    } catch {
      // 检测异常时保守视为有资源（触发询问，避免静默加载项目资源）
      return true;
    }
  }

  getDecision(cwd: string): boolean | null {
    try {
      return this.store.get(cwd);
    } catch {
      return null;
    }
  }

  setDecision(cwd: string, decision: boolean): void {
    this.store.set(cwd, decision);
  }
}