/**
 * 出图意图判定（纯函数，node:test 回归）。
 *
 * 为什么不是纯关键词：用户说「帮我把这套鉴权机制讲清楚」里没有「流程」二字，但那正是
 * 最该画图的请求。所以判定只负责「值不值得把完整输出规范塞进本轮系统提示」，
 * 不负责「要不要画图」——后者由常驻的那一句轻提示交给模型自己判断。
 *
 * 误判的代价是不对称的：多命中一次只是多花约 200 token 的规范文本，模型照样可以
 * 判断此处不需要图；漏命中则退化成用户抱怨的「1.2.3.4 文字看不懂」。故本表偏松。
 */

/** 中文意图信号 */
const ZH_PATTERNS: readonly string[] = [
  '梳理',
  '整理',
  '理清',
  '流程',
  '链路',
  '架构',
  '机制',
  '设计',
  '方案',
  '对比',
  '比较',
  '时序',
  '状态机',
  '拓扑',
  '调用关系',
  '依赖关系',
  '数据流',
  '原理',
  '讲清楚',
  '说明白',
  '看懂',
  '图解',
  '图示',
  '画个',
  '画张',
  '流程图',
  '全貌',
  '整体结构',
];

/** 英文意图信号（界面中英双语，提示词也可能是英文） */
const EN_PATTERNS: readonly string[] = [
  'walk me through',
  'flow',
  'process',
  'architecture',
  'pipeline',
  'sequence',
  'diagram',
  'visualize',
  'illustrate',
  'compare',
  'comparison',
  'side by side',
  'how does',
  'explain',
  'break down',
  'map out',
  'big picture',
];

/**
 * 判定本轮是否值得注入完整画布输出规范。
 *
 * 英文按小写子串匹配：这些词都是完整单词或短语，作为子串误伤面极小
 * （"flow" 会命中 "workflow"，但那本来就属于流程图范畴，方向一致）。
 */
export function looksLikeDiagramRequest(prompt: string): boolean {
  const text = (prompt ?? '').trim();
  if (text === '') return false;
  if (ZH_PATTERNS.some((k) => text.includes(k))) return true;
  const lower = text.toLowerCase();
  return EN_PATTERNS.some((k) => lower.includes(k));
}
