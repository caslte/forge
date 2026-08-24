import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ConversationMessage } from '@forge/core';

export interface PiAgentSessionLease<TSession> {
  session: TSession;
  dispose: () => void;
}

export interface PiAgentSessionFactoryOptions {
  cwd?: string;
  model?: string;
}

export type PiAgentSessionFactory<TSession = AgentSession> = (
  options: PiAgentSessionFactoryOptions,
) => Promise<PiAgentSessionLease<TSession>>;

interface SessionCallbacks {
  onDelta: (text: string) => void;
  onMessage: (message: ConversationMessage) => void;
}

type MinimalPiEvent = {
  type: string;
  delta?: string;
  message?: { role?: string; content?: string };
  assistantMessageEvent?: { delta?: string };
};

type MinimalPiSession = {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
};

export class PiConversationAdapter {
  private readonly leases = new Map<string, PiAgentSessionLease<MinimalPiSession>>();
  private readonly callbacks = new Map<string, SessionCallbacks>();
  private readonly partialContent = new Map<string, string>();

  private readonly factory: PiAgentSessionFactory<MinimalPiSession>;

  constructor(factory: PiAgentSessionFactory<MinimalPiSession>) {
    this.factory = factory;
  }

  onDelta(sessionId: string, listener: (text: string) => void): void {
    this.callbacks.set(sessionId, {
      ...(this.callbacks.get(sessionId) ?? { onMessage: () => undefined }),
      onDelta: listener,
    });
  }

  onMessage(sessionId: string, listener: (message: ConversationMessage) => void): void {
    this.callbacks.set(sessionId, {
      ...(this.callbacks.get(sessionId) ?? { onDelta: () => undefined }),
      onMessage: listener,
    });
  }

  getPartialContent(sessionId: string): string {
    return this.partialContent.get(sessionId) ?? '';
  }

  async sendMessage(
    sessionId: string,
    content: string,
    options: PiAgentSessionFactoryOptions = {},
  ): Promise<void> {
    const lease = await this.factory(options);
    this.leases.set(sessionId, lease);
    this.partialContent.set(sessionId, '');
    if (!this.callbacks.has(sessionId)) {
      this.callbacks.set(sessionId, {
        onDelta: () => undefined,
        onMessage: () => undefined,
      });
    }
    lease.session.subscribe((event) => this.handleEvent(sessionId, event));
    await lease.session.prompt(content);
  }

  async cancelStream(sessionId: string): Promise<void> {
    await this.leases.get(sessionId)?.session.abort();
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    const content = this.partialContent.get(sessionId);
    if (!content) return [];
    return [{ role: 'assistant', content, ts: new Date().toISOString() }];
  }

  private handleEvent(sessionId: string, rawEvent: unknown): void {
    const event = rawEvent as MinimalPiEvent;
    const callback = this.callbacks.get(sessionId);
    if (!callback) return;

    const delta =
      event.type === 'message_update'
        ? event.assistantMessageEvent?.delta ?? event.delta
        : undefined;

    if (typeof delta === 'string') {
      this.partialContent.set(sessionId, `${this.partialContent.get(sessionId) ?? ''}${delta}`);
      callback.onDelta(delta);
      return;
    }

    if (
      event.type === 'message_end' &&
      event.message?.role === 'assistant' &&
      typeof event.message.content === 'string'
    ) {
      this.partialContent.set(sessionId, event.message.content);
      callback.onMessage({
        role: 'assistant',
        content: event.message.content,
        ts: new Date().toISOString(),
      });
    }
  }
}
