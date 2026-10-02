/**
 * 文件类型徽章（代码树 / 标签页共用）。
 *
 * 色板取 Linguist 官方语言色（与 demo code-tree-demo.html 同源），
 * 亮黄/亮绿系底色配深色文字，其余配白字，保证小字号下对比度。
 */
export interface FileBadge {
  /** 徽章底色 */
  bg: string;
  /** 徽章文字色 */
  fg: string;
  /** 1~2 字符缩写 */
  label: string;
}

const DARK_TEXT = '#1c1e21';

const BADGES: Record<string, FileBadge> = {
  ts: { bg: '#3178c6', fg: '#fff', label: 'TS' },
  tsx: { bg: '#3178c6', fg: '#fff', label: 'X' },
  js: { bg: '#f1e05a', fg: DARK_TEXT, label: 'JS' },
  jsx: { bg: '#f1e05a', fg: DARK_TEXT, label: 'X' },
  mjs: { bg: '#f1e05a', fg: DARK_TEXT, label: 'M' },
  cjs: { bg: '#f1e05a', fg: DARK_TEXT, label: 'C' },
  vue: { bg: '#42b883', fg: '#fff', label: 'V' },
  css: { bg: '#563d7c', fg: '#fff', label: 'C' },
  scss: { bg: '#c6538c', fg: '#fff', label: 'S' },
  less: { bg: '#2a4f9b', fg: '#fff', label: 'L' },
  html: { bg: '#e34c26', fg: '#fff', label: 'H' },
  json: { bg: '#cbcb41', fg: DARK_TEXT, label: '{}' },
  jsonc: { bg: '#cbcb41', fg: DARK_TEXT, label: '{}' },
  md: { bg: '#083fa1', fg: '#fff', label: 'M' },
  yml: { bg: '#cb171e', fg: '#fff', label: 'Y' },
  yaml: { bg: '#cb171e', fg: '#fff', label: 'Y' },
  toml: { bg: '#9c4221', fg: '#fff', label: 'T' },
  py: { bg: '#3572a5', fg: '#fff', label: 'PY' },
  rs: { bg: '#dea584', fg: DARK_TEXT, label: 'RS' },
  go: { bg: '#00add8', fg: DARK_TEXT, label: 'GO' },
  java: { bg: '#b07219', fg: '#fff', label: 'J' },
  c: { bg: '#555', fg: '#fff', label: 'C' },
  h: { bg: '#555', fg: '#fff', label: 'H' },
  cpp: { bg: '#f34b7d', fg: '#fff', label: 'C+' },
  sh: { bg: '#89e051', fg: DARK_TEXT, label: '$' },
  bash: { bg: '#89e051', fg: DARK_TEXT, label: '$' },
  bat: { bg: '#c1f12e', fg: DARK_TEXT, label: '#' },
  cmd: { bg: '#c1f12e', fg: DARK_TEXT, label: '#' },
  lock: { bg: '#888', fg: '#fff', label: '🔒' },
  svg: { bg: '#ff9800', fg: DARK_TEXT, label: 'S' },
  png: { bg: '#2e7d32', fg: '#fff', label: 'P' },
  jpg: { bg: '#2e7d32', fg: '#fff', label: 'J' },
  jpeg: { bg: '#2e7d32', fg: '#fff', label: 'J' },
  gif: { bg: '#2e7d32', fg: '#fff', label: 'G' },
  webp: { bg: '#2e7d32', fg: '#fff', label: 'W' },
  ico: { bg: '#2e7d32', fg: '#fff', label: 'IC' },
  ttf: { bg: '#777', fg: '#fff', label: 'T' },
  woff: { bg: '#777', fg: '#fff', label: 'W' },
  woff2: { bg: '#777', fg: '#fff', label: 'W' },
  txt: { bg: '#6a737d', fg: '#fff', label: 'T' },
  env: { bg: '#ecd53f', fg: DARK_TEXT, label: 'E' },
  gitignore: { bg: '#f03c2e', fg: '#fff', label: 'G' },
  gitattributes: { bg: '#f03c2e', fg: '#fff', label: 'G' },
  license: { bg: '#f03c2e', fg: '#fff', label: 'L' },
};

const FALLBACK: FileBadge = { bg: '#8892a0', fg: '#fff', label: '·' };

/**
 * 目录色块已经不用了（CodeTreePanel 改用线性文件夹图标）。
 *
 * 保留导出仅为兼容旧引用：目录行曾用「青绿方块 + 字母 D」，实机十几个目录连排时
 * 8.5px 的 D 就是一团糊，而且青绿与选中行的品牌绿撞色，把“选中”盖过了。
 * 需要目录色时请用 --muted-foreground，不要新开一块品牌色。
 *
 * @deprecated
 */
export const DIR_BADGE: FileBadge = { bg: '#8892a0', fg: '#fff', label: 'D' };

/** 按文件名取徽章：先查扩展名，再查整名（.gitignore / LICENSE 这类无扩展名文件） */
export function fileBadgeOf(name: string): FileBadge {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const b = BADGES[lower.slice(dot + 1)];
    if (b) return b;
  }
  return BADGES[lower] ?? FALLBACK;
}
