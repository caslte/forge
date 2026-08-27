import { randomUUID } from 'node:crypto';

import type { PiSessionAdapter as ForgePiSessionAdapter } from '@forge/core';

export class PiSessionAdapter implements ForgePiSessionAdapter {
  createSession(_projectPath: string): Promise<string> {
    return Promise.resolve(randomUUID());
  }

  stopSession(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  deleteSession(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }
}
