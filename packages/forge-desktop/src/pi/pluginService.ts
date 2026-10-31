/**
 * 插件市场 RPC（docs/prd/07_installer_update.md 插件市场扩展）。
 *
 * 5 个方法：plugin/list | plugin/search | plugin/inspect | plugin/install | plugin/remove。
 *
 * 核心认知（决定了本模块为什么这么薄）：
 * - **安装 = 写两处地方**：包下到 <agentDir>/npm/node_modules/<pkg>，名字追加到
 *   settings.json 的 packages。这两件事引擎 CLI 已经做完，本模块只负责调用与回显。
 * - **加载完全不在本模块**：启动时 DefaultPackageManager 按 packages 拼路径、
 *   jiti 动态 import、ExtensionRunner 汇总成工具表。所以「装完必须重启」是结构性的，
 *   UI 必须明说（引擎对「装了但路径不存在」是静默跳过，用户零感知）。
 *
 * 与预装的关系：同一个 CLI 命令（`pi install npm:<pkg> --no-approve`），差别只在
 * 触发者与反馈——预装静默失败、市场必须显式报错。安装器端口因此直接复用
 * piRuntime/startupUpdate 那一套（ELECTRON_RUN_AS_NODE + PI_CODING_AGENT_DIR +
 * consoleHidePreload），不另起一套子进程封装。
 *
 * 安全边界：
 * - spec 只接受 npm 包名（含 @scope/name 与可选 @version），不接受 git/本地路径，
 *   避免「用户以为装插件、实际把任意本地目录挂进扩展链」。
 * - 包名走 npm 官方命名规则校验后，统一补 `npm:` 前缀——引擎把裸名按本地路径解析，
 *   报错是误导性的 `Path does not exist`（recommendedPlugins.ts 已记这条坑）。
 * - 内置（预装清单内）插件不允许卸载：它们与内核行为耦合，卸掉会静默缺能力。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RpcResult } from '@forge/core';
import { buildPiCliArgv, ensureConsoleHidePreload } from './consoleHidePreload.ts';
import { PI_UPDATE_TIMEOUT_MS, buildPiCliEnv, readPiExtensionList, resolveBundledPiCli } from './piRuntime.ts';
import { RECOMMENDED_PLUGINS } from './recommendedPlugins.ts';

const execFileAsync = promisify(execFile);

/** npm 官方源与国内镜像（探测失败时保留官方源） */
export const NPM_REGISTRY_OFFICIAL = 'https://registry.npmjs.org';
export const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com';

/** 搜索/详情网络超时（列表页要快，失败即降级为仅本地清单） */
const REGISTRY_TIMEOUT_MS = 12_000;
/** 安装超时：与 piRuntime 同口径（npm 安装慢，含网络） */
const INSTALL_TIMEOUT_MS = PI_UPDATE_TIMEOUT_MS;
/** 输出尾部上限 */
const OUTPUT_TAIL_CHARS = 4000;

/**
 * npm 包名规则（含 scope）：小写优先但不强制（npm 允许大写，虽不推荐）；
 * 允许 `@scope/name` 与可选 `@version` 后缀。拒绝空段、拒绝 `..`、拒绝路径分隔符
 * ——从输入侧就堵死「本地路径伪装成包名」。
 */
const PACKAGE_SPEC_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[~^]?\d+\.\d+\.\d+[\w.-]*)?$/i;

/** 单条已安装插件（list 的返回项） */
export interface PluginEntry {
  /** npm 包名（不含 npm: 前缀） */
  name: string;
  /** 实体版本；null = 清单已列但实体未安装（历史遗留/装了一半） */
  version: string | null;
  /** 内置 = 预装清单内，不可卸载 */
  builtin: boolean;
}

/** plugin/list 响应 data */
export interface PluginListResult {
  plugins: PluginEntry[];
}

/** 搜索结果项（来自 npm registry search 接口，字段是它的子集） */
export interface PluginSearchItem {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  homepage: string | null;
  repository: string | null;
  /** 最近发布日期（ISO 字符串；registry 不保证有，缺失为 null） */
  updatedAt: string | null;
}

/** plugin/search 响应 data */
export interface PluginSearchResult {
  items: PluginSearchItem[];
  /** 命中的包总数（registry 的 total，用于「共 N 个」文案） */
  total: number;
  /** 实际使用的 registry（镜像探测结果） */
  registry: string;
  /** 搜索失败原因；非 null 时 items 为空，UI 应降级为本地推荐清单 */
  error: string | null;
}

/** plugin/inspect 响应 data（装前预览；字段取自 npm registry 单包接口） */
export interface PluginInspectResult {
  name: string;
  version: string;
  description: string;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  keywords: string[];
  /** 解包体积（字节）；registry 未提供时为 null */
  unpackedSize: number | null;
  /** 最新版发布日期 ISO；缺失为 null */
  updatedAt: string | null;
  /** 是否已安装（已装时 UI 禁用安装按钮） */
  installed: boolean;
  /** 是否内置（内置时 UI 提示不可卸载） */
  builtin: boolean;
}

/** plugin/install | plugin/remove 响应 data */
export interface PluginMutateResult {
  /** CLI 输出尾部（成功回显 / 失败排查） */
  output: string;
}

/** 可注入端口（单测不碰真实 CLI / 网络） */
export interface PluginServiceDeps {
  /** pi agent 目录（<userData>/agent） */
  agentDir: string;
  /** 内置 CLI 执行端口；缺省走 resolveBundledPiCli + ELECTRON_RUN_AS_NODE 子进程 */
  runCli?: (args: string[]) => Promise<{ ok: boolean; output: string }>;
  /** registry GET 端口（返回已解析 JSON）；缺省用全局 fetch */
  fetchJson?: (url: string) => Promise<unknown>;
  /** 当前使用的 registry（缺省官方源；测试可注入假地址） */
  registry?: string;
  /** 内置清单（缺省 RECOMMENDED_PLUGINS；测试可缩小） */
  builtinPlugins?: string[];
}

/** 方法表（与 createForgeCore.MethodTable 结构兼容，直接展开合并） */
export type PluginMethodTable = Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;

function failEnvelope<T = never>(code: number, message: string): RpcResult<T> {
  return { code, message, data: null as T };
}

function okEnvelope<T>(data: T, message = 'success'): RpcResult<T> {
  return { code: 0, message, data };
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL_CHARS ? t.slice(-OUTPUT_TAIL_CHARS) : t;
}

function readStringParam(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

/**
 * spec 校验与规范化：只接受 npm 包名（可带版本），统一补 `npm:` 前缀。
 * 返回 null = 非法（调用方回 1001）。
 */
export function normalizePackageSpec(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  // 已带前缀则剥掉再校验（用户可能从 README 复制了 `npm:` 形式）
  const bare = s.startsWith('npm:') ? s.slice('npm:'.length) : s;
  if (!PACKAGE_SPEC_RE.test(bare)) return null;
  // 防御：路径分隔符与上级目录不得出现在包名里
  if (bare.includes('\\') || bare.includes('..')) return null;
  return bare;
}

/** 从 spec 中分离包名与版本（`pkg@1.2.3` → pkg / 1.2.3；无版本则 version=null） */
export function splitPackageSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  // at <= 0 覆盖两种情况：无 @，或 @ 是 scope 起始（@scope/name）
  if (at <= 0) return { name: spec, version: null };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** 包名 → node_modules 实体目录 */
function installedPackageDir(agentDir: string, name: string): string {
  return path.join(agentDir, 'npm', 'node_modules', ...name.split('/'));
}

/** 读实体版本；未装/损坏返回 null */
function readInstalledVersion(agentDir: string, name: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(installedPackageDir(agentDir, name), 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 默认 registry 请求：Node 18+ 全局 fetch，超时用 AbortSignal */
async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`registry 返回 ${res.status}`);
  return res.json();
}

/** 默认 CLI 执行（与 startupUpdate.defaultRunCli 同款，复用同一套 env/preload 约定） */
function makeDefaultRunCli(agentDir: string): (args: string[]) => Promise<{ ok: boolean; output: string }> {
  return async (args) => {
    const cli = resolveBundledPiCli();
    if (cli === null) return { ok: false, output: '内置引擎 CLI 不存在，无法执行插件操作' };
    try {
      const preload = ensureConsoleHidePreload(agentDir);
      const { stdout } = await execFileAsync(process.execPath, buildPiCliArgv(cli, args, preload), {
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: buildPiCliEnv(agentDir),
      });
      return { ok: true, output: tail(stdout) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = [e.stderr, e.stdout].filter((x): x is string => typeof x === 'string' && x !== '').join('\n');
      return { ok: false, output: tail(output || e.message || '未知错误') };
    }
  };
}

/**
 * 把引擎/registry 的原始错误翻译成人话。
 * 引擎那几条报错对用户毫无意义（尤其 `Path does not exist`——它的真因是裸名被当本地路径）。
 */
export function humanizeInstallError(raw: string): string {
  const t = raw.toLowerCase();
  if (t.includes('path does not exist')) {
    return '安装失败：包名格式不对（引擎把裸名当本地路径解析了）。请确认包名，例如 pi-web-access 或 @scope/name';
  }
  if (t.includes('e404') || t.includes('404 not found') || t.includes('not found in registry')) {
    return '安装失败：npm 上找不到这个包，请检查包名拼写';
  }
  if (t.includes('etimedout') || t.includes('timeout') || t.includes('econnreset') || t.includes('fetch failed')) {
    return '安装失败：网络连接超时，请检查网络或稍后重试';
  }
  if (t.includes('eacces') || t.includes('eperm') || t.includes('permission denied')) {
    return '安装失败：没有写入权限，无法安装到应用数据目录';
  }
  if (t.includes('enoent') && t.includes('npm')) {
    return '安装失败：找不到 npm，请确认 Node.js/npm 已安装且在 PATH 中';
  }
  if (t.includes('eexist')) {
    return '安装失败：目标目录已存在同名文件，请先卸载后重试';
  }
  return '安装失败，详情见下方输出';
}

/** 组装插件服务（返回方法表；deps 可注入以便单测） */
export function createPluginMethods(deps: PluginServiceDeps): PluginMethodTable {
  const { agentDir } = deps;
  const runCli = deps.runCli ?? makeDefaultRunCli(agentDir);
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const registry = deps.registry ?? NPM_REGISTRY_OFFICIAL;
  const builtinSet = new Set(deps.builtinPlugins ?? RECOMMENDED_PLUGINS);

  return {
    /** 已安装清单：settings.json packages ∪ 内置清单（只读，零网络） */
    'plugin/list': async (): Promise<RpcResult<PluginListResult>> => {
      const listed = readPiExtensionList(agentDir);
      const seen = new Set<string>();
      const plugins: PluginEntry[] = [];
      for (const { name, version } of listed) {
        if (seen.has(name)) continue;
        seen.add(name);
        plugins.push({ name, version, builtin: builtinSet.has(name) });
      }
      // 内置项即便实体缺失也要出现在清单里（让用户看到「装了但没装上」）
      for (const name of builtinSet) {
        if (seen.has(name)) continue;
        seen.add(name);
        plugins.push({ name, version: readInstalledVersion(agentDir, name), builtin: true });
      }
      return okEnvelope({ plugins });
    },

    /** 联网搜索（registry /-/v1/search）。失败不抛，回 error 字段让 UI 降级 */
    'plugin/search': async (params): Promise<RpcResult<PluginSearchResult>> => {
      const keyword = readStringParam(params, 'query') ?? '';
      const sizeRaw = typeof params === 'object' && params !== null ? (params as Record<string, unknown>).size : undefined;
      const size = typeof sizeRaw === 'number' && sizeRaw > 0 && sizeRaw <= 50 ? Math.floor(sizeRaw) : 20;
      // 关键词为空时默认检索 pi 生态包（keywords 是发布约定，实测命中 1.2 万+）
      const text = keyword === '' ? 'keywords:pi-package' : `${keyword} keywords:pi-package`;
      const url = `${registry}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
      try {
        const json = (await fetchJson(url)) as {
          total?: unknown;
          objects?: Array<{ package?: Record<string, unknown> }>;
        };
        const objects = Array.isArray(json.objects) ? json.objects : [];
        const items: PluginSearchItem[] = [];
        for (const obj of objects) {
          const p = obj.package;
          if (p === undefined || p === null) continue;
          const name = typeof p.name === 'string' ? p.name : null;
          if (name === null) continue;
          const links = (p.links ?? {}) as Record<string, unknown>;
          items.push({
            name,
            version: typeof p.version === 'string' ? p.version : '',
            description: typeof p.description === 'string' ? p.description : '',
            keywords: Array.isArray(p.keywords) ? p.keywords.filter((k): k is string => typeof k === 'string') : [],
            homepage: typeof links.homepage === 'string' ? links.homepage : null,
            repository: typeof links.repository === 'string' ? links.repository : null,
            updatedAt: typeof p.date === 'string' ? p.date : null,
          });
        }
        return okEnvelope({
          items,
          total: typeof json.total === 'number' ? json.total : items.length,
          registry,
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return okEnvelope({ items: [], total: 0, registry, error: `无法连接 npm registry：${message}` });
      }
    },

    /** 单包详情（装前预览）。失败回 6002，UI 提示但不阻断手动安装 */
    'plugin/inspect': async (params): Promise<RpcResult<PluginInspectResult>> => {
      const raw = readStringParam(params, 'name');
      if (raw === null) return failEnvelope(1001, '参数错误：name 不能为空');
      const spec = normalizePackageSpec(raw);
      if (spec === null) return failEnvelope(1001, '参数错误：请输入有效的 npm 包名');
      const { name } = splitPackageSpec(spec);
      // @scope/name 里的 / 必须编码，否则 registry 路由解析错
      const url = `${registry}/${name.replace('/', '%2f')}`;
      try {
        const json = (await fetchJson(url)) as {
          'dist-tags'?: Record<string, unknown>;
          versions?: Record<string, Record<string, unknown>>;
          time?: Record<string, unknown>;
        };
        const latest = typeof json['dist-tags']?.latest === 'string' ? json['dist-tags'].latest : null;
        if (latest === null) return failEnvelope(6002, `npm 上找不到 ${name} 的可用版本`);
        const ver = json.versions?.[latest] ?? {};
        const dist = (ver.dist ?? {}) as Record<string, unknown>;
        const repository = ver.repository;
        const repoUrl =
          typeof repository === 'string'
            ? repository
            : typeof repository === 'object' && repository !== null && typeof (repository as Record<string, unknown>).url === 'string'
              ? ((repository as Record<string, unknown>).url as string)
              : null;
        return okEnvelope({
          name,
          version: latest,
          description: typeof ver.description === 'string' ? ver.description : '',
          license: typeof ver.license === 'string' ? ver.license : null,
          homepage: typeof ver.homepage === 'string' ? ver.homepage : null,
          repository: repoUrl,
          keywords: Array.isArray(ver.keywords) ? ver.keywords.filter((k): k is string => typeof k === 'string') : [],
          // 体积在**版本级** dist 上（包级 dist 是空的——实测踩过）
          unpackedSize: typeof dist.unpackedSize === 'number' ? dist.unpackedSize : null,
          updatedAt: typeof json.time?.[latest] === 'string' ? (json.time[latest] as string) : null,
          installed: readInstalledVersion(agentDir, name) !== null,
          builtin: builtinSet.has(name),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failEnvelope(6002, `无法获取 ${name} 的信息：${message}`);
      }
    },

    /** 安装：`pi install npm:<pkg> --no-approve`（与预装完全同一命令） */
    'plugin/install': async (params): Promise<RpcResult<PluginMutateResult>> => {
      const raw = readStringParam(params, 'name');
      if (raw === null) return failEnvelope(1001, '参数错误：name 不能为空');
      const spec = normalizePackageSpec(raw);
      if (spec === null) return failEnvelope(1001, '参数错误：请输入有效的 npm 包名（如 pi-web-access 或 @scope/name）');
      const { name } = splitPackageSpec(spec);
      if (readInstalledVersion(agentDir, name) !== null) {
        return failEnvelope(4090, `${name} 已安装，无需重复安装`);
      }
      const result = await runCli(['install', `npm:${spec}`, '--no-approve']);
      if (!result.ok) {
        return failEnvelope(6002, humanizeInstallError(result.output));
      }
      return okEnvelope({ output: result.output }, '已安装，重启后生效');
    },

    /** 卸载：`pi remove npm:<pkg> --no-approve`（真删 node_modules + 摘清单） */
    'plugin/remove': async (params): Promise<RpcResult<PluginMutateResult>> => {
      const raw = readStringParam(params, 'name');
      if (raw === null) return failEnvelope(1001, '参数错误：name 不能为空');
      const spec = normalizePackageSpec(raw);
      if (spec === null) return failEnvelope(1001, '参数错误：请输入有效的 npm 包名');
      const { name } = splitPackageSpec(spec);
      if (builtinSet.has(name)) {
        return failEnvelope(1001, `${name} 是内置插件，随 forge 发版，不能卸载`);
      }
      if (readInstalledVersion(agentDir, name) === null) {
        return failEnvelope(1002, `${name} 未安装`);
      }
      const result = await runCli(['remove', `npm:${name}`, '--no-approve']);
      if (!result.ok) {
        return failEnvelope(6002, '卸载失败，详情见下方输出');
      }
      return okEnvelope({ output: result.output }, '已卸载，重启后生效');
    },
  };
}
