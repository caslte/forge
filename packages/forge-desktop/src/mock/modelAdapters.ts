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
 *
 * 与 PiModelsFileAdapter 同构：pi 的 models.json 按 provider name 作 key，
 * 读回时 id === name === provider key。模型配置别名锚点（settings.defaultModel /
 * 会话 modelOverride）存的就是这个 id，mock 若原样保留传入 id 会让改名传播、
 * 锚点解析这类行为在 mock 下测不出来。
 */
export class MockModelsFileAdapter implements ModelsFileAdapter {
  private records: ProviderFileRecord[] = [];

  async readProviders(): Promise<ProviderConfig[]> {
    return this.records.map((r) => ({
      id: r.name,
      name: r.name,
      type: r.type,
      baseUrl: r.baseUrl,
      models: [...r.models],
      lastError: r.lastError,
    }));
  }

  async writeProviders(providers: ProviderFileRecord[]): Promise<void> {
    const byName = new Map<string, ProviderFileRecord>();
    for (const p of providers) {
      byName.set(p.name, { ...p, id: p.name, models: [...p.models] });
    }
    this.records = [...byName.values()];
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
