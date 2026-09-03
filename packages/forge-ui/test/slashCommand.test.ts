/**
 * U-CV-011/012 斜杠命令基础层纯函数单测（AC-CV-026~030，
 * docs/test/03_conversation/coverage-matrix.md「扩展 CV-S08」）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例 conversationTimeline.test.ts）。
 * 覆盖输入变体（契约来源 docs/api/03_conversation.md §9「斜杠命令清单」）：
 * - 检测：首行行首 `/`；多行中间行行首 `/`；`/` 后含空格；光标在命令中间；
 *   行首非 `/`；空文本；光标在第二行（前置换行）；光标越界/负数/非整数防御；
 * - 插入：插入串 = `/` + 原始命令名 + 尾随空格，区间 [lineStart, prefixEnd) 替换；
 * - 过滤：git/GIT/skill:git/tests/推送/空串/无匹配 zzz（包含匹配：原始名或描述、大小写不敏感）；
 * - 美化：kebab/snake/camel 分段首字母大写，剥 `/` 与 `skill:` 前缀；
 * - 负向：句中 `/` 不激活；插入串不含美化名；filterCommands 不改入参；
 *   畸形名（空串、纯符号、非字符串）不抛异常、不产生 undefined/NaN。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSlashContext,
  buildInsertion,
  filterCommands,
  formatCommandLabel,
  extractCommandFromMessage,
  splitSkillRefs,
  SOURCE_LABELS,
} from '../src/utils/slashCommand.ts';

import type { SlashCommand } from '../src/bridge.ts';

/** 命令清单 fixture：三类来源 + 无描述项 + 大小写混合名（U-CV-012 前置条件） */
function fixtureCommands(): SlashCommand[] {
  return [
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    { name: 'skill:write-tests', description: null, source: 'skill' },
    { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
    { name: 'gitStatus', description: '查看工作区状态', source: 'extension' },
    { name: 'write-tests', description: '生成测试用例', source: 'prompt' },
    { name: 'compact', description: null, source: 'extension' },
  ];
}

// ===== U-CV-011：detectSlashContext（AC-CV-026 触发 / AC-CV-030 关闭） =====

test('首行行首 /：激活，filter 为 / 后至光标文本，lineStart=0，prefixEnd=光标', () => {
  // '/git-push' 长 9（/ g i t - p u s h），光标在末尾
  assert.deepEqual(detectSlashContext('/git-push', 9), {
    active: true,
    filter: 'git-push',
    lineStart: 0,
    prefixEnd: 9,
  });
});

test('仅输入 /（光标紧随其后）：激活且 filter 为空串（列全量命令）', () => {
  assert.deepEqual(detectSlashContext('/', 1), {
    active: true,
    filter: '',
    lineStart: 0,
    prefixEnd: 1,
  });
});

test('多行中间行行首 /：lineStart 指向该行行首，filter 为该行 / 后前段', () => {
  // h0 e1 l2 l3 o4 \n5 w6 o7 r8 l9 d10 \n11 /12 g13 i14 t15（长度 16）
  assert.deepEqual(detectSlashContext('hello\nworld\n/git', 16), {
    active: true,
    filter: 'git',
    lineStart: 12,
    prefixEnd: 16,
  });
});

test('光标在第二行（首行后有换行）：激活且 lineStart 在换行之后', () => {
  // h0 e1 l2 l3 o4 \n5 /6 g7 i8 t9（长度 10）
  assert.deepEqual(detectSlashContext('hello\n/git', 10), {
    active: true,
    filter: 'git',
    lineStart: 6,
    prefixEnd: 10,
  });
  // 文本以换行开头：第二行行首 /
  assert.deepEqual(detectSlashContext('\n/git', 5), {
    active: true,
    filter: 'git',
    lineStart: 1,
    prefixEnd: 5,
  });
});

test('光标在命令中间：filter 取光标前段（后段不进过滤串）', () => {
  assert.deepEqual(detectSlashContext('/git-push', 4), {
    active: true,
    filter: 'git',
    lineStart: 0,
    prefixEnd: 4,
  });
});

test('/ 与光标之间含空格：不激活（AC-CV-030 行内空格关闭）；光标仍在空格前则激活', () => {
  assert.equal(detectSlashContext('/git push', 9).active, false, '光标在空格后：不激活');
  assert.deepEqual(detectSlashContext('/git push', 4), {
    active: true,
    filter: 'git',
    lineStart: 0,
    prefixEnd: 4,
  });
});

test('行首非 /：不激活', () => {
  assert.equal(detectSlashContext('git-push', 9).active, false);
});

test('句中 /（行首是普通字符）：不激活（负向，非行首 /）', () => {
  assert.equal(detectSlashContext('hello /git', 10).active, false);
});

test('空文本：不激活且不抛异常', () => {
  assert.deepEqual(detectSlashContext('', 0), { active: false });
});

test('光标在行首 / 之前（caret 落在 / 上）：不激活（命令尚未进入光标左侧）', () => {
  assert.equal(detectSlashContext('/git', 0).active, false);
  // h0 e1 l2 l3 o4 \n5 /6 …：光标 6 正好在第二行 / 上
  assert.equal(detectSlashContext('hello\n/git', 6).active, false);
});

test('光标越界/负数/非整数/NaN：不激活（防御，不产生 NaN）', () => {
  assert.equal(detectSlashContext('/git', 100).active, false);
  assert.equal(detectSlashContext('/git', -1).active, false);
  assert.equal(detectSlashContext('/git', 1.5).active, false);
  assert.equal(detectSlashContext('/git', Number.NaN).active, false);
});

test('激活态字段良构：filter 为 string、lineStart/prefixEnd 为非负整数（无 undefined/NaN 泄漏）', () => {
  // 'hello\n/git-push' 长 15（h e l l o \n / g i t - p u s h）
  const ctx = detectSlashContext('hello\n/git-push', 15);
  assert.ok(ctx.active);
  assert.equal(typeof ctx.filter, 'string');
  assert.ok(Number.isInteger(ctx.lineStart) && ctx.lineStart >= 0);
  assert.ok(Number.isInteger(ctx.prefixEnd) && ctx.prefixEnd >= 0);
  assert.ok(ctx.lineStart < ctx.prefixEnd);
});

// ===== U-CV-011：buildInsertion（AC-CV-029 插入原始串） =====

test('buildInsertion：/ 前缀 + 原始命令名 + 尾随空格（skill: 前缀原样保留）', () => {
  assert.equal(buildInsertion('git-push'), '/git-push ');
  assert.equal(buildInsertion('skill:git-push'), '/skill:git-push ');
  assert.equal(buildInsertion('review-pr'), '/review-pr ');
});

test('buildInsertion：插入串绝不包含美化名（负向，AC-CV-029）', () => {
  const ins = buildInsertion('skill:git-push');
  assert.ok(!ins.includes('Git Push'), `插入串不得含美化名，实际 ${ins}`);
  assert.ok(!ins.includes('Skill'));
  assert.ok(!ins.includes('Push'));
  assert.equal(ins, '/skill:git-push ');
});

test('buildInsertion：空串/非字符串防御不抛异常', () => {
  assert.equal(buildInsertion(''), '/ ');
  assert.equal(buildInsertion(undefined as unknown as string), '/ ');
});

test('插入区间语义：[lineStart, prefixEnd) 替换为插入串后为完整命令行（AC-CV-029）', () => {
  const text = 'hello\n/git-pu'; // h0 e1 l2 l3 o4 \n5 /6 g7 i8 t9 -10 p11 u12（长度 13）
  const ctx = detectSlashContext(text, 13);
  assert.deepEqual(ctx, { active: true, filter: 'git-pu', lineStart: 6, prefixEnd: 13 });
  assert.ok(ctx.active);
  const next = text.slice(0, ctx.lineStart) + buildInsertion('git-push') + text.slice(ctx.prefixEnd);
  assert.equal(next, 'hello\n/git-push ');
});

// ===== U-CV-012：filterCommands（AC-CV-028 模糊过滤与空态，用户裁定：包含匹配） =====

test('过滤 git：包含匹配，名含 git 即命中（skill 前缀命令与裸名均中）', () => {
  const r = filterCommands(fixtureCommands(), 'git');
  assert.deepEqual(r.map((c) => c.name), ['skill:git-push', 'gitStatus']);
});

test('过滤 GIT：大小写不敏感（与 git 结果一致）', () => {
  const r = filterCommands(fixtureCommands(), 'GIT');
  assert.deepEqual(r.map((c) => c.name), ['skill:git-push', 'gitStatus']);
});

test('过滤 skill:git：过滤串含 skill: 前缀时按原始名包含匹配', () => {
  const r = filterCommands(fixtureCommands(), 'skill:git');
  assert.deepEqual(r.map((c) => c.name), ['skill:git-push']);
});

test('过滤中间文字：tests 命中 skill:write-tests 与 write-tests（不只前缀）', () => {
  const r = filterCommands(fixtureCommands(), 'tests');
  assert.deepEqual(r.map((c) => c.name), ['skill:write-tests', 'write-tests']);
});

test('过滤描述关键词：推送/查看 按描述命中（记不得英文名时）', () => {
  assert.deepEqual(filterCommands(fixtureCommands(), '推送').map((c) => c.name), ['skill:git-push']);
  assert.deepEqual(filterCommands(fixtureCommands(), '查看').map((c) => c.name), ['gitStatus']);
});

test('过滤空串：返回全量副本（新数组、内容一致）', () => {
  const src = fixtureCommands();
  const r = filterCommands(src, '');
  assert.equal(r.length, 6);
  assert.notEqual(r, src, '必须返回新数组（副本）');
  assert.deepEqual(r, src);
});

test('无匹配 zzz：返回空数组（空态「无匹配命令」数据源）', () => {
  assert.deepEqual(filterCommands(fixtureCommands(), 'zzz'), []);
});

test('过滤 review：只命中原始名 review-pr（不误伤 writeTests 等）', () => {
  const r = filterCommands(fixtureCommands(), 'review');
  assert.deepEqual(r.map((c) => c.name), ['review-pr']);
});

test('不把美化名当过滤匹配键（负向）：Git Push / Write Tests 均无匹配', () => {
  assert.deepEqual(filterCommands(fixtureCommands(), 'Git Push'), []);
  assert.deepEqual(filterCommands(fixtureCommands(), 'Write Tests'), []);
});

test('filterCommands 不修改入参（负向）', () => {
  const src = fixtureCommands();
  const snapshot = fixtureCommands();
  filterCommands(src, 'git');
  filterCommands(src, '');
  filterCommands(src, 'zzz');
  assert.deepEqual(src, snapshot);
});

test('filterCommands 防御：非数组入参返回空数组不抛异常', () => {
  assert.deepEqual(filterCommands(null as unknown as SlashCommand[], 'git'), []);
});

// ===== U-CV-012：formatCommandLabel（AC-CV-027 codex 风格美化） =====

test('kebab：git-push → Git Push', () => {
  assert.equal(formatCommandLabel('git-push'), 'Git Push');
});

test('snake：write_tests → Write Tests', () => {
  assert.equal(formatCommandLabel('write_tests'), 'Write Tests');
});

test('camel：writeTests → Write Tests', () => {
  assert.equal(formatCommandLabel('writeTests'), 'Write Tests');
});

test('review-pr → Review Pr（分段各自首字母大写）', () => {
  assert.equal(formatCommandLabel('review-pr'), 'Review Pr');
});

test('skill: 前缀剥除：skill:git-push → Git Push', () => {
  assert.equal(formatCommandLabel('skill:git-push'), 'Git Push');
});

test('/ 前缀剥除（防御）：/skill:git-push → Git Push', () => {
  assert.equal(formatCommandLabel('/skill:git-push'), 'Git Push');
});

test('畸形名：空串/纯符号/非字符串不抛异常', () => {
  assert.equal(formatCommandLabel(''), '');
  assert.equal(formatCommandLabel('skill:'), '');
  assert.equal(formatCommandLabel('/'), '');
  // 纯符号：返回原串（不产生 undefined）
  assert.equal(formatCommandLabel('---'), '---');
  assert.equal(formatCommandLabel('%%%'), '%%%');
  assert.equal(formatCommandLabel(undefined as unknown as string), '');
  assert.equal(formatCommandLabel(null as unknown as string), '');
});

test('无描述项：description null 保留（UI 副文本留空契约，AC-CV-027），显示名照常生成', () => {
  const r = filterCommands(fixtureCommands(), 'compact');
  assert.equal(r.length, 1);
  assert.equal(r[0]!.description, null, '无描述以 null 表达，副文本留空');
  assert.equal(formatCommandLabel(r[0]!.name), 'Compact');
});

// ===== 来源标签（AC-CV-027） =====

test('SOURCE_LABELS：skill→技能、extension→命令、prompt→模板', () => {
  assert.equal(SOURCE_LABELS.skill, '技能');
  assert.equal(SOURCE_LABELS.extension, '命令');
  assert.equal(SOURCE_LABELS.prompt, '模板');
});

// ===== 消息气泡命令美化（extractCommandFromMessage，用户验收修正） =====

test('气泡美化-原始串：/skill:xxx 正文 → 命令段 + rest，source=skill', () => {
  const r = extractCommandFromMessage('/skill:gen-doc-all 测试一下技能');
  assert.deepEqual(r, { name: 'skill:gen-doc-all', source: 'skill', rest: '测试一下技能' });
});

test('气泡美化-原始串：无 skill: 前缀 source=null（不渲染标签），仅命令无正文 rest 为空串', () => {
  assert.deepEqual(extractCommandFromMessage('/review-pr'), {
    name: 'review-pr',
    source: null,
    rest: '',
  });
  assert.equal(extractCommandFromMessage('/skill:git-push ')!.rest, '');
});

test('气泡美化-原始串：rest 保留换行等多行正文', () => {
  const r = extractCommandFromMessage('/skill:x 第一行\n第二行');
  assert.equal(r!.rest, '第一行\n第二行');
});

test('气泡美化-负向：普通文本/路径/句中斜杠/空串/非字符串 → null 不误伤', () => {
  assert.equal(extractCommandFromMessage('普通消息'), null);
  assert.equal(extractCommandFromMessage('/usr/bin/foo --help'), null, 'token 含 / 非命令');
  assert.equal(extractCommandFromMessage('前面有文字 /skill:x'), null, '行首非 / 不激活');
  assert.equal(extractCommandFromMessage(''), null);
  assert.equal(extractCommandFromMessage(undefined as never), null);
});

test('气泡美化-pi 展开块：<skill> 指令文档收起，只留尾部用户正文', () => {
  const expanded =
    '<skill name="gen-doc-all" location="C:\\u\\s\\SKILL.MD">\n# gen-doc-all\n指令全文...\n</skill>\n\n测试一下技能';
  const r = extractCommandFromMessage(expanded);
  assert.deepEqual(r, { name: 'gen-doc-all', source: 'skill', rest: '测试一下技能' });
  assert.equal(r!.rest.includes('指令全文'), false, '指令文档不进入展示正文');
});

test('气泡美化-pi 展开块：无尾部正文 rest 为空串；未闭合 <skill> 不误判', () => {
  const r = extractCommandFromMessage(
    '<skill name="git-push" location="C:\\x\\SKILL.md">\n内容\n</skill>',
  );
  assert.deepEqual(r, { name: 'git-push', source: 'skill', rest: '' });
  assert.equal(extractCommandFromMessage('<skill name="x" location="y">\n未闭合'), null);
});

// ===== 消息气泡正文多技能引用美化（splitSkillRefs，用户裁定：样式归 forge，执行语义归 pi） =====

test('正文切段-多个引用：/skill:name 全部切出，前后文保留', () => {
  assert.deepEqual(splitSkillRefs('拉一下 /skill:git-push 推一下 /skill:git-pull'), [
    { kind: 'text', text: '拉一下 ' },
    { kind: 'skill', text: 'git-push' },
    { kind: 'text', text: ' 推一下 ' },
    { kind: 'skill', text: 'git-pull' },
  ]);
});

test('正文切段-无引用：单 text 段；空串/非字符串 → []', () => {
  assert.deepEqual(splitSkillRefs('普通正文，没有引用'), [{ kind: 'text', text: '普通正文，没有引用' }]);
  assert.deepEqual(splitSkillRefs(''), []);
  assert.deepEqual(splitSkillRefs(undefined as never), []);
});

test('正文切段-边界：中文标点不吞名；裸 /skill: 无名不误切；连写引用逐个切', () => {
  assert.deepEqual(splitSkillRefs('用/skill:a，再用/skill:b。'), [
    { kind: 'text', text: '用' },
    { kind: 'skill', text: 'a' },
    { kind: 'text', text: '，再用' },
    { kind: 'skill', text: 'b' },
    { kind: 'text', text: '。' },
  ]);
  assert.deepEqual(splitSkillRefs('/skill: 后面没名字'), [{ kind: 'text', text: '/skill: 后面没名字' }]);
  assert.deepEqual(splitSkillRefs('连写/skill:a/skill:b'), [
    { kind: 'text', text: '连写' },
    { kind: 'skill', text: 'a' },
    { kind: 'skill', text: 'b' },
  ]);
});
