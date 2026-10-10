/**
 * IR 产出通过率统计（阶段 1 的验收工具）。
 *
 * 为什么需要它：阶段 1 的唯一任务是回答「模型能否稳定产出合规 IR」。
 * 没有客观计数就只能靠印象拍板——那正是本项目反复出现的自证陷阱
 * （见 MEMORY「验证闭环 / TaskLedger 方向」：模型自述通过率不算数）。
 *
 * 数据从哪来：真实对话中模型产出的 ```canvas-ir 围栏内容，逐条喂给 judgeIr。
 * **绝不可由本项目自己扮演模型生成样本**——那是自证，不是验证。
 */

import { judgeIr, type IrCode, type IrJudgement } from '@forge/core/markdown';

/** 一条样本 = 一次真实对话里模型产出的 IR 原文。 */
export interface IrSample {
  /** 采样标识，仅用于追溯是哪次对话。 */
  id: string;
  /** 用户原始请求（中文，用于人工回看失败原因时定位上下文）。 */
  prompt: string;
  /** 模型产出的 IR 围栏内容（已剥掉围栏标记）。 */
  source: string;
  /** 该次对话用的模型标识。分模型统计才能定位「是不是某模型格外不稳」。 */
  model?: string;
}

/** 阶段 1 的出口门槛（用户与分析稿共同确认）。 */
export const STAGE1_PASS_THRESHOLD = 0.8;

export interface IrSampleReport {
  sample: IrSample;
  judgement: IrJudgement;
}

export interface IrPassRateReport {
  total: number;
  passed: number;
  /** 首次通过率。注意：分母是总样本数，不是「进入修复的样本数」。 */
  firstPassRate: number;
  verdict: 'pass' | 'fail';
  /** 各缺陷码出现次数，用于定位「模型最容易犯哪个错」。 */
  codeHistogram: Record<string, number>;
  /** 按模型分组统计。 */
  byModel: Record<string, { total: number; passed: number; rate: number }>;
  perSample: IrSampleReport[];
  /** 门槛线，供UI 画参考位。 */
  threshold: number;
}

/** 逐条判定。不做提前退出——失败样本也要进报告，供人工回看。 */
export function reportSamples(samples: readonly IrSample[]): IrPassRateReport {
  const perSample: IrSampleReport[] = samples.map((sample) => ({
    sample,
    judgement: judgeIr(sample.source),
  }));

  const passed = perSample.filter((r) => r.judgement.verdict === 'ok').length;
  const firstPassRate = samples.length === 0 ? 0 : passed / samples.length;

  const codeHistogram: Record<string, number> = {};
  for (const r of perSample) {
    for (const d of r.judgement.diagnostics) {
      codeHistogram[d.code] = (codeHistogram[d.code] ?? 0) + 1;
    }
  }

  const byModel: Record<string, { total: number; passed: number; rate: number }> = {};
  for (const r of perSample) {
    const key = r.sample.model ?? '(未标注)';
    const bucket = byModel[key] ?? { total: 0, passed: 0, rate: 0 };
    bucket.total += 1;
    if (r.judgement.verdict === 'ok') bucket.passed += 1;
    byModel[key] = bucket;
  }
  for (const k of Object.keys(byModel)) {
    const bucket = byModel[k]!;
    bucket.rate = bucket.total === 0 ? 0 : bucket.passed / bucket.total;
  }

  return {
    total: samples.length,
    passed,
    firstPassRate,
    verdict: firstPassRate >= STAGE1_PASS_THRESHOLD ? 'pass' : 'fail',
    codeHistogram,
    byModel,
    perSample,
    threshold: STAGE1_PASS_THRESHOLD,
  };
}

/** 渲染成可直接贴进会话的报告文本。刻意可读，便于人工复核而非只看数字。 */
export function formatPassRateReport(r: IrPassRateReport): string {
  const pct = (x: number) => (x * 100).toFixed(0) + '%';
  const lines: string[] = [
    'IR 首次通过率：' + r.passed + '/' + r.total + ' = ' + pct(r.firstPassRate),
    '门槛 ' + pct(r.threshold) + ' → 阶段 1 结论：' + (r.verdict === 'pass' ? '通过，进入阶段 2' : '不通过，回去打磨提示词，不加功能'),
  ];
  if (Object.keys(r.byModel).length > 1) {
    lines.push('按模型：');
    for (const [m, s] of Object.entries(r.byModel)) {
      lines.push('  - ' + m + '：' + s.passed + '/' + s.total + ' = ' + pct(s.rate));
    }
  }
  const codes = Object.entries(r.codeHistogram).sort((a, b) => b[1] - a[1]);
  if (codes.length) {
    lines.push('缺陷分布（定位最常犯的错）：');
    for (const [c, n] of codes) lines.push('  - ' + c + '：' + n + ' 次');
  }
  const failed = r.perSample.filter((x) => x.judgement.verdict !== 'ok');
  if (failed.length) {
    lines.push('失败样本（供人工回看）：');
    for (const f of failed) {
      lines.push('  # ' + f.sample.id + '｜' + f.sample.prompt.slice(0, 40));
      for (const d of f.judgement.diagnostics) {
        lines.push('' + ' [' + d.code + '] ' + d.subject + ' — ' + d.evidence);
      }
    }
  }
  return lines.join('\n');
}

/** 类型导出，便于 UI 侧消费时不必依赖 forge-core 内部路径。 */
export type { IrCode };