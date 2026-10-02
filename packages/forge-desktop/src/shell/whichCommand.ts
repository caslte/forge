/**
 * 在 PATH 上解析命令的全部命中行（`where` / `which`）。
 *
 * 为什么返回**数组**而不是首行：Windows 上 VS Code 的 `where code` 至少两行——
 * 第一行是无扩展名的 sh 脚本（`...\bin\code`），第二行才是 `code.cmd`。
 * 旧实现只取首行，等于把一个 spawn 不了的东西交出去。本函数只负责取回，
 * 怎么解析（.exe / 垫片 / 跳过）由 editorScan 决定。
 *
 * 照抄 gitBashResolver 的做法：数组参数、windowsHide、短超时、失败静默返回 []。
 */
import { execFile } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

/** 解析命令的全部 PATH 命中行；找不到 / 抛错一律返回 []（不把原因透给调用方） */
export function whichAll(cmd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      IS_WIN ? 'where' : 'which',
      [cmd],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s !== '');
        resolve(lines);
      },
    );
  });
}
