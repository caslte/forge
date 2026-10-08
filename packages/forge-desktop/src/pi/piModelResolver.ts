/**
 * pi 模型解析器（P1-C）。
 *
 * 职责：把 forge 的模型 ID 字符串解析为 pi runtime 可用的 Model 对象，
 * 供会话创建注入与运行中热切换使用。数据源为 pi models.json（经 SDK
 * ModelRuntime 组合，保留 contextWindow/cost 等元数据的默认值处理）。
 *
 * 设计决策：
 * - ModelRuntime 按 modelsPath 缓存复用，refreshOnCreate=false 保证纯本地、
 *   不产生网络请求；未配置/不可用的模型抛出稳定可读错误。
 * - 用户配置优先：pi 内置 catalog（如 minimax/minimax-cn）可能与用户在
 *   models.json 配置的模型 id 撞名（回归案例 MiniMax-M3）。必须先在
 *   models.json 显式配置的 provider 中查找，命中即返回，避免解析到
 *   内置 provider 的同名模型（端点/协议/凭据全不对，报 No API key found）。
 */
import fs from 'node:fs';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

import { defaultPiModelsPath, stripJsonComments } from './piModelsFileAdapter.ts';

/** pi 模型对象（由 SDK getModel 返回类型推导，避免依赖未导出的 Model 类型） */
export type PiModel = Exclude<ReturnType<ModelRuntime['getModel']>, undefined>;

/** modelsPath -> ModelRuntime 缓存（同一配置文件只组合一次） */
const runtimeCache = new Map<string, Promise<ModelRuntime>>();
/** modelsPath -> 用户配置的 provider id 集合缓存（与 runtime 同生命周期） */
const configuredProviderCache = new Map<string, Set<string>>();

/**
 * 清空模型运行时缓存：provider 配置（models.json）变更后调用，
 * 下次解析模型时重新加载 models.json（否则缓存的旧 provider 组合
 * 会继续用旧 apiKey 引用，导致「No API key found」）。
 */
export function clearPiModelRuntimeCache(): void {
  runtimeCache.clear();
  configuredProviderCache.clear();
}

async function getRuntime(modelsPath: string): Promise<ModelRuntime> {
  const cached = runtimeCache.get(modelsPath);
  if (cached !== undefined) {
    return cached;
  }
  const created = ModelRuntime.create({
    modelsPath,
    refreshOnCreate: false,
  });
  runtimeCache.set(modelsPath, created);
  // 拒绝的 create 不入缓存：Promise 被缓存住后，即使下一次 models.json 已被修好，
  // 本进程内也永远拿到同一个 rejection（只有 provider 增删改才会清缓存），
  // 表现为「配置明明对了，模型却一直报未配置」——必须失败即摘除。
  created.catch(() => {
    if (runtimeCache.get(modelsPath) === created) runtimeCache.delete(modelsPath);
  });
  return created;
}

/**
 * 读取 models.json 中用户显式配置的 provider id 集合（仅取 providers 键名，
 * 不解析模型——id 集合用于查找排序，不关心其余字段）。
 * 文件缺失/损坏时返回空集合（视为无用户配置，走内置 catalog 查找）。
 *
 * 必须经 stripJsonComments 与 pi / forge 写入口保持同一解析口径：models.json 是
 * JSONC，允许 `//` 注释。裸 JSON.parse 遇注释会整份失败 → configured 集合变空 →
 * 「用户 provider 优先」那一轮被跳过 → 同名模型解析到无凭据的内置 catalog
 * （正是文件头注释记的 MiniMax-M3 撞名回归）。
 */
function getConfiguredProviderIds(modelsPath: string): Set<string> {
  const cached = configuredProviderCache.get(modelsPath);
  if (cached !== undefined) {
    return cached;
  }
  const ids = new Set<string>();
  try {
    const raw = stripJsonComments(fs.readFileSync(modelsPath, 'utf8'));
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, unknown>;
    };
    if (parsed.providers !== null && typeof parsed.providers === 'object') {
      for (const key of Object.keys(parsed.providers)) {
        ids.add(key);
      }
    }
  } catch {
    // 读取/解析失败：按无用户配置处理
  }
  configuredProviderCache.set(modelsPath, ids);
  return ids;
}

/** 模型不存在（解析跑完了，确实没这个模型）——与「运行时加载失败」严格区分。 */
export class PiModelNotFoundError extends Error {
  readonly model: string;
  constructor(model: string) {
    // 错误文案带「怎么办」：这个字符串会原样冒到对话顶部的错误横幅（分类器只管
    // provider/网络层错误，模型解析失败走无分类的单行原文通道）。只说「未配置」
    // 时用户无从判断是自己选错了、还是设置里刚把它改名/删掉了。
    super(`模型未配置或不可用: ${model}（该模型可能已被改名或删除，请在输入框下方重新选择模型）`);
    this.name = 'PiModelNotFoundError';
    this.model = model;
  }
}

/**
 * 把模型 ID 解析为 pi Model 对象。
 * 查找顺序：models.json 用户配置的 provider 优先（撞名时保端点/凭据一致），
 * 未命中再遍历全部 provider（含内置 catalog）。
 * @param model forge 模型 ID（models.json 中 providers[].models[].id）
 * @param modelsPath pi models.json 路径（生产由调用方注入 agent 目录下路径；缺省回退 defaultPiModelsPath，仅 dev/测试）
 * @returns pi Model 对象
 * @throws Error 模型在任何 provider 下都不存在时抛出稳定错误
 */
export async function resolvePiModel(
  model: string,
  modelsPath: string = defaultPiModelsPath(),
): Promise<PiModel> {
  const runtime = await getRuntime(modelsPath);
  const providers = runtime.getProviders();
  const configured = getConfiguredProviderIds(modelsPath);
  // 第一轮：仅用户配置的 provider（保证同名模型用用户端点与凭据）
  for (const provider of providers) {
    if (!configured.has(provider.id)) continue;
    const found = runtime.getModel(provider.id, model);
    if (found !== undefined) {
      return found;
    }
  }
  // 第二轮：全部 provider（内置 catalog 兜底，覆盖未自建模型的场景）
  for (const provider of providers) {
    const found = runtime.getModel(provider.id, model);
    if (found !== undefined) {
      return found;
    }
  }
  throw new PiModelNotFoundError(model);
}

/**
 * 探测模型可解析性，且区分「确实没有这个模型」与「探测本身失败了」。
 *
 * 发送前的自愈必须做这个区分：models.json 临时读不到 / ModelRuntime 创建失败时，
 * 「探不到」不等于「模型没了」，此时若当坏值处理就会把用户好端端的模型设置清掉。
 * 拿不准时一律当 unknown，由调用方保持原状。
 *
 * @param model forge 模型 ID
 * @param modelsPath pi models.json 路径
 * @returns 'ok' 可解析；'not-found' 解析完成但无此模型；'unknown' 探测失败
 */
export async function probePiModel(
  model: string,
  modelsPath: string = defaultPiModelsPath(),
): Promise<'ok' | 'not-found' | 'unknown'> {
  try {
    await resolvePiModel(model, modelsPath);
    return 'ok';
  } catch (err) {
    if (err instanceof PiModelNotFoundError) return 'not-found';
    return 'unknown';
  }
}

/**
 * 查询模型的可用思考级别列表（TP-MP-04：消费 pi SDK `getSupportedThinkingLevels`，
 * forge 不复制 reasoning/thinkingLevelMap 过滤规则；TD-MP-04）。
 * @param model forge 模型 ID
 * @param modelsPath pi models.json 路径（生产由调用方注入 agent 目录下路径；缺省回退 defaultPiModelsPath，仅 dev/测试）
 * @returns 可用级别数组（如 ["off","minimal",...]；非推理模型仅 ["off"]）；
 *          模型解析失败返回 null（上层映射为 1004「模型未配置」）
 */
export async function getPiSupportedThinkingLevels(
  model: string,
  modelsPath: string = defaultPiModelsPath(),
): Promise<string[] | null> {
  try {
    const piModel = await resolvePiModel(model, modelsPath);
    return getSupportedThinkingLevels(piModel);
  } catch {
    return null;
  }
}

/**
 * 请求级别超出模型支持范围时经 pi SDK `clampThinkingLevel` 就近收敛为可用级别
 * （TD-MP-04；如仅至 high 的模型请求 max -> 收敛 high）。
 * @param model forge 模型 ID
 * @param level 请求级别（off/minimal/low/medium/high/xhigh/max）
 * @param modelsPath pi models.json 路径（生产由调用方注入 agent 目录下路径；缺省回退 defaultPiModelsPath，仅 dev/测试）
 * @returns 收敛后的可用级别；模型解析失败返回 level 原值（上层兜底）
 */
export async function clampPiThinkingLevel(
  model: string,
  level: string,
  modelsPath: string = defaultPiModelsPath(),
): Promise<string> {
  try {
    const piModel = await resolvePiModel(model, modelsPath);
    return clampThinkingLevel(piModel, level as ModelThinkingLevel);
  } catch {
    return level;
  }
}
