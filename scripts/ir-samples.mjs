#!/usr/bin/env node
/**
 * 阶段 1 采样通道 CLI：pi 会话转录（JSONL） → IrSample[] → 首次通过率报告。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ir-samples.mjs
 *   node --experimental-strip-types scripts/ir-samples.mjs --sessions <dir> [--sessions <dir>...]
 *   node --experimental-strip-types scripts/ir-samples.mjs --model mx/MiniMax-M3.1-Flash-Preview
 *   node --experimental-strip-types scripts/ir-samples.mjs --dump tmp/ir-samples.json
 *
 * 为什么是 CLI 而不是 UI：阶段 1 的验收是**一次性、可归档**的动作，产出要能贴进
 * 会话或存档复核。CLI + 纯文本报告最直接，不必先建一套界面。
 *
 * 纪律提醒：本脚本只做「读取已有真实对话」。它**不生成**任何样本——
 * 自造样本是自证，不是验证（见 src/canvasIrStats/irPassRate.ts 头注）。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  extractIrSamples,
  guessSessionRoots,
} from '../packages/forge-desktop/src/canvasIrStats/extractIrSamples.ts';
import {
  formatPassRateReport,
  reportSamples,
} from '../packages/forge-desktop/src/canvasIrStats/irPassRate.ts';

function parseArgs(argv) {
  const opts = { sessions: [], model: undefined, idPrefix: undefined, dump: undefined, allAttempts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sessions') opts.sessions.push(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--id-prefix') opts.idPrefix = argv[++i];
    else if (a === '--dump') opts.dump = argv[++i];
    else if (a === '--all-attempts') opts.allAttempts = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else {
      console.error(`未知参数：${a}`);
      opts.help = true;
    }
  }
  return opts;
}

const HELP = `阶段 1 IR 采样通道 —— 从真实对话转录统计首次通过率

  --sessions <dir>    转录文件或目录，可重复；缺省自动探测本机 sessions 根
  --model <m>         只统计该模型（匹配 provider/model 或裸 model）
  --id-prefix <p>     样本 id 前缀，便于区分批次
  --all-attempts      不只看首次产出，把修复轮也算进分母（默认只看首次）
  --dump <file>       把抽到的样本原文写成 JSON，便于归档复核
  -h, --help          显示本帮助
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const roots = opts.sessions.length > 0 ? opts.sessions : guessSessionRoots();
if (roots.length === 0) {
  console.error('没找到任何 sessions 目录。请用 --sessions <dir> 显式指定。');
  console.error('生产默认位置：<userData>/agent/sessions，Windows 即 %APPDATA%\\@forge\\desktop\\agent\\sessions');
  process.exit(2);
}

const report = extractIrSamples(roots, {
  model: opts.model,
  idPrefix: opts.idPrefix,
  firstAttemptOnly: !opts.allAttempts,
});

console.log('扫描根目录：');
for (const r of roots) console.log('  - ' + r);
console.log('转录文件：' + report.files.length + ' 个');
if (report.badLines > 0) console.log('解析失败行：' + report.badLines + ' 行（已跳过）');
if (report.skippedRepairs > 0) console.log('跳过的修复轮：' + report.skippedRepairs + ' 条（首轮口径）');
if (report.repairedOpeners > 0) {
  console.log('修好的围栏开口：' + report.repairedOpeners + ' 条（思考标记漏进 ```canvas-ir 开口行，已按生产同一规则拼回）');
  console.log('  ↑ 这些样本本身合格、照常进分母；计数单列是为了让「无 IR 围栏」这个数字不再单独撒谎。');
}
if (report.filesWithoutIr.length > 0) {
  console.log('无 IR 围栏的文件：' + report.filesWithoutIr.length + ' 个');
}
console.log('');

if (report.samples.length === 0) {
  console.error('一条 IR 样本都没有。');
  console.error('注意：这通常不是脚本的问题，而是**还没有真实 IR 产出**——');
  console.error('即真实对话里从未触发过 ```canvas-ir 围栏。阶段 1 无法验收。');
  process.exit(3);
}

console.log(formatPassRateReport(reportSamples(report.samples)));

if (opts.dump) {
  const out = path.resolve(opts.dump);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report.samples, null, 2), 'utf8');
  console.log('');
  console.log('样本已归档：' + out);
}
