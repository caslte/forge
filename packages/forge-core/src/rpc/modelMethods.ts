/**
 * 模型与 Provider 配置 RPC 方法层（wu-05-rpc）。
 *
 * 职责：把 ModelService 的业务方法包装为传输无关的方法映射（method -> handler），
 * 统一返回 `{ code, message, data }` 信封（docs/api/index.md 响应格式），供任意传输
 * 层（Electron IPC / headless HTTP）直接调用。本模块是纯 Node，不 import
 * Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 信封格式：成功 `{ code: 0, message: "success", data }`；失败 `{ code, message,
 *    data: null }`。错误码与 docs/api/05_model.md §8 一致：1001 参数错误 / 1002
 *    provider / 会话不存在 / 1004 provider 未配置 / 5000 内部错误。
 * 2. 参数校验：每个 handler 先校验 params（name/type/models/sessionId/id/model 等），
 *    非法输入直接返回 1001，不进入服务层。
 * 3. 密钥安全（TD-MP-01，硬约束）：queryProviderList 与 providersChanged 事件载荷
 *    中的 provider 一律经 toSafeProvider 映射为文档公开形状（docs/api/05_model.md
 *    §1），剥离 apiKey 安全引用，绝不明文/引用泄漏。
 * 4. 异常隔离：服务层意外抛错（如 adapter 异常、store 落盘失败）被捕获并返回 5000，
 *    不向调用方泄漏异常细节；错误日志用英文 + `[方法名]` 前缀（docs/specs/common/
 *    coding-style.md）。
 * 5. 事件：model.providersChanged 在 saveProvider / deleteProvider 成功后发射，载荷
 *    为重新查询后的 provider 列表（docs/api/05_model.md §7）；事件汇（EventSink）
 *    为 EventEmitter 兼容接口（仅需 emit），默认使用 node:events EventEmitter，
 *    调用方可注入自定义汇（如跨进程转发）。
 * 6. 异步方法统一经 call 包装，返回 Promise<RpcResult>；方法映射签名兼容同步/异步
 *    handler。
 */

import { EventEmitter } from 'node:events';
import type { RpcResult, EventSink } from './projectMethods.ts';
import {
  THINKING_LEVELS,
  type ModelService,
  type ModelResult,
  type ProviderConfig,
  type SaveProviderInput,
  type ThinkingLevel,
} from '../model/modelService.ts';

/** 构造成功信封 */
function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

/** 构造失败信封（data 恒为 null） */
function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** 类型守卫：params 是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从 params 中取非空字符串参数。
 * @param params 请求参数（未知类型，来自传输层）
 * @param key 参数名
 * @returns 非空字符串；缺失/非字符串/空白返回 null
 */
function requireString(params: unknown, key: string): string | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return value;
}

/**
 * 归一化 provider 响应形状（docs/api/05_model.md §1）。
 * 默认保留 apiKey 字段用于前端回显（用户选择「回显已存密钥」）；
 * contextWindow 原样透出（MP-S06；未配置统一回显 null，docs/api/05_model.md §1，转发不回丢）。
 * @param provider 服务层返回的 provider
 * @returns 统一形状的 provider 对象（含 apiKey 回显）
 */
function toSafeProvider(provider: ProviderConfig): ProviderConfig {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    models: provider.models,
    lastError: provider.lastError,
    contextWindow: provider.contextWindow ?? null,
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    // 多模态回显：布尔值透传（未配置省略，前端按 === true 勾选）
    ...(provider.vision !== undefined ? { vision: provider.vision } : {}),
    // MP-S07 回显：思考强度 + 思考等级白名单透传（丢字段会导致编辑对话框要求重选思考等级）
    ...(provider.reasoning !== undefined ? { reasoning: provider.reasoning } : {}),
    ...(provider.thinkingLevels !== undefined ? { thinkingLevels: provider.thinkingLevels } : {}),
  };
}

/**
 * 解析并校验 saveProvider 请求参数。
 * @param params 请求参数（未知类型，来自传输层）
 * @returns 合法输入；name/type 缺失或空白、models 非数组/为空/含非字符串、
 *          contextWindow 非法类型返回 null（→ 1001）
 */
function parseSaveInput(params: unknown): SaveProviderInput | null {
  if (!isRecord(params)) {
    return null;
  }
  const name = params.name;
  const type = params.type;
  if (typeof name !== 'string' || name.trim() === '') {
    return null;
  }
  if (typeof type !== 'string' || type.trim() === '') {
    return null;
  }
  if (!Array.isArray(params.models) || params.models.length === 0) {
    return null;
  }
  if (!params.models.every((m) => typeof m === 'string')) {
    return null;
  }
  const input: SaveProviderInput = { name, type, models: params.models as string[] };
  if (typeof params.id === 'string' && params.id.trim() !== '') {
    input.id = params.id;
  }
  if (typeof params.baseUrl === 'string') {
    input.baseUrl = params.baseUrl;
  }
  if (typeof params.apiKey === 'string') {
    input.apiKey = params.apiKey;
  }
  // contextWindow（MP-S06）：可选；必须为 number 或 null；非法类型判 1001 不进入服务层
  if (params.contextWindow !== undefined) {
    if (params.contextWindow !== null && typeof params.contextWindow !== 'number') {
      return null;
    }
    input.contextWindow = params.contextWindow as number | null;
  }
  // vision（多模态）：可选；必须为布尔值（true/false 均显式传递，缺省保留原值）；非法类型判 1001 不进入服务层
  if (params.vision !== undefined) {
    if (typeof params.vision !== 'boolean') {
      return null;
    }
    input.vision = params.vision;
  }
  // reasoning（MP-S07 思考强度）：可选；必须为布尔值；非法类型判 1001 不进入服务层
  if (params.reasoning !== undefined) {
    if (typeof params.reasoning !== 'boolean') {
      return null;
    }
    input.reasoning = params.reasoning;
  }
  // thinkingLevels（MP-S07 思考等级白名单）：可选；必须为 THINKING_LEVELS 内的字符串数组或 null；非法判 1001
  if (params.thinkingLevels !== undefined) {
    if (params.thinkingLevels === null) {
      input.thinkingLevels = null;
    } else if (
      Array.isArray(params.thinkingLevels) &&
      params.thinkingLevels.every((l) => typeof l === 'string' && THINKING_LEVELS.includes(l as ThinkingLevel))
    ) {
      input.thinkingLevels = [...new Set(params.thinkingLevels as ThinkingLevel[])];
    } else {
      return null;
    }
  }
  return input;
}

/**
 * 模型与 Provider 配置 RPC 方法层：方法映射 + 事件发射。
 * @param service ModelService 业务实例
 * @param events 事件汇（默认新建 EventEmitter；可注入自定义汇）
 */
export class ModelApi {
  /** 方法映射：方法名 -> handler(params) -> 统一信封（可同步/异步） */
  readonly methods: Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;
  /** 事件汇：model.providersChanged 在此发射 */
  readonly events: EventSink;
  private readonly service: ModelService;

  constructor(service: ModelService, events?: EventSink) {
    this.service = service;
    this.events = events ?? new EventEmitter();
    this.methods = {
      'model/queryProviderList': (params) => this.queryProviderList(params),
      'model/saveProvider': (params) => this.saveProvider(params),
      'model/deleteProvider': (params) => this.deleteProvider(params),
      'model/queryModels': (params) => this.queryModels(params),
      'model/setDefault': (params) => this.setDefault(params),
      'model/getSessionModel': (params) => this.getSessionModel(params),
      'model/setSessionModel': (params) => this.setSessionModel(params),
      'model/getModelThinkingLevels': (params) => this.getModelThinkingLevels(params),
      'model/getSessionThinkingLevel': (params) => this.getSessionThinkingLevel(params),
      'model/setSessionThinkingLevel': (params) => this.setSessionThinkingLevel(params),
    };
  }

  /**
   * 通用调用包装：执行服务方法并映射为信封；意外异常捕获为 5000。
   * @param method 方法名（日志前缀）
   * @param fn 服务调用（同步或异步）
   * @returns 统一信封
   */
  private async call<T>(
    method: string,
    fn: () => ModelResult<T> | Promise<ModelResult<T>>,
  ): Promise<RpcResult> {
    try {
      const result = await fn();
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error(`[${method}] internal error`, err);
      return fail(5000, 'internal error');
    }
  }

  /**
   * 重新查询 provider 列表并发射 model.providersChanged（docs/api/05_model.md §7）。
   * 仅在重新查询成功时发射；载荷为剥离 apiKey 的安全 provider 列表。
   */
  private async emitProvidersChanged(): Promise<void> {
    const result = await this.service.queryProviderList();
    if (result.ok) {
      this.events.emit('model.providersChanged', {
        providers: result.data.providers.map(toSafeProvider),
      });
    }
  }

  /** model/queryProviderList：查询 provider 列表（MP-S03），剥离 apiKey 引用 */
  private queryProviderList(params: unknown): Promise<RpcResult> {
    return this.call('queryProviderList', async () => {
      const result = await this.service.queryProviderList();
      if (result.ok) {
        return { ok: true, data: { providers: result.data.providers.map(toSafeProvider) } };
      }
      return result;
    });
  }

  /** model/saveProvider：保存 / 更新 provider（MP-S01），成功后发射 providersChanged */
  private async saveProvider(params: unknown): Promise<RpcResult> {
    const input = parseSaveInput(params);
    if (input === null) {
      return fail(1001, '参数错误：name/type 必须为非空字符串，models 必须为非空字符串数组');
    }
    const result = await this.call('saveProvider', () => this.service.saveProvider(input));
    if (result.code === 0) {
      await this.emitProvidersChanged();
    }
    return result;
  }

  /** model/deleteProvider：删除 provider（MP-S01），成功后发射 providersChanged */
  private async deleteProvider(params: unknown): Promise<RpcResult> {
    const id = requireString(params, 'id');
    if (id === null) {
      return fail(1001, '参数错误：id 必须为非空字符串');
    }
    const result = await this.call('deleteProvider', () => this.service.deleteProvider(id));
    if (result.code === 0) {
      await this.emitProvidersChanged();
    }
    return result;
  }

  /** model/queryModels：查询模型列表与全局默认（MP-S02） */
  private queryModels(params: unknown): Promise<RpcResult> {
    return this.call('queryModels', () => this.service.queryModels());
  }

  /** model/setDefault：设置全局默认模型（MP-S02），未知模型由服务层返回 1004 */
  private setDefault(params: unknown): Promise<RpcResult> {
    if (!isRecord(params)) {
      return Promise.resolve(fail(1001, '参数错误：model 必须为字符串或 null'));
    }
    const model = params.model;
    if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
      return Promise.resolve(fail(1001, '参数错误：model 必须为字符串或 null'));
    }
    return this.call('setDefault', () =>
      this.service.setDefault(model === null ? null : model.trim()),
    );
  }

  /** model/getSessionModel：查询会话生效模型（MP-S02），未知会话由服务层返回 1002 */
  private getSessionModel(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('getSessionModel', () => this.service.getSessionModel(sessionId));
  }

  /** model/setSessionModel：设置会话级模型覆盖（MP-S02），未知会话由服务层返回 1002 */
  private setSessionModel(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    if (!isRecord(params)) {
      return Promise.resolve(fail(1001, '参数错误：model 必须为字符串或 null'));
    }
    const model = params.model;
    if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
      return Promise.resolve(fail(1001, '参数错误：model 必须为字符串或 null'));
    }
    return this.call('setSessionModel', () =>
      this.service.setSessionModel(sessionId, model === null ? null : model.trim()),
    );
  }

  /** model/getModelThinkingLevels：查询模型可用思考级别列表（MP-S05），未知模型由服务层返回 1004 */
  private getModelThinkingLevels(params: unknown): Promise<RpcResult> {
    const model = requireString(params, 'model');
    if (model === null) {
      return Promise.resolve(fail(1001, '参数错误：model 必须为非空字符串'));
    }
    return this.call('getModelThinkingLevels', () => this.service.getModelThinkingLevels(model));
  }

  /** model/getSessionThinkingLevel：查询会话当前生效思考级别（MP-S05）；sessionId 缺省时查全局默认（草稿态，新会话继承全局），未知会话由服务层返回 1002 */
  private getSessionThinkingLevel(params: unknown): Promise<RpcResult> {
    if (!isRecord(params) || params.sessionId === undefined) {
      return this.call('getSessionThinkingLevel', () => this.service.getSessionThinkingLevel(null));
    }
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('getSessionThinkingLevel', () =>
      this.service.getSessionThinkingLevel(sessionId),
    );
  }

  /** model/setSessionThinkingLevel：设置会话思考级别（MP-S05），非法 level 由服务层返回 1001 */
  private setSessionThinkingLevel(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    if (!isRecord(params)) {
      return Promise.resolve(fail(1001, '参数错误：level 必须为思考级别字符串或 null'));
    }
    const level = params.level;
    if (level !== null && typeof level !== 'string') {
      return Promise.resolve(fail(1001, '参数错误：level 必须为思考级别字符串或 null'));
    }
    return this.call('setSessionThinkingLevel', () =>
      this.service.setSessionThinkingLevel(sessionId, level as ThinkingLevel | null),
    );
  }
}

/**
 * 创建 ModelApi 实例（工厂）。
 * @param service 模型与 Provider 配置业务服务
 * @param events 事件汇（可选，默认新建 EventEmitter）
 * @returns ModelApi 实例
 */
export function createModelApi(service: ModelService, events?: EventSink): ModelApi {
  return new ModelApi(service, events);
}