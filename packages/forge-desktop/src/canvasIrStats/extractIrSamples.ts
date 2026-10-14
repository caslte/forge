/**
 * 从 pi 会话转录（JSONL）抽取真实 IR 样本 —— 阶段 1 的采样通道。
 *
 * 为什么需要它：`irPassRate.ts` 是纯分析工具，不负责采样；而阶段 1 的纪律是
 * 「样本必须来自真实对话，不可自造」（见 `irPassRate.ts` 头注与
 * `docs/plan/canvas-ir-stage1-test-design.md` §三）。此前数据源（JSONL）与判定器
 * （`reportSamples`）两端都在，中间这段「转录 → IrSample[]」不存在，P0 门禁因此
 * 无法执行。本模块补上这一段。
 *
 * 数据形态（实测自 `%APPDATA%\@forge\desktop\agent\sessions\*\forge-*.jsonl`）：
 *   每行一个 JSON，`type` ∈ `session` | `model_change` | `thinking_level_change` | `message`
 *   `message` 行 = `{ type:'message', id, parentId, timestamp,
 *                     message:{ role, content: string | [{type,text}], provider?, model? } }`
 *
 * 围栏语法**不在此处重新实现**：复用 `canvasIr` 的 `extractIrFences`（以及开口修复
 * `repairIrFenceOpeners`），保持单一事实来源。否则采样口径与生产渲染口径会悄悄分叉，
 * 算出来的通过率就不代表线上真实表现。
 *
 * 首次通过率的口径：**每个用户请求只取第一次产出**。模型被回执打回后重新产出的那些
 * 属于修复轮，计入分母会把通过率系统性算低（这正是 `irPassRate.ts` 强调「分母不是
 * 进入修复的样本数」要防的错）。被跳过的修复轮数在报告里单列，便于对账。
 */
import fs from 'node:fs';
import path from 'node:path';

import { IR_RETRY_TAG } from '@forge/extensions';
import { extractIrFences, repairIrFenceOpeners } from '@forge/core/markdown';

import type { IrSample } from './irPassRate.ts';

/** 转录文件名形态（piSessionPaths：`forge-{sessionId}.jsonl`；前缀把 forge 会话与 pi CLI 原生会话区分开）。 */
const TRANSCRIPT_RE = /^forge-[A-Za-z0-9._-]+\.jsonl$/;

export interface ExtractOptions {
  /** 只保留该模型产出的样本，匹配 `${provider}/${model}` 或裸 `model`。 */
  model?: string;
  /** id 前缀，便于区分批次（同一批采样在报告里可辨识来源）。 */
  idPrefix?: string;
  /** 每个用户请求只取第一次产出。默认 true（首次通过率的正确口径）。 */
  firstAttemptOnly?: boolean;
  /** prompt 截断长度，避免报告里塞进整段长文。默认 1000。 */
  promptMaxChars?: number;
}

/** 单文件抽取结果。 */
export interface ExtractFileResult {
  samples: IrSample[];
  /** 解析失败的行数。损坏转录不应让整次采样失败——静默跳过并计数。 */
  badLines: number;
  /** 含 canvas-ir 围栏的 assistant 消息数（含修复轮，用于对账）。 */
  fenceMessages: number;
  /** 因 firstAttemptOnly 被跳过的修复轮数量。 */
  skippedRepairs: number;
  /**
   * 围栏开口行被思考标记劈开、由 repairIrFenceOpeners 修回来的消息数。
   *
   * 为什么单列：修好之后这条样本是**合格的**，该进分母；但「模型输出曾被传输层
   * 破坏过」这件事本身必须可见——否则下一次损坏若修不动（标记落在 JSON 体内），
   * 样本会被当成「模型没画」静默丢弃，报告上看不出任何迹象。有这个计数，
   * 「0 条围栏」就不再能单独撒谎。
   */
  repairedOpeners: number;
}

/** 多文件汇总结果。 */
export interface ExtractReport extends Omit<ExtractFileResult, 'samples'> {
  samples: IrSample[];
  /** 实际扫描的转录文件（已去重）。 */
  files: string[];
  /**
   * 扫过但一条 IR 围栏都没有的文件。
   * 这一项专门用来回答「是不是根本没触发」——如果它等于 files.length，
   * 说明还没有真实 IR 产出，采样无从谈起（而不是脚本坏了）。
   */
  filesWithoutIr: string[];
}

interface JsonLine {
  type?: string;
  id?: string;
  timestamp?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
  };
}

/** content 取正文：字符串原样，parts 数组拼 text 段（与 loadPiSessionHistory 口径一致）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (p !== null && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
      parts.push((p as { text: string }).text);
    }
  }
  return parts.join('\n');
}

/** `provider/model`（无 provider 时退化为裸 model），供 byModel 分组用。 */
function modelKey(provider: unknown, model: unknown): string | undefined {
  if (typeof model !== 'string' || model === '') return undefined;
  return typeof provider === 'string' && provider !== '' ? `${provider}/${model}` : model;
}

/**
 * 递归找出 root 下所有 forge 转录文件。
 * root 可以是单个文件、会话目录（含多个 encoded-cwd 子目录）或 sessions 根。
 * 路径不存在/不可读一律返回空数组，不抛错——采样工具不该因为目录缺失而炸。
 */
export function findTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (TRANSCRIPT_RE.test(path.basename(p))) out.push(p);
      return;
    }
    if (!st.isDirectory()) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const e of entries) walk(path.join(p, e));
  };
  walk(root);
  return out.sort();
}

/** 抽取单个转录文件。 */
export function extractFromTranscript(
  file: string,
  options: ExtractOptions = {},
): ExtractFileResult {
  const firstOnly = options.firstAttemptOnly !== false;
  const promptMax = options.promptMaxChars ?? 1000;
  const sessionId = path.basename(file).replace(/\.jsonl$/, '');

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { samples: [], badLines: 0, fenceMessages: 0, skippedRepairs: 0, repairedOpeners: 0 };
  }

  const samples: IrSample[] = [];
  let badLines = 0;
  let fenceMessages = 0;
  let skippedRepairs = 0;
  let repairedOpeners = 0;
  let currentModel: string | undefined;
  let lastPrompt = '';
  let takenThisRequest = false;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let entry: JsonLine;
    try {
      entry = JSON.parse(line) as JsonLine;
    } catch {
      badLines++;
      continue;
    }

    if (entry.type === 'model_change') {
      currentModel = modelKey(entry.provider, entry.modelId);
      continue;
    }
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg || typeof msg.role !== 'string') continue;

    if (msg.role === 'user') {
      const text = textOf(msg.content);
      // 修复回执是**以用户消息身份回灌的**（见 canvasIrRepair/extension.ts 的
      // IR_RETRY_TAG），但用户并没有提出新请求。若不识别，每一轮修复都会被当成
      // 一个新的「首轮」，于是：
      //   1. 分母被修复产物灌水 —— 26 次对话抽出 33 个样本，多出来的正是修复轮；
      //   2. 修复产物若通过，会被算成一次「首轮通过」，把通过率算高。
      // 两侧都错且方向相反，净效果取决于模型是修好了还是越修越坏。
      // 判定用内容自证（与扩展自身的防循环口径一致），不依赖任何会话内状态。
      if (text.startsWith(IR_RETRY_TAG)) {
        // 不回填 lastPrompt：回执不是用户意图，摊进报告只会误导人工回看。
        // 也不重置 takenThisRequest —— 修复产物由下方 fence 分支计入 skippedRepairs。
        continue;
      }
      lastPrompt = text.slice(0, promptMax);
      // 新请求 → 重置「首次」计数：上一个请求的修复轮不再影响这一个
      takenThisRequest = false;
      continue;
    }
    if (msg.role !== 'assistant') continue;

    // 先修围栏开口（思考标记漏进行内会劈开 ```canvas-ir，见 canvasIrRepairOpeners 注释），
    // 再走生产同一个 extractIrFences——采样口径因此与线上渲染口径保持同一条修复链。
    const rawText = textOf(msg.content);
    const text = repairIrFenceOpeners(rawText);
    if (text !== rawText) repairedOpeners++;
    const fences = extractIrFences(text);
    if (fences.length === 0) continue;
    fenceMessages++;

    if (firstOnly && takenThisRequest) {
      skippedRepairs += fences.length;
      continue;
    }
    takenThisRequest = true;

    // 模型优先取消息自带的（逐条准确），回退到最近一次 model_change
    const model = modelKey(msg.provider, msg.model) ?? currentModel;
    fences.forEach((source, i) => {
      const suffix = fences.length > 1 ? `#${i + 1}` : '';
      const id = `${options.idPrefix ? `${options.idPrefix}-` : ''}${sessionId}:${entry.id ?? 'msg'}${suffix}`;
      samples.push({ id, prompt: lastPrompt, source, model });
    });
  }

  return { samples, badLines, fenceMessages, skippedRepairs, repairedOpeners };
}

/**
 * 汇总抽取多个路径（文件或目录）。
 * `model` 过滤在汇总阶段做——避免在单文件循环里过滤时误把「被过滤掉的首轮」
 * 当成不存在，从而错误地把后续修复轮认作首轮。
 */
export function extractIrSamples(
  paths: readonly string[],
  options: ExtractOptions = {},
): ExtractReport {
  const found: string[] = [];
  for (const p of paths) found.push(...findTranscripts(p));
  const files = Array.from(new Set(found));

  const samples: IrSample[] = [];
  const filesWithoutIr: string[] = [];
  let badLines = 0;
  let fenceMessages = 0;
  let skippedRepairs = 0;
  let repairedOpeners = 0;

  for (const f of files) {
    const r = extractFromTranscript(f, options);
    if (r.fenceMessages === 0) filesWithoutIr.push(f);
    samples.push(...r.samples);
    badLines += r.badLines;
    fenceMessages += r.fenceMessages;
    skippedRepairs += r.skippedRepairs;
    repairedOpeners += r.repairedOpeners;
  }

  const filtered = options.model ? samples.filter((s) => s.model === options.model) : samples;
  return { samples: filtered, files, filesWithoutIr, badLines, fenceMessages, skippedRepairs, repairedOpeners };
}

/**
 * 猜测本机 pi sessions 根目录（只返回实际存在的候选）。
 *
 * 生产 agentDir = `<userData>/agent`（`main.ts` 注入），故 sessions 根 = 其下 `sessions/`。
 * 这里按平台列候选而非硬编码单一路径：采样工具常被在 dev 机上跑，dev 回退根
 * （`~/.pi/agent/sessions`）也要能命中。
 */
export function guessSessionRoots(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const candidates: string[] = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, '@forge', 'desktop', 'agent', 'sessions'));
  }
  if (home) {
    candidates.push(
      path.join(home, 'Library', 'Application Support', '@forge', 'desktop', 'agent', 'sessions'),
    );
    candidates.push(path.join(home, '.config', '@forge', 'desktop', 'agent', 'sessions'));
    candidates.push(path.join(home, '.pi', 'agent', 'sessions'));
  }
  return candidates.filter((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  });
}
