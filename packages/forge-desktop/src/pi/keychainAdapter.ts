/**
 * 真实密钥适配器（MVP：环境变量安全引用）。
 *
 * 职责：把 apiKey 以 `$ENV_VAR` 引用形式保存到 models.json，不明文落盘
 * （docs/prd/05_model_provider.md TD-MP-01 的降级路径：OS 无 keychain 时用 $ENV_VAR）。
 *
 * Windows 上完整 keychain（DPAPI / keytar）属于增强项；当前 MVP 采用环境变量引用，
 * 满足「不明文写入 models.json」的硬约束：
 * - storeKey(providerId, apiKey)：把 apiKey 写入进程环境变量
 *   `FORGE_<PROVIDER>_API_KEY`（仅当前进程，不落盘），返回 `$FORGE_<PROVIDER>_API_KEY` 引用。
 * - isAvailable()：始终 true（env 引用总是可用，无需系统 keychain）。
 *
 * 注：当前实现把值放进程环境变量，重启进程后环境变量丢失，但 models.json 里保留的
 * 是 `$ENV_VAR` 引用；若用户已把该变量配置在系统环境，则 pi 重启后仍可读取。完整
 * 持久化 keychain（Windows DPAPI）留待后续迭代。
 */
export class EnvVarKeychainAdapter {
  private readonly memory: Map<string, string> = new Map();

  /** 由 provider id 生成环境变量名（如 openai -> FORGE_OPENAI_API_KEY） */
  private envName(providerId: string): string {
    return `FORGE_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  }

  async storeKey(providerId: string, apiKey: string): Promise<string> {
    const name = this.envName(providerId);
    // 写入进程级环境变量（当前会话可见）；同时内存缓存供本次运行查询
    process.env[name] = apiKey;
    this.memory.set(providerId, apiKey);
    return `$${name}`;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
