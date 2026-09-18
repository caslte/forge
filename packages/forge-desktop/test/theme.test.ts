/**
 * 窗口底色主题镜像（theme.ts）单测。
 *
 * 覆盖两类不变量：
 * 1. 读/写/容错语义：缺文件/损坏/非法取值一律回 light（不能因镜像坏了就让启动失败）；
 *    写入必须原子（不留 .tmp 残骸）。
 * 2. **底色与设计令牌同源**：THEME_BACKGROUND 是硬编码 hex，而 forge-ui 的
 *    design-tokens.css 才是 --background 的事实来源。两者一旦漂移，主进程建窗底色与
 *    splash 底色就会差一档，交接口可见色阶跳变。故本测试直接从 CSS 解析 oklch 令牌、
 *    自己换算成 sRGB 再比对——改令牌不改 hex 会立刻红（反向亦然）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THEME,
  THEME_BACKGROUND,
  backgroundFor,
  isThemeMode,
  readThemeSync,
  themeFilePath,
  writeTheme,
} from '../src/theme.ts';
import * as contract from '../src/ipc-contract.ts';

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 每个用例独立临时目录（userData 的替身），避免用例间串味 */
function makeUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-theme-test-'));
}

// ---------- oklch → sRGB hex（只为断言用；与浏览器 canvas 的取色口径数学等价） ----------

/** oklch(L C H) → #rrggbb。实现照 OKLab 官方矩阵，最后做 sRGB gamma 编码。 */
function oklchToHex(l: number, c: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lc = l_ ** 3;
  const mc = m_ ** 3;
  const sc = s_ ** 3;
  const linear = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
  const bytes = linear.map((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  });
  return `#${bytes.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 从 design-tokens.css 取某主题档的 `--background` 原始值 */
function readBackgroundToken(css: string, theme: 'light' | 'dark'): string {
  const from = theme === 'dark' ? css.indexOf("data-theme='dark'") : 0;
  assert.notEqual(from, -1, `design-tokens.css 未找到 ${theme} 档（data-theme='dark' 缺失）`);
  const m = /--background:\s*([^;]+);/.exec(css.slice(from));
  assert.ok(m, `design-tokens.css 的 ${theme} 档未声明 --background`);
  return m[1]!.trim();
}

/** 'oklch(0.26 0.006 286.2)' → '#242427'（含容差比较，容忍不同实现的末位舍入） */
function tokenToHex(raw: string, theme: string): string {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(raw);
  assert.ok(m, `${theme} 档 --background 不是纯 oklch(L C H) 字面量（读到 "${raw}"）——` +
    '本测试的换算只支持该形式，改令牌写法时请同步更新 theme.ts 与该断言');
  return oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 逐通道比较（±1：不同 oklch→sRGB 实现的末位舍入差） */
function assertSameHex(actual: string, expected: string, label: string): void {
  const parse = (hex: string): number[] =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [parse(actual), parse(expected)];
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(a[i]! - b[i]!) <= 1,
      `${label} 不一致：theme.ts=${actual} vs design-tokens.css→sRGB=${expected}`,
    );
  }
}

// ---------- 用例 ----------

test('缺省与容错：文件缺失 / JSON 损坏 / 取值非法 / mode 类型错 一律回 light', () => {
  assert.equal(DEFAULT_THEME, 'light');

  // 1) 文件不存在（首次启动）
  const fresh = makeUserDataDir();
  assert.equal(readThemeSync(fresh), 'light');

  // 2) 目录都不存在（userData 尚未创建）
  assert.equal(readThemeSync(path.join(fresh, 'not-created-yet')), 'light');

  // 3) 半截 JSON（模拟非原子写的后果——正因如此才要原子写）
  const broken = makeUserDataDir();
  fs.writeFileSync(themeFilePath(broken), '{ "mode": "da', 'utf8');
  assert.equal(readThemeSync(broken), 'light');

  // 4) 合法 JSON 但取值非法（旧版本残留 / 手工改坏）
  const invalid = makeUserDataDir();
  fs.writeFileSync(themeFilePath(invalid), JSON.stringify({ mode: 'solarized' }), 'utf8');
  assert.equal(readThemeSync(invalid), 'light');

  // 5) 合法 JSON 但 mode 不是字符串
  const wrongType = makeUserDataDir();
  fs.writeFileSync(themeFilePath(wrongType), JSON.stringify({ mode: 1 }), 'utf8');
  assert.equal(readThemeSync(wrongType), 'light');
});

test('写读往返：light/dark 均能原样读回，且写入是原子的（不留 .tmp）', () => {
  const dir = makeUserDataDir();
  for (const mode of ['dark', 'light'] as const) {
    assert.equal(writeTheme(dir, mode), true);
    assert.equal(readThemeSync(dir), mode);
    assert.equal(
      fs.existsSync(`${themeFilePath(dir)}.tmp`),
      false,
      '写入后不应残留 .tmp（应已 rename 成正式文件）',
    );
  }
  // 落盘内容是带 mode 字段的 JSON（人可读、可手工排查）
  assert.equal(JSON.parse(fs.readFileSync(themeFilePath(dir), 'utf8')).mode, 'light');
});

test('isThemeMode 守卫只放行 light/dark（IPC 载荷不可信）', () => {
  assert.equal(isThemeMode('light'), true);
  assert.equal(isThemeMode('dark'), true);
  assert.equal(isThemeMode('Dark'), false);
  assert.equal(isThemeMode(''), false);
  assert.equal(isThemeMode(null), false);
  assert.equal(isThemeMode(undefined), false);
  assert.equal(isThemeMode(0), false);
  assert.equal(isThemeMode({ mode: 'dark' }), false);
});

test('建窗底色：与 forge-ui design-tokens.css 的 --background 同源（改令牌不改 hex 即红）', () => {
  const cssPath = path.resolve(desktopRoot, '../forge-ui/src/design-tokens.css');
  assert.equal(fs.existsSync(cssPath), true, `design-tokens.css 不存在: ${cssPath}`);
  const css = fs.readFileSync(cssPath, 'utf8');

  for (const theme of ['light', 'dark'] as const) {
    assertSameHex(
      THEME_BACKGROUND[theme],
      tokenToHex(readBackgroundToken(css, theme), theme),
      `${theme} 档建窗底色`,
    );
  }
  // 两档必须真不同：否则暗色主题下建窗仍是亮底（本次要修的现象）
  assert.notEqual(THEME_BACKGROUND.light, THEME_BACKGROUND.dark);
  assert.equal(backgroundFor('dark'), THEME_BACKGROUND.dark);
});

test('IPC 通道名唯一：forge:theme:set 不与既有通道撞名', () => {
  assert.equal(contract.IPC_THEME_SET, 'forge:theme:set');
  const channels = Object.entries(contract)
    .filter(([k, v]) => k.startsWith('IPC_') && typeof v === 'string')
    .map(([k, v]) => [k, v as string] as const);
  assert.ok(channels.length > 10, '未枚举到 IPC 通道，契约模块结构可能变了');
  const seen = new Map<string, string>();
  for (const [key, value] of channels) {
    const prev = seen.get(value);
    assert.equal(prev, undefined, `通道名重复：${key} 与 ${prev} 同为 ${value}`);
    seen.set(value, key);
  }
});
