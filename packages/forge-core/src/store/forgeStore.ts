/**
 * forge-store 持久化层。
 *
 * 职责：forge 自有数据（项目元数据 / 会话元数据 / 全局偏好）的单文件 JSON 持久化，
 * 对应 docs/db/forge-store/schema.md 的 project / session / settings 三张表。
 * 存储介质为单文件 `forge-store.json`，路径由调用方注入（forge-desktop 传入 userData
 * 目录下的路径）；本模块是纯 Node 实现，不 import Electron / Vue / pi。
 *
 * 设计决策（本 WU 的持久化契约，projectService 依赖此接口）：
 * 1. 写入策略：原子写 —— 先写 `<file>.tmp`，再 `fs.renameSync` 覆盖目标文件，
 *    避免崩溃导致文件损坏（schema.md「存储级约束」）。
 * 2. 并发选型：forge-core 是唯一写入者（所有 IPC 经 forge-core 串行化），
 *    故单文件 JSON + 原子写足够安全，不引入 SQLite（schema.md「并发选型」）。
 * 3. 唯一键：project.path 经 `fs.realpathSync` 规范化（解析符号链接/联接、大小写、
 *    `..` 段）后作为唯一键；重复路径由 addProject 返回 `{ ok: false, code: 1001 }`，
 *    调用方（projectService）可直接映射为错误码 1001。
 * 4. addProject 返回判别联合结果而非抛异常：调用方无需 try/catch 即可映射错误码，
 *    契约稳定（1001=重复路径，1002=路径无效或不可访问）。
 * 5. schemaVersion 语义：文件不存在 → 首次播种默认值并落盘；文件存在但缺少
 *    schemaVersion → 视为旧版数据，重新播种（覆盖，文档已注明）；schemaVersion > 1
 *    → 抛 SCHEMA_VERSION_TOO_NEW（未知新版本，拒绝读取）；schemaVersion < 1 → 抛
 *    SCHEMA_VERSION_INVALID（非法版本）。
 * 6. 移除项目不删除会话元数据（schema.md 存储级约束：session 保留，重新添加同路径
 *    项目可恢复会话可见性）。
 * 7. 路径存在性/目录性校验是唯一键规范化的必要部分，故在 store 内完成；业务级校验
 *    （别名、权限等）归 projectService。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ForgeStoreData, ProjectRecord, SessionRecord, StoreKey } from '../types/forge-store.ts';

/** 当前支持的存储结构版本（schema.md settings 表 seed 数据一致） */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * forge-store 错误（带稳定错误码，供调用方区分失败原因）。
 * @param code 错误码：SCHEMA_VERSION_TOO_NEW / SCHEMA_VERSION_INVALID / STORE_CORRUPT / STORE_READ_FAILED / PATH_INVALID
 * @param message 错误描述
 * @param cause 底层异常（可选，便于排查）
 */
export class ForgeStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ForgeStoreError';
    this.code = code;
  }
}

/**
 * addProject 的结果（判别联合）。
 * - `{ ok: true, project }`：注册成功，project.path 为规范化后的唯一键
 * - `{ ok: false, code: 1001 }`：路径重复（唯一键冲突）
 * - `{ ok: false, code: 1002 }`：路径无效或不可访问
 */
export type AddProjectResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; code: 1001; message: string }
  | { ok: false; code: 1002; message: string };

/**
 * updateProject 的结果（判别联合）。
 * - `{ ok: true, project }`：更新成功
 * - `{ ok: false, code: 1003 }`：项目不存在
 */
export type UpdateProjectResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; code: 1003; message: string };

/**
 * removeProject 的结果（幂等）。
 * - `{ ok: true, removed: true }`：删除了记录
 * - `{ ok: true, removed: false }`：路径不存在，无副作用（重复移除幂等）
 */
export type RemoveProjectResult = { ok: true; removed: boolean };

/**
 * reorderProjects 的结果（判别联合）。
 * - `{ ok: true, projects }`：重排成功，返回按新 priority 排序后的列表
 * - `{ ok: false, code: 1003 }`：paths 中含未注册项目路径，不写盘
 */
export type ReorderProjectsResult =
  | { ok: true; projects: ProjectRecord[] }
  | { ok: false; code: 1003; message: string };

/** 构造默认存储数据（首次创建 / 重新播种时使用，与 schema.md seed 数据一致） */
function createEmptyData(): ForgeStoreData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    sessions: [],
    settings: [
      { key: 'defaultModel', value: null },
      // 全局默认思考级别默认关闭（thinking 内容不展示，除用户显式开启）
      { key: 'thinkingLevel', value: 'off' },
      { key: 'schemaVersion', value: CURRENT_SCHEMA_VERSION },
    ],
  };
}

/**
 * 规范化项目路径并校验其有效性（唯一键机制）。
 * 将输入路径解析为绝对路径后经 `fs.realpathSync` 规范化（解析符号链接/联接、大小写、
 * `..` 段），并校验其存在且为目录。
 * @param input 待校验的路径（可为相对路径）
 * @returns 规范化后的绝对路径
 * @throws ForgeStoreError(PATH_INVALID) 路径不存在、不可访问或不是目录
 */
export function normalizeProjectPath(input: string): string {
  const abs = path.resolve(input);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new ForgeStoreError('PATH_INVALID', `路径不存在或不可访问: ${abs}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new ForgeStoreError('PATH_INVALID', `路径不是目录: ${real}`);
  }
  return real;
}

/**
 * forge-store 持久化类：单文件 JSON 读写 + 项目/会话/设置 CRUD。
 *
 * 构造时即执行 load()（首次运行自动播种默认值并落盘；schemaVersion 异常时构造抛错）。
 * 所有变更方法（add/update/remove/setSetting）修改内存数据后立即原子落盘。
 * @param filePath forge-store.json 的完整路径（由调用方注入，如 userData 目录下）
 */
export class ForgeStore {
  private readonly filePath: string;
  private data: ForgeStoreData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = createEmptyData();
    this.load();
  }

  /**
   * 读取并校验存储文件；文件不存在时播种默认值并落盘。
   * 幂等：可重复调用以重新从磁盘加载（如外部修改后刷新）。
   * @returns 加载后的完整存储数据
   * @throws ForgeStoreError 文件损坏 / schemaVersion 非法或过新 / 读取失败
   */
  load(): ForgeStoreData {
    if (!fs.existsSync(this.filePath)) {
      this.seedDefaults();
      return this.data;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new ForgeStoreError('STORE_READ_FAILED', `读取存储文件失败: ${this.filePath}`, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ForgeStoreError('STORE_CORRUPT', `存储文件 JSON 解析失败: ${this.filePath}`, err);
    }
    const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
    // 文件存在但缺少 schemaVersion：视为旧版数据，重新播种（设计决策 5，文档已注明）
    if (typeof version !== 'number') {
      this.seedDefaults();
      return this.data;
    }
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new ForgeStoreError(
        'SCHEMA_VERSION_TOO_NEW',
        `存储 schemaVersion=${version} 高于当前支持版本 ${CURRENT_SCHEMA_VERSION}，拒绝读取`,
      );
    }
    if (version < 1) {
      throw new ForgeStoreError('SCHEMA_VERSION_INVALID', `存储 schemaVersion=${version} 非法（最小为 1）`);
    }
    const data = parsed as ForgeStoreData;
    if (!Array.isArray(data.projects) || !Array.isArray(data.sessions) || !Array.isArray(data.settings)) {
      throw new ForgeStoreError('STORE_CORRUPT', `存储文件结构不完整: ${this.filePath}`);
    }
    this.data = data;
    return this.data;
  }

  /**
   * 原子写盘：先写 `<file>.tmp`，再 `fs.renameSync` 覆盖目标文件。
   * 成功后不残留 .tmp 文件；目录不存在时自动创建。
   */
  save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * 播种默认数据并落盘（首次创建 / schemaVersion 缺失时由 load 调用）。
   * 默认值：schemaVersion=1，projects/sessions 为空，settings 含
   * defaultModel=null、thinkingLevel=off（全局默认思考级别默认关闭）与
   * schemaVersion=1（schema.md settings 表 seed 数据）。
   */
  seedDefaults(): void {
    this.data = createEmptyData();
    this.save();
  }

  /**
   * 项目列表排序（拖拽钉扎优先）：priority 升序在前（数字越小越靠前），
   * 未钉扎（null/缺省）项目按 lastOpenedAt 降序排其后。
   * @returns 项目记录副本（外部修改不影响内存数据）
   */
  listProjects(): ProjectRecord[] {
    return [...this.data.projects].sort((a, b) => {
      const ap = a.priority ?? null;
      const bp = b.priority ?? null;
      if (ap !== null || bp !== null) {
        if (ap === null) return 1;
        if (bp === null) return -1;
        if (ap !== bp) return ap - bp;
      }
      return this.compareByLastOpenedAt(a, b);
    });
  }

  /** 最近打开时间降序比较（null 排最后） */
  private compareByLastOpenedAt(a: ProjectRecord, b: ProjectRecord): number {
    if (a.lastOpenedAt === null && b.lastOpenedAt === null) return 0;
    if (a.lastOpenedAt === null) return 1;
    if (b.lastOpenedAt === null) return -1;
    return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
  }

  /**
   * 按 path 精确查找项目（path 为规范化后的绝对路径）。
   * @param path 项目唯一键
   * @returns 项目记录副本；未找到返回 null
   */
  getProject(path: string): ProjectRecord | null {
    const found = this.data.projects.find((p) => p.path === path);
    return found ? { ...found } : null;
  }

  /**
   * 注册项目：规范化路径 → 唯一键判重 → 写入并落盘。
   * @param record 项目记录（path 可为原始路径，内部会规范化）
   * @returns AddProjectResult：成功返回规范化后的记录；重复返回 code=1001；
   *          路径无效/不可访问返回 code=1002（不写盘）
   */
  addProject(record: ProjectRecord): AddProjectResult {
    let normalized: string;
    try {
      normalized = normalizeProjectPath(record.path);
    } catch {
      return { ok: false, code: 1002, message: '路径无效或不可访问' };
    }
    if (this.data.projects.some((p) => p.path === normalized)) {
      return { ok: false, code: 1001, message: `项目已存在: ${normalized}` };
    }
    const project: ProjectRecord = { ...record, path: normalized };
    this.data.projects.push(project);
    this.save();
    return { ok: true, project };
  }

  /**
   * 更新项目记录（按 path 精确匹配，不重新 realpath —— 目录被删后仍可更新元数据）。
   * @param record 完整的新记录（path 为已注册的规范化路径）
   * @returns 成功返回更新后的项目；项目不存在返回 code=1003
   */
  updateProject(record: ProjectRecord): UpdateProjectResult {
    const idx = this.data.projects.findIndex((p) => p.path === record.path);
    if (idx === -1) {
      return { ok: false, code: 1003, message: `项目不存在: ${record.path}` };
    }
    const updated: ProjectRecord = { ...record };
    this.data.projects[idx] = updated;
    this.save();
    return { ok: true, project: updated };
  }

  /**
   * 全量重排项目（拖拽钉扎）：按传入顺序为每个项目写 priority=index（全部钉扎），
   * 一次性落盘。
   * @param paths 新的全量顺序（已注册的规范化路径列表）
   * @returns 成功返回按新顺序排序后的项目列表；含未注册路径返回 1003 且不写盘
   */
  reorderProjects(paths: string[]): ReorderProjectsResult {
    const byPath = new Map(this.data.projects.map((p) => [p.path, p]));
    for (const p of paths) {
      if (!byPath.has(p)) {
        return { ok: false, code: 1003, message: `项目不存在: ${p}` };
      }
    }
    const next = this.data.projects.map((p) => ({ ...p, priority: paths.indexOf(p.path) }));
    this.data.projects = next;
    this.save();
    return { ok: true, projects: this.listProjects() };
  }

  /**
   * 移除项目记录（幂等）。仅删除 project 记录，不删除会话元数据与源文件
   * （schema.md 存储级约束：session 保留，重新添加同路径可恢复）。
   * @param path 已注册的规范化路径
   * @returns removed=true 表示删除了记录；false 表示路径不存在（无副作用）
   */
  removeProject(path: string): RemoveProjectResult {
    const idx = this.data.projects.findIndex((p) => p.path === path);
    if (idx === -1) {
      return { ok: true, removed: false };
    }
    this.data.projects.splice(idx, 1);
    this.save();
    return { ok: true, removed: true };
  }

  /**
   * 会话列表，按 lastActiveAt 降序（最近活动在前）。
   * @param projectPath 可选：仅返回该项目的会话；省略则返回全部
   * @returns 会话记录副本（外部修改不影响内存数据）
   */
  listSessions(projectPath?: string): SessionRecord[] {
    const sessions =
      projectPath === undefined
        ? this.data.sessions
        : this.data.sessions.filter((s) => s.projectPath === projectPath);
    return [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  /**
   * 按 sessionId 精确查找会话。
   * @param sessionId 会话唯一键（pi session ID）
   * @returns 会话记录副本；未找到返回 undefined
   */
  getSession(sessionId: string): SessionRecord | undefined {
    const found = this.data.sessions.find((s) => s.sessionId === sessionId);
    return found ? { ...found } : undefined;
  }

  /**
   * 写入会话记录（按 sessionId 主键 upsert：存在则覆盖，不存在则新增），
   * 写入后按 lastActiveAt 降序保持有序并落盘。
   * @param record 会话记录（sessionId 为唯一键）
   */
  saveSession(record: SessionRecord): void {
    const idx = this.data.sessions.findIndex((s) => s.sessionId === record.sessionId);
    if (idx === -1) {
      this.data.sessions.push({ ...record });
    } else {
      this.data.sessions[idx] = { ...record };
    }
    this.data.sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    this.save();
  }

  /**
   * 移除会话记录（幂等）。
   * @param sessionId 会话唯一键
   * @returns true 表示删除了记录；false 表示不存在（无副作用）
   */
  removeSession(sessionId: string): boolean {
    const idx = this.data.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) {
      return false;
    }
    this.data.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * 读取全局设置值。
   * @param key 设置键（当前键集合见 StoreKey）
   * @returns 设置值；未设置返回 null
   */
  getSetting(key: StoreKey): unknown {
    const record = this.data.settings.find((s) => s.key === key);
    return record ? record.value : null;
  }

  /**
   * 写入全局设置值并落盘（键不存在则新增）。
   * @param key 设置键
   * @param value 设置值（可为 null）
   */
  setSetting(key: StoreKey, value: unknown): void {
    const idx = this.data.settings.findIndex((s) => s.key === key);
    if (idx === -1) {
      this.data.settings.push({ key, value });
    } else {
      this.data.settings[idx] = { key, value };
    }
    this.save();
  }
}