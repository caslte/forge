/**
 * 子 Agent 管理服务（wu-06-subagent-core）。
 *
 * 职责：实现 docs/api/06_subagent.md 的子 agent 内存态管理与主会话 done 门控
 * （SA-F01/F02/F05/F07 业务真源）。纯 Node 业务层，不 import Electron / Vue / pi
 * —— 扩展（pi-subagents）事件经上层适配后以事件快照喂入 ingest，终止 RPC 经构造
 * 注入的 SubagentStopPort 抽象完成（desktop 层接真实扩展 RPC，测试注入 mock）。
 *
 * 设计决策：
 * 1. 内存态归组（TD-SA-05 / AC-SA-021）：SubagentRegistry 按 sessionId 分 Map 存储，
 *    会话间互不串扰，不持久化，应用重启后为空；disposeSession 整表清理。
 * 2. 幂等合并（AC-SA-002）：ingest 按 agentId 幂等 upsert；终态记录拒绝活跃态事件
 *    回退；finishedAt/result/error 一经设置不变（终态→终态仅合并 usage 累计）；
 *    重复事件无字段变化时 changed=false，不重复发射 subagent.updated。
 * 3. done 门控（AC-SA-004/005）：主会话 done = 主轮结束 且 活跃计数（queued+running）
 *    为 0。notifyMainTurnEnd 时计数为 0 立即发 done，否则延迟到计数归零；done 经
 *    EventSink 以 conversation.statusChanged { status: 'done' } 发射且每轮恰好一次。
 *    notifyMainTurnStart 在新一轮发送（状态转 streaming）时重置门控（清残留兜底
 *    计时器与上一轮未终态孤儿记录）：门控标记若跨轮保留，第二轮起 done 被短路
 *    永不发射，会话状态将永久卡在 streaming。
 * 4. 超时兜底（AC-SA-006）：主轮结束且计数>0 时启动 timeoutMs（默认 30 分钟）计时，
 *    窗口内任意子 agent 事件重置计时；到时发 done 并记兜底日志。兜底后迟到事件只
 *    更新子 agent 记录，不得把会话拉回 running 或重发 done。
 * 5. 终止编排（AC-SA-016/017）：stop 仅对 queued/running 调 stopPort，失败重试恰
 *    一次，仍失败返回 5000 且记录保留原状态（前端可重试）；已终态幂等成功。
 *    stopAllActive 为级联终止编排：逐个终止全部活跃子 agent，单个失败重试后仍失败
 *    记日志并保留原状态，不阻塞其余终止。
 * 6. 会话清理（AC-SA-022）：disposeSession 清记录/门控/计时器并标记已销毁，迟到
 *    ingest 与门控信号丢弃不报错不重建；重复调用幂等。
 * 7. 事件（经注入 sink，emit(sessionId, event, payload)）：subagent.updated（payload
 *    为完整记录）/ subagent.removed（payload { agentIds }）/ conversation.statusChanged
 *    （payload { status: 'done' }）。clearFinished 无终态时不发射 removed（无变化）。
 * 8. 错误码（docs/api/06_subagent.md §6）：1001 参数错误 / 1002 会话或子 agent 不
 *    存在 / 5000 终止失败。业务方法返回判别联合 { ok: true, data } | { ok: false,
 *    code, message }，调用方无需 try/catch 即可映射错误码。
 */

/** 子 agent 状态机（docs/api/06_subagent.md §0）：queued → running → 终态，终态不可逆 */
export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

/** 终态集合 */
const TERMINAL_STATUSES: readonly SubagentStatus[] = ['completed', 'failed', 'stopped'];

/** 合法状态集合（事件校验用） */
const VALID_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'stopped',
]);

/** 判定状态是否为终态（completed/failed/stopped） */
export function isTerminalStatus(status: SubagentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Token 用量（lifetime 累计；无产出时缺省） */
export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 子 agent 完整记录（docs/api/06_subagent.md §0；终态字段一经设置不变） */
export interface SubagentRecord {
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentStatus;
  startedAt: string;
  finishedAt: string | null;
  result: string | null;
  error: string | null;
  usage?: SubagentUsage;
}

/** 子 agent 事件输入（扩展事件流快照；agentId 为幂等合并键） */
export interface SubagentEventInput {
  agentId: string;
  status: SubagentStatus;
  agentType?: string;
  description?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  usage?: SubagentUsage;
}

/** 时钟抽象（默认 Date.now/setTimeout；测试注入假时钟验证 30 分钟超时兜底） */
export interface SubagentClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 默认时钟实现（真实时间） */
const defaultClock: SubagentClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** 终止端口抽象：desktop 层接真实扩展 RPC，测试注入 mock */
export interface SubagentStopPort {
  stop(sessionId: string, agentId: string): Promise<void>;
}

/** 事件汇（按会话发射）：subagent.updated / subagent.removed / conversation.statusChanged */
export interface SubagentEventSink {
  emit(sessionId: string, event: string, payload: unknown): boolean | void;
}

/** 兜底/失败日志接口（默认 console） */
export interface SubagentLogger {
  warn(message: string): void;
}

/** Registry 构造选项 */
export interface SubagentRegistryOptions {
  /** 时钟（建档缺省时间戳用；测试注入假时钟） */
  clock?: SubagentClock;
}

/** 事件合并结果：changed=false 表示无字段变化（重复事件，不重复发射） */
export interface IngestResult {
  record: SubagentRecord;
  changed: boolean;
}

/** 事件输入校验：agentId 非空字符串且 status 合法 */
function isValidEvent(event: SubagentEventInput): boolean {
  return (
    typeof event.agentId === 'string' &&
    event.agentId !== '' &&
    typeof event.status === 'string' &&
    VALID_STATUSES.has(event.status)
  );
}

/**
 * 子 Agent 注册表：按 sessionId 归组的内存态存储（不持久化，TD-SA-05）。
 * 职责：事件幂等合并（U-SA-001）、终态语义（U-SA-002）、展示排序与活跃计数。
 * 事件由上层喂入，本类不发射事件（事件发射与门控在 SubagentService）。
 */
export class SubagentRegistry {
  /** 会话表：sessionId -> (agentId -> record)；无模块级可变会话数据之外的状态 */
  private readonly sessions = new Map<string, Map<string, SubagentRecord>>();
  private readonly clock: SubagentClock;

  constructor(options: SubagentRegistryOptions = {}) {
    this.clock = options.clock ?? defaultClock;
  }

  /**
   * 幂等合并一条子 agent 事件（U-SA-001/002）。
   * 合并规则：按 agentId upsert；终态记录拒绝活跃态事件回退；
   * finishedAt/result/error 一经设置不变；空串 description/result/error 按缺失处理。
   * @param sessionId 会话 ID
   * @param event 事件快照
   * @returns 合并后的记录副本与是否发生变化；事件非法返回 null（不建档）
   */
  ingest(sessionId: string, event: SubagentEventInput): IngestResult | null {
    if (!isValidEvent(event)) {
      return null;
    }
    let sessionMap = this.sessions.get(sessionId);
    if (sessionMap === undefined) {
      sessionMap = new Map();
      this.sessions.set(sessionId, sessionMap);
    }
    const existing = sessionMap.get(event.agentId);
    if (existing === undefined) {
      const record = this.createRecord(event);
      sessionMap.set(event.agentId, record);
      return { record: { ...record }, changed: true };
    }
    const before = JSON.stringify(existing);
    this.applyEvent(existing, event);
    const changed = JSON.stringify(existing) !== before;
    return { record: { ...existing }, changed };
  }

  /**
   * 查询会话子 agent 列表（展示顺序）：运行中（queued/running）在前，终态按
   * finishedAt 倒序。返回记录副本，外部突变不影响内部状态。
   */
  list(sessionId: string): SubagentRecord[] {
    const sessionMap = this.sessions.get(sessionId);
    if (sessionMap === undefined) {
      return [];
    }
    const active: SubagentRecord[] = [];
    const terminal: SubagentRecord[] = [];
    for (const record of sessionMap.values()) {
      if (isTerminalStatus(record.status)) {
        terminal.push(record);
      } else {
        active.push(record);
      }
    }
    terminal.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return [...active, ...terminal].map((r) => ({ ...r }));
  }

  /** 查询单条记录（副本）；不存在返回 null */
  get(sessionId: string, agentId: string): SubagentRecord | null {
    const record = this.sessions.get(sessionId)?.get(agentId);
    return record === undefined ? null : { ...record };
  }

  /** 活跃计数 = queued + running（done 门控判据） */
  activeCount(sessionId: string): number {
    let count = 0;
    const sessionMap = this.sessions.get(sessionId);
    if (sessionMap === undefined) {
      return 0;
    }
    for (const record of sessionMap.values()) {
      if (!isTerminalStatus(record.status)) {
        count += 1;
      }
    }
    return count;
  }

  /** 移除会话内全部终态记录（clearFinished），返回被移除的 agentId 列表（插入序） */
  removeFinished(sessionId: string): string[] {
    const sessionMap = this.sessions.get(sessionId);
    if (sessionMap === undefined) {
      return [];
    }
    const removed: string[] = [];
    for (const [agentId, record] of sessionMap) {
      if (isTerminalStatus(record.status)) {
        sessionMap.delete(agentId);
        removed.push(agentId);
      }
    }
    return removed;
  }

  /** 清空会话内存态（disposeSession 用） */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 移除会话内全部未终态记录（notifyMainTurnStart 清理上一轮孤儿用）：
   * 终止失败 / 超时兜底后仍处 queued/running 的记录不再参与新一轮门控计数。
   * 返回被移除的 agentId 列表（插入序）。
   */
  removeActive(sessionId: string): string[] {
    const sessionMap = this.sessions.get(sessionId);
    if (sessionMap === undefined) {
      return [];
    }
    const removed: string[] = [];
    for (const [agentId, record] of sessionMap) {
      if (!isTerminalStatus(record.status)) {
        sessionMap.delete(agentId);
        removed.push(agentId);
      }
    }
    return removed;
  }

  /** 由事件建档（首次出现的 agentId） */
  private createRecord(event: SubagentEventInput): SubagentRecord {
    const nowIso = this.toIso(this.clock.now());
    const terminal = isTerminalStatus(event.status);
    const record: SubagentRecord = {
      agentId: event.agentId,
      agentType: event.agentType ?? '',
      description: event.description ?? '',
      status: event.status,
      startedAt: event.startedAt ?? nowIso,
      finishedAt: terminal ? (event.finishedAt ?? nowIso) : null,
      result: event.result ? event.result : null,
      error: event.error ? event.error : null,
    };
    if (event.usage !== undefined) {
      record.usage = event.usage;
    }
    return record;
  }

  /** 就地合并事件到既有记录（收敛规则见 ingest 注释） */
  private applyEvent(existing: SubagentRecord, event: SubagentEventInput): void {
    if (isTerminalStatus(existing.status)) {
      // 终态记录：终态不可逆。迟到的活跃态事件整体忽略（不回退）；
      // 终态→终态仅合并 usage 累计（finishedAt/result/error 一经设置不变）
      if (isTerminalStatus(event.status) && event.usage !== undefined) {
        existing.usage = event.usage;
      }
      return;
    }
    // 活跃记录：描述性字段后到非空值生效（空串按缺失处理，不覆盖）
    if (event.agentType) {
      existing.agentType = event.agentType;
    }
    if (event.description) {
      existing.description = event.description;
    }
    if (event.startedAt) {
      existing.startedAt = event.startedAt;
    }
    if (event.usage !== undefined) {
      existing.usage = event.usage;
    }
    if (isTerminalStatus(event.status)) {
      // 活跃→终态：状态单向推进，终态字段落位
      existing.status = event.status;
      existing.finishedAt = event.finishedAt ?? this.toIso(this.clock.now());
      existing.result = event.result ? event.result : null;
      existing.error = event.error ? event.error : null;
    } else if (event.status !== existing.status) {
      existing.status = event.status; // queued→running 推进
    }
  }

  private toIso(ms: number): string {
    return new Date(ms).toISOString();
  }
}

/** done 门控超时默认窗口：30 分钟（docs/api/06_subagent.md §4） */
export const SUBAGENT_DONE_TIMEOUT_MS = 30 * 60 * 1000;

/** 业务方法统一结果（判别联合）：code 为 docs/api/06_subagent.md §6 错误码 */
export type SubagentResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 1002 | 5000; message: string };

/** 服务构造选项（事件汇 / 时钟 / 超时窗口 / 日志均可注入） */
export interface SubagentServiceOptions {
  /** 事件汇（subagent.updated / subagent.removed / conversation.statusChanged）；未注入为空操作 */
  sink?: SubagentEventSink;
  /** 时钟（默认真实时钟；测试注入假时钟验证超时兜底） */
  clock?: SubagentClock;
  /** done 门控超时窗口（默认 30 分钟） */
  timeoutMs?: number;
  /** 日志（默认 console） */
  logger?: SubagentLogger;
}

/** 会话门控状态（每会话内存态，按轮重置） */
interface GateState {
  /** 主轮是否已结束（notifyMainTurnEnd 已达） */
  mainTurnEnded: boolean;
  /** done 是否已发出（本轮恰好一次；notifyMainTurnStart 重置） */
  doneSent: boolean;
  /** 超时兜底计时器句柄（null = 未启动） */
  timeoutTimer: unknown | null;
}

/** 级联终止编排结果 */
export interface StopAllActiveResult {
  /** 终止成功的 agentId */
  stopped: string[];
  /** 重试后仍失败的 agentId（记录保留原状态，可重试） */
  failed: string[];
}

/** 提取异常消息（5000 错误联合用） */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 子 Agent 管理服务：事件归组 + 查询/终止/清除业务方法 + 主会话 done 门控 +
 * 30 分钟超时兜底 + 级联终止编排 + 会话清理。
 */
export class SubagentService {
  private readonly registry: SubagentRegistry;
  private readonly sink: SubagentEventSink;
  private readonly clock: SubagentClock;
  private readonly timeoutMs: number;
  private readonly logger: SubagentLogger;
  /** 会话门控状态表（sessionId -> GateState） */
  private readonly gates = new Map<string, GateState>();
  /** 已销毁会话（墓碑：迟到 ingest/门控信号丢弃，不报错不重建） */
  private readonly disposedSessions = new Set<string>();

  constructor(options: SubagentServiceOptions = {}) {
    this.registry = new SubagentRegistry({ clock: options.clock });
    this.sink = options.sink ?? { emit: () => true };
    this.clock = options.clock ?? defaultClock;
    this.timeoutMs = options.timeoutMs ?? SUBAGENT_DONE_TIMEOUT_MS;
    this.logger = options.logger ?? console;
  }

  /**
   * 喂入一条子 agent 事件（扩展事件流经上层适配归一化后的快照）。
   * 副作用：注册表幂等合并；有变化时发射 subagent.updated（完整记录）；
   * 主轮已结束且未发 done 时联动门控（计数归零发 done / 计数>0 重置兜底计时）。
   * 已销毁会话的迟到事件直接丢弃（不报错不重建）。
   */
  ingest(sessionId: string, event: SubagentEventInput): void {
    if (sessionId === '' || this.disposedSessions.has(sessionId)) {
      return;
    }
    const merged = this.registry.ingest(sessionId, event);
    if (merged === null) {
      return;
    }
    if (merged.changed) {
      this.sink.emit(sessionId, 'subagent.updated', merged.record);
    }
    const gate = this.gates.get(sessionId);
    if (gate === undefined || gate.doneSent || !gate.mainTurnEnded) {
      return; // 兜底已发 done 的迟到事件只更新记录（上方已 emit），不复活门控
    }
    if (this.registry.activeCount(sessionId) === 0) {
      this.sendDone(sessionId);
    } else {
      this.restartTimeoutTimer(sessionId, gate); // 窗口内任意子 agent 事件重置计时
    }
  }

  /**
   * 查询会话子 agent 列表（SA-F01）：运行中在前、终态按 finishedAt 倒序；
   * 会话不存在/空返回 []。
   */
  queryList(sessionId: string): SubagentResult<SubagentRecord[]> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, code: 1001, message: '参数错误：sessionId 必须为非空字符串' };
    }
    return { ok: true, data: this.registry.list(sessionId) };
  }

  /**
   * 终止单个子 agent（SA-F05/SA-F06）：仅 queued/running 调 stopPort（注入抽象）；
   * 已终态幂等直接成功；stopPort 抛错重试恰一次，仍失败返回 5000 且记录保留
   * 原状态；成功后记录置 stopped（error 带原因）并联动门控。
   */
  async stop(
    sessionId: string,
    agentId: string,
    stopPort: SubagentStopPort,
  ): Promise<SubagentResult<null>> {
    if (
      typeof sessionId !== 'string' ||
      sessionId === '' ||
      typeof agentId !== 'string' ||
      agentId === ''
    ) {
      return { ok: false, code: 1001, message: '参数错误：sessionId/agentId 必须为非空字符串' };
    }
    const record = this.registry.get(sessionId, agentId);
    if (record === null) {
      return { ok: false, code: 1002, message: `子 agent 不存在: ${agentId}` };
    }
    if (isTerminalStatus(record.status)) {
      return { ok: true, data: null }; // 幂等：已终态重复终止直接成功
    }
    try {
      await stopPort.stop(sessionId, agentId);
    } catch {
      try {
        await stopPort.stop(sessionId, agentId); // 失败重试恰一次
      } catch (retryErr) {
        this.logger.warn(
          `[SubagentService] stop subagent failed after retry (session=${sessionId}, agentId=${agentId}): ${toMessage(retryErr)}`,
        );
        return { ok: false, code: 5000, message: `终止失败: ${toMessage(retryErr)}` };
      }
    }
    // 终止成功：记录置 stopped（error 带终止原因），经 ingest 触发 updated 事件与门控联动
    this.ingest(sessionId, {
      agentId,
      status: 'stopped',
      error: '已被用户终止',
      finishedAt: this.toIso(this.clock.now()),
    });
    return { ok: true, data: null };
  }

  /**
   * 级联终止编排（SA-F05 / AC-SA-016）：逐个终止会话内全部活跃（queued/running）
   * 子 agent（每个复用 stop 的重试语义），单个失败重试后仍失败记日志并保留原状态，
   * 不阻塞其余终止。终态记录不被触碰。
   */
  async stopAllActive(
    sessionId: string,
    stopPort: SubagentStopPort,
  ): Promise<SubagentResult<StopAllActiveResult>> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, code: 1001, message: '参数错误：sessionId 必须为非空字符串' };
    }
    const stopped: string[] = [];
    const failed = new Set<string>();
    // 循环内实时取活跃记录：处理过程中列表可能变化；失败者加入排除集防死循环
    for (;;) {
      const next = this.registry
        .list(sessionId)
        .find((r) => !isTerminalStatus(r.status) && !failed.has(r.agentId));
      if (next === undefined) {
        break;
      }
      const result = await this.stop(sessionId, next.agentId, stopPort);
      if (result.ok) {
        stopped.push(next.agentId);
      } else {
        failed.add(next.agentId);
      }
    }
    return { ok: true, data: { stopped, failed: [...failed] } };
  }

  /**
   * 清除已完成（SA-F03）：移除会话内全部终态记录，返回被移除的 agentId 列表；
   * 有移除时发射 subagent.removed { agentIds }，无终态时不发射（无变化）。
   */
  clearFinished(sessionId: string): SubagentResult<string[]> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, code: 1001, message: '参数错误：sessionId 必须为非空字符串' };
    }
    const removed = this.registry.removeFinished(sessionId);
    if (removed.length > 0) {
      this.sink.emit(sessionId, 'subagent.removed', { agentIds: removed });
    }
    return { ok: true, data: removed };
  }

  /**
   * 新一轮主轮开始（done 门控重置入口）：把门控恢复为「未结束、未发 done」，并
   * 清掉残留兜底计时器与上一轮未终态的孤儿子 agent 记录（终止失败 / 超时兜底后
   * 仍 running 的记录不再参与新一轮门控计数，经 sink 发 subagent.removed 通知
   * UI 剪枝）。使 done 按「每轮恰好一次」发射：门控标记若跨轮保留，第二轮起
   * notifyMainTurnEnd 被 doneSent 短路，done 永不发射，会话状态卡在 streaming。
   * 重复调用幂等（已是重置态无操作）；已销毁会话忽略。
   */
  notifyMainTurnStart(sessionId: string): void {
    if (sessionId === '' || this.disposedSessions.has(sessionId)) {
      return;
    }
    const gate = this.gates.get(sessionId);
    if (gate !== undefined) {
      if (!gate.mainTurnEnded && !gate.doneSent && gate.timeoutTimer === null) {
        return; // 已是重置态，幂等
      }
      this.clearTimeoutTimer(gate);
      gate.mainTurnEnded = false;
      gate.doneSent = false;
    } else {
      // 首轮：新建门控即重置态（仍需走下方孤儿清理）
      this.gates.set(sessionId, { mainTurnEnded: false, doneSent: false, timeoutTimer: null });
    }
    // 上一轮遗留的未终态孤儿记录移出注册表并通知 UI 剪枝（不发 subagent.updated）
    const orphanIds = this.registry.removeActive(sessionId);
    if (orphanIds.length > 0) {
      this.sink.emit(sessionId, 'subagent.removed', { agentIds: orphanIds });
    }
  }

  /**
   * 主轮结束信号（done 门控入口，SA-F02）：计数=0 立即发 done（恰好一次）；
   * 计数>0 延迟，并启动超时兜底计时。重复调用幂等（不重发 done、不重复计时）。
   */
  notifyMainTurnEnd(sessionId: string): void {
    if (sessionId === '' || this.disposedSessions.has(sessionId)) {
      return;
    }
    let gate = this.gates.get(sessionId);
    if (gate === undefined) {
      gate = { mainTurnEnded: false, doneSent: false, timeoutTimer: null };
      this.gates.set(sessionId, gate);
    }
    if (gate.doneSent) {
      return; // done 恰好一次
    }
    gate.mainTurnEnded = true;
    if (this.registry.activeCount(sessionId) === 0) {
      this.sendDone(sessionId);
    } else if (gate.timeoutTimer === null) {
      this.startTimeoutTimer(sessionId, gate); // 计数>0 延迟，启动兜底计时
    }
  }

  /**
   * 主轮看门狗强制放行（SA-F02 兜底补充）：主轮结束信号整体丢失（如 pi 侧 run
   * 生命周期异常导致适配器 prompt 永不返回，notifyMainTurnEnd 永远不会到达）时，
   * 由上层在无活动窗口到期后调用。直接置门控为已结束并发 done（幂等：已发过则
   * 忽略）；已销毁会话忽略。与 notifyMainTurnEnd 共享「每会话恰好一次」语义。
   */
  forceDone(sessionId: string): void {
    if (sessionId === '' || this.disposedSessions.has(sessionId)) {
      return;
    }
    let gate = this.gates.get(sessionId);
    if (gate === undefined) {
      gate = { mainTurnEnded: false, doneSent: false, timeoutTimer: null };
      this.gates.set(sessionId, gate);
    }
    gate.mainTurnEnded = true;
    this.sendDone(sessionId);
  }

  /**
   * 会话删除清理（SA-F07 / AC-SA-022）：清内存态、清计时器、标记已销毁（迟到
   * ingest 与门控信号丢弃不报错不重建）；重复调用幂等。
   */
  disposeSession(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return;
    }
    const gate = this.gates.get(sessionId);
    if (gate !== undefined) {
      this.clearTimeoutTimer(gate);
      this.gates.delete(sessionId);
    }
    this.registry.clearSession(sessionId);
    this.disposedSessions.add(sessionId);
  }

  /** 发 done（conversation.statusChanged { status: 'done' }），每会话恰好一次 */
  private sendDone(sessionId: string): void {
    const gate = this.gates.get(sessionId);
    if (gate === undefined || gate.doneSent) {
      return;
    }
    gate.doneSent = true;
    this.clearTimeoutTimer(gate);
    this.sink.emit(sessionId, 'conversation.statusChanged', { status: 'done' });
  }

  /** 启动超时兜底计时（仅主轮结束且计数>0 时调用） */
  private startTimeoutTimer(sessionId: string, gate: GateState): void {
    gate.timeoutTimer = this.clock.setTimeout(() => {
      gate.timeoutTimer = null;
      this.onGateTimeout(sessionId);
    }, this.timeoutMs);
  }

  /** 重置兜底计时（窗口内任意子 agent 事件触发） */
  private restartTimeoutTimer(sessionId: string, gate: GateState): void {
    this.clearTimeoutTimer(gate);
    this.startTimeoutTimer(sessionId, gate);
  }

  private clearTimeoutTimer(gate: GateState): void {
    if (gate.timeoutTimer !== null) {
      this.clock.clearTimeout(gate.timeoutTimer);
      gate.timeoutTimer = null;
    }
  }

  /** 兜底到期：记兜底日志并发 done（仅放行一次，迟到的门控回调幂等忽略） */
  private onGateTimeout(sessionId: string): void {
    const gate = this.gates.get(sessionId);
    if (gate === undefined || gate.doneSent) {
      return;
    }
    this.logger.warn(
      `[SubagentService] subagent done gate timeout fallback (session=${sessionId}, timeoutMs=${this.timeoutMs})`,
    );
    this.sendDone(sessionId);
  }

  private toIso(ms: number): string {
    return new Date(ms).toISOString();
  }
}
