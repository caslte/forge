/**
 * edit 工具并排 Diff 行生成（P1-B，PRD TE-S03 / TD-TE-01）。
 *
 * 职责：把 old/new 文本按行对齐为并排行列表（左=旧，右=新），供前端
 * DiffView 渲染。纯函数、无依赖、无 DOM。
 *
 * 算法：经典 LCS 动态规划做行对齐；连续删除块与新增块按顺序逐行配对为
 * 「替换行」（左 removed / 右 added），多出的删除行右侧为空，多出的新增行
 * 左侧为空。
 *
 * 降级（roadmap P1-B 验收）：
 * - oldString 为 null/空 → 全量新增（新建文件或缺失旧文本）
 * - newString 为 null/空 → 全量删除
 * - 两者皆空 → 空列表
 */

/** 单侧单元格类型 */
export interface SideBySideCell {
  type: 'equal' | 'removed' | 'added';
  text: string;
  /** 源文本中的行号（1 起始） */
  line: number;
}

/** 并排一行：left/right 至少一侧非空 */
export interface SideBySideRow {
  left: SideBySideCell | null;
  right: SideBySideCell | null;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

export function buildSideBySideDiff(
  oldString: string | null,
  newString: string | null,
): SideBySideRow[] {
  const oldLines = splitLines(oldString ?? '');
  const newLines = splitLines(newString ?? '');

  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) return addedOnly(newLines);
  if (newLines.length === 0) return removedOnly(oldLines);

  // LCS 长度表
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // 回溯出操作序列（equal / removed / added）
  type Op = { kind: 'equal' | 'removed' | 'added'; oldIdx?: number; newIdx?: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: 'equal', oldIdx: i, newIdx: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'removed', oldIdx: i });
      i += 1;
    } else {
      ops.push({ kind: 'added', newIdx: j });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ kind: 'removed', oldIdx: i });
    i += 1;
  }
  while (j < n) {
    ops.push({ kind: 'added', newIdx: j });
    j += 1;
  }

  // 连续 removed 块与 added 块按序配对成替换行
  const rows: SideBySideRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === 'equal') {
      rows.push({
        left: { type: 'equal', text: oldLines[op.oldIdx!]!, line: op.oldIdx! + 1 },
        right: { type: 'equal', text: newLines[op.newIdx!]!, line: op.newIdx! + 1 },
      });
      k += 1;
      continue;
    }
    const removedBlock: number[] = [];
    while (k < ops.length && ops[k]!.kind === 'removed') {
      removedBlock.push(ops[k]!.oldIdx!);
      k += 1;
    }
    const addedBlock: number[] = [];
    while (k < ops.length && ops[k]!.kind === 'added') {
      addedBlock.push(ops[k]!.newIdx!);
      k += 1;
    }
    const pairCount = Math.max(removedBlock.length, addedBlock.length);
    for (let p = 0; p < pairCount; p += 1) {
      const oldIdx = removedBlock[p];
      const newIdx = addedBlock[p];
      rows.push({
        left:
          oldIdx !== undefined
            ? { type: 'removed', text: oldLines[oldIdx]!, line: oldIdx + 1 }
            : null,
        right:
          newIdx !== undefined
            ? { type: 'added', text: newLines[newIdx]!, line: newIdx + 1 }
            : null,
      });
    }
  }
  return rows;
}

function addedOnly(lines: string[]): SideBySideRow[] {
  return lines.map((text, idx) => ({
    left: null,
    right: { type: 'added' as const, text, line: idx + 1 },
  }));
}

function removedOnly(lines: string[]): SideBySideRow[] {
  return lines.map((text, idx) => ({
    left: { type: 'removed' as const, text, line: idx + 1 },
    right: null,
  }));
}
