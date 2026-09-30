/**
 * forge-store 类型骨架。
 *
 * 仅定义与 docs/db/forge-store/schema.md 各表字段一一对应的 TypeScript 接口，
 * 供后续工作单元实现 forge-store 读写时使用。本文件不包含任何实现逻辑。
 */

/** 项目信任状态缓存（权威值在 pi，此处仅展示缓存，见 schema.md project 表） */
export type TrustState = 'untrusted' | 'asking' | 'trusted' | 'rejected';

/**
 * 项目元数据（对应 schema.md project 表）。
 * @param path 项目目录规范化绝对路径，主键
 * @param alias 项目别名（默认取目录名，可编辑）
 * @param createdAt 创建时间（ISO8601）
 * @param lastOpenedAt 最近打开时间（ISO8601），未打开过为 null
 * @param trustState 信任状态缓存
 * @param priority 手动排序优先级（拖拽钉扎）：数字越小越靠前；null/缺省=未钉扎，按最近打开倒序排钉扎项目之后
 */
export interface ProjectRecord {
  path: string;
  alias: string;
  createdAt: string;
  lastOpenedAt: string | null;
  trustState: TrustState;
  priority?: number | null;
}

/**
 * 会话元数据（对应 schema.md session 表，只存元信息不存消息内容）。
 * @param sessionId pi session ID（对应 pi session 目录名），主键
 * @param projectPath 所属项目绝对路径
 * @param alias 会话别名（默认取首条用户消息摘要，可编辑），可为 null
 * @param lastActiveAt 最近活动时间（ISO8601），会话列表排序用：创建时写一次，
 *   之后每轮会话开始（状态转 running）由 SessionService.setSessionStatus touch，
 *   故 listSessions 的"最近活动在前"在重启后依然成立
 * @param createdAt 创建时间（ISO8601）
 * @param modelOverride 会话级模型覆盖（模块 05；空则用全局默认）
 * @param thinkingLevel 会话级思考级别覆盖（模块 05 MP-S05：off/minimal/low/medium/high/xhigh/max；空则用全局默认）
 * @param doneReadAt 最近一次查看完成结果时间（ISO8601，会话树绿点已读落盘）。
 *   null/缺省=完成结果未读（绿点显示）；新一轮完成（状态转 done）时由服务层清回 null。
 *   可选字段：旧数据无此字段，视为未读。
 */
export interface SessionRecord {
  sessionId: string;
  projectPath: string;
  alias: string | null;
  lastActiveAt: string;
  createdAt: string;
  modelOverride: string | null;
  thinkingLevel: string | null;
  doneReadAt?: string | null;
}

/** settings 表当前键集合（schema.md 设计说明） */
export type StoreKey = 'defaultModel' | 'thinkingLevel' | 'schemaVersion';

/**
 * 全局偏好记录（对应 schema.md settings 表，单例 key-value）。
 * @param key 设置键，主键
 * @param value 设置值（schema 定义为 any；骨架阶段保持与文档一致）
 */
export interface SettingsRecord {
  key: StoreKey;
  value: any;
}

/**
 * forge-store.json 整体结构（单文件原子写，含 schemaVersion 支持迁移）。
 * @param schemaVersion 存储结构版本（当前为 1）
 * @param projects 项目元数据列表
 * @param sessions 会话元数据列表
 * @param settings 全局偏好列表
 */
export interface ForgeStoreData {
  schemaVersion: number;
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  settings: SettingsRecord[];
}