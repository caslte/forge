/**
 * IR 卡片的主题变量口径（2026-10-10 真机 bug 修复，两轮）。
 *
 * ## 两轮 bug 的完整链条（都要锁住，缺一不可）
 *
 * 第一轮：`--c-*` 只存在于 iframe 内部（canvas 围栏由 buildCanvasDocument 注入
 * srcdoc），IrCanvasBlock 用 v-html 把 SVG 直插宿主 DOM ⇒ 宿主没有这组变量 ⇒
 * SVG 的 fill/stroke 全部解析失败 ⇒ 整卡白板。
 *
 * 第二轮：修法用了 `:style="irCardRootStyle()"`，而该函数返回的是**完整 CSS 规则串**
 * （`.ir-card{...}`）。**Vue 的 :style 期望内联声明串**，带选择器的规则串被整段忽略
 * ⇒ 变量仍然没注入 ⇒ 真机仍白板。当时单测还断言「以 .ir-card { 开头」——
 * 测试把错误设计锁成了"正确"，绿灯是假象。
 *
 * 最终形态：变量定义直接写进组件 scoped style（静态、无 JS），
 * 本文件作为映射表的单一事实来源供单测断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IR_CARD_CSS_VARS,
  irCardVarsDeclaration,
} from '../src/utils/irCardTheme.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('变量表覆盖 IR 编译产物用到的全部语义色', () => {
  // canvasIrRender.ts 的 KIND_STYLE 用到的必须全在
  for (const k of ['--c-bg', '--c-fg', '--c-border', '--c-ok', '--c-warn', '--c-bad',
                    '--c-ok-bg', '--c-warn-bg', '--c-bad-bg', '--c-muted-fg', '--c-surface']) {
    assert.ok(k in IR_CARD_CSS_VARS, '变量表缺：' + k);
  }
});

test('语义色全部走 var()，无硬编码（深浅色适配的前提）', () => {
  for (const [name, value] of Object.entries(IR_CARD_CSS_VARS)) {
    assert.ok(value.includes('var(--'), name + ' 必须引用基础令牌，实测：' + value);
    assert.ok(!/^#[0-9a-fA-F]{3,8}$/.test(value), name + ' 不得是硬编码色');
  }
});

test('声明串形态正确：无选择器无花括号（:style 唯一能接受的形态）', () => {
  const s = irCardVarsDeclaration();
  // 第二轮 bug 的直接断言：绝不能再返回带选择器的 CSS 规则串
  assert.ok(!s.includes('{'), '声明串不得含花括号（那是 CSS 规则，:style 会整段忽略）');
  assert.ok(!s.includes('.ir-card'), '声明串不得含选择器');
  assert.ok(s.startsWith('--c-bg:'), '应以变量声明开头');
  assert.ok(s.includes(';'), '多条声明用分号分隔');
});

test('组件 scoped style 里的变量定义与映射表一致（防两处漂移）', () => {
  const vue = readFileSync(
    join(here, '../src/components/IrCanvasBlock.vue'), 'utf-8');
  for (const [name, value] of Object.entries(IR_CARD_CSS_VARS)) {
    // scoped style 里应出现「name: value;」形式的定义（允许空白差异）
    const re = new RegExp(name.replace(/-/g, '\\-') + '\\s*:\\s*' +
      value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.ok(re.test(vue), '组件 CSS 缺少或偏离映射：' + name + ' → ' + value);
  }
});

test('组件不再用 :style 绑定 CSS 规则串（第二轮 bug 的回归锁）', () => {
  const vue = readFileSync(
    join(here, '../src/components/IrCanvasBlock.vue'), 'utf-8');
  assert.ok(!vue.includes(':style="cardStyle"'),
    '不得再用 :style 绑定规则串——那正是第二轮白板的根因');
  // 只拦代码引用（import 与调用），注释里对历史的记述不拦
  const code = vue.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!code.includes('irCardRootStyle'),
    'irCardRootStyle 已删除，组件代码不得再引用');
});
