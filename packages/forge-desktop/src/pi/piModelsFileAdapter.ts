/**
 * 真实 pi models.json 适配器（双向同步）。
 *
 * 职责：把 pi 的 `~/.pi/agent/models.json` 作为唯一数据源读写，forge 作为可视化编辑器
 * 与其双向同步（对应 docs/prd/05_model_provider.md TD-MP-03「复用 pi models.json」）。
 *
 * pi models.json 结构（用户本机实例）：
 * ```json
 * {
 *   "providers": {
 *     "Grok 4.5": {
 *       "baseUrl": "https://xuseny.online/v1",
 *       "api": "openai-completions",
 *       "apiKey": "sk-...",
 *       "models": [{ "id": "grok-4.5", "contextWindow": ..., "reasoning": true }]
 *     }
 *   }
 * }
 * ```
 *
 * 映射规则：
 * - pi provider 的 key（如 "Grok 4.5"）→ forge 的 id 与 name
 * - pi `api` → forge `type`（openai-completions 等协议名）
 * - pi `models[].id` → forge `models[]`（单个 provider 可含多个模型）
 * - `apiKey` 保留原样引用，不解析不回写明文差异
 *
 * 写入策略：
 * - 原子写（tmp + rename），与 forge-store 一致，避免崩溃损坏 pi 配置。
 * - 保持 pi 其它字段（models[].contextWindow / reasoning / compat 等）不丢。
 * - 文件不存在时按 pi 结构播种空 providers（不抛错，等待 forge 添加）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProviderConfig, ProviderFileRecord } from '@forge/core';

/** pi 单个模型记录（保留 pi 附加字段，如 contextWindow/reasoning/compat） */
interface PiModelRecord {
  id: string;
  [k: string]: unknown;
}

/** pi provider 记录（apiKey 可为 !command / $ENV_VAR / 明文引用） */
interface PiProviderRecord {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: PiModelRecord[];
  [k: string]: unknown;
}

/** pi models.json 根结构 */
interface PiModelsFile {
  providers: Record<string, PiProviderRecord>;
}

/** 默认 pi models.json 路径：~/.pi/agent/models.json */
export function defaultPiModelsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'models.json');
}

/** 剥离 JSONC 行注释（// 到行尾，引号内保留），供 pi models.json 解析 */
function stripJsonComments(src: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      // 跳到行尾
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 真实 pi models.json 适配器。
 * @param filePath models.json 路径（默认 ~/.pi/agent/models.json）
 */
export class PiModelsFileAdapter {
  private readonly filePath: string;

  constructor(filePath: string = defaultPiModelsPath()) {
    this.filePath = filePath;
  }

  private readFile(): PiModelsFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      // pi 的 models.json 允许 // 行注释（JSONC），解析前剥离；引号内保留
      const stripped = stripJsonComments(raw);
      const parsed = JSON.parse(stripped) as PiModelsFile;
      if (!parsed || typeof parsed.providers !== 'object' || parsed.providers === null) {
        return { providers: {} };
      }
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === 'ENOENT') return { providers: {} };
      throw new Error(`读取 pi models.json 失败: ${e?.message ?? String(err)}`);
    }
  }

  private writeFile(data: PiModelsFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // 写入前备份原文件（含 pi 注释），避免误操作丢失 pi 配置
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
    }
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  async readProviders(): Promise<ProviderConfig[]> {
    const file = this.readFile();
    return Object.entries(file.providers).map(([name, p]) => ({
      id: name,
      name,
      type: p.api ?? 'openai-completions',
      baseUrl: p.baseUrl ?? null,
      models: (p.models ?? []).map((m) => m.id),
      lastError: null,
      // 回显已存 apiKey（pi 文件里的引用或原值），供前端展示
      ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
    }));
  }

  async writeProviders(providers: ProviderFileRecord[]): Promise<void> {
    const file = this.readFile();
    const next: Record<string, PiProviderRecord> = {};
    for (const p of providers) {
      const existing = file.providers[p.name];
      const prevModels = existing?.models ?? [];
      const nextModels: PiModelRecord[] = p.models.map((id) => {
        const prev = prevModels.find((m) => m.id === id);
        return { ...(prev ?? {}), id };
      });
      next[p.name] = {
        ...(existing ?? {}),
        baseUrl: p.baseUrl ?? undefined,
        api: p.type || 'openai-completions',
        models: nextModels,
      };
      if (p.apiKey !== undefined) {
        next[p.name]!.apiKey = p.apiKey;
      } else if (existing?.apiKey !== undefined) {
        next[p.name]!.apiKey = existing.apiKey;
      }
    }
    file.providers = next;
    this.writeFile(file);
  }

  async readModelNames(): Promise<string[]> {
    const file = this.readFile();
    const names = new Set<string>();
    for (const p of Object.values(file.providers)) {
      for (const m of p.models ?? []) {
        names.add(m.id);
      }
    }
    return [...names];
  }
}
