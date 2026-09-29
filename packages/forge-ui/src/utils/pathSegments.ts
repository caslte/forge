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
