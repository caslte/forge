/**
 * CE-S11 提交历史 · 纯逻辑单测（PRD 12 §3.7，对应 docs/test/12_code_explorer/unit.md
 * 的 U-CE-03 / U-CE-13 / U-CE-14）。
 *
 * 只测纯函数：头像派生、筛选、日期分组。不挂载组件、不 mock git。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarOf,
  filterCommits,
  groupCommitsByDay,
  dayLabel,
  dayLabelSpec,
  relativeTimeOf,
  relativeTimeSpec,
  absoluteTimeOf,
} from '../src/utils/gitHistory.ts';
// 直接引合并字典（不经 i18n/index.ts）：后者 import vue，纯逻辑单测不该拖进 Vue 运行时。
// i18n.test.ts 已覆盖「合并字典 key 集合一致」，这里只查新增时间 key 两侧都在。
import { zhCN } from '../src/i18n/zh-CN.ts';
import { en } from '../src/i18n/en.ts';

// 契约口径：epoch **秒**
const NOW = Math.floor(new Date('2026-10-08T14:00:00+08:00').getTime() / 1000);
const NOW_YEAR = new Date(NOW * 1000).getFullYear();

/* ==================== U-CE-03 头像派生 ==================== */

test('avatarOf：中文名取**首字（姓氏）**，王工/李工/陈默三者可区分', () => {
  // 反例固化：取末字会让「王工」「李工」双双得到「工」，两人在列表里长得完全一样，
  // 恰好毁掉「按作者视觉成串」的设计意图（原型实测踩过）。
  const wang = avatarOf('王工', 'ligang@kibo.com.cn');
  const li = avatarOf('李工', 'lihua@kibo.com.cn');
  const chen = avatarOf('陈默', 'chenmo@kibo.com.cn');
  assert.equal(wang.initial, '王');
  assert.equal(li.initial, '李');
  assert.equal(chen.initial, '陈');
  const initials = new Set([wang.initial, li.initial, chen.initial]);
  assert.equal(initials.size, 3, '三个中文名的头像首字必须两两不同');
});

test('avatarOf：西文取首字母并大写', () => {
  assert.equal(avatarOf('John Doe', 'jd@x.com').initial, 'J');
  assert.equal(avatarOf('ada', 'a@x.com').initial, 'A');
});

test('avatarOf：同 email 色相稳定，不同 email 有区分度', () => {
  const a1 = avatarOf('陈默', 'chenmo@kibo.com.cn');
  const a2 = avatarOf('陈默', 'chenmo@kibo.com.cn');
  assert.equal(a1.hue, a2.hue, '同 email 必须同色（同一作者视觉成串）');
  const hues = new Set(
    ['chenmo@kibo.com.cn', 'ligang@kibo.com.cn', 'lihua@kibo.com.cn'].map((e) => avatarOf('x', e).hue),
  );
  assert.equal(hues.size, 3, '三个作者应有不同色相');
});

test('avatarOf：色相在 0~360 内且为整数（可直接喂给 oklch）', () => {
  for (const email of ['a@b.com', 'chenmo@kibo.com.cn', '李工@例子.中国', '']) {
    const { hue } = avatarOf('x', email);
    assert.equal(Number.isInteger(hue), true, `hue 必须是整数：${email}`);
    assert.ok(hue >= 0 && hue < 360, `hue 越界：${hue}`);
  }
});

test('avatarOf：空名/单字名不抛错', () => {
  assert.equal(typeof avatarOf('', 'a@b.com').initial, 'string');
  assert.equal(avatarOf('陈', 'a@b.com').initial, '陈');
});

/* ==================== U-CE-13 筛选 ==================== */

const COMMITS = [
  { shortSha: 'aaaaaaa', subject: 'feat: 新增历史面板', authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn', authoredAt: NOW - 3600 },
  { shortSha: 'bbbbbbb', subject: 'fix: 修复合并提交显示', authorName: '王工', authorEmail: 'ligang@kibo.com.cn', authoredAt: NOW - 7200 },
  { shortSha: 'ccccccc', subject: 'docs: 补充文档', authorName: '李工', authorEmail: 'lihua@kibo.com.cn', authoredAt: NOW - 86400 },
];

test('filterCommits：按作者姓名过滤（大小写不敏感）', () => {
  assert.equal(filterCommits(COMMITS, '陈默').length, 1);
  assert.equal(filterCommits(COMMITS, '王工').length, 1);
  assert.equal(filterCommits(COMMITS, '李工').length, 1);
});

test('filterCommits：按说明子串过滤', () => {
  assert.equal(filterCommits(COMMITS, '合并').length, 1);
  assert.equal(filterCommits(COMMITS, 'feat').length, 1);
});

test('filterCommits：按 email 局部片段过滤', () => {
  assert.equal(filterCommits(COMMITS, 'kibo').length, 3);
  assert.equal(filterCommits(COMMITS, 'ligang').length, 1);
});

test('filterCommits：空查询返回全量，无匹配返回空数组（非 null）', () => {
  assert.equal(filterCommits(COMMITS, '').length, 3);
  assert.equal(filterCommits(COMMITS, '   ').length, 3);
  const none = filterCommits(COMMITS, '不存在的关键词zzz');
  assert.ok(Array.isArray(none));
  assert.equal(none.length, 0);
});

test('filterCommits：保留原顺序（不重排）', () => {
  const r = filterCommits(COMMITS, 'kibo');
  assert.deepEqual(r.map((c) => c.shortSha), ['aaaaaaa', 'bbbbbbb', 'ccccccc']);
});

/* ==================== U-CE-14 日期分组 ==================== */

test('dayLabel：今天 / 昨天 / 具体日期', () => {
  assert.equal(dayLabel(NOW, NOW), '今天');
  assert.equal(dayLabel(NOW - 86400, NOW), '昨天');
  assert.equal(dayLabel(NOW - 3 * 86400, NOW), '10 月 5 日');
});

test('dayLabelSpec：返回 i18n key 而非成串（AC-CE-031 不得硬编码语言）', () => {
  assert.deepEqual(dayLabelSpec(NOW, NOW), { key: 'code.historyDayToday' });
  assert.deepEqual(dayLabelSpec(NOW - 86400, NOW), { key: 'code.historyDayYesterday' });
  assert.deepEqual(dayLabelSpec(NOW - 3 * 86400, NOW), {
    key: 'code.historyDayMonthDay',
    params: { year: NOW_YEAR, month: 10, day: 5 },
  });
});

test('dayLabelSpec：跨年补年份 key', () => {
  const dec31 = Math.floor(new Date(NOW_YEAR - 1, 11, 31, 12, 0, 0).getTime() / 1000);
  const spec = dayLabelSpec(dec31, NOW);
  assert.equal(spec.key, 'code.historyDayFull');
  assert.equal(spec.params?.year, NOW_YEAR - 1);
});

test('相对时间 spec 与字典一致：key 在中英词典里都存在（防新增 key 漏落字典）', () => {
  // 组件用 t(spec.key) 渲染；key 不在字典里会回退成键名，界面直接露 key
  const zh = zhCN as Record<string, string>;
  const enDict = en as Record<string, string>;
  const stamps = [0, 59, 60, 3600, 86_400, 45 * 86_400];
  for (const ago of stamps) {
    for (const spec of [dayLabelSpec(NOW - ago, NOW), relativeTimeSpec(NOW - ago, NOW)]) {
      assert.ok(zh[spec.key], `zh-CN 缺 key：${spec.key}`);
      assert.ok(en[spec.key], `en 缺 key：${spec.key}`);
    }
  }
});

test('groupCommitsByDay：按天聚合并保持时间倒序', () => {
  const list = [
    { shortSha: 'a', authoredAt: NOW - 1000 },
    { shortSha: 'b', authoredAt: NOW - 2000 },
    { shortSha: 'c', authoredAt: NOW - 86400 },
  ];
  const groups = groupCommitsByDay(list, NOW);
  assert.equal(groups.length, 2, '跨两天应分两组');
  assert.equal(groups[0]!.label.key, 'code.historyDayToday');
  assert.deepEqual(groups[0]!.commits.map((c: { shortSha: string }) => c.shortSha), ['a', 'b']);
  assert.deepEqual(groups[1]!.label, { key: 'code.historyDayYesterday' });
  assert.equal(groups[1]!.commits.length, 1);
});

test('groupCommitsByDay：未来时间戳不产生负数天分组', () => {
  // 后端时钟超前时 authoredAt 可能大于 now，不能归到「明天」这类不存在的标签
  const groups = groupCommitsByDay([{ shortSha: 'a', authoredAt: NOW + 10_000 }], NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label.key, 'code.historyDayToday');
});

test('groupCommitsByDay：空列表返回空数组', () => {
  assert.deepEqual(groupCommitsByDay([], NOW), []);
});
/* ==================== 时间戳单位回归（踩过的坑） ==================== */

test('时间戳入参是 epoch **秒**不是毫秒（曾整片显示成 1970 年）', () => {
  // 1791438623 秒 = 2026-10-08。若被当成毫秒，new Date(1791438623) 落在 1970-01-22
  const sec = 1791438623;
  assert.equal(dayLabel(sec, sec + 3600), '今天');
  assert.equal(relativeTimeOf(sec, sec + 3600), '1 小时前');
  assert.equal(relativeTimeOf(sec, sec + 60), '1 分钟前');
  assert.equal(relativeTimeOf(sec, sec + 2 * 86400), '2 天前');
  // 绝对时间的年份应是 2026，不是 1970
  assert.ok(absoluteTimeOf(sec).startsWith('2026/'), `实际：${absoluteTimeOf(sec)}`);
});

test('时间戳单位回归同样落在 spec 出口上（秒口径，不是毫秒）', () => {
  const sec = 1791438623;
  assert.deepEqual(dayLabelSpec(sec, sec + 3600), { key: 'code.historyDayToday' });
  assert.deepEqual(relativeTimeSpec(sec, sec + 3600), { key: 'code.historyTimeHours', params: { count: 1 } });
  assert.deepEqual(relativeTimeSpec(sec, sec + 60), { key: 'code.historyTimeMinutes', params: { count: 1 } });
  assert.deepEqual(relativeTimeSpec(sec, sec + 2 * 86400), { key: 'code.historyTimeDays', params: { count: 2 } });
});

test('分组在秒口径下也正确（毫秒口径会全落进同一天）', () => {
  const sec = 1791438623;
  const groups = groupCommitsByDay([{ shortSha: 'a', authoredAt: sec }], sec + 3600);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label.key, 'code.historyDayToday');
});
