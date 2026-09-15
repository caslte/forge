/**
 * 子 agent 执行过程输出文件（wu-06 v1.1，PRD 06 SA-F04）。
 *
 * pi-subagents 扩展把每个子 agent 的完整执行过程实时写入任务输出文件
 * （output-file.js 约定，forge 只读）：
 *   {tmpdir}/pi-subagents-{uid}/{encodeCwd(cwd)}/{piSessionId}/tasks/{agentId}.output
 * - uid：Windows 无 process.getuid，扩展回退 0 → "pi-subagents-0"
 * - piSessionId = "forge-<forgeSessionId>"（createPiAgentSessionFactory 同规则）
 * - encodeCwd：路径分隔符 → "-"、去 Windows 盘符前缀、去前导 "-"
 *
 * forge 不写该文件、不解析其格式，只做只读 tail（UTF-8 边界安全）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 单次读取的过程尾部上限：64KB（PRD 06 SA-F04 性能上限） */
export const SUBAGENT_OUTPUT_TAIL_BYTES = 64 * 1024;

/** 复刻 pi-subagents output-file.js 的 encodeCwd（路径推导需与扩展逐字节一致） */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, '-')
    .replace(/^[A-Za-z]:-/, '')
    .replace(/^-+/, '');
}

/**
 * 单个会话的子 agent 输出目录：`{tmpdir}/pi-subagents-{uid}/{encodeCwd(cwd)}/forge-{sessionId}`。
 * 会话删除时整目录移除（其下 `tasks/*.output` 属于该会话，一并清掉）。
 */
export function resolveSubagentOutputDir(projectCwd: string, forgeSessionId: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `pi-subagents-${uid}`, encodeCwd(projectCwd), `forge-${forgeSessionId}`);
}

/** 子 agent 执行过程输出文件路径（只读；文件由扩展创建与写入） */
export function resolveSubagentOutputFile(
  projectCwd: string,
  forgeSessionId: string,
  agentId: string,
): string {
  return path.join(resolveSubagentOutputDir(projectCwd, forgeSessionId), 'tasks', `${agentId}.output`);
}

export interface SubagentOutputTail {
  exists: boolean;
  size: number;
  chunk: string;
}

/**
 * 读取文件尾部至多 maxBytes 字节并按 UTF-8 解码。
 * 文件不存在返回 { exists: false }；读取竞态（扩展正在写）按空内容返回不报错。
 */
export function readTail(filePath: string, maxBytes: number): SubagentOutputTail {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { exists: false, size: 0, chunk: '' };
  }
  const start = Math.max(0, stat.size - maxBytes);
  let buf: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(stat.size - start);
      if (buf.length > 0) {
        const read = fs.readSync(fd, buf, 0, buf.length, start);
        buf = buf.subarray(0, read);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exists: true, size: stat.size, chunk: '' };
  }
  // 多字节边界：tail 起点可能落在多字节 UTF-8 序列中间，跳过开头的
  // continuation byte（10xxxxxx，至多 3 个）再解码，避免首字符乱码
  let offset = 0;
  while (offset < buf.length && offset < 3 && (buf[offset]! & 0xc0) === 0x80) {
    offset += 1;
  }
  return { exists: true, size: stat.size, chunk: buf.subarray(offset).toString('utf8') };
}
