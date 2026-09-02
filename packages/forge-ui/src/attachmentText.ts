/**
 * 用户消息附件解析（展示层）。
 *
 * 附件统一给路径后，用户消息里可能出现两种附件形态：
 * 1. 尾部连续绝对路径行（`正文\nC:\a\x.ts\nC:\b\y.png`，forge 附件发送格式）
 * 2. markdown 链接图片 `[Image #1](file:///C:/...)`（pi 侧会话带来的格式）
 *
 * 气泡展示时：图片 → 缩略图（不显示路径）；非图片 → 文件占位 chip（title 显示完整路径）。
 */

/** 图片扩展名 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export interface ParsedUserContent {
  /** 去除附件引用后的正文 */
  body: string;
  /** 非图片附件路径（chip 展示） */
  files: string[];
  /** 图片附件路径（缩略图展示） */
  images: string[];
}

/** 单行是否为绝对路径（Windows 盘符 / Unix 根开头） */
function isPathLine(line: string): boolean {
  return /^[A-Za-z]:[\\/].+/.test(line) || /^\/.+/.test(line);
}

/** file:/// URL → 本地路径；其余原样返回 */
function fileUrlToPath(target: string): string {
  if (target.startsWith('file://')) {
    try {
      // file:///C:/x.png 去掉 scheme 后残留的 /（Windows 盘符前的第三条斜杠）一并去掉
      return decodeURIComponent(target.replace(/^file:\/\/(localhost)?\//, ''));
    } catch {
      return target;
    }
  }
  return target;
}

function isImagePath(p: string): boolean {
  const ext = (p.split('.').pop() ?? '').toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/** 文件名提取（chip 展示用） */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export { isImagePath };

/**
 * 解析用户消息：markdown 链接图片（任意位置）与尾部连续路径行提取为附件，
 * 其余为正文。正文中间的裸路径视为普通文字不提取。
 */
export interface ParseUserContentOptions {
  /**
   * 消息已含 base64 图片 part（pi 会话格式：文本里的链接/占位符与 image part 指向同一批图）。
   * 为 true 时：正文里的链接图片与 [Image #N] 占位行只剥离、不提取缩略图——
   * 缩略图由 base64 part 渲染，避免同一张图出现两遍。
   */
  hasEmbeddedImages?: boolean;
}

/** pi 图片占位标记行（裸 [Image #N]） */
const IMAGE_MARKER_LINE = /^\s*\[Image #\d+\]\s*$/;

export function parseUserContent(content: string, options?: ParseUserContentOptions): ParsedUserContent {
  const images: string[] = [];
  // 1) markdown 链接形式的本地图片引用（[x](file:///)、[[x]](盘符路径)、![](路径) 均可），任意位置；
  //    消息已含 base64 part 时链接只是同一批图的引用：剥离但不提取，避免双重渲染
  let text = content.replace(/!?\[+[^\]]*\]+\(([^)\s]+)\)/g, (match, target: string) => {
    const p = fileUrlToPath(target);
    if (isImagePath(p) && (isPathLine(p) || p.startsWith('file://'))) {
      if (!options?.hasEmbeddedImages) {
        images.push(p);
      }
      return '';
    }
    return match;
  });
  // 2) 尾部连续绝对路径行（forge 附件发送格式）
  const lines = text.split('\n');
  const files: string[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1] ?? '';
    if (line === '' || !isPathLine(line)) break;
    if (isImagePath(line)) images.push(line);
    else files.push(line);
    end -= 1;
  }
  text = lines.slice(0, end).join('\n');
  // 3) 裸 [Image #N] 占位行（pi 会话格式，与 base64 part 同批）：剥离不重复展示
  if (options?.hasEmbeddedImages) {
    text = text
      .split('\n')
      .filter((l) => !IMAGE_MARKER_LINE.test(l))
      .join('\n');
  }
  // 清理移除附件引用后残留的首尾空行
  return { body: text.trim(), files, images };
}
