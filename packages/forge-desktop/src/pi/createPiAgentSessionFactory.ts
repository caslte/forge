import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';

import type {
  MinimalPiSession,
  PiAgentSessionFactoryOptions,
} from './piConversationAdapter.ts';
import { resolvePiModel } from './piModelResolver.ts';

export interface PiSessionHandle {
  sessionFile: string | undefined;
}

export interface CreatePiAgentSessionFactoryOptions {
  agentDir?: string;
  /** pi models.json 路径（默认 ~/.pi/agent/models.json），用于模型字符串解析 */
  modelsPath?: string;
}

type PiAgentSessionRuntimeFactory = (
  request: FactoryOptions,
) => Promise<{
  session: AgentSession & { setThinkingLevel(level: string): Promise<void> };
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

    // P1-C：模型字符串解析为 pi Model 后注入新会话；解析失败抛稳定错误
    const createOptions: CreateAgentSessionOptions = {
      agentDir: options.agentDir,
      cwd,
      sessionManager: manager,
    };
    if (typeof request.model === 'string') {
      createOptions.model = await resolvePiModel(request.model, options.modelsPath);
    } else if (request.model !== undefined) {
      createOptions.model = request.model as CreateAgentSessionOptions['model'];
    }
    // MP-S05：创建会话时应用生效思考级别（pi 内部按模型能力 clamp 就近收敛）
    if (typeof request.thinkingLevel === 'string' && request.thinkingLevel !== '') {
      createOptions.thinkingLevel = request.thinkingLevel as CreateAgentSessionOptions['thinkingLevel'];
    }

    const result = await createAgentSession(createOptions);

    // 真实 AgentSession.setThinkingLevel 为同步方法，而上层合约（MinimalPiSession）
    // 需要 async 形式的思考级别设置；用 Proxy 仅包装该方法为 Promise，其余能力
    // （prompt/subscribe/abort/setModel/getContextUsage/compact/modelRuntime 等）原样委托。
    const rawSession = result.session;
    const session = new Proxy(rawSession, {
      get(target, prop, receiver) {
        if (prop === 'setThinkingLevel') {
          return (level: string) => {
            target.setThinkingLevel(level as AgentSession['thinkingLevel']);
            return Promise.resolve();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AgentSession & { setThinkingLevel(level: string): Promise<void> };

    return {
      session,
      dispose: () => rawSession.dispose(),
      handle: {
        get sessionFile() {
          return rawSession.sessionFile;
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
