/**
 * updater-state.json 读写（docs/db/07_installer/schema.md）。
 *
 * 单例 JSON 文档，存 userData 目录（路径由 main.ts 传入，不经 forge-core——
 * 更新体系属 Electron 壳层职责）：预装/联动的幂等标志与组件版本快照。
 * - 单写者：仅 forge-desktop 主进程更新编排（startupUpdate.ts）读写
 * - 原子写：同目录 tmp 文件 + rename 覆盖
 * - 文件缺失/损坏按全默认值重建（降级为重新预装/重新触发联动，均幂等安全）
 * - 启动路径小文件，全部同步 fs
 */
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

/** updater-state.json 文档结构（schemaVersion=1，单例） */
export interface UpdaterState {
  schemaVersion: number;
  /** 上次运行时记录的 forge 版本；null = 首次运行 */
  lastRunForgeVersion: string | null;
  /** 推荐组件预装是否已完成；失败保持 false，下次启动重试 */
  preinstallDone: boolean;
  /** 预装完成时间（ISO8601，观测用，无业务判断依赖） */
  preinstallDoneAt: string | null;
  /** 最近一次检查/执行组件更新时间（ISO8601，观测用） */
  lastUpdateCheckAt: string | null;
  /** 组件版本快照：{ 包名: 版本 }；每次组件更新成功后整体刷新 */
  components: Record<string, string>;
}

/** updater-state.json 在 userData 目录下的默认路径（目录由调用方传入，本模块不自取） */
export function defaultUpdaterStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'updater-state.json');
}

/** 文档默认值（首次创建 seed，docs/db/07_installer/schema.md） */
function defaultUpdaterState(): UpdaterState {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastRunForgeVersion: null,
    preinstallDone: false,
    preinstallDoneAt: null,
    lastUpdateCheckAt: null,
    components: {},
  };
}

/** 字段类型校验；任一字段损坏即视为整份文档损坏（按全默认值重建） */
function isValidState(value: unknown): value is UpdaterState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schemaVersion === 'number' &&
    (v.lastRunForgeVersion === null || typeof v.lastRunForgeVersion === 'string') &&
    typeof v.preinstallDone === 'boolean' &&
    (v.preinstallDoneAt === null || typeof v.preinstallDoneAt === 'string') &&
    (v.lastUpdateCheckAt === null || typeof v.lastUpdateCheckAt === 'string') &&
    typeof v.components === 'object' &&
    v.components !== null &&
    !Array.isArray(v.components) &&
    Object.values(v.components).every((x) => typeof x === 'string')
  );
}

/**
 * 读取 updater-state.json；文件缺失或损坏（JSON 非法/字段类型不符）→ 全默认值。
 * 绝不抛出（降级为重新预装/重新触发联动，均幂等安全）。
 */
export function readUpdaterState(statePath: string): UpdaterState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!isValidState(parsed)) return defaultUpdaterState();
    return {
      schemaVersion: parsed.schemaVersion,
      lastRunForgeVersion: parsed.lastRunForgeVersion,
      preinstallDone: parsed.preinstallDone,
      preinstallDoneAt: parsed.preinstallDoneAt,
      lastUpdateCheckAt: parsed.lastUpdateCheckAt,
      components: { ...parsed.components },
    };
  } catch {
    return defaultUpdaterState();
  }
}

/** 原子写：同目录 tmp 文件 + rename 覆盖（单写者，无并发） */
export function writeUpdaterState(statePath: string, state: UpdaterState): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, statePath);
}

/** 组件快照增量合并（纯函数）：changes 值为版本号写入、null 移除该包；不改入参 */
export function updateComponents(
  state: UpdaterState,
  changes: Record<string, string | null>,
): UpdaterState {
  const components = { ...state.components };
  for (const [name, version] of Object.entries(changes)) {
    if (version === null) delete components[name];
    else components[name] = version;
  }
  return { ...state, components };
}
