/**
 * Mock pi 适配器（forge-desktop 冒烟用假实现）。
 *
 * 让 SessionService / ConversationService 脱离真实 pi SDK 跑通全流程：
 * - MockPiSessionAdapter：createSession 返回唯一递增 id；stop/delete 记录调用且幂等
 * - MockPiConversationAdapter：sendMessage 追加 user 消息后异步产生 assistant 回复并触发
 *   onReply 回调，由主进程组装时驱动 ConversationService 状态流转与事件推送
 *
 * 仅以 `import type` 引用 @forge/core 的 adapter 接口，类型剥离后运行时不依赖
 * forge-core dist（测试可直接跑；生产运行时 forge-core 已 build 出 dist）。
 */
import type {
  PiSessionAdapter,
  PiConversationAdapter,
  ConversationMessage,
} from '@forge/core';

/** MockPiConversationAdapter 构造选项 */
export interface MockPiConversationAdapterOptions {
  /** assistant 回复延迟（毫秒，默认 300，测试可设 0） */
  replyDelayMs?: number;
  /** assistant 回复回调：主进程在此驱动 ConversationService.setStatus('done') 与 emitMessage */
  onReply?: (sessionId: string, message: ConversationMessage) => void;
}

/**
 * pi 会话适配器 mock：会话生命周期操作的内存假实现。
 * 调用记录暴露供测试断言；createSession 返回 mock-session-{n} 唯一 id。
 */
export class MockPiSessionAdapter implements PiSessionAdapter {
  createCalls: string[] = [];
  stopCalls: string[] = [];
  deleteCalls: string[] = [];
  private counter = 0;

  async createSession(projectPath: string): Promise<string> {
    this.createCalls.push(projectPath);
    this.counter += 1;
    return `mock-session-${this.counter}`;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopCalls.push(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleteCalls.push(sessionId);
  }
}

/**
 * pi 对话适配器 mock：消息历史的内存假实现。
 * sendMessage 立即追加 user 消息，按 replyDelayMs 延迟追加 assistant 回复并触发 onReply；
 * 历史按会话隔离；cancelStream 仅记录调用。
 */
export class MockPiConversationAdapter implements PiConversationAdapter {
  cancelCalls: string[] = [];
  private readonly replyDelayMs: number;
  /** assistant 回复回调：createForgeCore 构造后赋值，驱动 ConversationService 状态流转与事件推送 */
  onReply?: (sessionId: string, message: ConversationMessage) => void;
  private readonly histories: Map<string, ConversationMessage[]> = new Map();

  constructor(options: MockPiConversationAdapterOptions = {}) {
    this.replyDelayMs = options.replyDelayMs ?? 300;
    this.onReply = options.onReply;
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const history = this.getHistory(sessionId);
    history.push({ role: 'user', content, ts: new Date().toISOString() });
    const reply: ConversationMessage = {
      role: 'assistant',
      content: `（模拟回复）已收到：${content}`,
      ts: new Date().toISOString(),
    };
    setTimeout(() => {
      history.push(reply);
      this.onReply?.(sessionId, reply);
    }, this.replyDelayMs);
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    return [...this.getHistory(sessionId)];
  }

  async cancelStream(sessionId: string): Promise<string[]> {
    this.cancelCalls.push(sessionId);
    return [];
  }

  private getHistory(sessionId: string): ConversationMessage[] {
    let h = this.histories.get(sessionId);
    if (h === undefined) {
      h = [];
      this.histories.set(sessionId, h);
    }
    return h;
  }
}
