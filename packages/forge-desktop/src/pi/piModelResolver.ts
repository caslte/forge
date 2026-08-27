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

import { defaultPiModelsPath } from './piModelsFileAdapter.ts';

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
  return created;
}

/**
 * 读取 models.json 中用户显式配置的 provider id 集合（仅取 providers 键名，
 * 不解析模型——id 集合用于查找排序，不关心其余字段）。
 * 文件缺失/损坏时返回空集合（视为无用户配置，走内置 catalog 查找）。
 */
function getConfiguredProviderIds(modelsPath: string): Set<string> {
  const cached = configuredProviderCache.get(modelsPath);
  if (cached !== undefined) {
    return cached;
  }
  const ids = new Set<string>();
  try {
    const raw = fs.readFileSync(modelsPath, 'utf8');
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

/**
 * 把模型 ID 解析为 pi Model 对象。
 * 查找顺序：models.json 用户配置的 provider 优先（撞名时保端点/凭据一致），
 * 未命中再遍历全部 provider（含内置 catalog）。
 * @param model forge 模型 ID（models.json 中 providers[].models[].id）
 * @param modelsPath pi models.json 路径（默认 ~/.pi/agent/models.json）
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
  throw new Error(`模型未配置或不可用: ${model}`);
}

/**
 * 查询模型的可用思考级别列表（TP-MP-04：消费 pi SDK `getSupportedThinkingLevels`，
 * forge 不复制 reasoning/thinkingLevelMap 过滤规则；TD-MP-04）。
 * @param model forge 模型 ID
 * @param modelsPath pi models.json 路径（默认 ~/.pi/agent/models.json）
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
 * @param modelsPath pi models.json 路径（默认 ~/.pi/agent/models.json）
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
