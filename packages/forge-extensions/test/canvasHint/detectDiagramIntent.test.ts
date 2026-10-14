/**
 * 出图触发器的**双向**回归锁。
 *
 * 为什么单独一个文件：2026-10-13 首轮真实对话门禁（20 条出图 prompt）实测，
 * 20 条里 **7 条没命中触发器**——「思维导图」「树形图」「一张树」
 * 「画一下这个项目的模块组成」「用图讲一下…」全是用户日常说法，但它们不含「图」字。
 *
 * 漏命中的代价不对称：**整段画布输出契约没注入**。模型只拿到常驻段，
 * 于是自创输出格式（实测样本里出现过完全不合围栏名的 JSON）。
 *
 * 两侧都要锁：只有命中侧的话，放宽词表迟早会退化成「泛主题词全命中」
 * （2026-09 那次收窄修的就是这个）；只有忽略侧的话就会重演上面的事故。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeDiagramRequest } from '../../src/canvasHint/detect.ts';

/** 2026-10-13 真实门禁里全部 20 条出图 prompt 原文（未删改）。 */
const REAL_DIAGRAM_PROMPTS: readonly string[] = [
  '画个流程图：收到订单后先校验库存，库存不足就通知用户，库存够就扣减库存并生成发货单。',
  '帮我画一下 CI 的流程：先跑 lint，lint 不过就停下来；过了跑测试，测试失败就回退。',
  '画一张审批流程图。提交申请之后主管审批，主管通过就转财务，主管驳回就打回给申请人重填。',
  '用流程图说明一下缓存的读取逻辑：先查缓存，命中直接返回；没命中就查数据库，查到之后写回缓存再返回。',
  '画个登录流程图，包含密码校验、失败次数过多锁定账号这两条分支。',
  '帮我画一下这个项目的模块组成。',
  '画一张架构图：数据采集、清洗、特征、训练、服务，分成离线层和在线层两层。',
  '把 forge 的几个 package 的依赖关系画成一张架构图。',
  '画个三层架构图：前端 Vue、主进程 Electron、核心引擎，说明它们的调用关系。',
  '画架构图：接入层、业务层、存储层，存储层下面挂 MySQL 和 Redis 两个组件。',
  '画个时序图：浏览器发起请求，网关转发到订单服务，订单服务查数据库后返回。',
  '时序图：用户下单，订单服务调支付服务，支付成功后支付服务回调订单服务，订单服务再通知物流。',
  '用图讲一下一次对话从用户输入到模型返回的完整链路。',
  '画时序图：客户端 → 网关 → 服务 A → 缓存，缓存未命中再走服务 A 到数据库这一路。',
  '画个时序图说明发布流程：开发者提交代码，CI 构建镜像，推送到仓库，运维从仓库拉取并部署。',
  '帮我梳理一下这个仓库的目录结构。',
  '把 IR 校验的错误码按类别整理成一张树。',
  '画一张思维导图，主题是「如何提升模型出图的首次通过率」。',
  '画个思维导图，梳理一下这个项目接下来的工作计划。',
  '把「一个前端工程师需要掌握的知识」画成一张树形图。',
];

/**
 * 不该命中的样本。收的都是**真实会出现的非出图请求**，不是臆造的边界。
 * 特别是「红黑树」这类：`树` 已按「体裁 + 动词」通道放进词表，代价已知且有意接受。
 */
const REAL_NON_DIAGRAM_PROMPTS: readonly string[] = [
  '把这段代码重构一下',
  '这个 bug 怎么修',
  '帮我看下测试为什么挂',
  '解释一下闭包的原理',
  '把日志里的错误贴出来',
  '对比一下 Redux 和 Zustand',
  '这篇文档太长了，精简一下',
  '今天的天气怎么样',
  '帮我把颜色方案改浅一点',
  '这个项目的测试怎么跑？',
  '总结一下 docs/changelog.md 最近几条改了什么。',
  '解释一下 canvasHint 扩展是干什么的。',
];

test('回归锁：真实门禁的 20 条出图 prompt 必须全部命中（v2 触发器漏网事故）', () => {
  const missed = REAL_DIAGRAM_PROMPTS.filter((s) => !looksLikeDiagramRequest(s));
  assert.deepEqual(
    missed,
    [],
    `${missed.length} 条出图请求没命中触发器 ⇒ 契约整段不注入 ⇒ 模型自创 schema。\n` +
      '漏网：\n  - ' + missed.join('\n  - '),
  );
});

test('反向：日常非出图请求不得命中（防词表退化成泛主题词全命中）', () => {
  const hit = REAL_NON_DIAGRAM_PROMPTS.filter((s) => looksLikeDiagramRequest(s));
  assert.deepEqual(
    hit,
    [],
    `${hit.length} 条非出图请求被误命中 ⇒ 会重演 2026-09「文字塞卡片」伪图示。\n` +
      '误命中：\n  - ' + hit.join('\n  - '),
  );
});

test('思维导图 / 树形图 一族是体裁名词，不需要与动词共现', () => {
  // 这一组曾经全部漏网：它们不含「图」字，而 v2 之前只认「…图」结尾的体裁。
  for (const s of [
    '画一张思维导图',
    '整理成思维导图',
    '做个脑图',
    '画个树形图',
    '画成树状图',
    'a mind map please',
    'draw a tree diagram',
    'org chart for the team',
  ]) {
    assert.equal(looksLikeDiagramRequest(s), true, '应命中：' + s);
  }
});

test('「画一下」这类不带「图」字的祈使式命中，但「画」+非图宾语不得命中', () => {
  assert.equal(looksLikeDiagramRequest('帮我画一下这个项目的模块组成'), true);
  assert.equal(looksLikeDiagramRequest('画一下下这个流程'), true);
  // 纪律边界：不收「画 + 任意名词」，否则会扩到非出图场景
  assert.equal(looksLikeDiagramRequest('画个分割线'), false);
  assert.equal(looksLikeDiagramRequest('画出这两个方案的界线'), false);
});
