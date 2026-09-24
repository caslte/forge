/**
 * pi 运行时信息与插件更新（设置页「版本更新」分区后端，docs/api/07_pi.md）。
 *
 * 产品语义：UI 只讲「forge 版本 + 组件更新」，内部实现为：
 * - forge 版本 = 应用版本（main.ts 注入 app.getVersion()）
 * - 插件 = forge 自有 agent 目录（<userData>/agent，settings.json packages 清单 +
 *   npm 工程实体）；与终端 pi 的 ~/.pi/agent 产品隔离，不再共用
 * - 更新 = 内置引擎 CLI 的 `pi update --extensions`（不依赖用户是否安装全局 pi：
 *   经 ELECTRON_RUN_AS_NODE 以 node 模式运行自带 dist/bundle/cli.js）。CLI 子进程
 *   必须经 buildPiCliEnv 注入 PI_CODING_AGENT_DIR，否则组件会装回用户 ~/.pi 造成
 *   与 in-process 读写根裂脑
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { stripJsonComments } from './piModelsFileAdapter.ts';

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

/** 更新超时：npm 安装较慢（含网络），放宽到 10 分钟 */
export const PI_UPDATE_TIMEOUT_MS = 10 * 60_000;
/** 失败/成功时返回给前端的输出尾部上限 */
export const PI_UPDATE_OUTPUT_TAIL_CHARS = 4000;

/** 单个共享扩展信息（version=null 表示清单已列但实体未安装） */
export interface PiPluginInfo {
  name: string;
  version: string | null;
}

/**
 * 内置 CLI 子进程统一环境变量：node 模式 + PI_CODING_AGENT_DIR 指向 forge 的 agent 目录。
 * pi SDK 的 getAgentDir() 优先读该 env（dist/config.js），子进程据此与 in-process 同根。
 */
export function buildPiCliEnv(agentDir: string): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: agentDir };
}

/** 读取共享扩展清单与各自版本；settings.json 缺失/损坏返回 []（静默降级） */
export function readPiExtensionList(agentDir: string): PiPluginInfo[] {
  let packages: string[] = [];
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw)) as { packages?: unknown };
    if (Array.isArray(parsed.packages)) {
      packages = parsed.packages.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    return [];
  }
  return packages.map((source) => {
    // 清单项形如 "npm:@tintinweb/pi-subagents"（npm: 前缀 = npm 源）
    const name = source.startsWith('npm:') ? source.slice('npm:'.length) : source;
    return { name, version: readInstalledVersion(agentDir, name) };
  });
}

/** 读 npm 工程内已装包版本；未安装/损坏返回 null */
function readInstalledVersion(agentDir: string, name: string): string | null {
  try {
    const pkgPath = path.join(agentDir, 'npm', 'node_modules', ...name.split('/'), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 解析内置引擎 CLI（dist/bundle/cli.js）；缺失返回 null（打包裁剪等场景） */
export function resolveBundledPiCli(): string | null {
  try {
    const pkg = nodeRequire.resolve('@earendil-works/pi-coding-agent/package.json');
    const cli = path.join(path.dirname(pkg), 'dist', 'bundle', 'cli.js');
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** 更新执行结果（output 为输出尾部，供 UI 失败排查/成功回显） */
export interface PiUpdateResult {
  ok: boolean;
  output: string;
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > PI_UPDATE_OUTPUT_TAIL_CHARS ? t.slice(-PI_UPDATE_OUTPUT_TAIL_CHARS) : t;
}

/**
 * 更新共享扩展（等价终端 `pi update --extensions`）：
 * 用 Electron 主进程可执行文件以 node 模式跑内置 CLI，不依赖全局 pi。
 * --no-approve 忽略项目本地文件信任提示，避免子进程交互挂起。
 * @param agentDir forge agent 目录（经 PI_CODING_AGENT_DIR 传给 CLI，与 in-process 同根）
 */
export async function updatePiExtensions(agentDir: string): Promise<PiUpdateResult> {
  const cli = resolveBundledPiCli();
  if (cli === null) {
    return { ok: false, output: '内置引擎 CLI 不存在，无法更新插件' };
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cli, 'update', '--extensions', '--no-approve'],
      {
        windowsHide: true,
        timeout: PI_UPDATE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: buildPiCliEnv(agentDir),
      },
    );
    return { ok: true, output: tail(stdout) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stderr, e.stdout].filter((x) => typeof x === 'string' && x !== '').join('\n');
    return { ok: false, output: tail(output || e.message || '未知错误') };
  }
}
