/**
 * forge-store 持久化层出口（store 自有 barrel）。
 *
 * 供 projectService 等上层模块以稳定路径导入，避免直接依赖实现文件。
 * 注意：本 barrel 不并入 src/index.ts（该文件由 wu-01-rpc 维护）。
 */

export { ForgeStore, ForgeStoreError, normalizeProjectPath, CURRENT_SCHEMA_VERSION } from './forgeStore.ts';
export type { AddProjectResult, UpdateProjectResult, RemoveProjectResult } from './forgeStore.ts';