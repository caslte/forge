/**
 * 输入框 @ 弹文件补全纯函数（CV-S01 扩展，v3.30：与附件 @路径行协议闭环）。
 *
 * 交互同斜杠命令浮窗（检测→过滤→键盘选择），区别：
 * - 触发：行内任意位置的 `@` token（不限行首；`@` 前必须有空白/行首，邮箱不触发）
 * - 选中：`@filter` token 从文本移除，文件进待发区（addPaths），发送时由
 *   onSend 统一拼成 @路径行 —— 不内联插入路径，展示层零歧义。
 * - 纯 TS 零依赖（Node type stripping 可直跑，先例 utils/slashCommand.ts）。
 */

/** 激活态：光标所在 token 以 `@` 开头，`@` 至光标无空白 */
export interface ActiveAtContext {
  active: true;
  /** 过滤串：`@` 后至光标的文本（空串 = 刚输入 `@`，列全量候选） */
  filter: string;
  /** `@` 字符位置（= 待移除区间起点） */
  atStart: number;
}

/** 未激活态 */
export interface InactiveAtContext {
  active: false;
}

export type AtContext = ActiveAtContext | InactiveAtContext;

const INACTIVE: InactiveAtContext = { active: false };

/**
 * 检测光标处是否处于 @ 补全上下文：
 * - 光标前最近的空白之后为 token；token 首字符必须是 `@`；
 * - `@` 前一个字符必须是空白或行首（`a@b` 邮箱类不触发）；
 * - 非字符串/光标越界等一律不激活。
 */
export function detectAtContext(text: string, caret: number): AtContext {
  if (typeof text !== 'string' || text === '') return INACTIVE;
  if (typeof caret !== 'number' || !Number.isFinite(caret) || !Number.isInteger(caret)) return INACTIVE;
  if (caret < 0 || caret > text.length) return INACTIVE;
  let atStart = caret;
  while (atStart > 0 && !/\s/.test(text[atStart - 1] ?? '')) atStart -= 1;
  if (text[atStart] !== '@') return INACTIVE;
  if (atStart === caret) return INACTIVE; // 光标压在 @ 上（其前），命令尚未进入光标左侧
  const before = atStart > 0 ? (text[atStart - 1] ?? '') : '';
  if (before !== '' && !/\s/.test(before)) return INACTIVE; // 前面是 token 内字符：邮箱等
  return { active: true, filter: text.slice(atStart + 1, caret), atStart };
}

/**
 * 按过滤串过滤 + 排序候选文件（大小写不敏感）：
 * basename 前缀 > basename 包含 > 路径包含；同级路径短者前。
 * 空过滤串按原序（BFS 浅层优先）截前 limit 条；无匹配返回 []。
 */
export function filterAtFiles(files: string[], filter: string, limit = 30): string[] {
  if (!Array.isArray(files)) return [];
  const q = (typeof filter === 'string' ? filter : '').toLowerCase();
  if (q === '') return files.slice(0, limit);
  const scored: Array<{ p: string; rank: number }> = [];
  for (const p of files) {
    if (typeof p !== 'string' || p === '') continue;
    const lp = p.toLowerCase();
    if (!lp.includes(q)) continue;
    const base = (lp.split(/[\\/]/).pop() ?? '');
    const rank = base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2;
    scored.push({ p, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.p.length - b.p.length || (a.p < b.p ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.p);
}
