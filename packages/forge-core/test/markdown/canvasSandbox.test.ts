/**
 * 画布卡片渲染层（契约 docs/plan/canvas-card.md）。
 *
 * 守五件事：
 * 1. ```canvas 围栏出 data-md-canvas 占位，且 sanitize 不吃掉该属性（吃掉就永远不出卡片）；
 * 2. ```html 围栏不被劫持（模型展示 HTML 代码示例是常态，误渲染成卡片是回归）；
 * 3. 占位里的 base64 与源码 UTF-8 往返一致（中文标注不能乱码）；
 * 4. looksLikeHtmlCanvas 降级判据：JS/纯文本 false，残缺 HTML true；
 * 5. looksLikeProseCanvas「文字塞卡片」判据（2026-09 增）：标签壳包纯文字 true，
 *    带视觉结构的真图示 false，配套 stripCanvasProse 摘文还段。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_DEFAULT_HEIGHT,
  CANVAS_LANGUAGE,
  CANVAS_TALL_HEIGHT,
  buildCanvasDocument,
  buildCanvasStandaloneFile,
  clearRenderCache,
  judgeCanvasSource,
  looksLikeAsciiArt,
  looksLikeCodeCanvas,
  looksLikeHtmlCanvas,
  looksLikeProseCanvas,
  renderMarkdown,
  stripCanvasProse,
} from '../../src/markdown/renderMarkdown.ts';

const TOKENS = {
  bg: 'oklch(0.26 0.006 286.2)',
  fg: 'oklch(0.88 0.002 286.3)',
  muted: 'oklch(0.3 0.005 286.2)',
  mutedFg: 'oklch(0.7 0.008 286.3)',
  surface: 'oklch(0.3 0.005 286.2)',
  border: 'oklch(0.32 0.005 286.3)',
  ok: 'oklch(0.72 0.14 145)',
  warn: 'oklch(0.8 0.14 85)',
  bad: 'oklch(0.7 0.18 27.325)',
  accent: 'oklch(0.78 0.1 170)',
};

function decodeAttr(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

test('canvas 围栏输出占位，data-md-canvas 在 sanitize 白名单内存活', () => {
  clearRenderCache();
  const out = renderMarkdown('```canvas\n<div class="x">hi</div>\n```');
  assert.match(out, /<pre class="md-canvas-wrap"><code class="md-canvas" data-md-canvas="/);
});

test('canvas 占位 base64 与源码 UTF-8 往返一致（中文标注不乱码）', () => {
  clearRenderCache();
  const src = '<div>登录接口防爆破机制 · 报告模型 vs 代码实际链路</div>';
  const out = renderMarkdown(`\`\`\`canvas\n${src}\n\`\`\``);
  const encoded = out.match(/data-md-canvas="([^"]+)"/)![1]!;
  assert.equal(decodeAttr(encoded), src);
});

test('canvas 源码里的 script 不会以可执行形态出现在宿主 HTML 中', () => {
  clearRenderCache();
  const out = renderMarkdown('```canvas\n<div>a</div><script>alert(1)</script>\n```');
  // 宿主侧只应看到 base64 与转义兜底文本，不应出现裸 <script>
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('```html 围栏不被劫持，仍走高亮展示源码', () => {
  clearRenderCache();
  const out = renderMarkdown('```html\n<div>x</div>\n```');
  assert.ok(!out.includes('data-md-canvas'));
  assert.match(out, /<pre class="md-code-block"><code class="language-html"/);
  // ```html 是「给项目写示例」的常态，同样要有复制入口
  assert.match(out, /<button[^>]*class="md-code-copy"/);
});

test('mermaid 与 canvas 共存时互不干扰', () => {
  clearRenderCache();
  const out = renderMarkdown('```mermaid\ngraph TD;A-->B;\n```\n\n```canvas\n<div>c</div>\n```');
  assert.equal((out.match(/data-md-mermaid="/g) ?? []).length, 1);
  assert.equal((out.match(/data-md-canvas="/g) ?? []).length, 1);
});

test('高度档位：骨架蒙版与终态同高（跳变即回归）', () => {
  assert.equal(CANVAS_DEFAULT_HEIGHT, 320);
  assert.ok(CANVAS_TALL_HEIGHT > CANVAS_DEFAULT_HEIGHT);
});

test('looksLikeHtmlCanvas：JS 源码与纯文本判 false（降级代码块）', () => {
  assert.equal(looksLikeHtmlCanvas('const a = 1;\nif (a > 0) { throw new Error("x"); }'), false);
  assert.equal(looksLikeHtmlCanvas('就是一段说明文字，没有任何标签'), false);
  assert.equal(looksLikeHtmlCanvas(''), false);
});

test('looksLikeHtmlCanvas：完整与残缺 HTML 都判 true（残缺交给浏览器补闭合）', () => {
  assert.equal(looksLikeHtmlCanvas('<div>ok</div>'), true);
  assert.equal(looksLikeHtmlCanvas('<div style="color:red">写到一半'), true);
  assert.equal(looksLikeHtmlCanvas('<table><tr><td>a'), true);
});

test('looksLikeHtmlCanvas：薄 HTML 壳包 ASCII 字符画判 false（进 iframe 会被空白规则压毁）', () => {
  const art = [
    '<div style="font:13px sans-serif">',
    '| off |   | low |   | high |',
    '|___更牙___|___|___| 【A: Codex 共分镜清单】',
    '| 排查 | 原因 | 处置 |',
    '|__|__|__| 【B】 放桌 —— 上方原值展开',
    '</div>',
  ].join('\n');
  assert.equal(looksLikeHtmlCanvas(art), false);
  // 无壳的纯字符画同理
  assert.equal(looksLikeHtmlCanvas(art.replace('<div style="font:13px sans-serif">\n', '').replace('</div>', '')), false);
});

test('looksLikeHtmlCanvas：真 HTML 卡片即使文本里带少量管道也不误降级', () => {
  assert.equal(
    looksLikeHtmlCanvas('<div class="row"><div>方案A | 高对比</div><div>方案B</div><div>方案C</div></div>'),
    true,
  );
  // 标签间排版缩进不被当内容（剥标签前先吃掉标签间空白）
  assert.equal(
    looksLikeHtmlCanvas('<div>\n  <div>标题</div>\n  <div>内容说明文字</div>\n</div>'),
    true,
  );
});

test('looksLikeAsciiArt：正文段落级判定（minArt=2），普通硬换行散文不受影响', () => {
  // 两行密集分栏：命中
  assert.equal(looksLikeAsciiArt('| a |  | b |\n| c || d |', 2), true);
  // 制表字符命中
  assert.equal(looksLikeAsciiArt('┌─┐\n│x│\n└─┘', 2), true);
  // 单管道散文、尾随双空格硬换行：不命中
  assert.equal(looksLikeAsciiArt('选项 off | low | high\n第二行普通文字  ', 2), false);
});

test('looksLikeProseCanvas：标签壳包纯文字判 true（宿主降级为正文渲染）', () => {
  // 实测「文字塞卡片」形态：说明文字包在 p/b 里，除排版壳外没有任何视觉结构
  const prose =
    '<div style="font-size:13px">' +
    '<p><b>private（现在）</b>读代码：只有你 + 授权协作者。Secrets 只在你的账号下可见，仅授权可见，规则强制生效，有被爬走风险。</p>' +
    '<p><b>public（点了之后）</b>读代码：全网可读，匿名也能看，可被镜像站抓走。Actions 日志全网公开，会被搜索引擎长期缓存。</p>' +
    '<p>最需要记住的一条：public 是一次性的单向门，转私有不回退。</p>' +
    '</div>';
  assert.equal(looksLikeProseCanvas(prose), true);
});

test('looksLikeProseCanvas：真图示不误判——布局/图元特征即 false', () => {
  // flex 布局 + 边框盒子（真图示的最低配置）
  assert.equal(
    looksLikeProseCanvas(
      '<div style="display:flex;gap:8px"><div style="border:1px solid var(--c-border);padding:8px">网关</div>' +
        '<div style="border:1px solid var(--c-border);padding:8px">服务</div><div style="border:1px solid var(--c-border);padding:8px">数据库</div>' +
        '<p>三个节点按请求顺序从左到右排列，箭头由上一节的连线负责画出。</p></div>',
    ),
    false,
  );
  // 表格图元
  assert.equal(
    looksLikeProseCanvas('<table><tr><td>阶段</td><td>动作</td></tr><tr><td>构建</td><td>编译打包并跑测试，产物归档到缓存目录，失败即中断后续部署流程</td></tr></table>'),
    false,
  );
  // 绝对定位 / 浮动（模型绕开 flex 画盒子时的兜底特征）
  assert.equal(
    looksLikeProseCanvas('<div style="position:relative;height:120px"><div style="position:absolute;left:0;top:0">源</div><div style="position:absolute;left:120px;top:0">汇，中间由 SVG 连线相接，两个节点以上下错位摆放呈现出汇流的形态</div></div>'),
    false,
  );
});

test('looksLikeProseCanvas：内联箭头的「伪流程卡」判 true（2026-09-29 真机漏网案例）', () => {
  // 行文里的 A → B → C 是标点不是布局——中文技术写作极常用，初版把箭头当
  // 视觉特征导致这类卡片畅通进 iframe。文本占源码九成、无任何布局信号。
  const forkCard =
    '<div><b>fork 之后你本地会同时连着两个远程仓库</b> origin → 你的 fork（你有 write 权限，随便推） upstream → 原作者仓库（你只能拉，推不上去）' +
    '<b>你的日常循环</b> 1. git fetch upstream &amp;&amp; git rebase upstream/main ← 拉原作者的新提交 2. 在本地分支上改 → git push origin my-branch ← 推到你自己的 fork ' +
    '3. 打开你的 fork 页面点 Compare &amp; pull request → 向上游发申请 4. 他审阅 → 合并进他的 main；或提 modifications 要求你改；或直接 Close，网页上也有个 Sync fork 按钮，做的就是第 1 步</div>';
  assert.equal(looksLikeProseCanvas(forkCard), true);
  // 纯箭头流水线同理：没有盒子就没有图，降级成正文不丢信息
  assert.equal(
    looksLikeProseCanvas('<p>请求先到网关 → 网关做鉴权 → 转发到服务 → 服务写库 → 返回结果给调用方，整条链路按顺序走完一遍，其中任何一步失败都会直接中断并返回错误给调用方</p>'),
    true,
  );
});

test('looksLikeProseCanvas：grid 壳包分级长文判 true（布局信号盖不住长句）', () => {
  // 第三轮真机漏网：P0/P1/P2 分级列表，外层 display:grid、每条一个带样式 div，
  // 布局信号全齐但本质是文字堆——长句判据（单片段 ≥80 字）无视布局信号直接判 prose
  const item = (tag: string, style: string, body: string) =>
    `<div style="${style}"><b>${tag}</b> ${body}</div>`;
  const auditCard =
    '<div style="display:grid;gap:12px;line-height:1.8">' +
    item('P0 · 必须处理（公开前）', 'padding:10px;border-radius:8px;background:var(--c-bad-bg)',
      'docs/plan/ 全 17 个文件 ·meeting-room-demo-output.md —— 内含 huoshan-ark 与 minimax-M3 两轮对抗式评审全文：这是内部会议记录，不是交付物，外发等于把自我批评和未决策争论公开。') +
    item('P1 · 强烈建议移除', 'padding:10px;border-radius:8px;background:var(--c-warn-bg)',
      'AGENT.MD 你的个人开发规约：skill 调用策略、强制文档同步、什么时候该用 dev-tdd，不违规，但把私人工作流摊开给所有贡献者看通常不是你想要的。') +
    '</div>';
  assert.equal(looksLikeProseCanvas(auditCard), true);
});

test('looksLikeProseCanvas：svg/img 是「画」，即使夹了长文也不降级（剥标签会拆图）', () => {
  // 标签文本刻意拉过 80 字长句线：没有 GRAPHIC_RE 豁免时这两例都会被判 prose，
  // 用它们钉住「图形卡不进文字判据」这条豁免
  const longLabel = '请求先到网关，网关做鉴权之后转发到服务层处理业务逻辑再写入数据库，最后由服务层把结果按原路返回给调用方，整个闭环走完才算一次成功的调用，任何一步失败都会中断流程并在日志里留下完整的审计记录';
  // SVG 图形卡
  assert.equal(
    looksLikeProseCanvas(`<div><svg width="300" height="80"><text x="10" y="40">${longLabel}</text></svg></div>`),
    false,
  );
  // 位图 + 说明文字
  assert.equal(
    looksLikeProseCanvas(`<div><img src="data:image/png;base64,iVBORw0KGgo=" alt="架构图"><p>${longLabel}，具体以图为准。</p></div>`),
    false,
  );
});

test('looksLikeProseCanvas：无标签 / 超短文本 / 样式占大头的卡片不归它管', () => {
  // 无标签但只有 33 字：不到 PROSE_MIN_TEXT，判不出是散文开头还是画图前言，判 false。
  // （2026-09-29 截图修复后「无标签」不再是排除条件，够长的无标签散文一律判 prose，
  //   见下方 judgeCanvasSource 截图回归用例。这条现在是被长度门槛挡住的。）
  assert.equal(looksLikeProseCanvas('就是一段说明文字，没有任何标签，顺便把长度凑到最短限制之上再说两句'), false);
  // 带标签但可见文本太短：带标题的小图示不值得降级
  assert.equal(looksLikeProseCanvas('<div class="k">登录接口防爆破机制 · 报告模型 vs 代码实际链路</div>'), false);
  // 化妆品属性不算视觉特征：只有圆角/底色的薄壳仍是 prose——由第一用例的反向补充验证
  assert.equal(
    looksLikeProseCanvas('<div style="border-radius:8px;background:var(--c-surface)"><p>这里是一段足够长的说明文字，除了圆角和底色之外没有任何布局、框线、箭头或表格特征，用来说明化妆品属性不该被当成视觉结构的证据：模型经常拿一个带样式的薄壳 div 包住整段说明文字塞进 canvas 围栏，这类卡片应当判定为文字塞卡片并降级成正文渲染，而不是进固定高度的 iframe，这也是 2026-09 收紧之后的宿主兜底。</p></div>'),
    true,
  );
});

test('stripCanvasProse：块级闭标签还原段落边界，实体解码，script/style 整块丢弃', () => {
  const out = stripCanvasProse('<div><p>a&amp;b</p><p>第二段<br>折行</p><style>p{color:red}</style><script>alert(1)</script></div>');
  assert.equal(out, 'a&b\n\n第二段\n折行');
});

/* ------------------------------------------------------------------ *
 * 2026-09-29 截图回归：模型把纯文字说明（无任何标签）塞进 ```canvas 围栏。
 *
 * 改前：looksLikeProseCanvas 在首行 `if (!looksLikeHtmlCanvas(s)) return false`
 * 直接出局 → 落 canvas-fallback 代码框；流式期间还先挂一秒骨架（假进度），
 * 闭合后突然变成黑底代码框。改后：无标签且不像源码 → prose 走正文流。
 * ------------------------------------------------------------------ */

/** 截图红框第一段：纯文字 + 「·」伪列表，源码里一个标签都没有 */
const PLAIN_NO_LICENSE = `没有 LICENSE 时，GitHub 自动套用「保留所有权利」
· 别人能读你的代码、能 fork —— 纯「阅读」不违法
· 但复制一段代码用在自己项目里、拿去商用、改了再发布 —— 法律上不允许
即使他们想做善意的贡献也只能提 PR，因为没有授权基础

实际会发生什么
· 有人想在自己的项目里 import 你的 @forge/core — 被法律挡住，只能 fork 后当私用代码用
· 企业法务看到「无许可证」直接跳过 → 少掉一大半潜在使用者
· GitHub 页面右侧会挂一个灰色的 "Unlicensed" 警告标签，看着就不专业`;

/** 截图红框第二段：✓ 勾选式清单，同样无标签 */
const PLAIN_MIT = `别人【可以】
✓ 复制代码到自己项目里用
✓ 拿去商用、闭源打包成自己的产品
✓ 改造完成完全一样的样子发布

别人【必须】
· 保留你写的版权声明（不能抹掉"copyright 2026"）
· 不能声称代码是自己写的
· 不能拿你的名字担保他们的产品质量`;

test('judgeCanvasSource：无标签纯文字判 prose（截图回归——改前落代码框）', () => {
  assert.equal(judgeCanvasSource(PLAIN_NO_LICENSE), 'prose');
  assert.equal(judgeCanvasSource(PLAIN_MIT), 'prose');
});

test('judgeCanvasSource：无标签真源码仍判 code（不得被 prose 吞掉）', () => {
  assert.equal(
    judgeCanvasSource('const total = list.reduce((a, b) => a + b, 0);\nif (total > 30) throw new Error("x");'),
    'code',
  );
  // 无标签字符画：必须等宽保对齐，判 code 而非 prose（prose 会剥标签毁掉对齐）
  assert.equal(judgeCanvasSource('| 阶段 | 动作 |\n| 构建 | 编译打包 |\n| 部署 | 发布上线 |'), 'code');
});

test('looksLikeCodeCanvas：句中出现的代码词不算源码（截图正文里就有 import）', () => {
  // 「在自己的项目里 import 你的 @forge/core」——import 在句中，是中文技术写作的
  // 普通名词用法。关键词必须锚行首，否则纯中文说明被误判成源码、照旧掉进代码框。
  assert.equal(looksLikeCodeCanvas(PLAIN_NO_LICENSE), false);
  assert.equal(looksLikeCodeCanvas(PLAIN_MIT), false);
  // 行首才是源码
  assert.equal(looksLikeCodeCanvas('import os\nprint(os.getcwd())'), true);
  assert.equal(looksLikeCodeCanvas('for (const x of xs) {\n  f(x);\n}'), true);
});

test('judgeCanvasSource：真 HTML 卡片判 html，布局信号不被 prose 抢走', () => {
  assert.equal(judgeCanvasSource('<div class="k">登录接口防爆破机制</div>'), 'html');
  assert.equal(
    judgeCanvasSource('<div style="display:flex;gap:8px"><div style="border:1px solid var(--c-border);padding:8px">网关</div><div style="border:1px solid var(--c-border);padding:8px">服务</div></div>'),
    'html',
  );
  assert.equal(judgeCanvasSource('<table><tr><td>阶段</td><td>动作</td></tr></table>'), 'html');
});

test('judgeCanvasSource：undecided 只给「无标签且太短」，流式骨架据此挂不挂', () => {
  // 太短判不出是不是散文开头：交给骨架占位
  assert.equal(judgeCanvasSource('没有 LI'), 'undecided');
  assert.equal(judgeCanvasSource(''), 'empty');
  // 一旦够长就判死，且对无标签内容单调（文本只增不减）——
  // 骨架不会在闭合瞬间翻面，这是提前撤骨架的前提
  const half = PLAIN_NO_LICENSE.slice(0, Math.floor(PLAIN_NO_LICENSE.length / 2));
  assert.equal(judgeCanvasSource(half), 'prose');
  assert.equal(judgeCanvasSource(PLAIN_NO_LICENSE), 'prose');
});

test('stripCanvasProse：伪列表符还原成 markdown 列表（否则降级正文糊成一段话）', () => {
  // 截图里的 `·` 与 `✓` 剥成纯文本后只是行内字面量，不还原会丢掉原列表结构
  assert.equal(
    stripCanvasProse(PLAIN_NO_LICENSE).split('\n')[1],
    '- 别人能读你的代码、能 fork —— 纯「阅读」不违法',
  );
  assert.equal(stripCanvasProse(PLAIN_MIT).split('\n')[1], '- 复制代码到自己项目里用');
  // 还原后过 renderMarkdown 出真 <ul>，不再出代码块
  const html = renderMarkdown(stripCanvasProse(PLAIN_MIT));
  assert.ok(html.includes('<ul>'));
  assert.ok(!html.includes('<pre'));
  // 行中的 · / ✓ 不受影响（只处理行首）
  assert.ok(stripCanvasProse('<p>范围是 A · B 的并集</p>').includes('A · B'));
});

test('stripCanvasProse：行首排版缩进剥掉（防 renderMarkdown 顶成代码块），连续空行收敛', () => {
  const out = stripCanvasProse('<div>\n  <p>第一段有缩进</p>\n\n  <p>第二段也有</p>\n</div>');
  assert.equal(out, '第一段有缩进\n\n第二段也有');
  // 实体解码后不会复活成真标签（先剥标签后解码的顺序契约）
  assert.equal(stripCanvasProse('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<script>alert(1)</script>');
});

test('沙箱文档：预注入语义变量 + 卡片源码原样进 body', () => {
  const doc = buildCanvasDocument('<div class="k">内容</div>', TOKENS);
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('--c-bg:oklch(0.26 0.006 286.2)'));
  assert.ok(doc.includes('--c-bad-bg:color-mix(in oklab, oklch(0.7 0.18 27.325) 12%, transparent)'));
  assert.ok(doc.includes('<div class="k">内容</div>'));
});

test('另存文档：独立可打开，标题转义不进标签', () => {
  const file = buildCanvasStandaloneFile('<div>x</div>', TOKENS, '</title><script>');
  assert.match(file, /<title>&lt;\/title&gt;&lt;script&gt;<\/title>/);
  assert.ok(file.includes('<meta name="viewport"'));
});
