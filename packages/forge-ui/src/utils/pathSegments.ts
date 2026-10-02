/**
 * 正斜杠路径的词法段折叠（不触碰文件系统）。
 *
 * 文件类工具入参常带 `./` 前缀（如 `./yewu/swift/build_docker.sh`），与项目根字符串
 * 拼接后中间会残留 `/./` 段。Node 的 statSync 能解析这种路径，但 Windows 的
 * ShellExecuteEx（shell.openPath 底层）不归一中间段，会弹「Windows 找不到文件」——
 * 所以交给 openPath 前必须先折叠。入参约定为已归一成正斜杠的路径（useChangedFiles）。
 */

/**
 * 折叠 `.` / `..` / 空段：绝对路径（`C:/`、`/`、`//` 前缀）在根/盘符处截停 `..`，
 * 相对路径顶部多出的 `..` 保留原样（后续交主进程 stat 校验失败即可，不伪造路径）。
 */
export function collapseDotSegments(p: string): string {
  const prefix = /^(?:[a-zA-Z]:\/|\/\/|\/)/.exec(p)?.[0] ?? '';
  const segs: string[] = [];
  let ups = 0; // 相对路径顶部未被消费的 .. 数（绝对路径被根截停，恒 0）
  for (const seg of p.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length > 0) segs.pop();
      else if (prefix === '') ups += 1;
    } else {
      segs.push(seg);
    }
  }
  return prefix + [...Array(ups).fill('..'), ...segs].join('/');
}

/** 看起来是不是绝对路径（正斜杠口径：/ 开头、盘符开头、UNC 开头） */
function looksAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('//');
}

/**
 * 把「项目内相对路径」或「已是绝对路径」统一成可交给主进程的绝对路径。
 *
 * 为什么要折叠中间段：见本文件顶部——Windows 的 ShellExecuteEx 不归一 `/./`，
 * 拼接后残留 `./` 会直接弹「找不到文件」。
 *
 * 为什么不判断 relPath 是否越界（`../../etc/passwd`）：这里只做**词法**拼接，
 * 越界与软链的最终裁决在主进程（shell/openTarget.ts 用 lstat 拒软链、
 * openPath 恒校验目标是真实目录）。渲染层再抄一份边界判断只会出现两套不一致的口径。
 *
 * @param projectRoot 项目根；为空时原样返回（让主进程自己失败）
 */
export function absoluteFilePath(projectRoot: string | null | undefined, p: string): string {
  if (looksAbsolute(p)) return collapseDotSegments(p);
  const root = (projectRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return root !== '' ? collapseDotSegments(`${root}/${p}`) : p;
}

/**
 * 取正斜杠路径的目录部分。根目录 / 单段名原样返回——
 * 调用方（如「打开所在目录」）把这种值交给 openPath，让它自己失败即可。
 */
export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}

/** 正斜杠路径的最后一段（文件名 / 目录名） */
export function baseNameOf(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}
