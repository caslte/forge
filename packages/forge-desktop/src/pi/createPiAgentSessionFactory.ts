import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { createAgentSession, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';

import type { PiAgentSessionFactoryOptions } from './piConversationAdapter.ts';

export interface PiSessionHandle {
  sessionFile: string | undefined;
}

export interface CreatePiAgentSessionFactoryOptions {
  agentDir?: string;
}

type PiAgentSessionRuntimeFactory = (
  request: FactoryOptions,
) => Promise<{
  session: AgentSession;
  dispose: () => void;
}>;

interface FactoryOptions extends PiAgentSessionFactoryOptions {
  sessionId?: string;
}

export function createPiAgentSessionFactory(
  options: CreatePiAgentSessionFactoryOptions = {},
): PiAgentSessionRuntimeFactory {
  const factory: PiAgentSessionRuntimeFactory = async (request) => {
    const cwd = request.cwd ?? process.cwd();
    const sessionDir = getDefaultSessionDir(cwd, options.agentDir);
    const forgeSessionId = assertValidSessionId(
      request.sessionId ?? crypto.randomUUID().replace(/-/g, ''),
    );
    const piSessionId = `forge-${forgeSessionId}`;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(piSessionId)) {
      throw new Error(`非法 pi 会话 ID: ${piSessionId}`);
    }

    const sessionFile = path.join(sessionDir, `${piSessionId}.jsonl`);
    const manager = fs.existsSync(sessionFile)
      ? SessionManager.open(sessionFile, sessionDir)
      : SessionManager.create(cwd, sessionDir);
    if (!fs.existsSync(sessionFile)) {
      const header = {
        type: 'session',
        version: 3,
        id: piSessionId,
        timestamp: new Date().toISOString(),
        cwd,
      };
      fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf8');
      manager.setSessionFile(sessionFile);
    }
    if (!fs.existsSync(sessionFile)) {
      const header = {
        type: 'session',
        version: 3,
        id: piSessionId,
        timestamp: new Date().toISOString(),
        cwd,
      };
      fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf8');
    }
    manager.setSessionFile(sessionFile);

    const result = await createAgentSession({
      agentDir: options.agentDir,
      cwd,
      sessionManager: manager,
    });

    return {
      session: result.session,
      dispose: () => result.session.dispose(),
      handle: {
        get sessionFile() {
          return result.session.sessionFile;
        },
      },
    };
  };

  return factory;
}

function getDefaultSessionDir(cwd: string, agentDir?: string): string {
  const root = agentDir ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.pi', 'agent');
  return path.join(root, 'sessions', encodeURIComponent(cwd));
}

function assertValidSessionId(sessionId?: string): string {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`非法 forge 会话 ID: ${sessionId ?? '(空)'}`);
  }
  return sessionId;
}
