/**
 * 画布卡片（```canvas 围栏）的沙箱侧约定。
 *
 * 为什么单独成文件：这些判据既被渲染层（renderMarkdown 的围栏分派）用，也被渲染
 * 进程（HtmlCanvasBlock 决定「出 iframe / 出骨架 / 出代码块」）用，还必须是纯函数
 * ——它们要在 node:test 下回归，不能碰 DOM。
 *
 * 安全口径（不可放宽）：卡片源码不过 sanitize-html 白名单（白名单不含 style，会把
 * 卡片样式剥光），而是 base64 内嵌 → 前端解码 → iframe srcdoc（暗色下仅做背景色
 * 重映射，见 remapDarkBackgrounds）。安全边界完全由 iframe 的 `sandbox=""` 承担：
 * 不给 allow-scripts，也不给 allow-same-origin。
 * 因此 srcdoc 是独立 origin —— 主文档读不到它的内容、它拿不到 window.forge，
 * 模型 HTML 里的 <script> 与 on* 事件属性一律不执行。
 */

/**
 * 画布围栏的语言标记名（唯一权威定义）。
 *
 * 与 forge-extensions canvasHint 扩展写给模型的围栏名必须一致；不一致时卡片会静默
 * 退化成普通代码块（没有任何报错可查），故由 forge-desktop 的回归测试跨包断言相等。
 *
 * 注意不要复用 `html`：那个语言名已被 hljs 高亮占用（模型给项目展示 HTML 代码示例
 * 是常态），劫持它会把正常代码块误渲染成卡片。
 */
export const CANVAS_LANGUAGE = 'canvas';

/** 卡片默认高度（px）。骨架蒙版用同一数值，保证闭合瞬间零跳变。 */
export const CANVAS_DEFAULT_HEIGHT = 320;

/** 「拉高」档高度（px）。iframe 高度无法自适应内容（见文件头安全口径），故只给档位。 */
export const CANVAS_TALL_HEIGHT = 560;

/**
 * 内容是否像一张 HTML 图示。
 *
 * 用途是闭合那一刻的降级判定：蒙版期间用户看不到内容，若模型误把一段 JS / 纯文本
 * 塞进 canvas 围栏，无条件塞进 iframe 会得到一张空白卡片，用户等半天什么也没得到。
 *
 * 判据分两层：
 * 1. 存在任意标签形态——残缺但确是 HTML 的（模型写到一半就闭合）仍可进 iframe，
 *    交给浏览器自动补齐未闭合标签；
 * 2. 但「有一个标签」不等于「是一张有布局的图」：模型常拿一个薄壳（如
 *    `<div style="font:...">`）包住 ASCII 字符画。字符画进 iframe 会被 HTML 空白
 *    规则压成一坨（换行丢、连续空格折叠、对齐全毁），比降级代码块差得多。
 *    故剥掉标签取可见文本，文本呈字符画形态时判 false（降级代码块，等宽保对齐）。
 */
export function looksLikeHtmlCanvas(source: string): boolean {
  const s = source ?? '';
  if (!HAS_TAG_RE.test(s)) return false;
  return !looksLikeAsciiArt(stripTagsToText(s));
}

/** 任意标签形态（<div>、<!DOCTYPE、<!-- 注释…）：卡片是 HTML 的最低要求。 */
const HAS_TAG_RE = /<[a-zA-Z!/][^>]*>/;

/**
 * 末尾未闭合的标签片段：`<div style="padding:10px` 这种只写了一半的。
 *
 * 流式判据必须先把它剪掉再算内容。它没有 `>`，`stripTagsToText` / `longestTextRun`
 * 的 `<[^>]*>` 都剥不掉它，于是半截属性值被当成「正文」——属性里的 `=` 让
 * looksLikeCodeCanvas 命中赋值号（骨架提前塌成代码块，用户看见满屏源码），长内联
 * 样式让 longestTextRun ≥ PROSE_LONG_RUN（骨架塌成一段正文），标签一闭合片段消失
 * 又变回骨架。150ms 一次的节流重渲染下，就是「画图时一直闪、闪的时候看见源码」
 * （2026-09-30 真机）。
 *
 * 只吃「后随内容里没有 `>`」的最后一个 `<字母/!/`：`if (a < b)` 这类比较运算符
 * （`<` 后是空格或数字）不误伤。
 */
const TRAILING_PARTIAL_TAG_RE = /<[a-zA-Z!/][^>]*$/;

/** 剪掉末尾半截标签（流式判据的唯一入口，终态判据不剪：闭合后源码不再增长）。 */
function withoutTrailingPartialTag(source: string): string {
  return (source ?? '').replace(TRAILING_PARTIAL_TAG_RE, '');
}

/**
 * HTML `<canvas>` 元素（真标签，非 canvas 围栏这个词）。
 *
 * 2026-09-30 用户裁决（语料 G01）：`<canvas>` 是沙箱里的死元素，但只该剥掉元素本身、
 * 按其余内容重新判决——「好卡片 + 一个装饰性 canvas」不该整卡拖进代码块。剥标签留内容：
 * - 死画布里的 ASCII 表格回退文本 → 剥后走字符画路径 → 仍判 code（等宽保对齐，落点不变）；
 * - 纯文本回退 → 剥后按内容判（短句归 prose）；
 * - 好卡片混装饰 canvas → 剥后照常判 html。
 * 判决入口（终态与流式）统一先剥；srcdoc 渲染不剥——canvas 在沙箱里本来就不渲染，无害。
 */
const CANVAS_TAG_RE = /<\/?canvas\b[^>]*>/gi;

/** 判决入口统一先剥 <canvas> 标签（留内容）。只用于判决，不用于 srcdoc。 */
function withoutCanvasTags(s: string): string {
  return (s ?? '').replace(CANVAS_TAG_RE, '');
}

/**
 * `<script>` / `<style>` 的整块内容（含未闭合的流式半截）。
 *
 * 顺序同 stripCanvasProse（那边早就在做这件事，两边口径必须一致）：这类元素的内容
 * 既不是标签也不是可见文本，不先整块丢掉，它会被后面的 `<[^>]*>` 当成「标签间正文」
 * ——真机那张注册流程卡（2026-09-30）就是这样被降级成正文的：卡片顶着一个 `<style>`
 * 定义 .lane/.g2 网格，CSS 整段 1612 字被算成「最长文本片段」，直接顶穿长句阈值。
 *
 * 结尾 alternation 是给流式用的：围栏中途只有 `<style>` 没有 `</style>`，此时不能
 * 因为没闭合就把已写入的 CSS 当正文（骨架会提前塌成正文，正是 2026-09-30 真机
 * 「画图时一直闪」那类现象）。
 */
const RAW_TEXT_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/** 丢掉 script/style 整块（含未闭合的流式半截）。所有「算文本」的地方的唯一入口。 */
function dropRawTextBlocks(s: string): string {
  return (s ?? '').replace(RAW_TEXT_BLOCK_RE, '');
}

/** 取标签外的可见文本。先丢 script/style，再吃掉「标签间纯空白」（模型的排版缩进），缩进不是内容。 */
function stripTagsToText(s: string): string {
  return dropRawTextBlocks(s)
    .replace(/>\s+</g, '><')
    .replace(/<[^>]*>/g, '');
}

/* ------------------------------------------------------------------ *
 * 「文字塞卡片」判据（prose 降级）。
 *
 * looksLikeHtmlCanvas 只挡「没有标签」和「ASCII 字符画」，`<div>` 包一段纯文字
 * 会畅通进 iframe——固定 320px 高的卡片装着几百字说明，底部大片留白，用户读的
 * 还是不带 markdown 语义的裸文本。模型把 prose 塞进 ```canvas 围栏是实测高频
 * 行为（提示词已于 2026-09 收紧，仍需宿主兜底），故加第二道降级：判出「标签只是
 * 排版壳、内容是文章」的卡片，摘出文字按正文流渲染，不出 iframe。
 */

/**
 * 布局特征（命中任一即不判 prose）——只认「真排版」，不认「内容像图」。
 *
 * 教训（2026-09-29 真机漏网）：初版把箭头 → ← 和边框线型也算特征，结果
 * 「正文里夹内联箭头的伪流程卡」（origin → 你的 fork ← 拉新提交…）畅通进
 * iframe。行文里的 A → B → C 是标点不是布局，中文技术写作里极常见。
 *
 * 2026-09-30 用户裁决（语料 W03 正文 / G06 页面）把 flex/grid 从本表移出：
 * `display:flex` 在文字墙包装上和真图示里同样廉价，挡不住谁；区分 W03（无样式
 * 薄壳包整句 → 正文）与 G06（<style> 块 + 逐盒样式 → 页面）的是「样式投入量」，
 * 由薄壳路径的文本占比（样式越重占比越低）承担，不靠关键词。保留的信号只剩
 * 更重的投入：绝对定位/浮动、table/svg/img 图元、制表字符。
 */
const VISUAL_CUE_RE =
  /position\s*:\s*absolute|float\s*:|<(table|svg|img)\b|[─│┌┐└┘├┤┬┴┼]/i;

/**
 * 可见文本占源码的比例上限：超过才算「标签只是壳」。真图示的样式文本通常占一半以上。
 *
 * 分子（可见文本）不含 script/style 内容，分母（原始源码）**刻意含**——这不是口径
 * 不一致而是裁决（2026-09-30 语料 G06）：样式投入计入「不是薄壳」的证据，CSS 越重
 * 越像页面；W03 那类几乎零样式的 div 墙才落进薄壳。两边都丢 CSS 的话 G06 会翻成
 * prose，违背用户裁决。
 */
const PROSE_TEXT_RATIO = 0.6;

/** 可见文本最短长度：低于它不判 prose（带个标题的小图示不值得降级）。 */
const PROSE_MIN_TEXT = 40;

/**
 * 空壳地板：有标签但可见文本 ≤ 它，且存在 <style>/<script> 块，判 prose
 * （2026-09-30 用户裁决，语料 G02）。
 *
 * 「大 <style> 块 + 一个字」剥掉 CSS 后只剩 1 个字，判 html 会出一张 320px 空白卡；
 * 用户裁决「就一个字，是文本」。地板取 4，上端由语料钉住——N08 小卡可见文本 16 字
 * 仍是 html。但单看字数会误伤「网关/服务」这类两三个短标签的迷你图（可见文本恰好
 * 4 字），故加 SHELL_MARK_RE 门槛：空壳的标记是样式/脚本投入占绝对主导——卡里真有
 * 一大块 CSS/JS 而可见内容近零，才算空壳；裸 `<div>甲</div>` 渲染出来仍是个盒子，
 * 照旧 html。
 *
 * 只在终态判：流式期间可见文本从 0 长起，先短后长是常态，放进流式会让每张卡的
 * 第一个字都闪一次正文。
 */
const SHELL_TEXT_MAX = 4;
const SHELL_MARK_RE = /<(style|script)\b/i;

/**
 * 长句阈值：单个标签间文本片段的字符数超过它就是句子。
 *
 * 真图示的文本节点是短标签（「网关」「服务」「API Gateway」），几十字的连续长句
 * 不可能住在图示的节点里——所以长句是无视布局信号的 prose 铁证。第二轮真机漏网
 * 正是反例：P0/P1/P2 分级列表套着 grid 壳、每条一个带样式 div，布局信号全齐，
 * 本质仍是文字堆。
 *
 * 但只看极值会误伤第三轮真机那张流程图卡（2026-09-30：<style> 网格 + 94 个短标签 +
 * 2 条长说明），故长句还必须**占满**可见文本，见 PROSE_LONG_RUN_SHARE。
 */
const PROSE_LONG_RUN = 80;

/**
 * 长句文本占可见文本的比例门槛：低于它不判 prose。
 *
 * 为什么极值不够（2026-09-30 真机）：长句判据原本只看「最长片段 ≥80 字」这一条极值，
 * 于是把两种完全不同的卡片看成同一类——
 * - 图示的常态是「一堆短标签 + 一两条长说明」（真机注册流程卡：94 个片段、最长 101 字、
 *   长片段只占总文本 10%）。盒子、箭头、网格都在，长句只是某个格子里的一句话。
 * - 「文字塞卡片」是长句**占满**（存量 P0/P1/P2 用例：4 个片段、长句占 89%）。
 * 极值判据对前者是误伤，对后者是唯一抓手，所以补一条占比门槛把两者分开。
 *
 * 0.5 的来由：真机两例落在 0.10 与 0.89，取中位。误伤方向也核实过——本判据只负责
 * 「不出 prose」，判成 prose 后还有薄壳路径（VISUAL_CUE 布局信号）兜底；反过来
 * 放过一张文字堆的代价是固定 320px 卡片里一段没有结构的文字，比误降级更伤。
 */
const PROSE_LONG_RUN_SHARE = 0.5;

/**
 * 图形兜底：含 svg/img 的卡片是「画」，文字判据对它无权重——降级路径靠剥标签取文，
 * 会把整张图拆没。宁可留着卡片（哪怕它还带了段长文），也不做不可逆的破坏。
 */
const GRAPHIC_RE = /<(svg|img)\b/i;

/** 逐个取标签间的可见文本片段（trim 后，script/style 整块已丢）。 */
function textRuns(s: string): string[] {
  return dropRawTextBlocks(s)
    .split(/<[^>]*>/)
    .map((frag) => frag.trim())
    .filter((frag) => frag !== '');
}

/** 返回最长文本片段的字符数。 */
function longestTextRun(s: string): number {
  let max = 0;
  for (const run of textRuns(s)) {
    if (run.length > max) max = run.length;
  }
  return max;
}

/** 长句（≥PROSE_LONG_RUN）在全部可见文本里的字符占比。 */
function longRunShare(s: string): number {
  const runs = textRuns(s);
  let total = 0;
  let long = 0;
  for (const run of runs) {
    total += run.length;
    if (run.length >= PROSE_LONG_RUN) long += run.length;
  }
  return total === 0 ? 0 : long / total;
}

/** 长句铁证：既有 ≥PROSE_LONG_RUN 的片段，长句又占满（≥PROSE_LONG_RUN_SHARE）可见文本。 */
function isProseByLongRun(s: string): boolean {
  return longestTextRun(s) >= PROSE_LONG_RUN && longRunShare(s) >= PROSE_LONG_RUN_SHARE;
}

/**
 * 源码形态：模型把一段代码（非 HTML）错塞进 canvas 围栏。
 *
 * 用来把「无标签」再分流一次——无标签不等于 prose（真代码照样无标签），
 * 但也不等于「该按代码块降级」：截图那类纯文字说明（`·` 伪列表 + 中文长句）
 * 无标签却不是代码，按代码块渲染是纯噪声。
 *
 * 判据只认代码独有的排版信号，且**关键词必须出现在行首**（`m` 标志 + `^`）：
 * 截图正文里就有「在自己的项目里 import 你的 @forge/core」这种把代码词当普通
 * 名词用的句子，全串搜 `import` 会把纯中文说明误判成源码、照旧掉进代码框。
 * 行首 `const/for/if` 才是源码；句中 import 是散文。其余信号（花括号、分号、
 * 赋值、箭头函数、调用后接标点）在中文正文里同样不会出现。
 */
const CODE_SHAPE_RE =
  /^[ \t]*(?:const|let|var|function|class|def|import|from|export|package|if|else|for|while|return|throw|new|public|private|static)\b|[{};]|=>|[a-zA-Z_$][\w$]*\s*=(?!=)|\w+\s*\([^)]*\)\s*[:{;]/m;

/** 源码形态判据的对外入口（供回归测试钉住误伤面） */
export function looksLikeCodeCanvas(source: string): boolean {
  return CODE_SHAPE_RE.test(source ?? '');
}

/* ------------------------------------------------------------------ *
 * 四态判决（唯一口径）。
 *
 * 为什么要收成一个函数：流式骨架要不要撤（MessageCard）与终态渲染成什么
 * （HtmlCanvasBlock）本来各判一遍，两边的顺序只要有一处不同就会出现「骨架闪一下
 * 然后落到代码框」这种自相矛盾的结果——这正是 2026-09-29 实测到的现象。判定逻辑
 * 只有一份，两边都读它。
 *
 * 但「一份」不等于「一档」：流式中途的源码是半截的，终态判据（按完整源码设计）
 * 直接在它上面跑会抖——见 judgeStreamingCanvas 的说明。故入口收成一个、口径分两档，
 * 由 options.streaming 选。
 */

/** 卡片源码的终态（'undecided' 专用于流式中途：还判不出是不是 HTML） */
export type CanvasVerdict = 'empty' | 'html' | 'prose' | 'code' | 'undecided';

/** 判决档位选择 */
export interface CanvasJudgeOptions {
  /**
   * true = 围栏尚未闭合（流式中途，源码还会继续增长）。
   *
   * 中途只放行「剪掉末尾半截标签后依然成立」的判据，且只放行其中**单调**的那几条：
   * 一旦判成 prose/code 就不会再翻回骨架。文本占比这类非单调判据（正文占比随标签
   * 增多降、随文字增多升）留到闭合后判一次，否则每个节流点来回翻面。
   *
   * 默认 false = 闭合终态，口径与历史完全一致（老调用点零改动）。
   */
  streaming?: boolean;
}

/**
 * 卡片源码判成哪一态。
 *
 * 入口统一先剥 <canvas> 标签（留内容，见 CANVAS_TAG_RE）——判决看的永远是
 * 「剥掉死元素之后还剩什么」。
 *
 * 终态顺序即优先级（2026-09-30 用户裁决后）：
 * 1. 空 → 空态文案；
 * 2. 有标签 →
 *    a. 字符画薄壳（looksLikeHtmlCanvas 的字符画否决）→ code——薄壳 div 包字符画
 *       进 iframe 会被空白规则压毁对齐，等宽代码块是唯一不丢信息的落点（G03，
 *       注释声称此路径多年，实现直到今天才接上）；
 *    b. 空壳（<style>/<script> 块在场、可见文本 ≤ SHELL_TEXT_MAX 且无图元）→
 *       prose——剥掉 CSS 只剩一两个字的卡不出空白 iframe（G02）；
 *    c. looksLikeProseCanvas（长句主导 / 薄壳占比）→ prose，其余 html；
 * 3. 无标签 → 源码形态或字符画 → code；其余一律 prose——包括短句（G04「画好了」）：
 *    终态不再有 undecided，围栏既然闭合了，内容是什么就渲染什么，一句话不该进
 *    等宽代码框。
 *
 * 'undecided' 从此只在流式口径出现（还判不出、源码还会长，交给骨架占位）。
 */
export function judgeCanvasSource(source: string, options: CanvasJudgeOptions = {}): CanvasVerdict {
  const s = withoutCanvasTags(source ?? '');
  if (options.streaming === true) return judgeStreamingCanvas(s);
  if (s.trim() === '') return 'empty';
  if (HAS_TAG_RE.test(s)) {
    if (!looksLikeHtmlCanvas(s)) return 'code';
    if (SHELL_MARK_RE.test(s) && !GRAPHIC_RE.test(s) && stripTagsToText(s).trim().length <= SHELL_TEXT_MAX) return 'prose';
    return looksLikeProseCanvas(s) ? 'prose' : 'html';
  }
  // 无标签：源码与字符画先判——它们从第一个字符起就有排版信号（import/for/分号/
  // 管道），不需要等长度门槛。
  if (looksLikeCodeCanvas(s) || looksLikeAsciiArt(s, 2)) return 'code';
  return 'prose';
}

/**
 * 流式口径（围栏未闭合）。与终态口径的差别只有两处，都是为了「中途不翻面」：
 *
 * 1. 先剪掉末尾半截标签（TRAILING_PARTIAL_TAG_RE）再算内容。不剪的话，`<div style=`
 *    会因属性里的 `=` 命中 looksLikeCodeCanvas → 骨架提前塌成代码块（用户看到的是
 *    满屏源码），长内联样式会因算进「最长文本片段」命中 PROSE_LONG_RUN → 塌成正文，
 *    标签一闭合又变回骨架：150ms 一次的重渲染下就是一直闪。剪掉后这两种都不再发生。
 * 2. 有标签时只放行「长句铁证」这一条单调判据（见 streamingProseShell），
 *    薄壳的占比判据留到闭合后判一次——它天生非单调。
 *
 * 终态独有的三条（字符画薄壳 / 空壳 / 短句 prose）不进流式：字符画的「画行占比」
 * 会随后续正文变多跌破半数（code→html 翻面），空壳的可见文本会从 1 个字长成一段
 * （prose→html 翻面）。这三类的流式期间照常挂骨架，闭合时一次性落终态——接受这一
 * 次闭合翻面，换流式全程零抖动（2026-09-30 方案 A 裁决）。
 *
 * 空态（'empty'）属于终态结论：中途只能给 'undecided'（挂骨架）。中途就出空态文案，
 * 等于在刚开栏那一帧闪一次「画布没有内容」。
 */
function judgeStreamingCanvas(raw: string): CanvasVerdict {
  const s = withoutTrailingPartialTag(raw);
  if (s.trim() === '') return 'undecided';
  if (!HAS_TAG_RE.test(s)) {
    if (looksLikeCodeCanvas(s) || looksLikeAsciiArt(s, 2)) return 'code';
    if (s.trim().length < PROSE_MIN_TEXT) return 'undecided';
    return 'prose';
  }
  return streamingProseShell(s) ? 'prose' : 'html';
}

/** base64 → UTF-8（前端与流式判决共用一份解码；atob 只给 Latin-1，需 TextDecoder 还原） */
export function decodeCanvasSource(encoded: string): string {
  try {
    const binary = atob(encoded);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

/**
 * 源码是否「文字塞卡片」（prose 降级）：有标签（否则归 looksLikeHtmlCanvas 的代码块降级）、
 * 非图形（svg/img 不碰），且命中其一——
 * 1. 长句路径：任一标签间文本 ≥ PROSE_LONG_RUN（无视布局信号）；
 * 2. 薄壳路径：可见文本占源码六成以上、且无任何重投入布局特征（定位/图元/制表符；
 *    flex/grid 已按 2026-09-30 语料 W03/G06 裁决移出，见 VISUAL_CUE_RE）。
 */
export function looksLikeProseCanvas(source: string): boolean {
  const s = source ?? '';
  // 无标签：prose 与源码在此分岔（截图那类纯文字说明走 prose，代码走代码块降级）。
  // 字符画不进 prose——它要等宽保对齐，剥标签会毁掉它。
  if (!HAS_TAG_RE.test(s)) {
    if (s.trim().length < PROSE_MIN_TEXT) return false;
    if (looksLikeAsciiArt(s, 2)) return false;
    return !looksLikeCodeCanvas(s);
  }
  const text = proseShellText(s);
  if (text === null) return false;
  if (isProseByLongRun(s)) return true;
  if (text.length / s.length <= PROSE_TEXT_RATIO) return false;
  return !VISUAL_CUE_RE.test(s);
}

/**
 * 有标签内容的 prose 前哨（终态与流式共用）：命中即返回可见文本，未命中返回 null。
 *
 * 两个档位必须读同一份前哨：任何一边单独加个否决条件，都会让「中途判成 A、闭合判成 B」
 * 变成翻面。所以这里只做静态否决（标签形态 / 图元 / 最小文本量），不放任何会随源码
 * 增长而反复成立-不成立的判据。
 */
function proseShellText(s: string): string | null {
  // <canvas 标签已在判决入口剥掉（CANVAS_TAG_RE），这里不需要再否决——带 canvas 的
  // 卡片按剥掉死元素之后的内容参加 prose 判决（2026-09-30 语料 G01 裁决）。
  if (!looksLikeHtmlCanvas(s)) return null;
  if (GRAPHIC_RE.test(s)) return null;
  const text = stripTagsToText(s).trim();
  return text.length < PROSE_MIN_TEXT ? null : text;
}

/**
 * 流式口径的 prose：只认「长句铁证」。
 *
 * 为什么只留这一条：文本片段只会变长（末尾半截标签已先剪掉，片段不会被标签闭合
 * 缩回去），所以 `≥ PROSE_LONG_RUN` 一旦成立就不再撤销——中途撤骨架出来的是正文，
 * 不会在下一个节流点变回骨架。比例那条（薄壳路径）反过来：标签流进来占比就掉、
 * 文字流进来占比就升，是骨架↔正文来回闪的第二来源，留到闭合后判一次。
 *
 * 长句占比（PROSE_LONG_RUN_SHARE）与终态同判据、同一数值：分档写两套口径才是
 * 「中途判成 A、闭合判成 B」翻面的根源，这里宁可接受它偶尔提前判 prose（正文不丢
 * 信息），也不能让骨架在闭合瞬间翻面。
 *
 * 前哨与终态共用，故中途判成 prose 的，闭合后仍判 prose（长句路径在终态里也排第一，
 * 且 svg/img、字符画、<canvas 的否决两边一样）。
 */
function streamingProseShell(s: string): boolean {
  return proseShellText(s) !== null && isProseByLongRun(s);
}

/**
 * 「文字塞卡片」的降级还原：把 HTML 片段摘成可读纯文本，交给渲染层过
 * renderMarkdown（sanitize 白名单在内）按正文流渲染。
 *
 * 顺序敏感：先整块丢弃 script/style（其内容不配出现在正文里），再剥标签，最后才
 * 解码实体——反过来先解码，`&lt;script&gt;` 会复活成真标签。块级闭标签还原成段落
 * 边界防文字粘连；行首空白剥掉，防 renderMarkdown 把模型排版缩进顶成代码块。
 */
export function stripCanvasProse(source: string): string {
  return (source ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|table|tr|blockquote|pre|section|article)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    // 伪列表符还原成 markdown 列表：模型在卡片里手写 `·` / `✓` 排版（截图里
    // 「· 别人能读你的代码」「✓ 复制代码到自己项目里用」），剥成纯文本后这些字符
    // 只是行内字面量，一段话全糊成一行。不还原的话降级出来的正文丢掉了原列表结构。
    .replace(/^([ \t]*)[·•·‧∙◦▪]\s+/gm, '$1- ')
    .replace(/^([ \t]*)√[ \t]?/gm, '$1- ')
    .replace(/^([ \t]*)[✓✔☑]\s*/gm, '$1- ')
    // 还原后连续两行是同一列表项的续行还是两个列表项，markdown 自己会按缩进判定；
    // 只需保证列表项之间有空行不会粘连（renderMarkdown 的 loose list 行为一致）。
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 文本是否呈 ASCII 字符画形态。
 *
 * 行级判据（命中其一即算一行「画」）：
 * 1. 制表字符（┌─│ 等）——字符画的强特征，单独成立；
 * 2. ≥2 个管道符且行中（非行尾）有 ≥2 连续空格——「竖线分栏 + 空格对齐」；
 *    排除行尾是避开 markdown 硬换行的尾随双空格习惯；
 * 3. ≥2 个管道符且带下划线长跑——`|__|__|` 式表格线；
 * 4. ≥3 个管道符——密集分栏（「off | low | high」式的两管道单空格写法不误伤）；
 * 5. 同行出现 ≥2 段 `___` 级下划线长跑——横线分隔。
 *    单段 `___` 可能是强调记号，不单独计。
 *
 * 整体判据：非空行数 ≥ minArt，且「画」≥ minArt 行、占非空行一半以上——
 * 少量 `|` 分隔的正文（如「off | low | high」单空格写法）不误伤。
 * minArt 传 2 供 markdown 正文段落用（段落行数天然少），围栏降级用默认 3。
 */
export function looksLikeAsciiArt(text: string, minArt = 3): boolean {
  const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < minArt) return false;
  let art = 0;
  for (const line of lines) {
    if (asciiArtLine(line)) art += 1;
  }
  return art >= minArt && art * 2 >= lines.length;
}

function asciiArtLine(line: string): boolean {
  if (/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩═║]/.test(line)) return true;
  const pipes = (line.match(/\|/g) ?? []).length;
  if (pipes >= 3) return true;
  if (pipes >= 2 && / {2,}\S/.test(line)) return true;
  if (pipes >= 2 && /_{2,}/.test(line)) return true;
  return (line.match(/_{3,}/g) ?? []).length >= 2;
}

/** 注入沙箱文档的语义色令牌（由渲染进程从 :root 计算样式读出，随主题切换重算） */
export interface CanvasTokens {
  bg: string;
  fg: string;
  muted: string;
  mutedFg: string;
  surface: string;
  border: string;
  ok: string;
  warn: string;
  bad: string;
  accent: string;
}

/**
 * 沙箱文档的预注入样式（preflight）。
 *
 * 为什么需要：模型不知道也不该知道 forge 的调色板。给它一套固定的 `--c-*` 语义变量，
 * 提示词里要求只准用这些变量取色，于是同一份卡片源码在暗色/亮色下都自动成立——
 * 换主题时我们重算 srcdoc，模型侧零改动。
 *
 * 这里刻意只做「变量声明 + 最小 reset + 滚动条」，不预设任何排版：卡片布局是模型的
 * 表达自由，我们只保证它拿得到一套和宿主同源的色。
 */
export function buildCanvasPreflight(tokens: CanvasTokens): string {
  return `<style>
:root{
  --c-bg:${tokens.bg};
  --c-fg:${tokens.fg};
  --c-muted:${tokens.muted};
  --c-muted-fg:${tokens.mutedFg};
  --c-surface:${tokens.surface};
  --c-border:${tokens.border};
  --c-ok:${tokens.ok};
  --c-warn:${tokens.warn};
  --c-bad:${tokens.bad};
  --c-accent:${tokens.accent};
  --c-ok-bg:color-mix(in oklab, ${tokens.ok} 12%, transparent);
  --c-warn-bg:color-mix(in oklab, ${tokens.warn} 14%, transparent);
  --c-bad-bg:color-mix(in oklab, ${tokens.bad} 12%, transparent);
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--c-bg);
  color:var(--c-fg);
  font-family:"Noto Sans CJK SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size:13px;
  line-height:1.7;
  padding:14px 16px;
}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:color-mix(in oklab, ${tokens.fg} 18%, transparent);border-radius:999px}
</style>`;
}

/**
 * 暗色主题下把写死的浅色「背景」重映射到 --c-surface 令牌。
 *
 * 契约第 4 条要求模型只用 --c-* 变量，但它经常不听（2026-09-29 真机：
 * `<canvas style="background:#fff">` 在暗色卡片里糊出一大块白）。这里做
 * 宿主兜底：只替换 background/background-color 属性值里的浅色字面量
 * （white / 近白 3·6 位 hex / 高亮 rgb·hsl），前景色 color、border 等一概
 * 不动——暗色下白字是常见且正确的写法，全局换 white 会把字洗没。
 * 亮色主题原样返回（白背景本来就对，不做不可逆的多余改写）。
 */
export function remapDarkBackgrounds(body: string, tokens: CanvasTokens): string {
  if (!isLightColor(tokens.bg)) return body;
  return (body ?? '').replace(
    /(background(?:-color)?\s*:\s*)(white|#(?:f{3,6}|fff[a-f0-9]{3})(?![\da-f])|rgb(?:a)?\(\s*25[0-5]\s*,\s*25[0-5]\s*,\s*25[0-5]\s*\)|hsl\(0\s*,\s*0%\s*,\s*100%\))/gi,
    `$1var(--c-surface)`,
  );
}

/** 颜色字面量是否「接近纯白」：只吃确定性的写法，不做通用色彩解析。 */
function isLightColor(color: string): boolean {
  const c = (color ?? '').trim().toLowerCase();
  if (c === 'white') return true;
  const hex = c.match(/^#([\da-f]{3}|[\da-f]{6})$/);
  if (hex) {
    const digits = hex[1]!;
    const bytes = digits.length === 3
      ? [...digits].map((h) => parseInt(h + h, 16))
      : [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
    return bytes.every((b) => b >= 240);
  }
  const rgb = c.match(/^rgb(?:a)?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return Number(rgb[1]) >= 240 && Number(rgb[2]) >= 240 && Number(rgb[3]) >= 240;
  const hsl = c.match(/^hsl\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*([\d.]+)%/);
  if (hsl) return Number(hsl[1]) >= 94;
  return false;
}

/**
 * 拼出完整的沙箱文档。卡片源码只经 remapDarkBackgrounds（暗色下换写死的浅色
 * 背景）后进 body，其余不做任何改写。
 */
export function buildCanvasDocument(body: string, tokens: CanvasTokens): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${buildCanvasPreflight(tokens)}</head><body>${remapDarkBackgrounds(body, tokens)}</body></html>`;
}

/**
 * 另存的独立 HTML 文档（脱离 forge 也能看）。
 *
 * 与 buildCanvasDocument 分开是因为语义不同：另存件要能作为独立文件被浏览器打开，
 * 所以带 <title>；沙箱件只活在 iframe 里，标题无意义。背景重映射两边共用
 * （另存件带走的正是当前主题下应有的观感）。
 */
export function buildCanvasStandaloneFile(body: string, tokens: CanvasTokens, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtmlText(title)}</title>
${buildCanvasPreflight(tokens)}
</head>
<body>${remapDarkBackgrounds(body, tokens)}</body>
</html>
`;
}

/** 文本转义（标题进 <title> 用；卡片正文本身不过这里，它进的是 iframe 沙箱） */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
