/**
 * 模型与 Provider 配置服务（wu-05-model-service）。
 *
 * 职责：实现 docs/api/05_model.md 的模型与 provider 方法契约（queryProviderList /
 * saveProvider / deleteProvider / queryModels / setDefault / getSessionModel /
 * setSessionModel），是 forge-core 纯 Node 业务层，不 import Electron / Vue / pi /
 * fs —— models.json 读写经构造注入的 ModelsFileAdapter 适配器完成，密钥经
 * KeychainAdapter 适配器完成（TD-MP-01：OS keychain 或 $ENV_VAR 引用，绝不明文），
 * 全局默认模型与会话覆盖经最小 store 接口完成，测试注入 mock。
 *
 * 设计决策：
 * 1. 错误码映射（docs/api/05_model.md §8）：
 *    - 1001 参数错误：name/type 缺失、models 为空、baseUrl 格式非法、apiKey 为空。
 *    - 1002 provider / 会话不存在：deleteProvider 未知 provider、getSessionModel /
 *      setSessionModel 未知会话。
 *    - 1004 provider 未配置：setDefault 的模型不在可用模型列表中。
 *    - 5000 内部错误：adapter 读写异常（models.json 写失败等）捕获为 5000 错误联合。
 * 2. 密钥安全（TD-MP-01，硬约束）：apiKey 明文仅传给 KeychainAdapter.storeKey，
 *    models.json 中只落 `!command`（keychain 可用）或 `$ENV_VAR`（keychain 不可用
 *    降级）引用，绝不明文写入；queryProviderList 对引用形式 apiKey 经 keychain.readKey
 *    解析为明文返回（供编辑回显），keychain 不支持时保留引用。
 * 3. 幂等（MP-S01）：saveProvider 以 id 为键 upsert —— 同 id 重复保存覆盖更新；
 *    id 缺省时由 name 生成 slug 作为 id；未提供新 apiKey 时保留内存中已存的引用。
 * 4. 删除联动（docs/api/05_model.md §3）：deleteProvider 删除 provider 后，若全局
 *    默认模型属于该 provider（defaultModel 命中其 models），将 defaultModel 置空。
 * 5. 会话模型（TD-MP-02）：getSessionModel 优先会话覆盖（effective=session），否则
 *    全局默认（effective=global）；setSessionModel 仅写该会话 modelOverride，不影响
 *    其他会话与全局默认。
 * 6. 所有方法返回判别联合 `{ ok: true, data } | { ok: false, code, message }`，
 *    调用方无需 try/catch 即可映射错误码。
 */

import type { SessionRecord, StoreKey } from '../types/forge-store.ts';

/** Provider 配置（docs/api/05_model.md §1 响应项） */
export interface ProviderConfig {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  models: string[];
  lastError: string | null;
  /** apiKey 安全引用（如 !command / $ENV_VAR / 原值）。默认不返回，仅回显需求时可选携带 */
  apiKey?: string;
}

/** models.json 落盘记录（ProviderConfig + 可选 apiKey 安全引用，不明文） */
export interface ProviderFileRecord extends ProviderConfig {
  apiKey?: string;
}

/** 模型注册表（docs/api/05_model.md §4 响应） */
export interface ModelRegistry {
  models: string[];
  defaultModel: string | null;
}

/** 会话模型信息（docs/api/05_model.md §6 响应） */
export interface SessionModelInfo {
  model: string | null;
  effective: 'session' | 'global';
}

/** saveProvider 请求参数（docs/api/05_model.md §2） */
export interface SaveProviderInput {
  /** 已有 provider 更新时必填；缺省时由 name 生成 */
  id?: string;
  name: string;
  type: string;
  /** 缺省/空为本地默认；远程需 http(s) URL，本地路径允许 */
  baseUrl?: string | null;
  models: string[];
  /** 可选；提供时必须非空，不明文写入 models.json */
  apiKey?: string;
}

/**
 * models.json 适配器（可注入 mock）。
 * 隔离 models.json 读写，服务层不直接 import fs / pi。
 * @param readProviders 读取全部 provider 配置
 * @param writeProviders 全量写回 provider 配置（含 apiKey 安全引用）
 * @param readModelNames 读取已注册模型名列表
 */
export interface ModelsFileAdapter {
  readProviders(): Promise<ProviderConfig[]>;
  writeProviders(providers: ProviderFileRecord[]): Promise<void>;
  readModelNames(): Promise<string[]>;
}

/**
 * 密钥适配器（可注入 mock）。
 * 隔离 OS keychain 访问，服务层不直接调用系统密钥服务。
 * @param storeKey 将 apiKey 存入密钥链，返回安全引用（`!command` 或 `$ENV_VAR`）
 * @param isAvailable 密钥链是否可用（不可用时降级为 $ENV_VAR 引用）
 * @param readKey 可选：读取已存密钥的原始明文（UI 编辑回显用）；不支持返回 null
 */
export interface KeychainAdapter {
  storeKey(providerId: string, apiKey: string): Promise<string>;
  isAvailable(): Promise<boolean>;
  readKey?(providerId: string): Promise<string | null>;
}

/** pi 配置值引用前缀（`!command` / `$ENV_VAR`，不明文落盘的安全引用形式） */
const KEY_REF_PREFIX = /^[!$]/;

/**
 * 最小 store 接口（兼容 ForgeStore 实例，便于测试注入 mock）。
 * 仅暴露本服务需要的设置与会话读写。
 */
export interface ModelStorePort {
  getSetting(key: StoreKey): unknown;
  setSetting(key: StoreKey, value: unknown): void;
  getSession(sessionId: string): SessionRecord | undefined;
  saveSession(record: SessionRecord): void;
}

/**
 * 审计日志回调（P3-D）：配置变更记审计日志；payload 只含 provider id / 动作标识，
 * 绝不含 apiKey 明文或引用。
 */
export type AuditLogFn = (event: {
  action: 'provider.saved' | 'provider.deleted' | 'model.defaultChanged';
  providerId: string;
  ts: string;
}) => void;

/** 服务依赖（构造注入：models.json 适配器 + 密钥适配器 + 最小 store；可选审计日志） */
export interface ModelServiceDeps {
  modelsFile: ModelsFileAdapter;
  keychain: KeychainAdapter;
  store: ModelStorePort;
  /** 审计日志回调（P3-D；可选，缺省不记） */
  audit?: AuditLogFn;
  /**
   * provider 配置变更钩子：saveProvider / deleteProvider 成功后触发，
   * 供上层刷新模型运行时缓存（使新 API Key 立即生效）；异常不阻断主流程。
   */
  onConfigChanged?: () => void | Promise<void>;
}

/**
 * 通用方法结果（判别联合）。
 * - `{ ok: true, data }`：成功
 * - `{ ok: false, code, message }`：失败，code 为 API 错误码（1001/1002/1004/5000）
 */
export type ModelResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 1002 | 1004 | 5000; message: string };

/** 由 name 生成稳定 id（小写、非字母数字转连字符） */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 由 provider id 生成环境变量名（如 openai -> FORGE_OPENAI_API_KEY） */
function envVarName(providerId: string): string {
  return `FORGE_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/** baseUrl 合法性：空/缺省或本地路径允许；http(s) 远程 URL 必须可解析 */
function isValidBaseUrl(baseUrl: string | null | undefined): boolean {
  if (baseUrl === undefined || baseUrl === null || baseUrl.trim() === '') {
    return true;
  }
  const trimmed = baseUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return true; // 本地路径
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** 规范化 baseUrl：空/缺省 -> null（本地默认），否则返回去空白后的原值 */
function normalizeBaseUrl(baseUrl: string | null | undefined): string | null {
  if (baseUrl === undefined || baseUrl === null || baseUrl.trim() === '') {
    return null;
  }
  return baseUrl.trim();
}

/** 提取异常消息（5000 错误联合用） */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 模型与 Provider 配置服务：provider CRUD / 模型查询 / 全局默认 / 会话模型，
 * 消费注入的 models.json 适配器、密钥适配器与最小 store。
 * @param deps 服务依赖（modelsFile / keychain / store）
 */
export class ModelService {
  private readonly deps: ModelServiceDeps;
  /** providerId -> apiKey 安全引用（内存缓存，未提供新 key 时保留） */
  private readonly apiKeyRefs: Map<string, string> = new Map();

  constructor(deps: ModelServiceDeps) {
    this.deps = deps;
  }

  /**
   * 查询 provider 列表（MP-S03）：从 models.json 适配器读取。
   * apiKey 为引用形式（`$VAR` / `!cmd`）时，若 keychain 支持读取则解析为明文
   * 返回（供 UI 编辑回显，与其他明文 provider 行为一致）；不支持/读取失败时
   * 保留引用，不回显明文。
   * @returns 成功返回 provider 列表；adapter 异常返回 5000
   */
  async queryProviderList(): Promise<ModelResult<{ providers: ProviderConfig[] }>> {
    try {
      const providers = await this.deps.modelsFile.readProviders();
      // bind 保留 keychain 为 this（class 实现依赖实例状态），并消除可选类型
      const readKey = this.deps.keychain.readKey?.bind(this.deps.keychain);
      if (readKey === undefined) {
        return { ok: true, data: { providers } };
      }
      const resolved = await Promise.all(
        providers.map(async (p) => {
          const apiKey = p.apiKey;
          if (apiKey === undefined || !KEY_REF_PREFIX.test(apiKey)) {
            return p;
          }
          try {
            const plain = await readKey(p.id);
            return plain !== null ? { ...p, apiKey: plain } : p;
          } catch {
            // 读取失败（机器变更等）：保留引用，访问者按引用解析或重新录入
            return p;
          }
        }),
      );
      return { ok: true, data: { providers: resolved } };
    } catch (err) {
      return { ok: false, code: 5000, message: `读取 provider 配置失败: ${toMessage(err)}` };
    }
  }

  /**
   * 保存 / 更新 provider 配置（MP-S01）：校验后经适配器写回 models.json。
   * @param input 配置参数（name/type/models 必填；baseUrl 格式校验；apiKey 非空校验）
   * @returns 成功返回 null；参数错误返回 1001；adapter 异常返回 5000
   */
  async saveProvider(input: SaveProviderInput): Promise<ModelResult<null>> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    if (name === '') {
      return { ok: false, code: 1001, message: 'provider 名称不能为空' };
    }
    if (type === '') {
      return { ok: false, code: 1001, message: 'provider 类型不能为空' };
    }
    if (!Array.isArray(input.models) || input.models.length === 0) {
      return { ok: false, code: 1001, message: 'models 至少需要一个模型' };
    }
    if (!isValidBaseUrl(input.baseUrl)) {
      return { ok: false, code: 1001, message: 'baseUrl 格式无效' };
    }
    if (input.apiKey !== undefined && input.apiKey.trim() === '') {
      return { ok: false, code: 1001, message: 'apiKey 不能为空' };
    }
    const id =
      input.id !== undefined && input.id.trim() !== '' ? input.id.trim() : slugify(name);
    const baseUrl = normalizeBaseUrl(input.baseUrl);

    // 密钥处理：提供新 key 时经 keychain 存引用（不可用降级 $ENV_VAR）；
    // 未提供时保留现有引用——内存缓存未命中（进程重启后为空）则回读
    // models.json 现有记录继承（否则留空保存会把已有 apiKey 引用丢掉）
    let apiKeyRef: string | undefined = this.apiKeyRefs.get(id);
    if (apiKeyRef === undefined) {
      try {
        const existing = await this.deps.modelsFile.readProviders();
        apiKeyRef = existing.find((p) => p.id === id)?.apiKey;
        if (apiKeyRef !== undefined) {
          this.apiKeyRefs.set(id, apiKeyRef);
        }
      } catch {
        // 读取失败按无引用处理（后续写入按新记录覆盖）
      }
    }
    if (input.apiKey !== undefined) {
      let available = false;
      try {
        available = await this.deps.keychain.isAvailable();
      } catch {
        available = false;
      }
      if (available) {
        try {
          apiKeyRef = await this.deps.keychain.storeKey(id, input.apiKey.trim());
        } catch (err) {
          return { ok: false, code: 5000, message: `密钥存储失败: ${toMessage(err)}` };
        }
      } else {
        apiKeyRef = `$${envVarName(id)}`;
      }
      this.apiKeyRefs.set(id, apiKeyRef);
    }

    const record: ProviderFileRecord = {
      id,
      name,
      type,
      baseUrl,
      models: input.models.map((m) => m.trim()),
      lastError: null,
    };
    if (apiKeyRef !== undefined) {
      record.apiKey = apiKeyRef;
    }

    try {
      const providers = await this.deps.modelsFile.readProviders();
      const idx = providers.findIndex((p) => p.id === id);
      if (idx === -1) {
        providers.push(record);
      } else {
        providers[idx] = record;
      }
      await this.deps.modelsFile.writeProviders(providers);
    } catch (err) {
      return { ok: false, code: 5000, message: `写入 models.json 失败: ${toMessage(err)}` };
    }
    // P3-D：配置变更审计（不含密钥明文/引用）
    this.deps.audit?.({ action: 'provider.saved', providerId: id, ts: new Date().toISOString() });
    // 配置变更钩子：刷新模型运行时缓存（新 API Key 立即生效）；失败不阻断保存结果
    try {
      await this.deps.onConfigChanged?.();
    } catch (err) {
      console.error('[saveProvider] onConfigChanged failed', err);
    }
    return { ok: true, data: null };
  }

  /**
   * 删除 provider（MP-S01）：移除配置；若全局默认模型属于该 provider 则重置为 null。
   * @param id provider ID
   * @returns 成功返回 null；provider 不存在返回 1002；adapter 异常返回 5000
   */
  async deleteProvider(id: string): Promise<ModelResult<null>> {
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, code: 1001, message: 'provider ID 不能为空' };
    }
    const providerId = id.trim();
    try {
      const providers = await this.deps.modelsFile.readProviders();
      const target = providers.find((p) => p.id === providerId);
      if (target === undefined) {
        return { ok: false, code: 1002, message: `provider 不存在: ${providerId}` };
      }
      await this.deps.modelsFile.writeProviders(providers.filter((p) => p.id !== providerId));
      const defaultModel = this.deps.store.getSetting('defaultModel');
      if (typeof defaultModel === 'string' && target.models.includes(defaultModel)) {
        this.deps.store.setSetting('defaultModel', null);
      }
      // P3-D：删除 provider 记审计（不含密钥）
      this.deps.audit?.({ action: 'provider.deleted', providerId, ts: new Date().toISOString() });
      // 配置变更钩子：刷新模型运行时缓存；失败不阻断删除结果
      try {
        await this.deps.onConfigChanged?.();
      } catch (err) {
        console.error('[deleteProvider] onConfigChanged failed', err);
      }
      return { ok: true, data: null };
    } catch (err) {
      return { ok: false, code: 5000, message: `删除 provider 失败: ${toMessage(err)}` };
    }
  }

  /**
   * 查询模型列表（MP-S02）：可用模型来自 models.json 适配器，默认模型来自 store。
   * @returns 成功返回 { models, defaultModel }；adapter 异常返回 5000
   */
  async queryModels(): Promise<ModelResult<ModelRegistry>> {
    let models: string[];
    try {
      models = await this.deps.modelsFile.readModelNames();
    } catch (err) {
      return { ok: false, code: 5000, message: `读取模型列表失败: ${toMessage(err)}` };
    }
    const defaultModel = this.deps.store.getSetting('defaultModel');
    return {
      ok: true,
      data: { models, defaultModel: typeof defaultModel === 'string' ? defaultModel : null },
    };
  }

  /**
   * 设置全局默认模型（MP-S02）：持久化到 store settings.defaultModel。
   * @param model 模型 ID；null 表示清除默认
   * @returns 成功返回 null；模型不在可用列表返回 1004；adapter 异常返回 5000
   */
  async setDefault(model: string | null): Promise<ModelResult<null>> {
    if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
      return { ok: false, code: 1001, message: '模型 ID 不能为空' };
    }
    const target = model === null ? null : model.trim();
    if (target !== null) {
      let models: string[];
      try {
        models = await this.deps.modelsFile.readModelNames();
      } catch (err) {
        return { ok: false, code: 5000, message: `读取模型列表失败: ${toMessage(err)}` };
      }
      if (!models.includes(target)) {
        return { ok: false, code: 1004, message: `模型未配置: ${target}` };
      }
    }
    this.deps.store.setSetting('defaultModel', target);
    // P3-D：默认模型变更记审计
    this.deps.audit?.({
      action: 'model.defaultChanged',
      providerId: target ?? '',
      ts: new Date().toISOString(),
    });
    return { ok: true, data: null };
  }

  /**
   * 查询会话当前生效模型（MP-S02）：优先会话覆盖，其次全局默认。
   * @param sessionId 会话 ID
   * @returns 成功返回 { model, effective }；会话不存在返回 1002
   */
  async getSessionModel(sessionId: string): Promise<ModelResult<SessionModelInfo>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    const session = this.deps.store.getSession(sessionId.trim());
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    const defaultModel = this.deps.store.getSetting('defaultModel');
    const globalModel = typeof defaultModel === 'string' ? defaultModel : null;
    if (session.modelOverride !== null) {
      return { ok: true, data: { model: session.modelOverride, effective: 'session' } };
    }
    return { ok: true, data: { model: globalModel, effective: 'global' } };
  }

  /**
   * 设置会话级模型覆盖（MP-S02）：仅写该会话 modelOverride，不影响其他会话与全局。
   * @param sessionId 会话 ID
   * @param model 模型 ID；null 表示清除覆盖回到全局默认
   * @returns 成功返回 null；会话不存在返回 1002
   */
  async setSessionModel(sessionId: string, model: string | null): Promise<ModelResult<null>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
      return { ok: false, code: 1001, message: '模型 ID 不能为空' };
    }
    const sid = sessionId.trim();
    const session = this.deps.store.getSession(sid);
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sid}` };
    }
    this.deps.store.saveSession({ ...session, modelOverride: model === null ? null : model.trim() });
    return { ok: true, data: null };
  }
}