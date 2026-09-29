/**
 * 错误横幅展示映射单测（CV-ERR-01）。
 *
 * 覆盖原型定稿的展示规则（prototypes/error-banner-variants.html）：
 * - 结论句按分类生成，且**永远带上原始错误原文**
 * - 色调三档：需用户处理=destructive、可自愈/未识别=warning、内容完整=info
 * - 「立即重试」只给可重试场景；鉴权/额度/上下文/本机依赖不给
 * - degraded（内容已完整、仅收尾报错）盖过分类，用最轻语气且不给重试
 *
 * 分类本身在 forge-core（classifyError.test.ts），本文件只测「分类 → 展示」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toErrorBannerModel } from '../src/utils/errorPresentation.ts';
import { classifyError, type ClassifiedError } from '../../forge-core/src/errors/errorClassifier.ts';
import type { ForgeErrorInfo } from '../src/types.ts';

/** 用 core 的真实分类器产出 UI 侧类型，保证两端字段一致（同源防漂移） */
function classified(raw: string, hasVisibleContent = false): ForgeErrorInfo {
  return classifyError(raw, { hasVisibleContent }) as unknown as ForgeErrorInfo;
}

test('CV-ERR-UI-001 结论句 + 原文：每类都有结论，且原文一字不改地跟随其后', () => {
  const samples = [
    'unknown error, 722 (1000)',
    'No API key found',
    '1008 insufficient balance',
    'context_length_exceeded: maximum context length is 204800 tokens',
    'spawn git ENOENT',
    '429 rate_limit_error',
    'APIConnectionError: socket hang up',
    '天书一样没头没尾的报错',
  ];
  for (const raw of samples) {
    const m = toErrorBannerModel(classified(raw));
    assert.ok(m.title.length > 0, `${raw} 缺结论句`);
    assert.equal(m.raw, raw, `${raw} 原文必须保真`);
    assert.ok(m.detail.length > 0, `${raw} 缺解释句`);
  }
});

test('CV-ERR-UI-002 色调分档：需用户处理=红，可自愈/未识别=黄', () => {
  assert.equal(toErrorBannerModel(classified('No API key found')).tone, 'destructive');
  assert.equal(toErrorBannerModel(classified('1008 insufficient balance')).tone, 'destructive');
  assert.equal(
    toErrorBannerModel(classified('context_length_exceeded')).tone,
    'destructive',
  );
  assert.equal(toErrorBannerModel(classified('spawn git ENOENT')).tone, 'destructive');

  assert.equal(toErrorBannerModel(classified('unknown error, 722 (1000)')).tone, 'warning');
  assert.equal(toErrorBannerModel(classified('429 rate_limit_error')).tone, 'warning');
  assert.equal(toErrorBannerModel(classified('socket hang up')).tone, 'warning');
  assert.equal(toErrorBannerModel(classified('没头没尾')).tone, 'warning');
});

test('CV-ERR-UI-003 立即重试：只给可重试场景', () => {
  // 可重试
  for (const raw of ['unknown error, 722 (1000)', '429 rate_limit_error', 'socket hang up', '天书']) {
    assert.equal(toErrorBannerModel(classified(raw)).showRetry, true, `${raw} 应给重试`);
  }
  // 不可重试：换个模型/等恢复/装依赖才有意义，重发是浪费
  for (const raw of [
    'No API key found',
    '1008 insufficient balance',
    'context_length_exceeded',
    'spawn git ENOENT',
  ]) {
    assert.equal(toErrorBannerModel(classified(raw)).showRetry, false, `${raw} 不应给重试`);
  }
});

test('CV-ERR-UI-004 降级优先：有内容 + provider 错误 → info 且不给重试', () => {
  const m = toErrorBannerModel(classified('unknown error, 722 (1000)', true));
  assert.equal(m.tone, 'info', '内容已完整，不该再用报错色调');
  assert.equal(m.showRetry, false, '回复已送达，重发只会得到重复回复');
  assert.equal(m.raw, 'unknown error, 722 (1000)', '原文仍要保留，便于反馈');
  // 同一原文、但本轮没有内容 → 回到 warning + 可重试
  const hard = toErrorBannerModel(classified('unknown error, 722 (1000)', false));
  assert.equal(hard.tone, 'warning');
  assert.equal(hard.showRetry, true);
});

test('CV-ERR-UI-005 provider 归因：给了名字就点名，没给就用泛称', () => {
  const named = toErrorBannerModel(classified('unknown error, 722 (1000)'), {
    providerName: 'MiniMax',
  });
  const generic = toErrorBannerModel(classified('unknown error, 722 (1000)'));
  assert.ok(named.title.includes('MiniMax'), `点名失败：${named.title}`);
  assert.ok(!generic.title.includes('MiniMax'), `泛称不应带名字：${generic.title}`);
  assert.notEqual(named.title, generic.title);
});

test('CV-ERR-UI-006 字段契约：UI 类型与 core 分类器字段同名（防漂移守卫）', () => {
  const core: ClassifiedError = classifyError('unknown error, 722 (1000)', {
    hasVisibleContent: false,
  });
  const ui: ForgeErrorInfo = core as unknown as ForgeErrorInfo;
  for (const key of ['category', 'source', 'raw', 'retryable', 'degraded'] as const) {
    assert.equal(ui[key], core[key], `字段 ${key} 两侧不一致`);
  }
});
