/**
 * Model 层 mock 适配器（forge-desktop 冒烟用假实现）。
 *
 * ModelService 依赖 ModelsFileAdapter（pi models.json 读写）与 KeychainAdapter
 * （OS 密钥链）；冒烟阶段无真实 pi models.json 与系统密钥链，用内存假实现承接。
 * 仅以 `import type` 引用 @forge/core 接口，类型剥离后运行时不依赖 forge-core dist。
 */
import type {
  ModelsFileAdapter,
  KeychainAdapter,
  ProviderConfig,
  ProviderFileRecord,
} from '@forge/core';

/**
 * models.json 适配器 mock：内存 provider 列表。
 * readProviders 剥离 apiKey 返回 ProviderConfig[]；writeProviders 接受落盘记录。
 */
export class MockModelsFileAdapter implements ModelsFileAdapter {
  private records: ProviderFileRecord[] = [];

  async readProviders(): Promise<ProviderConfig[]> {
    return this.records.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      baseUrl: r.baseUrl,
      models: [...r.models],
      lastError: r.lastError,
    }));
  }

  async writeProviders(providers: ProviderFileRecord[]): Promise<void> {
    this.records = providers.map((p) => ({ ...p, models: [...p.models] }));
  }

  async readModelNames(): Promise<string[]> {
    const names = new Set<string>();
    for (const p of this.records) {
      for (const m of p.models) {
        names.add(m);
      }
    }
    return [...names];
  }
}

/**
 * 密钥链适配器 mock：内存 key 存储，storeKey 返回 mock 安全引用。
 */
export class MockKeychainAdapter implements KeychainAdapter {
  private readonly keys: Map<string, string> = new Map();

  async storeKey(providerId: string, apiKey: string): Promise<string> {
    this.keys.set(providerId, apiKey);
    return `!mock:${providerId}`;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
