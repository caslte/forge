/**
 * 出图意图判定（纯函数，node:test 回归）。
 *
 * 只认「名词级出图请求」：用户话里出现了图的具体体裁（流程图/时序图/架构图…）或
 * 明确的画图动词（画个图/visualize），才值得把完整输出规范塞进本轮系统提示。
 *
 * 旧版刻意偏松（「讲清楚机制 / 对比一下 / explain」这类主题泛词也命中），赌的是
 * 「多命中只多花 200 token，模型自己会判断要不要画」——真机验证输了：契约一注入，
 * 模型就把它读成「本轮该画」，纯文字说明也被包进 canvas 围栏，产出大量「文字塞
 * 卡片」的伪图示（用户实测抱怨的正是这个）。故收窄为：泛主题词一律不命中，画的
 * 口味交还给常驻段——内容真有空间结构时模型仍可自发出卡，只是没人推着每轮都画。
 *
 * 误判的代价依旧不对称，但方向反过来：多命中 = 200 token + 一次画图倾向；
 * 漏命中 = 结构化 markdown 照样把机制讲清楚，用户真想看图会说「图」。
 */

/** 中文意图信号：图的具体体裁 / 明确画图动词，不含主题泛词 */
const ZH_PATTERNS: readonly string[] = [
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
  '画图',
  '画个图',
  '画张图',
  '画一张图',
  '可视化',
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
  if (ZH_PATTERNS.some((k) => text.includes(k))) return true;
  const lower = text.toLowerCase();
  return EN_PATTERNS.some((k) => lower.includes(k));
}
