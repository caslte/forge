/**
 * 出图意图判定（纯函数，node:test 回归）。
 *
 * 只认「名词级出图请求」：用户话里出现了图的具体体裁（流程图/时序图/架构图…）、
 * 命中「画/绘+图」动词短语正则、或有明确的画图动词（visualize），才把完整输出
 * 规范塞进本轮系统提示。
 *
 * 旧版刻意偏松（「讲清楚机制 / 对比一下 / explain」这类主题泛词也命中），赌的是
 * 「多命中只多花 200 token，模型自己会判断要不要画」——真机验证输了：契约一注入，
 * 模型就把它读成「本轮该画」，纯文字说明也被包进 canvas 围栏，产出大量「文字塞
 * 卡片」的伪图示（用户实测抱怨的正是这个）。故收窄为：泛主题词一律不命中，画的
 * 口味交还给常驻段——内容真有空间结构时模型仍可自发出卡，只是没人推着每轮都画。
 *
 * 误判的代价依旧不对称，但方向反过来：多命中 = 200 token + 一次画图倾向；
 * 漏命中 = 结构化 markdown 照样把机制讲清楚，用户真想看图会说「图」。
 * ——漏网一语成谶（2026-09-29 真机）：「你画一个图」不在四个字面表里，契约没
 * 注入，模型凭常驻段幻觉出「pi 原生 canvas 渲染 ASCII」交了裸 mermaid。故动词
 * 类从字面表改正则枚举；体裁名词表不动，泛主题词照旧一律不命中。
 */

/** 中文意图信号：图的具体体裁（名词级，字面匹配即可），不含主题泛词 */
const ZH_GENRE_PATTERNS: readonly string[] = [
  '流程图',
  '时序图',
  '架构图',
  '示意图',
  '原理图',
  '结构图',
  '关系图',
  '状态机图',
  '拓扑',
  '图解',
  '图示',
  '可视化',
];

/**
 * 中文「画图动词」短语正则（2026-09-29 由字面词表改来）。
 *
 * 旧表只有 画图/画个图/画张图/画一张图 四个字面，「你画一个图」差一个字就漏网
 * （真机：漏网轮契约没注入，模型凭常驻段幻觉出「pi 原生 canvas 渲染 ASCII」）。
 * 画/绘 × 数量词的变体是有限闭集，枚举组合比 `画.{0,3}图` 这类通配准——通配会
 * 把「画布图」「画出来的图」连上，还顺着句子跨到后半句的「图」字。
 * 「整/来」两条锚行首：「整张图」「整一个图」在句中都可能是别的意思（「把这张
 * 图发我」里没有画义），只有开头祈使式才稳。
 */
const ZH_DRAW_RES: readonly RegExp[] = [
  /[画绘][一两三几]?[张幅个下]?图/,
  /^[整来][一两三几]?[张幅个]?图/,
];

/** 英文意图信号（界面中英双语，提示词也可能是英文） */
const EN_PATTERNS: readonly string[] = [
  'diagram',
  'flowchart',
  'flow chart',
  'sequence diagram',
  'architecture diagram',
  'state diagram',
  'visualize',
  'visualise',
  'illustrate',
  'draw a',
  'draw me',
  'sketch a',
  'chart',
];

/**
 * 判定本轮是否值得注入完整画布输出规范。
 *
 * 英文按小写子串匹配：这些词都是完整单词或短语，作为子串误伤面极小
 * （"chart" 会命中 "flowchart"，方向一致；"draw a" 不受 "drawback" 干扰）。
 */
export function looksLikeDiagramRequest(prompt: string): boolean {
  const text = (prompt ?? '').trim();
  if (text === '') return false;
  if (ZH_GENRE_PATTERNS.some((k) => text.includes(k))) return true;
  if (ZH_DRAW_RES.some((re) => re.test(text))) return true;
  const lower = text.toLowerCase();
  return EN_PATTERNS.some((k) => lower.includes(k));
}
