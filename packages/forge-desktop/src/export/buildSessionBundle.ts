/**
 * 会话导出包构建（SM-S08）。
 *
 * 包内容**只有一份**：`transcript.jsonl` —— 磁盘原生转录，**逐字节原样**进包。
 * 不trim / 不去空行 / 不重排 / 不改写 —— TD-SM-06 的硬约束：转录里含 AI 思考链、
 * 被上下文压缩折叠掉的早期上下文、工具调用原始入参，这些是接手 agent 重建决策的唯一
 * 来源，经界面显示链路裁剪后不可恢复。
 *
 * **为什么不再另加一份 meta**：会话身份信息本来就在原生首行里
 * （`{type:'session', version, id, timestamp, cwd}`），模型/思考级别在紧随其后的
 * `model_change` / `thinking_level_change` 行里。再平行造一份元信息既是冗余，
 * 又引入"两处描述同一事实、以后必然漂移"的维护债。参考 deepseek harness 的导出
 * 也印证这点：那份同样只有 JSONL，没有额外的 meta 文件。
 *
 * 刻意**不含**：图片/附件实体（转录里是内嵌编码，抽出来只会让包体翻倍且无人消费）、
 * 项目源码（敏感 + 体积不可控）。
 *
 * 失败即中止且**不留任何残件**（AC-SM-039）：读盘在打包之前完成，写盘是最后一步，
 * 中途抛错不会在目标路径留下半个文件去误导接手方。
 */

import fs from 'node:fs';
import { buildZip } from './zipWriter.ts';

/** 包内条目名（唯一一份内容，不含目录层级） */
export const TRANSCRIPT_ENTRY_NAME = 'transcript.jsonl';

export type ExportFailureReason =
  | 'session-not-found'
  | 'transcript-missing'
  | 'transcript-unreadable'
  | 'target-unwritable';

export type ExportResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: ExportFailureReason };

/** 注入依赖：主进程从 core 拿（测试可传假值） */
export interface ExportDeps {
  /**
   * 会话 id → 磁盘转录路径；undefined = 无磁盘历史。
   * 必须是 core 的 resolveSessionFile（含 free-workspace 回落），另写一份会把
   * 「自由会话移入项目后继续对话」判成记录不存在。
   */
  resolveSessionFile: (sessionId: string) => string | undefined;
}

/**
 * 构建并落盘会话导出包。
 *
 * 顺序刻意是「读盘 → 打包 → 一次写盘」：写盘是最后一步且只发生一次，
 * 因此中途任何失败都不会在目标路径留下残缺文件（AC-SM-039）。
 */
export function exportSessionBundle(
  sessionId: string,
  targetPath: string,
  deps: ExportDeps,
): ExportResult {
  const file = deps.resolveSessionFile(sessionId);
  if (file === undefined) return { ok: false, reason: 'session-not-found' };

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT 与 EACCES 对用户是同一件事：读不出来
    return { ok: false, reason: code === 'ENOENT' ? 'transcript-missing' : 'transcript-unreadable' };
  }

  let zip: Buffer;
  try {
    zip = buildZip([{ name: TRANSCRIPT_ENTRY_NAME, data: Buffer.from(raw, 'utf8') }]).buffer;
  } catch {
    return { ok: false, reason: 'transcript-unreadable' };
  }

  try {
    fs.writeFileSync(targetPath, zip);
  } catch {
    return { ok: false, reason: 'target-unwritable' };
  }
  return { ok: true, bytes: zip.length };
}