/**
 * 附件格式白名单（单一事实来源）。
 *
 * 附件三入口共用：文件选择器（主进程 dialog filters）、粘贴与拖拽（渲染层
 * addPaths 统一校验）。此前仅选择器有软过滤（可手动输入文件名绕过），粘贴/
 * 拖拽完全不判格式；现统一按此白名单硬校验，避免多处列表漂移。
 *
 * 注意：xlsx/xls/docx/doc 为二进制（zip）格式，不参与 forge-desktop 的密钥
 * 嗅探（TEXT_SCAN_EXTS 仅收文本扩展名，对压缩字节做明文正则无意义）。
 */

/** 附件允许的扩展名：图片 / 文本与代码 / Office 文档 */
export const ATTACHMENT_EXTENSIONS: readonly string[] = [
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  // 文本与代码
  'txt', 'md', 'json', 'log', 'csv', 'yaml', 'yml', 'toml', 'xml', 'html', 'css',
  'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h',
  // Office 文档
  'xlsx', 'xls', 'docx', 'doc',
];

/** Electron 附件选择对话框过滤项（由白名单派生） */
export const ATTACHMENT_DIALOG_FILTER = {
  name: '图片、文本与文档',
  extensions: [...ATTACHMENT_EXTENSIONS],
};

/** 路径是否为允许的附件格式（按扩展名判断，大小写不敏感） */
export function isAllowedAttachmentPath(p: string): boolean {
  const ext = (p.split('.').pop() ?? '').toLowerCase();
  return ATTACHMENT_EXTENSIONS.includes(ext);
}
