/**
 * 跨行块注释状态扫描（模块 12 代码查看器）。
 *
 * 为什么不直接用 highlight.js 整篇 `highlight()` 再拆行：hljs 输出的 `<span>`
 * 可以跨换行包裹，拆行就得重排 DOM，脆且慢。也不逐行独立调 hljs——那正是
 * `highlightDiffLine`（diff 视图）的做法，行与行之间无状态，结果是**跨行块注释
 * 里除首行外的所有行都会被当成普通代码上色**。diff 里无所谓（每行是独立变更单元），
 * 但「读一个文件」时一屏 30 行灰字突然变回彩色，是很刺眼的错误。
 *
 * 所以这里只做一件事：用一次线性扫描算出「哪些行落在块注释内部」，交给渲染层
 * 决定这些行整体按注释上色；其余行照常走 hljs。语言判定与配色完全复用现有实现，
 * 不引入第二套 token 规则。
 *
 * 只处理两种块注释：C 系（`/ … /`）与 HTML（`<!-- … -->`，.vue/.html/.md 用）。
 * 行注释不影响跨行状态，交给 hljs。
 */

/** 各语言可能出现的块注释起止对；空数组表示无块注释 */
const BLOCK_PAIRS: Record<string, { open: string; close: string }[]> = {
  javascript: [{ open: '/*', close: '*/' }],
  typescript: [{ open: '/*', close: '*/' }],
  json: [],
  xml: [{ open: '<!--', close: '-->' }],
  css: [{ open: '/*', close: '*/' }],
  bash: [],
  powershell: [{ open: '<#', close: '#>' }],
  python: [],
  java: [{ open: '/*', close: '*/' }],
  go: [{ open: '/*', close: '*/' }],
  rust: [{ open: '/*', close: '*/' }],
  c: [{ open: '/*', close: '*/' }],
  cpp: [{ open: '/*', close: '*/' }],
  csharp: [{ open: '/*', close: '*/' }],
  sql: [{ open: '/*', close: '*/' }],
  yaml: [],
  markdown: [{ open: '<!--', close: '-->' }],
  diff: [],
  dockerfile: [],
};

/** 语言未注册时兜底（等价于无块注释，交给 hljs 按行处理） */
const NO_BLOCK: { open: string; close: string }[] = [];

/**
 * 标记每一行是否**整体处于**块注释内部（含注释起始行与结束行）。
 *
 * 「整行都在注释里」而非「行内某一段在注释里」：混合行（`int x; /* 注释`）交给 hljs，
 * 它自己会处理；本函数只救「完全落在注释内部」这种 hljs 逐行时看不出上下文的情况。
 *
 * @param content 文件全文
 * @param lang highlight.js 语言名（`detectDiffLanguage` 的返回值）；undefined 时全 false
 * @returns 与 content 行数等长的 boolean 数组，true = 该行整体在块注释中
 */
export function markBlockCommentLines(content: string, lang: string | undefined): boolean[] {
  const pairs = (lang && BLOCK_PAIRS[lang]) || NO_BLOCK;
  if (pairs.length === 0) return [];
  const lines = content.split('\n');
  const marks = new Array<boolean>(lines.length).fill(false);

  let inside = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!inside) {
      const open = findOutsideQuotes(line, pairs.map((p) => p.open));
      if (open === -1) continue;
      marks[i] = true;
      // 同一行内就闭合了（单行块注释）→ 不延续到下一行
      inside = !hasClose(line, open, pairs);
      continue;
    }
    marks[i] = true;
    if (hasClose(line, -1, pairs)) inside = false;
  }
  return marks;
}

/**
 * 找第一个**不在字符串/行注释里**的块注释起始符位置。
 *
 * 必须在引号外找：`const s = "/*"` 里的 `/*` 不是注释。同理 `"//"` 不是行注释。
 * 扫描时维护一个简化的引号状态机即可，不必完整解析字符串转义——本函数只用来
 * 判断「这行有没有可能进入块注释」，漏判（把字符串里的 /* 当注释）比误判更影响观感，
 * 故对转义做了处理但保持简单。
 */
function findOutsideQuotes(line: string, opens: string[]): number {
  let q: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (q !== null) {
      if (ch === '\\') {
        i += 1; // 跳过被转义的字符
        continue;
      }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      q = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') return -1; // 行注释，其后一律不算
    for (const open of opens) {
      if (line.startsWith(open, i)) return i;
    }
  }
  return -1;
}

/**
 * from 之后是否存在任一语言的块注释结束符。
 * from=-1 表示「本行开头就在注释里」，从 0 开始找即可。
 */
function hasClose(line: string, from: number, pairs: { open: string; close: string }[]): boolean {
  const start = from < 0 ? 0 : from;
  return pairs.some((p) => line.indexOf(p.close, start) !== -1);
}
