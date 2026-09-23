/**
 * Skill 管理 RPC（模块 09，docs/prd/09_skill_management.md）。
 *
 * 4 个方法：skill/listSkills | importSkill | createSkill | deleteSkill。
 * 纯 TS（不 import Electron）：回收站能力经 deps.trashItem 端口注入
 * （main.ts 传 Electron shell.trashItem；缺省回退永久删除，TD-SK-04）。
 *
 * 口径约定（TD-SK-01）：枚举复用 pi DefaultResourceLoader（与 slashCommandResources
 * 同款轻量化装配），"UI 看到的" == "agent 实际加载的"——loader 结果只含同名冲突
 * 生效方（loser 以 collision 诊断出现）；SKILL.md 缺失/非法目录 pi 静默跳过，
 * 本模块补一次 4 根直接子项影子扫描，缺口以 warning 诊断如实上报（AC-09-02）。
 *
 * 写入目标固定（TD-SK-05）：全局 → <agentDir>/skills，项目 → <project>/.agents/skills。
 * 安全边界（§1.3）：所有写路径 normalize 后必须落在对应 skills 根的**直接子目录**，
 * 且 realpath 复核父目录==根（防符号链接穿越，AC-09-11）；越界一律 1001 拒绝。
 *
 * 错误码：1001 参数/安全拒绝、1002 目标不存在、4090 同名冲突待用户确认（data 携带
 * conflictPath，UI 弹确认后带 overwrite=true 重调）、5000 内部/IO 失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { RpcResult } from '@forge/core';

/** 方法表（与 createForgeCore.MethodTable 结构兼容，直接展开合并） */
export type SkillMethodTable = Record<
  string,
  (params: unknown) => RpcResult | Promise<RpcResult>
>;

/** skill 作用域：user=全局（~/.pi/agent/skills + ~/.agents/skills），project=当前项目 */
export type SkillScope = 'user' | 'project';

/** 单条生效 skill（loader 返回的均为生效方；同名冲突 loser 走 issues 诊断） */
export interface SkillEntry {
  name: string;
  description: string;
  /** pi sourceInfo.scope 原样映射；'other'（temporary/package 等）兜底展示不归组 */
  scope: 'user' | 'project' | 'other';
  /** skill 目录（SKILL.md 所在目录，即真实根路径下的直接/嵌套子目录） */
  dirPath: string;
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** frontmatter disable-model-invocation（仅显式 /skill: 调用） */
  disableModelInvocation: boolean;
}

/** 异常/冲突诊断（warning=非法或未被加载，collision=同名被覆盖，error 预留） */
export interface SkillIssue {
  type: 'warning' | 'error' | 'collision';
  message: string;
  path: string | null;
  winnerPath: string | null;
  loserPath: string | null;
}

/** skill/listSkills 响应 data */
export interface ListSkillsResult {
  cwd: string;
  skills: SkillEntry[];
  issues: SkillIssue[];
}

/** loader.getSkills() 单条记录（真实 pi Skill 的结构子集，fake 同形） */
export interface LoaderSkillRecord {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: { scope: string };
}

/** loader 诊断记录（真实 pi ResourceDiagnostic 的结构子集） */
export interface LoaderDiagnosticRecord {
  type: string;
  message: string;
  path?: string;
  collision?: { resourceType: string; winnerPath: string; loserPath: string };
}

/** loader 可注入最小形态（生产 = 真实 DefaultResourceLoader；测试传 fake） */
export interface SkillLoaderLike {
  reload(): Promise<void>;
  getSkills(): { skills: LoaderSkillRecord[]; diagnostics: LoaderDiagnosticRecord[] };
}

/** 组装选项（测试接缝：loaderFactory / homeDir / trashItem 均可注入） */
export interface SkillServiceDeps {
  /** pi agent 目录（createForgeCore 已解析）；全局写入目标 = <agentDir>/skills */
  agentDir: string;
  /** 用户主目录（缺省与 pi package-manager 同口径：HOME ?? os.homedir()） */
  homeDir?: string;
  /** 移入系统回收站端口（main.ts 注入 shell.trashItem）；缺省/抛错 → 永久删除回退 */
  trashItem?: (targetPath: string) => Promise<void>;
  /** 测试接缝：替换 loader 创建 */
  loaderFactory?: (cwd: string, agentDir: string) => SkillLoaderLike;
}

/** 生产 loader：与 slashCommandResources 同款轻量化装配（不加载扩展/主题/上下文文件） */
function defaultLoaderFactory(cwd: string, agentDir: string): SkillLoaderLike {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noThemes: true,
    noContextFiles: true,
  });
}

/** 目录安全名（PRD F03：小写字母/数字/连字符，首字符非连字符；pi validateName 同源约束） */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 64;

// ---------------------------------------------------------------------------
// 参数与路径工具
// ---------------------------------------------------------------------------

function readStringParam(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/** 可选字符串：缺失/空串返回 null（body 允许为空） */
function readOptionalStringParam(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readScopeParam(params: unknown): SkillScope | null {
  const value = readStringParam(params, 'scope');
  return value === 'user' || value === 'project' ? value : null;
}

function readOverwriteFlag(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  return (params as Record<string, unknown>).overwrite === true;
}

function failEnvelope(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

function okEnvelope<T>(data: T, message = 'success'): RpcResult<T> {
  return { code: 0, message, data };
}

/** win32 大小写不敏感比较（盘符/路径大小写差异不致 containment 误判） */
function normalizeForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function pathsEqual(a: string, b: string): boolean {
  return normalizeForCompare(path.resolve(a)) === normalizeForCompare(path.resolve(b));
}

/** target 是否等于 root 或位于 root 之下（前缀带分隔符，防 /root-evil 误判） */
function isUnder(target: string, root: string): boolean {
  const t = normalizeForCompare(path.resolve(target));
  const r = normalizeForCompare(path.resolve(root));
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`);
}

/** 直接子目录校验：dirname(target) === root */
function isDirectChild(target: string, root: string): boolean {
  return pathsEqual(path.dirname(path.resolve(target)), path.resolve(root));
}

/** realpath 复核（路径不存在时逐级上溯到最近存在的祖先再比较；失败原样返回入参） */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 含 SKILL.md 的直接子目录名（导入误选多 skill 父目录时的定向提示用） */
function listChildSkillDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 影子扫描：pi 静默跳过的未加载子项补报诊断（AC-09-02）
// ---------------------------------------------------------------------------

/** 已加载 skill 覆盖判定：该子项（目录或根级 .md）路径命中任一 skill 的 filePath/baseDir */
function isCovered(childPath: string, loadedSkills: LoaderSkillRecord[]): boolean {
  return loadedSkills.some(
    (s) =>
      pathsEqual(s.filePath, childPath) ||
      isUnder(s.baseDir, childPath) ||
      isUnder(s.filePath, childPath),
  );
}

function scanUnloadedChildren(rootDir: string, loadedSkills: LoaderSkillRecord[]): SkillIssue[] {
  const issues: SkillIssue[] = [];
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(rootDir)) return issues;
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return issues;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const childPath = path.join(rootDir, entry.name);
    if (entry.isFile() && !entry.name.endsWith('.md')) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    if (isCovered(childPath, loadedSkills)) continue;
    issues.push({
      type: 'warning',
      message: entry.isDirectory()
        ? '目录未被 pi 加载（缺少 SKILL.md 或 frontmatter 非法）'
        : '根级 Markdown 未被 pi 加载（缺少有效 description）',
      path: childPath,
      winnerPath: null,
      loserPath: null,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 删除/覆盖共用：回收站优先，失败回退永久删除（TD-SK-04）
// ---------------------------------------------------------------------------

type RemovalMode = 'trashed' | 'permDeleted';

async function removeDirPreferTrash(
  targetPath: string,
  trashItem: SkillServiceDeps['trashItem'],
): Promise<RemovalMode> {
  if (trashItem) {
    try {
      await trashItem(targetPath);
      return 'trashed';
    } catch (err) {
      console.warn('[skillService] trashItem failed, falling back to permanent delete:', err);
    }
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
  return 'permDeleted';
}

// ---------------------------------------------------------------------------
// 方法表
// ---------------------------------------------------------------------------

export function createSkillMethods(deps: SkillServiceDeps): SkillMethodTable {
  const agentDir = path.resolve(deps.agentDir);
  const homeDir = path.resolve(deps.homeDir ?? process.env.HOME ?? os.homedir());
  const loaderFactory = deps.loaderFactory ?? defaultLoaderFactory;

  /** 4 根（pi package-manager 自动发现口径）：2 个用户根恒在，2 个项目根随 projectPath */
  function rootsFor(projectPath: string | null): Array<{ root: string; scope: SkillScope }> {
    const roots: Array<{ root: string; scope: SkillScope }> = [
      { root: path.join(agentDir, 'skills'), scope: 'user' },
      { root: path.join(homeDir, '.agents', 'skills'), scope: 'user' },
    ];
    if (projectPath !== null) {
      roots.push(
        { root: path.join(projectPath, '.pi', 'skills'), scope: 'project' },
        { root: path.join(projectPath, '.agents', 'skills'), scope: 'project' },
      );
    }
    return roots;
  }

  /** 写入目标根（TD-SK-05 固定）：user→<agentDir>/skills，project→<project>/.agents/skills */
  function targetRootFor(scope: SkillScope, projectPath: string | null): string | null {
    if (scope === 'user') return path.join(agentDir, 'skills');
    if (projectPath === null) return null; // 未打开项目：项目作用域不可用（AC-09-07 前端禁用+服务端拒绝）
    return path.join(projectPath, '.agents', 'skills');
  }

  /**
   * containment 复验（AC-09-11）：target 必须是某根的直接子项，且 realpath 复核
   * （父目录实际位置 == 根实际位置；target 若为符号链接，其指向不得逃出 4 根）。
   */
  function checkDeletionContainment(target: string, projectPath: string | null): string | null {
    const roots = rootsFor(projectPath);
    const resolved = path.resolve(target);
    for (const { root } of roots) {
      if (!isDirectChild(resolved, root)) continue;
      const parentReal = realpathSafe(path.dirname(resolved));
      const rootReal = realpathSafe(root);
      if (!pathsEqual(parentReal, rootReal)) {
        return '路径校验失败：父目录经符号链接重定向，拒绝删除';
      }
      try {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink()) {
          const entryReal = realpathSafe(resolved);
          const inside = roots.some(
            (r) => fs.existsSync(r.root) && isUnder(entryReal, realpathSafe(r.root)),
          );
          if (!inside) return '路径校验失败：目标为指向根外的符号链接，拒绝删除';
        }
      } catch {
        return null; // 不存在交给调用方映射 1002
      }
      return null;
    }
    return '安全拒绝：目标不是 skills 根目录的直接子目录';
  }

  return {
    // 列表：loader 口径（生效方）+ 诊断（collision/非法）+ 影子扫描补报（缺 SKILL.md）
    'skill/listSkills': async (params: unknown): Promise<RpcResult<ListSkillsResult | null>> => {
      const projectPath = readStringParam(params, 'projectPath');
      const cwd = projectPath ?? process.cwd();
      let skills: LoaderSkillRecord[];
      let diagnostics: LoaderDiagnosticRecord[];
      try {
        const loader = loaderFactory(cwd, agentDir);
        await loader.reload();
        ({ skills, diagnostics } = loader.getSkills());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[skillService] listSkills failed:', err);
        return failEnvelope(5000, `枚举 skill 失败: ${message}`);
      }
      const entries: SkillEntry[] = skills.map((s) => ({
        name: s.name,
        description: s.description,
        scope: s.sourceInfo.scope === 'user' || s.sourceInfo.scope === 'project' ? s.sourceInfo.scope : 'other',
        dirPath: s.baseDir,
        filePath: s.filePath,
        disableModelInvocation: s.disableModelInvocation,
      }));
      const issues: SkillIssue[] = diagnostics.map((d) => ({
        type: d.type === 'collision' ? 'collision' : d.type === 'error' ? 'error' : 'warning',
        message: d.message,
        path: d.path ?? null,
        winnerPath: d.collision?.winnerPath ?? null,
        loserPath: d.collision?.loserPath ?? null,
      }));
      // 同名冲突 loser 补充展示信息：collision 诊断的 loser 不在 skills 列表（pi 已 skip）
      for (const issue of scanUnloadedChildrenForRoots(rootsFor(projectPath), skills)) {
        issues.push(issue);
      }
      return okEnvelope({ cwd, skills: entries, issues });
    },

    // 导入：源目录校验 → 目标根直接子目录复制（临时目录 + rename 原子落位）
    'skill/importSkill': async (params: unknown): Promise<RpcResult> => {
      const scope = readScopeParam(params);
      const sourceDir = readStringParam(params, 'sourceDir');
      const projectPath = readStringParam(params, 'projectPath');
      const overwrite = readOverwriteFlag(params);
      if (scope === null || sourceDir === null) {
        return failEnvelope(1001, '参数错误：scope/sourceDir 必须为非空字符串');
      }
      const targetRoot = targetRootFor(scope, projectPath);
      if (targetRoot === null) {
        return failEnvelope(1001, '参数错误：项目作用域需要已打开项目（projectPath）');
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(sourceDir);
      } catch {
        return failEnvelope(1002, `源目录不存在: ${sourceDir}`);
      }
      if (!stat.isDirectory()) {
        return failEnvelope(1001, '参数错误：sourceDir 必须是目录');
      }
      // 自我复制守卫：源 == 目标根 / 源在目标根内
      if (isUnder(realpathSafe(sourceDir), realpathSafe(targetRoot)) && fs.existsSync(targetRoot)) {
        return failEnvelope(1001, '拒绝导入：源目录与目标 skills 根相同或位于其内');
      }
      // SKILL.md 校验（复用 pi loadSkillsFromDir 口径，AC-09-05）。
      // loader 会递归识别嵌套子 skill，父目录也能过——因此额外要求源目录自身
      // 就是 skill 目录（根级含 SKILL.md），杜绝一次导入整个 skills 父目录。
      const loaded = loadSkillsFromDir({ dir: sourceDir, source: 'user' });
      const hasRootSkillMd = fs.existsSync(path.join(sourceDir, 'SKILL.md'));
      // 含 skill 子目录一律拒（即使自身有 SKILL.md）：整树拷贝会把子 skill 一起带进来，
      // 语义上仍是「一次导入多个」，与 UI 承诺的「一次一个」冲突。
      const childDirs = listChildSkillDirs(sourceDir);
      if (childDirs.length > 0) {
        const preview = childDirs.slice(0, 3).join('、') + (childDirs.length > 3 ? ' 等' : '');
        if (!hasRootSkillMd) {
          return failEnvelope(
            1001,
            `无法导入：一次只能导入一个 skill 目录。所选目录本身没有 SKILL.md，但包含 ${childDirs.length} 个 skill 子目录（${preview}），请进入后选择其中一个`,
          );
        }
        return failEnvelope(
          1001,
          `无法导入：一次只能导入一个 skill 目录。所选目录自身含 SKILL.md，但还包含 ${childDirs.length} 个 skill 子目录（${preview}），整个导入会把它们一并带入，请改为选择其中一个子目录`,
        );
      }
      if (loaded.skills.length === 0 || !hasRootSkillMd) {
        const reason =
          loaded.diagnostics.map((d) => d.message).find((m) => m !== undefined) ??
          '目录中未找到有效 SKILL.md（需含非空 description）';
        return failEnvelope(1001, `拒绝导入：${reason}`);
      }
      const dirName = path.basename(sourceDir);
      const dest = path.resolve(targetRoot, dirName);
      if (!isDirectChild(dest, targetRoot)) {
        return failEnvelope(1001, '拒绝导入：目标目录名不安全');
      }
      const destExists = fs.existsSync(dest);
      if (destExists && !overwrite) {
        // 4090：UI 弹确认（旧目录将移入回收站）后带 overwrite=true 重调（TD-SK-03）
        return {
          code: 4090,
          message: `目标已存在同名 skill 目录：${dest}`,
          data: { conflictPath: dest, sourceDir },
        };
      }
      console.log(
        `[skillService] import skill scope=${scope} source=${sourceDir} dest=${dest} overwrite=${destExists}`,
      );
      const temp = path.join(
        targetRoot,
        `.forge-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        fs.mkdirSync(targetRoot, { recursive: true });
        if (destExists) {
          await removeDirPreferTrash(dest, deps.trashItem); // 确认后旧目录进回收站再导新
        }
        fs.cpSync(sourceDir, temp, { recursive: true });
        fs.renameSync(temp, dest);
        return okEnvelope({ path: dest, overwritten: destExists });
      } catch (err) {
        try {
          fs.rmSync(temp, { recursive: true, force: true }); // 清理半成品，不留半个 skill
        } catch {
          /* ignore */
        }
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[skillService] import failed:', err);
        return failEnvelope(5000, `导入失败: ${message}`);
      }
    },

    // 新建：目录安全名 + 标准 SKILL.md 模板，创建后回读验证（AC-09-08）
    'skill/createSkill': async (params: unknown): Promise<RpcResult> => {
      const scope = readScopeParam(params);
      const name = readStringParam(params, 'name');
      const description = readStringParam(params, 'description');
      const body = readOptionalStringParam(params, 'body');
      const projectPath = readStringParam(params, 'projectPath');
      const overwrite = readOverwriteFlag(params);
      if (scope === null || name === null) {
        return failEnvelope(1001, '参数错误：scope/name 必须为非空字符串');
      }
      if (!SAFE_NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
        return failEnvelope(1001, '名称不合法：仅小写字母/数字/连字符，以字母或数字开头，不超过 64 字符');
      }
      if (description === null) {
        return failEnvelope(1001, '描述不能为空');
      }
      const targetRoot = targetRootFor(scope, projectPath);
      if (targetRoot === null) {
        return failEnvelope(1001, '参数错误：项目作用域需要已打开项目（projectPath）');
      }
      const dest = path.resolve(targetRoot, name);
      if (!isDirectChild(dest, targetRoot)) {
        return failEnvelope(1001, '名称不合法：目标路径越出 skills 根目录');
      }
      const destExists = fs.existsSync(dest);
      if (destExists && !overwrite) {
        return {
          code: 4090,
          message: `目标已存在同名 skill 目录：${dest}`,
          data: { conflictPath: dest },
        };
      }
      console.log(`[skillService] create skill scope=${scope} name=${name} overwrite=${destExists}`);
      // YAML 双引号标量（JSON.stringify 兼容）：description 含冒号/引号安全
      const content = [
        '---',
        `name: ${JSON.stringify(name)}`,
        `description: ${JSON.stringify(description)}`,
        '---',
        '',
        `# ${name}`,
        '',
        body ?? `TODO: 编写 ${name} 的操作指引`,
        '',
      ].join('\n');
      try {
        fs.mkdirSync(targetRoot, { recursive: true });
        if (destExists) {
          await removeDirPreferTrash(dest, deps.trashItem);
        }
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'SKILL.md'), content, 'utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[skillService] create failed:', err);
        return failEnvelope(5000, `创建失败: ${message}`);
      }
      // 回读验证（PRD F03 数据一致性）：pi 解析口径确认可发现
      const verify = loadSkillsFromDir({ dir: dest, source: 'user' });
      if (verify.skills.length === 0) {
        const reason = verify.diagnostics[0]?.message ?? '未知原因';
        return failEnvelope(5000, `已创建但 pi 未识别该 skill：${reason}（目录保留：${dest}）`);
      }
      return okEnvelope({ path: dest, name: verify.skills[0]?.name ?? name });
    },

    // 删除：containment 复验 → 回收站优先 → 失败回退永久删除（trashed=false 如实上报）
    'skill/deleteSkill': async (params: unknown): Promise<RpcResult> => {
      const target = readStringParam(params, 'path');
      const projectPath = readStringParam(params, 'projectPath');
      if (target === null) {
        return failEnvelope(1001, '参数错误：path 必须为非空字符串');
      }
      const containmentError = checkDeletionContainment(target, projectPath);
      if (containmentError !== null) {
        console.warn(`[skillService] delete rejected: ${containmentError} target=${target}`);
        return failEnvelope(1001, containmentError);
      }
      const resolved = path.resolve(target);
      try {
        if (!fs.lstatSync(resolved).isDirectory()) {
          return failEnvelope(1001, '参数错误：只能删除 skill 目录');
        }
      } catch {
        return failEnvelope(1002, 'skill 目录不存在（可能已被外部删除），请刷新列表');
      }
      console.log(`[skillService] delete skill path=${resolved}`);
      try {
        const mode = await removeDirPreferTrash(resolved, deps.trashItem);
        return okEnvelope({ path: resolved, trashed: mode === 'trashed' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[skillService] delete failed:', err);
        return failEnvelope(5000, `删除失败: ${message}`);
      }
    },
  };

  /** 4 根影子扫描（去重：同一路径只报一次） */
  function scanUnloadedChildrenForRoots(
    roots: Array<{ root: string; scope: SkillScope }>,
    loadedSkills: LoaderSkillRecord[],
  ): SkillIssue[] {
    const seen = new Set<string>();
    const issues: SkillIssue[] = [];
    for (const { root } of roots) {
      for (const issue of scanUnloadedChildren(root, loadedSkills)) {
        const key = issue.path === null ? issue.message : normalizeForCompare(path.resolve(issue.path));
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(issue);
      }
    }
    return issues;
  }
}
