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
 * 2. 密钥存储（v1 临时，TD-MP-01 放宽）：apiKey 明文直接写入 models.json，与 pi 原生
 *    明文形式一致，不经 KeychainAdapter 安全引用；queryProviderList 仍兼容读取
 *    旧 `$ENV_VAR`/`!command` 引用（经 keychain.readKey 解析），便于存量占位符平滑过渡。
 * 3. 幂等（MP-S01）：saveProvider 以 id 为键 upsert —— 同 id 重复保存覆盖更新；
 *    id 缺省时由 name 生成 slug 作为 id；未提供新 apiKey 时保留内存中已存的引用。
 * 4. 删除联动（docs/api/05_model.md §3）：deleteProvider 删除 provider 后，若全局
 *    默认锚点指向该 provider（或存量裸模型 ID 属于其 models），将默认置空。
 * 5. 会话模型（TD-MP-02）：getSessionModel 优先会话覆盖（effective=session），否则
 *    全局默认（effective=global）；setSessionModel 仅写该会话 modelOverride，不影响
 *    其他会话与全局默认。
 * 6. **锚点语义**：settings.defaultModel 与 session.modelOverride 存的是 provider 别名
 *    （provider id = pi models.json 里该 provider 的 key，如 "mx"），不是模型 ID。
 *    模型 ID 是锚点解析出的派生值（该 provider 的首模型）。这样在设置里把某个配置的
 *    模型 ID 换掉（MiniMax-M3 → M3.1）时，主会话与所有引用该配置的会话自动跟随，
 *    不会留下一个指向不存在模型的悬空值。读侧兼容存量裸模型 ID（见 resolveAnchor），
 *    解析到归属后就地回写成别名，读一次即自愈；只有**改别名**需要传播（见
 *    propagateAnchor）。
 * 7. 所有方法返回判别联合 `{ ok: true, data } | { ok: false, code, message }`，
 *    调用方无需 try/catch 即可映射错误码。
 */

import type { SessionRecord, StoreKey } from '../types/forge-store.ts';

/** 思考级别枚举（docs/api/05_model.md §8/§9，同 pi thinkingLevelMap 级别，顺序固定） */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 思考级别全量列表（顺序固定：off→minimal→low→medium→high→xhigh→max） */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * 思考等级配置表单的默认选中集（MP-S07）。
 * 与 pi 原生默认一致：minimal/low/medium/high 缺省即可用，xhigh/max 需显式开启；
 * off 不参与（写 null 隐藏，对话框切换器不出现关闭思考挡位）。
 */
export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

/**
 * 由选中级别集构建 thinkingLevelMap（MP-S07）。
 * 全量 7 项显式写出：选中级别值取级别名（如 "high": "high"），未选中为 null（隐藏）。
 * 与 pi getSupportedThinkingLevels 语义一致：null=隐藏；xhigh/max 必须显式非 null 才可用。
 * off 未选中时为 null（对话框不出现「关闭思考」挡位）。
 */
export function buildThinkingLevelMap(
  levels: readonly ThinkingLevel[],
): Partial<Record<ThinkingLevel, string | null>> {
  const selected = new Set(levels);
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const l of THINKING_LEVELS) {
    map[l] = selected.has(l) ? l : null;
  }
  return map;
}

/** Provider 配置（docs/api/05_model.md §1 响应项） */
export interface ProviderConfig {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  models: string[];
  lastError: string | null;
  /** contextWindow 首个模型的上下文窗口（MP-S06；未配置为 null，v1 仅首模型透出） */
  contextWindow?: number | null;
  /**
   * 首模型是否支持图片输入（多模态）：对应 models.json 该模型记录的
   * `input` 数组含 "image"。true=支持（写 input:["text","image"]），
   * false/缺省=不支持（移除 input 字段，回退 pi 默认纯文本）。
   */
  vision?: boolean;
  /** 首模型是否启用思考（MP-S07）：models.json 该模型记录 `reasoning: true` */
  reasoning?: boolean;
  /** 首模型启用的思考等级白名单（MP-S07）：由 thinkingLevelMap 非 null 项推导；写入侧可传 null 表示移除该字段 */
  thinkingLevels?: ThinkingLevel[] | null;
  /** apiKey 安全引用（如 !command / $ENV_VAR / 原值）。默认不返回，仅回显需求时可选携带 */
  apiKey?: string;
}

/** models.json 落盘记录（ProviderConfig + 可选 apiKey 安全引用，不明文） */
export interface ProviderFileRecord extends ProviderConfig {
  apiKey?: string;
  /** 思考等级白名单（MP-S07）：数组=按构建器写 thinkingLevelMap；null=移除该字段；undefined=不触碰 */
  thinkingLevels?: ThinkingLevel[] | null;
}

/**
 * 模型可选项（queryModels 响应项）：一个 provider 配置 = 一个可选项。
 * @param providerId 别名锚点（= provider id = pi models.json 的 provider key），选中时写回存储的值
 * @param model 该配置当前解析出的模型 ID（派生值，喂给 pi 与思考等级查询）
 */
export interface ModelOption {
  providerId: string;
  model: string;
}

/** 模型注册表（docs/api/05_model.md §4 响应） */
export interface ModelRegistry {
  options: ModelOption[];
  /** 全局默认（主会话）模型的别名锚点；未配置或解析不到为 null */
  defaultProviderId: string | null;
}

/** 会话模型信息（docs/api/05_model.md §6 响应） */
export interface SessionModelInfo {
  /** 生效模型 ID（锚点解析出的派生值，pi 运行时消费的就是它） */
  model: string | null;
  /** 生效模型的别名锚点；与 model 同源，UI 按它标记选中项 */
  providerId: string | null;
  effective: 'session' | 'global';
}

/**
 * 锚点解析结果（见 ModelService.resolveAnchor）。
 * @param providerId 别名锚点
 * @param model 该配置解析出的生效模型 ID
 * @param legacyValue 存储值是否为存量裸模型 ID（调用方据此回写为别名，完成读时自愈）
 */
interface AnchorResolution {
  providerId: string;
  model: string;
  legacyValue: boolean;
}

/**
 * 配置的派生模型 ID：取该 provider 的首模型（与设置卡片「主会话模型」徽标同一口径）。
 * @param provider provider 配置
 * @returns 首模型；未配置模型返回 null（该配置不可作为锚点生效）
 */
function firstModel(provider: ProviderConfig): string | null {
  const model = provider.models[0];
  if (typeof model !== 'string' || model.trim() === '') {
    return null;
  }
  return model.trim();
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
  /** 可选；首个模型上下文窗口（MP-S06）：正数写入，null 移除字段，缺省保留原值 */
  contextWindow?: number | null;
  /**
   * 可选；首模型是否支持图片输入（多模态）：true 写模型记录 input:["text","image"]，
   * false 移除字段，缺省保留原值。仅接受布尔值。
   */
  vision?: boolean;
  /**
   * 可选；首模型是否启用思考（MP-S07）：true 写 reasoning:true，false 写 reasoning:false，
   * 缺省保留原值。仅接受布尔值。
   */
  reasoning?: boolean;
  /**
   * 可选；首模型思考等级白名单（MP-S07）：选中级别集，由服务层经 buildThinkingLevelMap
   * 写 thinkingLevelMap（选中=级别名，未选=null）；null 移除该字段；缺省保留原值。
   * 仅接受 THINKING_LEVELS 内的去重串。
   */
  thinkingLevels?: ThinkingLevel[] | null;
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
  /** 全部会话记录（改别名时传播锚点用，见 propagateAnchor） */
  listSessions(): SessionRecord[];
  getSession(sessionId: string): SessionRecord | undefined;
  saveSession(record: SessionRecord): void;
}

/**
 * 思考级别端口（可注入 mock）。
 * 查询某模型支持的思考级别列表（docs/api/05_model.md §8 MP-S05），能力来源为
 * pi SDK `getSupportedThinkingLevels`（reasoning + thinkingLevelMap 共同决定）。
 * @param getSupportedThinkingLevels 返回级别列表；null 表示该模型不可用/未配置
 */
export interface ThinkLevelsPort {
  getSupportedThinkingLevels(model: string): Promise<string[] | null>;
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
  /** 思考级别端口（MP-S05；可选，缺省时 getModelThinkingLevels 返回 5000「能力未配置」） */
  thinkLevels?: ThinkLevelsPort;
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
/**
 * 模型 ID 形态校验（回归：设置里把 `MiniMax-M3.1-Flash-Preview` 手打成
 * `MiniMax M3.1-Flash-Preview`，空格版被原样写进 models.json，随即成为
 * 全局默认与会话覆盖，而 pi 侧解析不到它——错误直到发送时才炸成
 * 「模型未配置或不可用」，且该会话此后每条消息都失败，只能手动重选模型才能恢复）。
 *
 * 模型 ID 是两层共用的查找键（models.json 模型记录的 id、pi
 * ModelRuntime.getModel(providerId, id)），含空白字符时必错且错得无声。
 * 这里在唯一的写入口（saveProvider）挡住。
 */
export function validateModelId(model: string): string | null {
  if (model === '') return '模型 ID 不能为空';
  if (/\s/.test(model)) return '模型 ID 不能包含空格或换行';
  if (/^[\p{C}]/u.test(model)) return '模型 ID 不能以控制字符开头';
  return null;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 判断值是否为合法思考级别枚举（docs/api/05_model.md §8） */
function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
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
    // 模型 ID 形态校验：含空格/空串/控制字符的 ID 一律拒写（见 validateModelId 注释的回归）。
    // 在此拦住是唯一的根治点——写进去之后它会静默污染全局默认与会话覆盖，
    // 而真正的解析失败要等到用户发消息才暴露，且会话从此每条消息都失败。
    for (const rawModel of input.models) {
      const modelId = typeof rawModel === 'string' ? rawModel.trim() : '';
      const invalid = validateModelId(modelId);
      if (invalid !== null) {
        return { ok: false, code: 1001, message: `${invalid}: ${JSON.stringify(rawModel)}` };
      }
    }
    if (new Set(input.models.map((m) => m.trim())).size !== input.models.length) {
      return { ok: false, code: 1001, message: 'models 不能重复' };
    }
    if (!isValidBaseUrl(input.baseUrl)) {
      return { ok: false, code: 1001, message: 'baseUrl 格式无效' };
    }
    if (input.apiKey !== undefined && input.apiKey.trim() === '') {
      return { ok: false, code: 1001, message: 'apiKey 不能为空' };
    }
    // contextWindow：提供时须为正数或 null（MP-S06）；负数/字符串/0 判 1001 不写
    if (
      input.contextWindow !== undefined &&
      input.contextWindow !== null &&
      (typeof input.contextWindow !== 'number' ||
        !Number.isFinite(input.contextWindow) ||
        input.contextWindow <= 0)
    ) {
      return { ok: false, code: 1001, message: 'contextWindow 必须为正数或 null' };
    }
    // vision：提供时须为布尔值；非法值判 1001 不写
    if (input.vision !== undefined && typeof input.vision !== 'boolean') {
      return { ok: false, code: 1001, message: 'vision 必须为布尔值' };
    }
    // reasoning：提供时须为布尔值（MP-S07）；非法值判 1001 不写
    if (input.reasoning !== undefined && typeof input.reasoning !== 'boolean') {
      return { ok: false, code: 1001, message: 'reasoning 必须为布尔值' };
    }
    // thinkingLevels：提供时须为 THINKING_LEVELS 内的去重列表（MP-S07）；非法项判 1001 不写
    if (input.thinkingLevels !== undefined && input.thinkingLevels !== null) {
      const levels = input.thinkingLevels;
      if (
        !Array.isArray(levels) ||
        levels.some((l) => !THINKING_LEVELS.includes(l)) ||
        new Set(levels).size !== levels.length
      ) {
        return { ok: false, code: 1001, message: 'thinkingLevels 必须为合法思考等级的去重列表' };
      }
    }
    const id =
      input.id !== undefined && input.id.trim() !== '' ? input.id.trim() : slugify(name);
    const baseUrl = normalizeBaseUrl(input.baseUrl);

    // v1 明文直写：apiKey 明文落盘，与 pi 原生一致
    // 未提供新 key 时保留现有（内存缓存未命中则回读 models.json）
    let apiKeyRef: string | undefined = this.apiKeyRefs.get(id);
    if (apiKeyRef === undefined) {
      try {
        const existing = await this.deps.modelsFile.readProviders();
        apiKeyRef = existing.find((p) => p.id === id)?.apiKey;
        if (apiKeyRef !== undefined) {
          // 存量占位符平滑迁移：若旧值为 $ENV_VAR/!command 且 keychain 可解析为明文，则转为明文
          if (KEY_REF_PREFIX.test(apiKeyRef) && this.deps.keychain.readKey !== undefined) {
            try {
              const plain = await this.deps.keychain.readKey(id);
              if (plain !== null && plain !== '') {
                apiKeyRef = plain;
              }
            } catch {
              // 解析失败保留原引用
            }
          }
          this.apiKeyRefs.set(id, apiKeyRef);
        }
      } catch {
        // 读取失败按无引用处理（后续写入按新记录覆盖）
      }
    }
    if (input.apiKey !== undefined) {
      const trimmedKey = input.apiKey.trim();
      // v1 明文直写：与 pi 原生 models.json 一致，不经 keychain 安全引用
      // 保留对旧占位符输入的防御：若前端误把 "$FORGE_..." 引用当新值传入，视为未提供
      if (trimmedKey !== '' && KEY_REF_PREFIX.test(trimmedKey)) {
        // 引用形式：保持现有 apiKeyRef 不变（由上方回读的旧值决定，含可能的迁移后明文）
      } else {
        apiKeyRef = trimmedKey;
        this.apiKeyRefs.set(id, apiKeyRef);
      }
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
    // contextWindow：仅显式提供时携带（正数或 null；缺省原样保留不篡改）
    if (input.contextWindow !== undefined) {
      record.contextWindow = input.contextWindow;
    }
    // vision：仅显式提供时携带（布尔；缺省保留原值，见 piModelsFileAdapter 落盘映射）
    if (input.vision !== undefined) {
      record.vision = input.vision;
    }
    // MP-S07 思考等级：仅显式提供时携带（布尔 / 数组或 null；缺省保留原值）
    if (input.reasoning !== undefined) {
      record.reasoning = input.reasoning;
    }
    if (input.thinkingLevels !== undefined) {
      record.thinkingLevels = input.thinkingLevels;
    }

    try {
      const providers = await this.deps.modelsFile.readProviders();
      const idx = providers.findIndex((p) => p.id === id);
      // 改名前记录：pi models.json 的 provider key 按 name 落盘，改别名等于换锚点
      const existing = idx === -1 ? undefined : providers[idx];
      if (idx === -1) {
        providers.push(record);
      } else {
        providers[idx] = record;
      }
      await this.deps.modelsFile.writeProviders(providers);
      if (existing !== undefined && existing.id !== name) {
        this.propagateAnchor(existing.id, name);
      }
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
   * 删除 provider（MP-S01）：移除配置；全局默认（主会话）锚点指向该 provider 时重置为 null。
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
      // 存量数据可能仍存裸模型 ID，两种形态一并认（别名命中 或 该 provider 的模型命中）
      const defaultModel = this.deps.store.getSetting('defaultModel');
      if (
        typeof defaultModel === 'string' &&
        (defaultModel.trim() === providerId || target.models.includes(defaultModel.trim()))
      ) {
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
   * 解析锚点存储值 -> 生效配置（设计决策 6）。
   *
   * 两种形态一并认：
   * - 新形态（别名锚点）：raw 等于某 provider 的 id，模型取该配置首模型；
   * - 存量形态（裸模型 ID）：raw 命中某 provider 的 models，解析出归属 provider，
   *   并由调用方回写为别名（legacyValue=true），读一次即自愈。
   *
   * 都解析不到返回 null（悬空值：配置被删或存量模型 ID 已被改名），由调用方降级。
   * @param raw 存储的原始值（settings.defaultModel 或 session.modelOverride）
   * @param providers 当前 provider 列表
   * @returns 解析结果；悬空返回 null
   */
  private resolveAnchor(raw: string, providers: ProviderConfig[]): AnchorResolution | null {
    const byId = providers.find((p) => p.id === raw);
    if (byId !== undefined) {
      const model = firstModel(byId);
      return model === null ? null : { providerId: byId.id, model, legacyValue: false };
    }
    const byModel = providers.find((p) => p.models.includes(raw));
    if (byModel !== undefined) {
      const model = firstModel(byModel);
      // 存量裸 ID 本身就是该配置的某个模型；首模型为空时按存储值原样生效
      return { providerId: byModel.id, model: model ?? raw, legacyValue: true };
    }
    return null;
  }

  /**
   * 解析全局默认锚点，并把存量裸模型 ID 形态就地回写为别名（读时自愈）。
   * @param providers 当前 provider 列表
   * @returns 解析结果；未配置或悬空返回 null
   */
  private resolveDefaultAnchor(providers: ProviderConfig[]): AnchorResolution | null {
    const stored = this.deps.store.getSetting('defaultModel');
    if (typeof stored !== 'string' || stored.trim() === '') {
      return null;
    }
    const resolved = this.resolveAnchor(stored.trim(), providers);
    if (resolved === null) {
      return null;
    }
    if (resolved.legacyValue) {
      this.deps.store.setSetting('defaultModel', resolved.providerId);
    }
    return resolved;
  }

  /**
   * 传播别名锚点改名（设计决策 6：改模型 ID 无需传播，改别名才需要）。
   * 全局默认与所有引用旧别名的会话覆盖一并改写为新别名，用户无感（静默，不提示条数）。
   * @param from 旧别名（= 旧 provider id）
   * @param to 新别名（= saveProvider 的 name，pi models.json 的 provider key）
   */
  private propagateAnchor(from: string, to: string): void {
    if (from === to) {
      return;
    }
    const stored = this.deps.store.getSetting('defaultModel');
    if (typeof stored === 'string' && stored.trim() === from) {
      this.deps.store.setSetting('defaultModel', to);
    }
    for (const session of this.deps.store.listSessions()) {
      if (session.modelOverride === from) {
        this.deps.store.saveSession({ ...session, modelOverride: to });
      }
    }
  }

  /**
   * 查询模型可选项与全局默认（MP-S02）：一个 provider 配置 = 一个可选项。
   * 可选项来自注入的 models.json 适配器（读 providers，不再用 readModelNames 的扁平
   * 模型名列表——扁平列表丢了归属信息，正是「改了模型 ID 就不认识配置」的根因）。
   * @returns 成功返回 { options, defaultProviderId }；adapter 异常返回 5000
   */
  async queryModels(): Promise<ModelResult<ModelRegistry>> {
    let providers: ProviderConfig[];
    try {
      providers = await this.deps.modelsFile.readProviders();
    } catch (err) {
      return { ok: false, code: 5000, message: `读取模型列表失败: ${toMessage(err)}` };
    }
    const options = providers
      .map((p) => ({ providerId: p.id, model: firstModel(p) }))
      .filter((o): o is ModelOption => o.model !== null);
    return {
      ok: true,
      data: { options, defaultProviderId: this.resolveDefaultAnchor(providers)?.providerId ?? null },
    };
  }

  /**
   * 设置全局默认（主会话）模型（MP-S02）：持久化别名锚点到 store settings.defaultModel。
   *
   * 参数是 provider 别名而非模型 ID：改某个配置的模型 ID 后，主会话仍指向该配置并
   * 自动跟着换模型。别名可含空格（pi provider key 原样），因此不做 validateModelId
   * 形态校验，只校验该配置存在。
   * @param providerId 别名锚点；null 表示清除默认
   * @returns 成功返回 null；空值返回 1001；配置不存在/无可用模型返回 1004；adapter 异常返回 5000
   */
  async setDefault(providerId: string | null): Promise<ModelResult<null>> {
    if (providerId !== null && (typeof providerId !== 'string' || providerId.trim() === '')) {
      return { ok: false, code: 1001, message: '模型配置别名不能为空' };
    }
    const target = providerId === null ? null : providerId.trim();
    if (target !== null) {
      let providers: ProviderConfig[];
      try {
        providers = await this.deps.modelsFile.readProviders();
      } catch (err) {
        return { ok: false, code: 5000, message: `读取 provider 配置失败: ${toMessage(err)}` };
      }
      const provider = providers.find((p) => p.id === target);
      if (provider === undefined) {
        return { ok: false, code: 1004, message: `模型配置未保存: ${target}` };
      }
      if (firstModel(provider) === null) {
        return { ok: false, code: 1004, message: `模型配置 ${target} 没有可用模型` };
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
   * 解析全局默认（主会话）锚点：别名 + 派生模型 ID。
   *
   * 供宿主侧（forge-desktop）消费的两处：发送前的悬空自愈回落、生成提交说明时的
   * provider 解析（按别名取配置，避免多配置共用同一模型 ID 时认不出是哪一个）。
   * 读取 models.json 失败时返回 null（调用方按「未配置」降级，不抛错）。
   * @returns { providerId, model }；未配置或解析不到返回 null
   */
  async resolveDefault(): Promise<{ providerId: string; model: string } | null> {
    try {
      const providers = await this.deps.modelsFile.readProviders();
      const resolved = this.resolveDefaultAnchor(providers);
      return resolved === null ? null : { providerId: resolved.providerId, model: resolved.model };
    } catch (err) {
      console.error('[resolveDefault] 读取 provider 配置失败', err);
      return null;
    }
  }

  /**
   * 查询会话当前生效模型（MP-S02）：优先会话覆盖，其次全局默认。
   *
   * 存储值是别名锚点，返回值是解析出的派生模型 ID（pi 消费它）+ 别名（UI 标记选中项）。
   * 覆盖值悬空（配置被删或存量 ID 已改名）时降级到全局默认，不报错——发送前的探测
   * 自愈负责清理。
   * @param sessionId 会话 ID
   * @returns 成功返回 { model, providerId, effective }；会话不存在返回 1002
   */
  async getSessionModel(sessionId: string): Promise<ModelResult<SessionModelInfo>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    const sid = sessionId.trim();
    const session = this.deps.store.getSession(sid);
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    let providers: ProviderConfig[];
    try {
      providers = await this.deps.modelsFile.readProviders();
    } catch (err) {
      return { ok: false, code: 5000, message: `读取 provider 配置失败: ${toMessage(err)}` };
    }
    const override = session.modelOverride;
    if (typeof override === 'string' && override.trim() !== '') {
      const resolved = this.resolveAnchor(override.trim(), providers);
      if (resolved !== null) {
        if (resolved.legacyValue) {
          // 存量裸模型 ID -> 别名回写，下一次读即走新形态
          this.deps.store.saveSession({ ...session, modelOverride: resolved.providerId });
        }
        return {
          ok: true,
          data: {
            model: resolved.model,
            providerId: resolved.providerId,
            effective: 'session',
          },
        };
      }
    }
    const global = this.resolveDefaultAnchor(providers);
    return {
      ok: true,
      data: {
        model: global?.model ?? null,
        providerId: global?.providerId ?? null,
        effective: 'global',
      },
    };
  }

  /**
   * 设置会话级模型覆盖（MP-S02）：仅写该会话 modelOverride，不影响其他会话与全局默认。
   *
   * 写的是 provider 别名锚点（设计决策 6），因此：
   * - 不做 validateModelId 形态校验——别名就是 pi models.json 的 provider key，可以含空格；
   * - **不**拿配置列表做包含性校验：会话模型可能合法存在于 pi 运行时而不在本服务注入的
   *   modelsFile 列表里，把列表当权威等于凭空引入第二份真相，热切换会被误判成 1004。
   *   别名是否还在由读取侧解析降级 + 发送前探测自愈处理。
   * @param sessionId 会话 ID
   * @param providerId 别名锚点；null 表示清除覆盖回到全局默认
   * @returns 成功返回 null；会话不存在返回 1002；别名空返回 1001
   */
  async setSessionModel(
    sessionId: string,
    providerId: string | null,
  ): Promise<ModelResult<null>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (providerId !== null && (typeof providerId !== 'string' || providerId.trim() === '')) {
      return { ok: false, code: 1001, message: '模型配置别名不能为空' };
    }
    const sid = sessionId.trim();
    const session = this.deps.store.getSession(sid);
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sid}` };
    }
    this.deps.store.saveSession({
      ...session,
      modelOverride: providerId === null ? null : providerId.trim(),
    });
    return { ok: true, data: null };
  }

  /**
   * 查询指定模型支持的思考级别列表（MP-S05，docs/api/05_model.md §8）。
   * 能力来源为注入的 ThinkLevelsPort（pi `getSupportedThinkingLevels`）。
   * @param model 模型 ID
   * @returns 成功返回 { levels }；参数空返回 1001；模型不可用（port 返回 null）返回 1004；
   *          能力端口未配置返回 5000
   */
  async getModelThinkingLevels(model: string): Promise<ModelResult<{ levels: string[] }>> {
    if (typeof model !== 'string' || model.trim() === '') {
      return { ok: false, code: 1001, message: '模型 ID 不能为空' };
    }
    const port = this.deps.thinkLevels;
    if (port === undefined) {
      return { ok: false, code: 5000, message: '思考级别能力未配置' };
    }
    try {
      const levels = await port.getSupportedThinkingLevels(model.trim());
      if (levels === null) {
        return { ok: false, code: 1004, message: `模型未配置: ${model}` };
      }
      // MP-S07 产品决策：推理模型的可用级别不向对话框暴露 off（仅推理模型才可能同时含 off 与多级别；
      // 非推理模型 levels=["off"] 原样返回，切换器隐藏判断不受影响）。
      // 过滤不复制 pi 的级别规则（TD-MP-04 仍成立），仅移除产品不展示的单挡位。
      const levelsFiltered = levels.length > 1 ? levels.filter((l) => l !== 'off') : levels;
      return { ok: true, data: { levels: levelsFiltered } };
    } catch (err) {
      return { ok: false, code: 5000, message: `查询思考级别失败: ${toMessage(err)}` };
    }
  }

  /**
   * 查询会话当前生效思考级别（MP-S05，docs/api/05_model.md §9）：优先会话覆盖，
   * 否则继承全局默认（settings.thinkingLevel）；sessionId 传 null 表示草稿态
   * （新会话未创建，docs/api/05_model.md §9），直接查全局默认。
   * @param sessionId 会话 ID；null 查全局默认
   * @returns 成功返回 { level, effective }；会话不存在返回 1002
   */
  async getSessionThinkingLevel(
    sessionId: string | null,
  ): Promise<ModelResult<{ level: ThinkingLevel | null; effective: 'session' | 'global' }>> {
    if (sessionId !== null) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return { ok: false, code: 1001, message: '会话 ID 不能为空' };
      }
      const session = this.deps.store.getSession(sessionId.trim());
      if (session === undefined) {
        return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
      }
      if (session.thinkingLevel !== null) {
        return {
          ok: true,
          data: { level: session.thinkingLevel as ThinkingLevel, effective: 'session' },
        };
      }
    }
    const global = this.deps.store.getSetting('thinkingLevel');
    // 旧数据缺失该键（getSetting 返回 null/非法值）时按 'off' 兜底（schema.md settings 表）
    return {
      ok: true,
      data: { level: isThinkingLevel(global) ? global : 'off', effective: 'global' },
    };
  }

  /**
   * 设置会话思考级别（MP-S05，docs/api/05_model.md §9）：写该会话 thinkingLevel 覆盖
   * 并同步全局默认（settings.thinkingLevel）；null 仅清除会话覆盖，不动全局默认。
   * @param sessionId 会话 ID
   * @param level 思考级别枚举；null 表示清除覆盖回全局默认
   * @returns 成功返回 null；会话不存在返回 1002；level 非法返回 1001
   */
  async setSessionThinkingLevel(
    sessionId: string,
    level: ThinkingLevel | null,
  ): Promise<ModelResult<null>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (level !== null && !isThinkingLevel(level)) {
      return { ok: false, code: 1001, message: '非法思考级别' };
    }
    const sid = sessionId.trim();
    const session = this.deps.store.getSession(sid);
    if (session === undefined) {
      return { ok: false, code: 1002, message: `会话不存在: ${sid}` };
    }
    this.deps.store.saveSession({ ...session, thinkingLevel: level });
    // 同步全局默认（新会话创建时快照全局默认，故已存在会话互不影响）
    if (level !== null) {
      this.deps.store.setSetting('thinkingLevel', level);
    }
    return { ok: true, data: null };
  }
}