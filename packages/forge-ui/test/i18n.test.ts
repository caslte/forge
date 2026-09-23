/**
 * 模块 08 i18n 核心单测（AC-08-01~04 + F04 storage 同步）。
 *
 * 运行方式：node --test（type stripping 直跑 .ts）。
 * createI18n 注入替身 env（node 无 localStorage/navigator），storage 事件路径
 * 直接调用 onStorageEvent 模拟跨窗口写入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';

import { createI18n, detectSystemLocale, type I18nRuntimeEnv } from '../src/i18n/index.ts';
import { zhCN } from '../src/i18n/zh-CN.ts';
import type { MessageKey } from '../src/i18n/zh-CN.ts';

function fakeEnv(initial: string | null = null, lang = 'en-US') {
  const store = { value: initial };
  const env: I18nRuntimeEnv & { written: string[] } = {
    written: [],
    readStored: () => store.value,
    writeStored: (v) => {
      store.value = v;
      env.written.push(v);
    },
    systemLanguage: () => lang,
  };
  return env;
}

test('AC-08-03 system 判定：zh 前缀（含 zh-TW/zh-HK）归 zh-CN；en 等归 en；空值回退源语言 zh-CN', () => {
  assert.equal(detectSystemLocale('zh-CN'), 'zh-CN');
  assert.equal(detectSystemLocale('zh-TW'), 'zh-CN');
  assert.equal(detectSystemLocale('zh-HK'), 'zh-CN');
  assert.equal(detectSystemLocale('ZH-cn'), 'zh-CN');
  assert.equal(detectSystemLocale('en-US'), 'en');
  assert.equal(detectSystemLocale(''), 'zh-CN');
  assert.equal(detectSystemLocale('  ja-JP'), 'en');
});

test('AC-08-01 t() 双语取值与 {n} 插值', () => {
  const i18n = createI18n(fakeEnv('zh-CN'));
  assert.equal(i18n.t('common.delete'), '删除');
  i18n.setPreference('en');
  assert.equal(i18n.t('common.delete'), 'Delete');

  (zhCN as Record<string, string>)['test.greet'] = '你好，{name}（{n} 条）';
  const key = 'test.greet' as MessageKey;
  const i18n2 = createI18n(fakeEnv('zh-CN'));
  assert.equal(i18n2.t(key, { name: 'forge', n: 3 }), '你好，forge（3 条）');
  assert.equal(i18n2.t(key, { name: 'x' }), '你好，x（{n} 条）', '缺参占位符原样保留');
  delete (zhCN as Record<string, string>)['test.greet'];
});

test('AC-08-01 en 缺键回退 zh-CN', () => {
  const env = fakeEnv('en');
  const i18n = createI18n(env);
  assert.equal(i18n.t('common.cancel'), 'Cancel');
  // settings.language.en 双语同值；构造仅 zh 有的键验证回退
  (zhCN as Record<string, string>)['test.zhOnly'] = '仅中文';
  const key = 'test.zhOnly' as MessageKey;
  const i18n2 = createI18n(fakeEnv('en'));
  assert.equal(i18n2.t(key), '仅中文');
  delete (zhCN as Record<string, string>)['test.zhOnly'];
});

test('AC-08-02 未知键原样返回且 warn 一次', () => {
  const i18n = createI18n(fakeEnv('en'));
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const unknown = 'no.such.key' as MessageKey;
    assert.equal(i18n.t(unknown), 'no.such.key');
    assert.equal(i18n.t(unknown), 'no.such.key');
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});

test('F01 非法存储值视同 system；setPreference 持久化', () => {
  const env = fakeEnv('garbage-value');
  const i18n = createI18n(env);
  assert.equal(i18n.preference.value, 'system');
  assert.equal(i18n.activeLocale.value, 'en'); // env lang=en-US
  i18n.setPreference('zh-CN');
  assert.equal(i18n.activeLocale.value, 'zh-CN');
  assert.deepEqual(env.written, ['zh-CN']);
});

test('AC-08-11/F04 storage 事件跨窗口同步（同值忽略、他键忽略）', () => {
  const i18n = createI18n(fakeEnv('zh-CN'));
  i18n.onStorageEvent({ key: 'forge.locale', newValue: 'en' });
  assert.equal(i18n.preference.value, 'en');
  assert.equal(i18n.activeLocale.value, 'en');
  const before = i18n.preference.value;
  i18n.onStorageEvent({ key: 'forge.locale', newValue: 'en' });
  assert.equal(i18n.preference.value, before);
  i18n.onStorageEvent({ key: 'other', newValue: 'zh-CN' });
  assert.equal(i18n.preference.value, 'en', '他键事件不改偏好');
  i18n.onStorageEvent({ key: 'forge.locale', newValue: '!!' });
  assert.equal(i18n.preference.value, 'system', '非法值归一为 system');
});

test('切换 preference 后 activeLocale 响应式更新（computed 重算）', async () => {
  const i18n = createI18n(fakeEnv('system', 'zh-CN'));
  assert.equal(i18n.activeLocale.value, 'zh-CN');
  i18n.setPreference('en');
  await nextTick();
  assert.equal(i18n.activeLocale.value, 'en');
});
