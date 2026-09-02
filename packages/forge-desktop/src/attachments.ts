/**
 * 附件统一"给路径"机制的主进程侧能力。
 *
 * 附件不再读取内容内联进消息：选择/拖拽/粘贴的文件只把绝对路径放进消息正文，
 * 由模型自行用 read 工具读取。本模块只做两件事：
 * 1. scanAttachments：附件加入待发区前的密钥嗅探（文本文件命中凭据特征 → flagged，
 *   发送前由 UI 弹确认——这是附件内容出域前的唯一防线，不能删）。
 * 2. savePasteImage：剪贴板截图落盘（截图本来不在盘上，给路径前必须先落成临时文件）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 疑似密钥/凭据特征（高置信度，避免对源码误报）：私钥块 / AWS / GitHub / OpenAI / Slack */
export const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

/** 参与密钥嗅探的文本扩展名（与附件选择器过滤一致） */
const TEXT_SCAN_EXTS = new Set([
  'txt', 'md', 'json', 'log', 'csv', 'yaml', 'yml', 'toml', 'xml', 'html', 'css',
  'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h',
]);

/** 单文件嗅探读取上限：只看头部，密钥一般在前部 */
const SCAN_MAX_BYTES = 1024 * 1024;

export interface AttachmentScanResult {
  path: string;
  name: string;
  /** 命中疑似密钥/凭据：发送前需用户确认 */
  flagged: boolean;
}

/** 对一批附件路径做密钥嗅探；图片/缺失/不可读文件不标记，不抛错 */
export function scanAttachments(paths: string[]): AttachmentScanResult[] {
  return paths.map((p) => {
    const name = path.basename(p);
    const ext = (path.extname(p) || '').slice(1).toLowerCase();
    if (!TEXT_SCAN_EXTS.has(ext)) {
      return { path: p, name, flagged: false };
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) {
        return { path: p, name, flagged: false };
      }
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, SCAN_MAX_BYTES));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return { path: p, name, flagged: SECRET_PATTERNS.some((re) => re.test(buf.toString('utf8'))) };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { path: p, name, flagged: false };
    }
  });
}

/** 粘贴截图落盘：base64 图片 → 系统临时目录，返回真实路径（forge-paste-HHmmss.ext） */
export function savePasteImage(base64Data: string, ext = 'png'): { path: string; name: string } {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'png';
  const name = `forge-paste-${hh}${mm}${ss}.${safeExt}`;
  const filePath = path.join(os.tmpdir(), name);
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  return { path: filePath, name };
}

/** 缩略图读取上限：与旧附件图片上限一致 */
const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 磁盘图片读为 data URL（仅缩略图/预览用，非消息通道）；缺失/超大/非图片返回 null */
export function readImageDataUrl(filePath: string): string | null {
  const ext = (path.extname(filePath) || '').slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > THUMBNAIL_MAX_BYTES) return null;
    const buf = fs.readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
