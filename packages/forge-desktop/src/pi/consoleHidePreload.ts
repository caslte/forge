/**
 * Windows 控制台弹窗治理（孙进程层）：pi 内置 CLI 在 Windows 上经 cross-spawn 调
 * cmd.exe 跑 npm（`pi install` / `pi update --extensions`），引擎的
 * DefaultPackageManager.spawnCommand 未传 windowsHide。forge 外层 execFile 的
 * windowsHide:true 只作用于直接子进程（CLI 本身），孙进程（cmd.exe → npm）会向
 * Windows 申请新的可见控制台 → 用户看到标题为 "npm install pi-mcp-adapter@…"
 * 的黑色命令行窗口（Node 已知行为：CREATE_NO_WINDOW 不跨进程树传递）。
 *
 * 修法：不动 node_modules（bump-pi / 重装会冲掉补丁），而是在 CLI 子进程启动时
 * 注入一个 CJS 预加载（`node --require <preload> cli.js …`），把
 * child_process.spawn / spawnSync 的缺省 windowsHide 改为 true。引擎的
 * cross-spawn 是经 exports 对象在调用时取 cp.spawn（已核实 bundle 结构），
 * 预加载先行生效；cmd.exe 拿到隐藏控制台后，其后代（npm → node）继承同一
 * 控制台，整棵进程树不再弹窗。显式传过 windowsHide 的调用不受影响。
 *
 * 文件在运行期写入 <userData>（agentDir 的父目录）：dev 与打包产物路径一致，
 * tsc 不拷贝 src 下的 .cjs 资产，落盘生成是两栖方案里最省事的。
 * 任何失败一律返回 null 静默降级（仅回退为「会弹窗」的原行为，不影响更新功能）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 预加载文件名（落在 userData 根，与 updater-state.json 等自有文件同级） */
export const CONSOLE_HIDE_PRELOAD_NAME = 'pi-cli-console-hide-preload.cjs';

/** 生成预加载脚本内容（CJS；引擎 CLI 子进程以 node 模式运行，require 可用） */
export function buildConsoleHidePreloadSource(): string {
  return [
    '/* forge 生成：Windows 下给 child_process.spawn/spawnSync 缺省注入 windowsHide，',
    ' * 防止引擎经 cross-spawn 调 cmd.exe 跑 npm 时弹出控制台窗口。请勿手改。 */',
    "'use strict';",
    "if (process.platform === 'win32') {",
    '  try {',
    "    var cp = require('node:child_process');",
    '    var forgeIsOpts = function (v) {',
    '      return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);',
    '    };',
    '    var forgeWithHide = function (opts) {',
    '      if (forgeIsOpts(opts)) {',
    '        return opts.windowsHide === undefined ? Object.assign({}, opts, { windowsHide: true }) : opts;',
    '      }',
    '      return { windowsHide: true };',
    '    };',
    '    var forgeWrap = function (orig) {',
    '      return function (file, a, b) {',
    '        // spawn(file[, args][, options])：args 缺省时第二参即 options',
    '        if (a === undefined || a === null || forgeIsOpts(a)) {',
    '          return orig.call(this, file, forgeWithHide(forgeIsOpts(a) ? a : undefined));',
    '        }',
    '        return orig.call(this, file, a, forgeWithHide(forgeIsOpts(b) ? b : undefined));',
    '      };',
    '    };',
    '    cp.spawn = forgeWrap(cp.spawn);',
    '    cp.spawnSync = forgeWrap(cp.spawnSync);',
    '  } catch (_err) { /* 静默：补丁失败仅回退为原弹窗行为 */ }',
    '}',
    '',
  ].join('\n');
}

/**
 * 确保预加载文件存在（内容不符时重写），返回绝对路径。
 * 仅 Windows 需要；其他平台返回 null（调用方不注入）。
 * @param agentDir forge agent 目录（<userData>/agent），取其父目录落盘
 */
export function ensureConsoleHidePreload(agentDir: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const dir = path.dirname(agentDir);
    const file = path.join(dir, CONSOLE_HIDE_PRELOAD_NAME);
    const source = buildConsoleHidePreloadSource();
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, source, 'utf8');
    }
    return file;
  } catch {
    return null; // 静默降级：写失败只影响「不弹窗」，不影响更新主流程
  }
}

/**
 * 组装内置 CLI 的 node argv：预加载存在时在最前注入 `--require <path>`，
 * 使补丁先于引擎 bundle 执行。node CLI 语义：首个非选项参数起才是脚本与其参数。
 */
export function buildPiCliArgv(cli: string, args: string[], preloadPath: string | null): string[] {
  if (preloadPath === null) return [cli, ...args];
  return ['--require', preloadPath, cli, ...args];
}
