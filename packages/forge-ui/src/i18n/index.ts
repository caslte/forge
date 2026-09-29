/**
 * 模块 08 UI 国际化核心（PRD：docs/prd/08_ui_i18n.md）。
 *
 * 设计要点（TD-I18N-01/02/03/05）：
 * - 自研轻量 composable，零新依赖；zh-CN 字典键集为类型基准，en 允许缺键（回退 zh）。
 * - 偏好三态 zh-CN|en|system 持久化在 localStorage['forge.locale']；system 按
 *   navigator.language 前缀判定生效语言（zh* → zh-CN，其余 → en）。
 * - 多窗口同步走 `storage` 事件（其他窗口写入触发；同值回环忽略）。
 * - 异常降级：localStorage 不可用 → 内存态；非法存储值 → 视同 system；
 *   缺键 → zh-CN → 原样返回键名 + console.warn。界面永不空白。
 */
import { computed, ref } from 'vue';

import { zhCN, type MessageKey } from './zh-CN.ts';
import { en } from './en.ts';

export type { MessageKey };
export type LocalePreference = 'zh-CN' | 'en' | 'system';
export type ActiveLocale = 'zh-CN' | 'en';

const STORAGE_KEY = 'forge.locale';

export interface I18nRuntimeEnv {
  readStored(): string | null;
  writeStored(value: string): void;
  systemLanguage(): string;
}

/** 缺省运行环境：浏览器/Electron 渲染进程；测试可注入替身 */
const defaultEnv: I18nRuntimeEnv = {
  readStored() {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  writeStored(value) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value);
    } catch {
      /* 隐私模式/禁用存储：内存态生效本次会话（F01 异常边界） */
    }
  },
  systemLanguage() {
    return typeof navigator !== 'undefined' ? String(navigator.language ?? '') : '';
  },
};

function normalizePreference(raw: string | null | undefined): LocalePreference {
  return raw === 'zh-CN' || raw === 'en' || raw === 'system' ? raw : 'system';
}

export function detectSystemLocale(language: string): ActiveLocale {
  // 无法判定（空/缺失）回退源语言 zh-CN：保证 node 单测与异常环境行为稳定
  return language.trim().toLowerCase().startsWith('zh') ? 'zh-CN' : language ? 'en' : 'zh-CN';
}

export function createI18n(env: I18nRuntimeEnv = defaultEnv) {
  const preference = ref<LocalePreference>(normalizePreference(env.readStored()));

  const activeLocale = computed<ActiveLocale>(() =>
    preference.value === 'system' ? detectSystemLocale(env.systemLanguage()) : preference.value,
  );

  const warned = new Set<string>();

  function t(key: MessageKey, params?: Record<string, string | number>): string {
    const dict = activeLocale.value === 'en' ? en : zhCN;
    let text: string | undefined = (dict as Partial<Record<MessageKey, string>>)[key];
    if (text === undefined && activeLocale.value !== 'zh-CN') {
      text = zhCN[key];
    }
    if (text === undefined) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(`[i18n] missing key "${key}" in both en and zh-CN dictionaries`);
      }
      return key;
    }
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  }

  function setPreference(next: LocalePreference): void {
    preference.value = next;
    env.writeStored(next);
  }

  /** 其他窗口写入 localStorage 时同步本窗口偏好（F04） */
  function onStorageEvent(event: { key?: string | null; newValue?: string | null }): void {
    if (event.key !== STORAGE_KEY) return;
    const next = normalizePreference(event.newValue);
    if (next !== preference.value) {
      preference.value = next;
    }
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('storage', onStorageEvent as EventListener);
  }

  return {
    preference,
    activeLocale,
    t,
    setPreference,
    onStorageEvent,
  };
}

/** 应用级单例（main.ts 与各组件共享） */
export const i18n = createI18n();

export function useI18n() {
  return {
    t: i18n.t,
    preference: i18n.preference,
    activeLocale: i18n.activeLocale,
    setPreference: i18n.setPreference,
  };
}
