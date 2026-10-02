/**
 * 「用外部编辑器打开」通道的目标校验与编辑器解析。
 *
 * 为什么单独一条通道（延续 CV-TRUST-02 的思路，见 docs/changelog.md:132）：
 * 这条通道**会启动一个外部程序**（VSCode / Cursor），比 openPath（只放行目录）和
 * openInBrowser（只放行 .html/.htm 普通文件）都更危险，所以口子收得更紧：
 *
 *  1. 目标必须是「已存在的**普通文件**」——用 `lstat` 判定，不跟随软链。
 *     指向别处的软链一律拒：解析编辑器命令本身不该成为软链逃逸的跳板。
 *  2. 文件名**不得以 `-` 开头**。编辑器 CLI 把参数交给自身解析，
 *     `--user-data-dir=C:\evil`、`-psn_0_12345` 之类会被当成开关而不是文件名
 *     （Mac 上 VSCode 还会据此把焦点抢到别的窗口）。我们不拼 `--` 也不赌各家 CLI
 *     对 `--` 的支持差异，直接拒掉以 `-` 开头的基名。
 *  3. 只启动**扫描出来的**编辑器（shell/editorScan.ts：白名单 + PATH/安装路径解析出
 *     真实 .exe），渲染层不能传命令名、不能传参数串——只传文件路径和一个编辑器 id。
 *  4. 永不 `shell: true`。参数以数组传入（与 gitService.execFile 同款），
 *     杜绝命令拼接。
 *
 * 与 openInBrowser 的区别：那条交给系统「用默认程序打开」（.html 才放行），
 * 这条是**显式指定**用哪个编辑器打开任意文本文件。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 纯判定：目标是否可以被交给外部编辑器。
 *
 * 与 resolveBrowserOpenTarget 同款结构（词法归一 → lstat 判普通文件），
 * 差别在于**不设扩展名白名单**（文本/二进制都能让编辑器自己处理），
 * 但多一条「基名不得以 `-` 开头」的参数注入防护。
 *
 * @returns 可安全交给编辑器的绝对路径；不满足任一条件返回 null
 */
export function resolveEditorOpenTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const normalized = path.normalize(raw);
  const base = path.basename(normalized);
  if (base.startsWith('-')) return null; // 参数注入，见文件头第 2 条
  let st: fs.Stats;
  try {
    st = fs.lstatSync(normalized);
  } catch {
    // 不存在 / 无权限 / 路径含非法字符：一律按「打不开」处理，不把原因透给渲染层
    return null;
  }
  if (!st.isFile()) return null;
  return normalized;
}
