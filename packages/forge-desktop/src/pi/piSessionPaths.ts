/**
 * pi 会话磁盘路径约定（单一定义源）。
 *
 * forge 会话在 pi 侧以 **JSONL 转录文件**落盘，路径规则由 pi 的 SessionManager 固定：
 *   {agentDir}/sessions/{encodeURIComponent(cwd)}/forge-{forgeSessionId}.jsonl
 * - agentDir 生产由 main.ts 注入 <userData>/agent；未注入回退 ~/.pi/agent（仅 dev/测试）
 * - 目录名是 cwd 的 encodeURIComponent（与 pi 逐字节一致，**不能**自己拼 "-"）
 * - 文件名前缀 `forge-` 把 forge 会话与 pi CLI 原生会话（`<ts>_<uuid>.jsonl`）
 *   区分开 —— 这是 forge 删除时只删自己文件的依据，绝不碰 CLI 会话。
 *
 * 该路径此前在 createPiAgentSessionFactory（resolveAgentDir/getDefaultSessionDir）
 * 与 createForgeCore（resolveSessionFile）各写了一份。删除功能要求「建 / 读 / 删」
 * 三处逐字节一致（错一个字符 → 文件永远删不掉），故收敛到本模块。
 */
import path from 'node:path';

/** forge 会话 ID 合法字符集（createSession 产出 UUID，含 `-`） */
const FORGE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** pi 会话文件名主体（含前缀）合法形态：pi SessionManager 对文件名的约束 */
const PI_SESSION_FILE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** 解析 pi agent 目录（生产必须显式注入 <userData>/agent；未注入回退 ~/.pi/agent，仅供 dev/测试隔离） */
export function resolvePiAgentDir(agentDir?: string): string {
  return (
    agentDir ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.pi', 'agent')
  );
}

/**
 * 项目会话目录：`{agentDir}/sessions/{encodeURIComponent(cwd)}`。
 * @param cwd 项目工作目录
 * @param agentDir pi agent 目录（未注入回退见 resolvePiAgentDir；相对路径按当前进程 cwd 解析）
 */
export function resolveProjectSessionDir(cwd: string, agentDir?: string): string {
  return path.join(resolvePiAgentDir(agentDir), 'sessions', encodeURIComponent(cwd));
}

/**
 * forge 会话 ID → pi 会话 ID（加 `forge-` 前缀）。
 * 非法 ID 抛错（调用方为建会话路径，必须早失败，避免建出无法定位的文件）。
 * @throws forge 会话 ID 含非法字符，或结果不满足 pi 文件名约束
 */
export function forgePiSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || !FORGE_SESSION_ID_RE.test(sessionId)) {
    throw new Error(`非法 forge 会话 ID: ${sessionId ?? '(空)'}`);
  }
  const piSessionId = `forge-${sessionId}`;
  if (!PI_SESSION_FILE_ID_RE.test(piSessionId)) {
    throw new Error(`非法 pi 会话 ID: ${piSessionId}`);
  }
  return piSessionId;
}

/**
 * pi 会话 JSONL 完整路径（建会话用；ID 非法直接抛错）。
 * @param sessionId forge 会话 ID
 * @param cwd 项目工作目录
 * @param agentDir pi agent 目录（未注入回退见 resolvePiAgentDir）
 */
export function resolveForgeSessionFile(
  sessionId: string,
  cwd: string,
  agentDir?: string,
): string {
  return path.join(resolveProjectSessionDir(cwd, agentDir), `${forgePiSessionId(sessionId)}.jsonl`);
}

/**
 * 同 resolveForgeSessionFile，但 ID 非法时返回 null 而非抛错。
 *
 * 删除路径专用：历史脏数据（ID 含非法字符）无法推导路径，此时应当**跳过磁盘清理
 * 继续删除会话**，而不是让用户永远删不掉这个会话。注意它也顺带承担**路径越界防线**
 * ——ID 经字符集校验后才参与拼路径，杜绝 `../` 之类逃逸出 sessions 目录。
 * @returns 路径；ID 非法返回 null
 */
export function tryResolveForgeSessionFile(
  sessionId: string,
  cwd: string,
  agentDir?: string,
): string | null {
  try {
    return resolveForgeSessionFile(sessionId, cwd, agentDir);
  } catch {
    return null;
  }
}
