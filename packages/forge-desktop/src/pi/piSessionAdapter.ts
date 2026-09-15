/**
 * pi 会话适配器（生产实现）：把 forge 会话生命周期落到 pi 的磁盘布局上。
 *
 * 职责边界：本类**只**做磁盘清理，不持有运行时会话对象 ——
 * 停执行 / dispose lease / 退订事件由 PiConversationAdapter.removeSession 负责，
 * SessionService 保证调用顺序为「stop → 本类 deleteSession → 移除 store 记录」。
 *
 * 删除语义（硬删，docs/api/02_session.md §3「硬删 pi session（不可逆）」）：
 * 1. `{agentDir}/sessions/{encodeURIComponent(cwd)}/forge-{sessionId}.jsonl`
 *    —— pi 的会话转录（消息历史本体，占用大头）。
 * 2. `{tmpdir}/pi-subagents-{uid}/{encodeCwd(cwd)}/forge-{sessionId}/`
 *    —— 该会话全部子 agent 的执行过程输出（pi-subagents 写，整目录清）。
 * 3. 两者删除后若各自父目录已空则顺带移除（空目录清理，失败忽略）。
 *
 * 关键取舍：
 * - **失败必须上抛**：只有 JSONL 真的删掉才认为删除成功。原因是反向的折中很糟 ——
 *   若"吞掉失败仍删记录"，用户以为删干净了，文件却永远留在盘上（这正是本类此前
 *   空实现造成的现状：本机 159 个 forge-*.jsonl vs store 里只有 54 个会话）。
 *   上抛后 rpc 层映射 5000、store 记录保留，用户可重试，且状态始终自洽。
 * - **目标不存在不算失败**：force 忽略 ENOENT，重复删除幂等。
 * - **ID 非法不阻断删除**：历史脏数据推不出路径，跳过磁盘清理（见 tryResolve...）。
 * - **重试**：Windows 上 pi 的文件句柄释放有延迟，句柄未关时 unlink 报 EPERM/EBUSY，
 *   fs.rm 的 maxRetries/retryDelay 正是为这种瞬时占用设计的。
 * - **只删自己的文件**：文件名前缀 `forge-` 是护栏，pi CLI 原生会话
 *   （`<ts>_<uuid>.jsonl`，同目录共存）绝不在删除范围内。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { PiSessionAdapter as ForgePiSessionAdapter } from '@forge/core';

import { resolveProjectSessionDir, tryResolveForgeSessionFile } from './piSessionPaths.ts';
import { resolveSubagentOutputDir } from './subagentOutput.ts';

/** Windows 句柄释放延迟的默认重试策略（约 150ms 内 3 次） */
export const DEFAULT_REMOVE_RETRIES = 3;
export const DEFAULT_REMOVE_RETRY_DELAY_MS = 50;

export interface PiSessionAdapterOptions {
  /** pi agent 目录；缺省 `~/.pi/agent`（与 createForgeCore 注入值一致） */
  agentDir?: string;
  /** 删除失败重试次数（句柄瞬时占用）；缺省 3 */
  removeMaxRetries?: number;
  /** 重试间隔（毫秒）；缺省 50 */
  removeRetryDelayMs?: number;
  /**
   * 移除端口：删除单个文件或目录。缺省 fs.promises.rm（recursive + force + 重试）。
   * 测试注入失败实现，验证「删不掉必须抛错」的传播语义（OS 级模拟在本机不可靠：
   * fs.promises.rm 会无视只读属性删除文件，无法稳定复现 EPERM）。
   */
  remove?: (target: string) => Promise<void>;
}

export class PiSessionAdapter implements ForgePiSessionAdapter {
  private readonly agentDir: string | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly remove: (target: string) => Promise<void>;

  constructor(options: PiSessionAdapterOptions = {}) {
    this.agentDir = options.agentDir;
    this.maxRetries = options.removeMaxRetries ?? DEFAULT_REMOVE_RETRIES;
    this.retryDelayMs = options.removeRetryDelayMs ?? DEFAULT_REMOVE_RETRY_DELAY_MS;
    this.remove = options.remove ?? ((target) => this.removeWithFs(target));
  }

  /**
   * 分配 forge 会话 ID。pi 侧会话文件**不在此处创建** —— 首条消息经
   * createPiAgentSessionFactory 启动会话时才落盘（未发消息的会话本就没有文件，
   * 删除时按"目标不存在即已删除"处理）。
   */
  createSession(_projectPath: string): Promise<string> {
    return Promise.resolve(randomUUID());
  }

  /**
   * 停止会话执行。生产链路的真实停执行在
   * PiConversationAdapter.removeSession（lease.session.abort + dispose），
   * 本类不持有运行时对象，故为空实现（保留以满足接口与 mock 对称）。
   */
  stopSession(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 硬删会话的全部磁盘残留（不可逆）。
   * @param sessionId forge 会话 ID
   * @param projectPath 所属项目工作目录（推导 pi 转录路径与子 agent 输出目录）
   * @throws 目标存在但删除失败（句柄占用/权限）时抛错，由调用方保留 store 记录
   */
  async deleteSession(sessionId: string, projectPath: string): Promise<void> {
    const sessionFile = tryResolveForgeSessionFile(sessionId, projectPath, this.agentDir);
    if (sessionFile === null) {
      // 历史脏数据：ID 含非法字符推不出路径。不阻断删除，但留下可追溯的告警
      console.warn(
        `[PiSessionAdapter] skip disk cleanup for invalid session id: ${sessionId}`,
      );
      return;
    }
    await this.removePath(sessionFile);
    const subagentDir = resolveSubagentOutputDir(projectPath, sessionId);
    await this.removePath(subagentDir);
    // 父目录已空则顺带移除（sessions/<encoded cwd> / <encodeCwd>）；非空（还有别的
    // 会话或 pi CLI 会话）时 rmdir 会失败，属预期，忽略
    await this.pruneDirIfEmpty(resolveProjectSessionDir(projectPath, this.agentDir));
    await this.pruneDirIfEmpty(path.dirname(subagentDir));
  }

  /**
   * 删除文件或目录（不存在即视为已删除）。
   * @throws 存在但删除失败时抛错，错误信息带路径与 cause 便于定位占用进程
   */
  private async removePath(target: string): Promise<void> {
    try {
      await this.remove(target);
    } catch (err) {
      throw new Error(`删除会话文件失败: ${target}`, { cause: err });
    }
  }

  /** 默认移除实现：fs.promises.rm（force 忽略 ENOENT，重试兜 Windows 句柄延迟释放） */
  private async removeWithFs(target: string): Promise<void> {
    await fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelayMs,
    });
  }

  /** 空目录清理（仅当目录存在且为空时成功；其余情况静默忽略） */
  private async pruneDirIfEmpty(dir: string): Promise<void> {
    try {
      await fs.promises.rmdir(dir);
    } catch {
      // ENOTEMPTY / ENOENT / 权限不足均属预期，空目录非删除目标本身
    }
  }
}
