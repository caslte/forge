/**
 * 真实密钥适配器（MVP：环境变量安全引用）。
 *
 * 职责：把 apiKey 以 `$ENV_VAR` 引用形式保存到 models.json，不明文落盘
 * （docs/prd/05_model_provider.md TD-MP-01 的降级路径：OS 无 keychain 时用 $ENV_VAR）。
 *
 * Windows 上完整 keychain（DPAPI）见 SafeStorageKeychainAdapter（P3-D，Electron safeStorage）；
 * 本类为纯环境变量降级：
 * - storeKey(providerId, apiKey)：把 apiKey 写入进程环境变量
 *   `FORGE_<PROVIDER>_API_KEY`（仅当前进程，不落盘），返回 `$FORGE_<PROVIDER>_API_KEY` 引用。
 * - isAvailable()：始终 true（env 引用总是可用，无需系统 keychain）。
 *
 * 注：当前实现把值放进程环境变量，重启进程后环境变量丢失，但 models.json 里保留的
 * 是 `$ENV_VAR` 引用；若用户已把该变量配置在系统环境，则 pi 重启后仍可读取。
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

  /** 读取已存密钥明文（编辑回显用）：优先内存缓存，其次进程环境变量；未找到返回 null */
  async readKey(providerId: string): Promise<string | null> {
    const cached = this.memory.get(providerId);
    if (cached !== undefined) return cached;
    const envValue = process.env[this.envName(providerId)];
    return envValue ?? null;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/**
 * Windows DPAPI 密钥适配器（P3-D）。
 *
 * 用 Electron 主进程内置 safeStorage（Windows 下即 DPAPI / credential store）
 * 加密 apiKey 持久化到本地 vault 文件，并把明文只放入进程环境变量供 pi 读取
 * （models.json 中保持 `$ENV_VAR` 引用，pi 侧零改动）：
 * - storeKey：safeStorage.encryptString → base64 写 vault（userData/forge-keyvault.json），
 *   同时写 process.env，返回 `$FORGE_<PROVIDER>_API_KEY` 引用。
 * - restoreEnv：启动时读 vault 解密回填 process.env（解决重启后环境变量丢失）。
 * - isAvailable：safeStorage.isEncryptionAvailable()（不可用降级由上层用 EnvVarKeychainAdapter）。
 *
 * 依赖注入 getSafeStorage（惰性）：主进程传 electron.safeStorage；node 环境（测试）
 * 不开启此适配器，避免硬依赖 Electron。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** vault 文件结构：providerId -> base64(encrypted) */
type VaultFile = Record<string, string>;

export class SafeStorageKeychainAdapter {
  private readonly vaultPath: string;
  private readonly getSafeStorage: () => SafeStorageLike | null;

  /**
   * @param vaultPath vault 文件路径（主进程传 userData/forge-keyvault.json）
   * @param getSafeStorage 返回 electron safeStorage；null 表示当前环境不可用
   */
  constructor(vaultPath: string, getSafeStorage: () => SafeStorageLike | null) {
    this.vaultPath = vaultPath;
    this.getSafeStorage = getSafeStorage;
  }

  /** 由 provider id 生成环境变量名（与 EnvVarKeychainAdapter 一致） */
  private envName(providerId: string): string {
    return `FORGE_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const ss = this.getSafeStorage();
      return ss !== null && ss.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async storeKey(providerId: string, apiKey: string): Promise<string> {
    const ss = this.getSafeStorage();
    if (ss === null || !ss.isEncryptionAvailable()) {
      throw new Error('系统密钥链不可用');
    }
    const encrypted = ss.encryptString(apiKey);
    const vault = this.readVault();
    vault[providerId] = encrypted.toString('base64');
    this.writeVault(vault);
    // 明文仅进进程环境变量，供 pi 按引用读取；不落盘
    process.env[this.envName(providerId)] = apiKey;
    return `$${this.envName(providerId)}`;
  }

  /** 启动恢复：读 vault 解密回填 process.env（重启后 pi 仍可按引用读 key） */
  restoreEnv(): void {
    const ss = this.getSafeStorage();
    if (ss === null || !ss.isEncryptionAvailable()) {
      return;
    }
    const vault = this.readVault();
    for (const [providerId, base64] of Object.entries(vault)) {
      try {
        const plain = ss.decryptString(Buffer.from(base64, 'base64'));
        process.env[this.envName(providerId)] = plain;
      } catch {
        // 单条解密失败（机器变更等）跳过，不影响其余
      }
    }
  }

  /**
   * 读取已存密钥明文（编辑回显用）：优先 vault 解密，其次进程环境变量；
   * 解密成功时同步回填 process.env（pi 侧按 `$VAR` 引用实时读 env，
   * 确保即使 restoreEnv 遗漏时发消息也能解析到 key）；不可用/失败返回 null。
   */
  async readKey(providerId: string): Promise<string | null> {
    const ss = this.getSafeStorage();
    if (ss !== null && ss.isEncryptionAvailable()) {
      try {
        const base64 = this.readVault()[providerId];
        if (typeof base64 === 'string' && base64 !== '') {
          const plain = ss.decryptString(Buffer.from(base64, 'base64'));
          process.env[this.envName(providerId)] = plain;
          return plain;
        }
      } catch {
        // 解密失败：回退到进程环境变量
      }
    }
    const envValue = process.env[this.envName(providerId)];
    return envValue ?? null;
  }

  private readVault(): VaultFile {
    try {
      if (!fs.existsSync(this.vaultPath)) {
        return {};
      }
      const raw = fs.readFileSync(this.vaultPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as VaultFile;
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeVault(vault: VaultFile): void {
    fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true });
    fs.writeFileSync(this.vaultPath, JSON.stringify(vault, null, 2), 'utf8');
  }
}
