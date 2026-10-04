/**
 * 把 `git diff`（unified）文本解析成两种并排/行内视图数据（模块 12「并排 diff」
 * 与「行内高亮」的解析层）。
 *
 * 数据源是 `git/getFileDiff` 的原始输出（真实 git，默认 3 行上下文）。
 * 两个投影共用**同一条状态机**（walkUnifiedDiff 的事件流），各自的行号计数、
 * 配对/锚点规则互不掺和：
 * - parseGitUnifiedDiff → 并排行（DiffView 同一契约，`SideBySideRow` 复用
 *   @forge/core 的类型，渲染层两处零翻译）；
 * - parseGitInlineDiff → 行级标记 + 删除块锚点（CodeViewer 文件正文上色用）。
 *
 * 为什么不在 UI 里重新对齐（拿 HEAD 版本走 buildSideBySideDiff）：
 * 1. LCS 是 O(m×n) 内存，几千行的文件就是几百 MB 级的表；
 * 2. git 已经算好了对齐——hunk 内的行序就是对齐结果，照搬即可。
 *
 * 状态机只有一个坑要躲：`--- `/`+++ ` 只在 hunk **外**是文件元数据，
 * hunk 内的同前缀行是内容（`--- foo` = 删除行「- foo」）。用 inHunk 区分；
 * hunk 头判定放在最前（相邻 hunk 之间没有分隔行，头既是开也是关）。
 */
import type { SideBySideCell, SideBySideRow } from '@forge/core/side-by-side-diff';

/** 并排投影的解析结果：rows 供渲染；binary=true 时 UI 给二进制专门空态 */
export interface ParsedGitDiff {
  rows: SideBySideRow[];
  binary: boolean;
}

/** hunk 头：`@@ -3,7 +3,8 @@`（,count 缺省 = 1；新文件旧侧是 -0,0） */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 状态机吐出的行事件（两个投影共用的唯一输入） */
type DiffEvent =
  | { kind: 'hunk'; oldNo: number; newNo: number }
  | { kind: 'equal'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'binary' };

function walkUnifiedDiff(diff: string): DiffEvent[] {
  const events: DiffEvent[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    // hunk 头判定放最前：它既是「开 hunk」也可能是「上一个 hunk 的结束」
    const hm = HUNK_RE.exec(line);
    if (hm) {
      events.push({ kind: 'hunk', oldNo: Number(hm[1]), newNo: Number(hm[3]) });
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        events.push({ kind: 'binary' });
      }
      // 其余（---/+++/index/rename…）都是 hunk 外元数据
      continue;
    }
    const body = line.slice(1);
    if (line.startsWith(' ') || line === '') {
      // 空串按「空上下文」处理：git 本体对空上下文行输出的是单个空格，
      // 但经手写 fixture/转写工具后常被剥成裸空行——宽容它，别把 hunk 掐断
      events.push({ kind: 'equal', text: body });
    } else if (line.startsWith('-')) {
      events.push({ kind: 'del', text: body });
    } else if (line.startsWith('+')) {
      events.push({ kind: 'add', text: body });
    } else if (line.startsWith('\\')) {
      // 「\ No newline at end of file」：不是内容行
    } else {
      // 不认识的行族：保守关 hunk（防 git 未来加元数据行被当成内容）
      inHunk = false;
    }
  }
  return events;
}

/** 配对一个 pending 的删除/新增块（多出的一侧为 null，与 core 配对口径一致） */
function flushPending(
  rows: SideBySideRow[],
  removed: SideBySideCell[],
  added: SideBySideCell[],
): void {
  const count = Math.max(removed.length, added.length);
  for (let i = 0; i < count; i += 1) {
    rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
  }
  removed.length = 0;
  added.length = 0;
}

export function parseGitUnifiedDiff(diff: string | null): ParsedGitDiff {
  if (!diff) return { rows: [], binary: false };
  const rows: SideBySideRow[] = [];
  const pendingRemoved: SideBySideCell[] = [];
  const pendingAdded: SideBySideCell[] = [];
  let binary = false;
  let oldNo = 0;
  let newNo = 0;

  for (const ev of walkUnifiedDiff(diff)) {
    switch (ev.kind) {
      case 'hunk':
        flushPending(rows, pendingRemoved, pendingAdded);
        oldNo = ev.oldNo;
        newNo = ev.newNo;
        break;
      case 'equal':
        flushPending(rows, pendingRemoved, pendingAdded);
        rows.push({
          left: { type: 'equal', text: ev.text, line: oldNo },
          right: { type: 'equal', text: ev.text, line: newNo },
        });
        oldNo += 1;
        newNo += 1;
        break;
      case 'del':
        pendingRemoved.push({ type: 'removed', text: ev.text, line: oldNo });
        oldNo += 1;
        break;
      case 'add':
        pendingAdded.push({ type: 'added', text: ev.text, line: newNo });
        newNo += 1;
        break;
      case 'binary':
        binary = true;
        break;
    }
  }
  flushPending(rows, pendingRemoved, pendingAdded);
  return { rows, binary };
}

/* ===== 行内投影（文件正文 + 行级标记） ===== */

/** 删除占位条里的一行（**旧文件**行号——工作区文件里没有这些行） */
export interface InlineDelLine {
  no: number;
  text: string;
}

/**
 * 删除占位条：贴在新文件第 afterLine 行**之后**；afterLine=null = 文件最前
 * （首个新行之前）。id 在单次解析结果内递增，供展开态集合当稳定 key。
 */
export interface InlineDelBlock {
  id: number;
  afterLine: number | null;
  lines: InlineDelLine[];
}

/** 行内投影：新增行按行号上色；被删行进占位条（-旧 +新 的替换也算） */
export interface ParsedInlineDiff {
  addedLines: number[];
  delBlocks: InlineDelBlock[];
  binary: boolean;
}

export function parseGitInlineDiff(diff: string | null): ParsedInlineDiff {
  if (!diff) return { addedLines: [], delBlocks: [], binary: false };
  const addedLines: number[] = [];
  const delBlocks: InlineDelBlock[] = [];
  let binary = false;
  let oldNo = 0;
  let newNo = 0;
  let blockId = 0;
  let pending: InlineDelLine[] = [];
  /** 块首行定格的锚点：块贴在新文件第 anchor 行之后；0 = 文件最前 */
  let anchor = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    blockId += 1;
    delBlocks.push({ id: blockId, afterLine: anchor === 0 ? null : anchor, lines: pending });
    pending = [];
  };

  for (const ev of walkUnifiedDiff(diff)) {
    switch (ev.kind) {
      case 'hunk':
        flush();
        oldNo = ev.oldNo;
        newNo = ev.newNo;
        break;
      case 'equal':
        flush();
        oldNo += 1;
        newNo += 1;
        break;
      case 'del':
        // 锚点在块首行定格：此刻 newNo 是「下一个新行号」，块贴在它前一行之后
        if (pending.length === 0) anchor = Math.max(0, newNo - 1);
        pending.push({ no: oldNo, text: ev.text });
        oldNo += 1;
        break;
      case 'add':
        flush();
        addedLines.push(newNo);
        newNo += 1;
        break;
      case 'binary':
        binary = true;
        break;
    }
  }
  flush();
  return { addedLines, delBlocks, binary };
}

/* ===== 并排视图的省略段（hunk 之间「未变更 N 行」分隔条的数据源） ===== */

/** 一段被省略的未变更区域：count=行数；endsAt=其后第一条新行号（null=文件末尾尾段） */
export interface DiffOmission {
  count: number;
  endsAt: number | null;
}

/**
 * 算出并排视图的省略段。git diff 只产出变更块 ±上下文，hunk 之间的未变更区域
 * 不在输出里——直接渲染就是「行号无解释地跳变」（用户 2026-10-03 报）。
 * 行号推进规则：右侧（新文件）行号连续推进，纯删除行（right=null）不占新文件行；
 * 尾段用文件总行数（activeFile.data.totalLines）兜底。
 */
export function collectDiffOmissions(rows: SideBySideRow[], totalLines: number): DiffOmission[] {
  const out: DiffOmission[] = [];
  let expect = 1;
  for (const row of rows) {
    const right = row.right;
    if (!right) continue;
    if (right.line > expect) {
      out.push({ count: right.line - expect, endsAt: right.line });
    }
    expect = right.line + 1;
  }
  if (totalLines >= expect) {
    out.push({ count: totalLines - expect + 1, endsAt: null });
  }
  return out;
}
