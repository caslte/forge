/**
 * 出图意图判据的漏网修复（2026-10-10 真机驱动）。
 *
 * ## 为什么要改
 *
 * 真机实测：用户说「梳理一下项目架构**图**」能命中，说「重新画一下」「帮我梳理一下
 * 项目**架构**」全部漏网。漏网 ⇒ 只注入常驻段 ⇒ 模型不知道 IR 长什么样 ⇒
 * 退回手写 HTML + 写文件（真机截图证实）。
 *
 * ## 为什么不加「上下文里已有图就命中」
 *
 * 想加，但**做不到**：`before_agent_start` 的 event 只有 `prompt` / `images` /
 * `systemPrompt` / `cwd` / `contextFiles` / `skills`（见 pi docs/extensions.md:536-544），
 * **不提供历史消息**。所以「用户说『重画』时上下文里一定有图」这个信号在本钩子里拿不到。
 *
 * 替代方案：常驻段自带最小 schema（见 promptIr.ts），使完整契约漏网时不至于完全瞎猜。
 * 这比依赖上下文判断更稳——不依赖任何拿不到的信息。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeDiagramRequest } from '../../src/canvasHint/detect.ts';

// ---------------------------------------------------------------- 改图信号

test('改图类请求命中（真机漏网点1：重新画）', () => {
  for (const s of ['重新画一下', '重新画', '再画一遍', '再画一版', '重画']) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});

test('改图类请求命中（真机漏网点 2：换个画法/再来一版）', () => {
  for (const s of ['换个画法', '再来一版', '重新出一版', '换个方式画']) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});

test('「这张图不好」类反馈后要求重画也命中', () => {
  for (const s of ['这张图不好看', '图太丑了重画', '这个图不对']) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});

// ---------------------------------------------------------------- 体裁词有限放宽

test('「架构/结构」与意图动词共现时命中（真机漏网点 3）', () => {
  for (const s of ['梳理一下项目架构', '帮我梳理架构', '分析下架构', '看下项目结构', '画个架构']) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});

test('「架构/结构」单独出现不命中（避免回到「泛主题词全命中」的老坑）', () => {
  // 2026-09 收窄判据的原因：泛主题词命中会让模型把纯文字说明也包成卡片，
  // 产出大量「文字塞卡片」伪图示。放宽必须有上限。
  for (const s of ['架构', '项目架构', '数据结构', '这个结构的含义']) {
    assert.equal(looksLikeDiagramRequest(s), false, '不应命中：' + s);
  }
});

// ---------------------------------------------------------------- 负向不回退

test('纯事实/问答仍然不命中（不得因放宽而滥触发）', () => {
  for (const s of [
    '',
    '   ',
    '这个函数叫什么名字',
    '1 + 1',
    '架构是怎么定义的',
    '帮我看下这段代码',
    '数据结构里有哪些字段',
  ]) {
    assert.equal(looksLikeDiagramRequest(s), false, '不应命中：' + s);
  }
});

test('既有 12 个体裁名词仍然全部命中（不得因改动漏掉原有词）', () => {
  for (const s of [
    '流程图', '时序图', '架构图', '示意图', '原理图', '结构图',
    '关系图', '状态机图', '拓扑', '图解', '图示', '可视化',
  ]) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});

test('英文判据未回退', () => {
  for (const s of ['draw a diagram', 'architecture diagram', 'visualize this', 'sketch a flow']) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});