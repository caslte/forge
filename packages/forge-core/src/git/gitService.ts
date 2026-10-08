/**
 * Git 服务（wu-01-project-git-core）。
 *
 * 职责：实现 docs/api/01_project.md §10/§11 的 git 分支查询与切换契约
 * （getBranchInfo / switchBranch），经 child_process.execFile 调用 git CLI，
 * 是 forge-core 纯 Node 业务层，不 import Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 实时查询不缓存（TD-PM-07）：每次 getBranchInfo 都执行真实 git 命令。
 * 2. 五态口径：rev-parse --is-inside-work-tree 失败（含 git 不可执行）→ isGitRepo:false
 *    全空值；branch --show-current 为空且 rev-parse --short HEAD 成功 → detached（branch=短 SHA）；
 *    rev-parse HEAD 失败但有分支名 → unborn（branches=[]）；其余为正常仓库。
 * 3. git 命令执行失败（如未安装 git）在 getBranchInfo 中不报错，返回 isGitRepo:false
 *    （docs/api/01_project.md §10）。
 * 4. switchBranch 幂等：当前分支==目标时直接成功（git 无操作），返回 changed:false 供
 *    RPC 层决定是否发射 git.branchChanged（TD-PM-09）。git 拒绝（冲突等）返回 6001，
 *    附 git 原始 stderr，仓库分支保持不变。
 * 5. 所有方法返回判别联合 `{ ok: true, data } | { ok: false, code, message }`，
 *    code 取值 1001 / 1002 / 6001（6001 附加 stderr）。
 * 6. 模块 11（wu-03 git 提交/推送，docs/prd/11_git_commit_push.md TD-GC-01）新增
 *    getStatus / commit / push / collectCommitDiff：错误码顺延 6006（提交失败）/
 *    6007（推送失败），均附 git 原始 stderr。commit/push 是写操作：message 经参数
 *    数组传入 execFile（绝不拼接 shell），提交身份交给用户 git config（不代填）。
 *    commit 服务端二次校验暂存非空（AC-11-07，UI 禁用是第一道）。写操作与 push 用
 *    放宽的 GIT_WRITE_TIMEOUT_MS（pre-commit hook / 网络），只读查询沿用 5s。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/** git 命令默认超时（ms） */
const GIT_TIMEOUT_MS = 5000;

/** 写操作超时（ms）：pre-commit hook 与 push 网络往返可远超 5s（TD-GC-01/F04 放宽口径） */
const GIT_WRITE_TIMEOUT_MS = 30_000;

/** AI 提交说明的 diff 上下文总字符上限（TD-GC-03，约 30k） */
const AI_DIFF_MAX_CHARS = 30_000;

/** AI diff 每文件保留的最大行数（TD-GC-03「每文件 diff 前 N 行」） */
const AI_DIFF_MAX_LINES_PER_FILE = 40;

/** 分支信息（docs/api/01_project.md §10 响应 data） */
export interface GitBranchInfo {
  isGitRepo: boolean;
  branch: string | null;
  branches: string[];
  dirty: boolean;
  detached: boolean;
}

/** 非仓库时的空值分支信息 */
const NOT_A_REPO: GitBranchInfo = {
  isGitRepo: false,
  branch: null,
  branches: [],
  dirty: false,
  detached: false,
};

/** switchBranch 成功数据：changed=false 表示幂等（目标即当前分支） */
export interface SwitchBranchData {
  branch: string;
  changed: boolean;
}

/** Git 服务方法结果（判别联合；6001 附加 git 原始 stderr） */
export type GitResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 1002 | 6001; message: string; stderr?: string };

/** switchBranch 结果 */
export type SwitchResult = GitResult<SwitchBranchData>;

/** 单个变更文件的状态（模块 12 代码树行尾 M/A/D/U 徽标的唯一数据源） */
export interface GitStatusFile {
  /** 相对仓库根的 POSIX 路径（porcelain 原生即 `/` 分隔，无需转换） */
  path: string;
  /**
   * 归一后的单字母状态；X（索引）优先于 Y（工作区），与 VSCode 资源管理器一致。
   * 1=已暂存新增 2=已暂存修改 3=已暂存删除
   * M=未暂存修改 D=未暂存删除 U=冲突
   * ?=未跟踪 A=按意图新增（`git add -N`） R/C=重命名/复制（取原状态）
   */
  status: 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | '?';
  /** true=已进暂存区（X 列非空且非 ?） */
  staged: boolean;
  /**
   * 本文件的新增行数（模块 12 变更视图的 `+N`）。
   *
   * 纯**新增字段**。三个来源：
   * - 跟踪文件：`git diff --numstat` 逐行拆（原本只汇总后丢弃了拆分）；
   * - 未跟踪文件：**git 根本不报它的行数**（不在任何 diff 输出里），
   *   由服务层读文件数行——不数就会在界面上显示 `+0`，与事实矛盾；
   * - 二进制（跟踪的报 `-`、未跟踪的含 NUL 字节）：一律 0，不瞎猜。
   *
   * ⚠ **口径提醒（两个数字的范围不同，别写等价断言）**：
   * `files[].added` **含未跟踪文件**，而 `GitStatusInfo.added` **不含**
   * （它就是 `diff HEAD --numstat` 的逐行求和，而 git 有意不把未跟踪
   * 文件放进 numstat；PRD 11 GC-F01 也是这么定义的）。
   * 所以「`files[].added` 之和 == `GitStatusInfo.added`」是**错的**，
   * 正确的关系是：非未跟踪项之和 == `GitStatusInfo.added`。
   * 界面要「这次一共改了多少行」时，应自行汇总 `files[]`。
   */
  added: number;
  /** 本文件的删除行数；来源与 `added` 同上 */
  removed: number;
}

/** 提交弹窗状态数据（模块 11 git/getStatus 响应，docs/prd/11 §GC-F01） */
export interface GitStatusInfo {
  isGitRepo: boolean;
  /** 当前分支；detached 时为短 SHA；无 HEAD 且无分支名时为 null */
  branch: string | null;
  detached: boolean;
  /** 变更文件数（porcelain v1 行数，含未跟踪；重命名计 1） */
  fileCount: number;
  /** numstat 汇总新增行（二进制/无 HEAD 未跟踪文件不计） */
  added: number;
  /** numstat 汇总删除行 */
  removed: number;
  /** 暂存区是否为空（X 列全为空格或 ?；D2 勾选不勾时的提交判据） */
  stagedEmpty: boolean;
  /** 暂存区文件数（X 列非空格非 ? 的 porcelain 行数；不勾「包含未暂存」时的待提交数） */
  stagedCount: number;
  /** 未推送提交涉及的文件数（upstream→origin/分支→--not --remotes 三级判据）；无远端/detached/无 HEAD → null（未知） */
  unpushedCount: number | null;
  /** HEAD 是否存在（空仓库=false，影响 diff 基线与推送语义） */
  hasHead: boolean;
  /**
   * 逐文件状态（模块 12 CE-S07：代码树行尾 M/A/D/U 徽标）。
   *
   * 纯**新增字段**：同一份 porcelain 输出切两刀，不额外起 git 进程——模块 12 要的
   * 就是这份数据，单独开一条 RPC 会让「进代码态」先等一次 git status 冷启动。
   * 提交弹窗等既有消费方忽略此字段即可，行为不变。
   */
  files: GitStatusFile[];
}

/**
 * git/getFileDiff 响应 data（模块 12 代码查看器「并排 diff」的数据源）。
 */
export interface GitFileDiffData {
  /**
   * 相对基线的 unified diff 文本（基线：有 HEAD 为 HEAD，无 HEAD 为暂存区，
   * 与 getStatus 的 numstat 同口径——对比的是「全部未提交变更」）。
   *
   * 三种取值刻意可区分：
   * - `''`（空串）= 跟踪文件相对基线无差异；
   * - `null` = 不可对比：未跟踪文件（git 根本不给它出 diff）/ 非 git 仓库，
   *   UI 对未跟踪文件用已加载的正文合成「全新增」视角；
   * - 非空文本 = 可解析的 unified diff（二进制变更时是 git 的
   *   `Binary files ... differ` 提示行，由解析层识别，不在这里特判）。
   */
  diff: string | null;
}

/** getFileDiff 结果（6001 = git diff 本身失败，附原始 stderr） */
export type GitFileDiffResult = GitResult<GitFileDiffData>;

/* ================================================================
 * CE-S11 提交历史（PRD 12 §3.7 / docs/api/11_git_commit_push.md §6~§8）
 * ================================================================ */

/** 提交列表项（getCommitLog）。authorName 是**作者**而非提交者——
 *  「这条提交是谁写的」问的是作者；两者在 rebase / amend 场景下不等。 */
export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** 作者时间 epoch 秒（%at）。时区格式化是展示层的事。 */
  authoredAt: number;
  parentCount: number;
  isMerge: boolean;
}

/** getCommitLog 结果 */
export interface GitCommitLogData {
  commits: GitCommitSummary[];
  hasMore: boolean;
}
export type GitCommitLogResult = GitResult<GitCommitLogData>;

/** 提交内的文件统计（getCommitDetail）。
 *  additions/deletions 为 -1 表示**二进制测不出**（git 的 numstat 对二进制给 `-\t-`）；
 *  不用 0 冒充——0 的语义是「真的没改行」，与「测不出」混同会让 UI 显示错统计。 */
export interface GitCommitFileStat {
  path: string;
  /** 仅 R/C 非 null：重命名或复制前的路径 */
  oldPath: string | null;
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  additions: number;
  deletions: number;
  binary: boolean;
}

/** 提交详情（getCommitDetail）。**故意不含 diff 字段**——两级取数的第一级（AC-CE-037）。 */
export interface GitCommitDetailData {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  /** 提交者时间；与 authoredAt 分开是因为 rebase/amend 下二者不等 */
  committedAt: number;
  committerName: string;
  committerEmail: string;
  parentCount: number;
  isMerge: boolean;
  isRoot: boolean;
  files: GitCommitFileStat[];
}
export type GitCommitDetailResult = GitResult<GitCommitDetailData>;

/** getCommitFileDiff 数据：非空=unified 文本；`''`=该文件在此提交中无行级变化；
 *  `null`=二进制（UI 给二进制空态，与「无变化」严格区分）。 */
export interface GitCommitFileDiffData {
  diff: string | null;
}
export type GitCommitFileDiffResult = GitResult<GitCommitFileDiffData>;

/** log 记录分隔符 / 字段分隔符（PRD §3.7.2）。
 *  选这两个控制字符而非 `--output-indicator` + 按行切：subject 可能含任意字符，
 *  逐行切分会误切（实测中文 subject 正常）。 */
const LOG_FIELD_SEP = '\x1f';
const LOG_RECORD_SEP = '\x1e';

/** 空仓库（unborn HEAD）的 git 报错特征：`git log` exit 128 且 stderr 含此句。
 *  必须识别并归一为「空历史」而非错误——这是 AC-CE-040 的全部意义。 */
function isUnbornHead(stderr: string): boolean {
  return /does not have any commits yet/i.test(stderr);
}

/** binary 判定：numstat 对二进制给 `-\t-`；name-status 的 A/M/D/R/C 里二进制无从判断，
 *  统一以 numstat 的 `-` 为准。 */
function numstatCounts(add: string, del: string): { additions: number; deletions: number; binary: boolean } {
  if (add === '-' || del === '-') {
    return { additions: -1, deletions: -1, binary: true };
  }
  return { additions: Number(add) || 0, deletions: Number(del) || 0, binary: false };
}

/**
 * 解析 `git --numstat -z` 输出。
 *
 * `-z` 不是可选项：不带它时重命名输出成 `a => b`（目录改名还是 `sub/{a => b}/f` 的
 * brace 形式），解析歧义；带 `-z` 后重命名是 `add\tdel\t\0old\0new\0` 的 NUL 分隔，无歧义。
 * （两种形式的实测输出都已在临时仓库上比对过。）
 *
 * 增删状态字母（R/C/A/M/D）需另跑 `--name-status`，但那会多一次子进程往返；
 * 这里从路径变化与增删数**推导**状态：git 对纯重命名给 `0\t0`，故
 * `0/0 且存在 oldPath` → R；其余按「路径为空→删除」「父提交无此路径→新增」判定。
 * 推导口径与 git `--name-status` 在本组用例覆盖的场景下一致。
 */
function parseNumstatZ(stdout: string): GitCommitFileStat[] | null {
  if (stdout.trim() === '') return [];
  const out: GitCommitFileStat[] = [];
  // NUL 分隔：普通条目 `add\tdel\tpath`，重命名条目 `add\tdel\t` + `\0old\0new`
  const chunks = stdout.split('\0');
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? '';
    if (chunk === '') continue;
    const tab1 = chunk.indexOf('\t');
    const tab2 = chunk.indexOf('\t', tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const counts = numstatCounts(chunk.slice(0, tab1), chunk.slice(tab1 + 1, tab2));
    let path: string;
    let oldPath: string | null = null;
    let status: GitCommitFileStat['status'];
    if (tab2 === chunk.length - 1) {
      // 重命名：增删列之后没有路径，后跟两个 NUL 分隔的 old/new
      const oldPathRaw = chunks[i + 1];
      const newPathRaw = chunks[i + 2];
      if (oldPathRaw === undefined || newPathRaw === undefined) return null;
      oldPath = oldPathRaw;
      path = newPathRaw;
      status = 'R';
      i += 2;
    } else {
      path = chunk.slice(tab2 + 1);
      status = 'M';
    }
    if (path.includes('\u0000')) return null;
    out.push({ path, oldPath, status, ...counts });
  }
  // A/D 需要与父提交比对才能判；本实现只区分 R 与 M，其余交给展示层的增删数解读
  // （A 的 additions 等于整个文件行数，D 的 deletions 同理，足以表达）。
  return out;
}

/**
 * relPath 安全校验：只接受仓库内的相对路径。拒绝绝对路径（`/`、盘符）与
 * `..`/`.`/空段逃逸——虽然 git 的 pathspec 越界匹配不到任何条目，但这条校验
 * 与 file 只读三方法的 containment 是同一意图，不在边界上赌 git 的行为。
 */
function isSafeRelPath(relPath: string): boolean {
  const p = relPath.replaceAll('\\', '/');
  if (p === '' || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** 非仓库时的空值状态数据 */
const NOT_A_STATUS: GitStatusInfo = {
  isGitRepo: false,
  branch: null,
  detached: false,
  fileCount: 0,
  added: 0,
  removed: 0,
  stagedEmpty: true,
  stagedCount: 0,
  unpushedCount: null,
  hasHead: false,
  files: [],
};

/**
 * 解析一行 `git status --porcelain=v1`。
 *
 * 格式：`XY <path>`，重命名为 `XY <new> -> <old>`（取箭头后的 new，与工作区一致）。
 * 未跟踪（`??`）归一为单字母 `?` 而非两个 `?`，UI 只需处理 6 个字面量。
 * X（索引）优先于 Y（工作区）：`MM` 显示 M（索引态），` M` 也显示 M——两者在代码树
 * 行尾只占一格，区分它们没有信息量，而在提交弹窗里 staged 已有独立计数。
 */
function parseStatusLine(line: string): GitStatusFile | null {
  if (line.length < 4) return null;
  const x = line[0] ?? ' ';
  const y = line[1] ?? ' ';
  let p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  if (arrow !== -1) p = p.slice(0, arrow);
  if (p === '') return null;
  const staged = x !== ' ' && x !== '?';
  const pick = (c: string): GitStatusFile['status'] | null => {
    if (c === 'M' || c === 'T') return 'M';
    if (c === 'A') return 'A';
    if (c === 'D') return 'D';
    if (c === 'U') return 'U';
    if (c === 'R') return 'R';
    if (c === 'C') return 'C';
    if (c === '?') return '?';
    return null;
  };
  const status = pick(x) ?? pick(y);
  // 行数在 getStatus 里按 numstat 回填（纯函数只管解析 porcelain 状态）
  return status === null ? null : { path: p, status, staged, added: 0, removed: 0 };
}

/** 二进制探测只看前 8KB：够抓住 NUL，且不把大文件整个读进内存 */
const BINARY_PROBE_BYTES = 8000;

/**
 * 数一个**未跟踪**文本文件的行数（= 它的全部新增行数）。
 *
 *  为什么需要自己数：未跟踪文件不在 `git diff HEAD --numstat` 的输出里，
 *  git 对它不报任何行数，而变更视图要显示 `+N`。
 *  二进制（含 NUL 字节）返回 0——与 `git diff --numstat` 对二进制的
 *  「报 `-` 不报数」口径一致，界面不该给一个瞎猜的数字。
 *  读失败（权限/已被删）也返回 0：这是锦上添花的统计，不该让整次状态查询失败。
 */
export function countUntrackedLines(cwd: string, relPath: string): number {
  try {
    const abs = path.resolve(cwd, relPath);
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) return 0;
    // 与 git 的行数口径一致：末尾无换行不算一行
    if (buf.length === 0) return 0;
    let lines = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 10) lines += 1;
    }
    if (buf[buf.length - 1] !== 10) lines += 1;
    return lines;
  } catch {
    return 0;
  }
}

/** name-only / log --name-only 输出的文件路径计数（去重、去空行） */
function uniquePaths(out: string): number {
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    const p = line.trim();
    if (p !== '') {
      set.add(p);
    }
  }
  return set.size;
}

/** commit 成功数据：shortHash=新提交短哈希，fileCount=本次提交涉及文件数 */
export interface CommitData {
  shortHash: string;
  fileCount: number;
}

/** push 成功数据 */
export interface PushData {
  branch: string;
  /** 实际推送到的远端名（无 upstream 自动 -u 时为 origin） */
  remote: string;
}

/** AI 提交说明用 diff 上下文（TD-GC-03 截断后的成品文本） */
export interface CommitDiffContext {
  /** 是否有任何可提交的变更（tracked 改动 + 未跟踪文件，排除 ignored） */
  hasChanges: boolean;
  /** 文件数（与文件清单段一致） */
  fileCount: number;
  /** 送入模型的文本：文件清单全量 + 每文件 diff 前 N 行，总长封顶截断 */
  text: string;
}

/** 写操作结果（git 域错误码顺延：6006 提交失败 / 6007 推送失败，附 git 原始 stderr） */
export type GitWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 6006 | 6007; message: string; stderr?: string };

/** commit 结果 */
export type CommitResult = GitWriteResult<CommitData>;

/** push 结果 */
export type PushResult = GitWriteResult<PushData>;

/** 单次 git 命令执行结果 */
interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Git 分支查询与切换服务。
 * @param gitBin git 可执行文件名/路径（可注入，默认 'git'）
 */
export class GitService {
  private readonly gitBin: string;

  constructor(gitBin: string = 'git') {
    this.gitBin = gitBin;
  }

  /** 执行 `git -C <cwd> <args>`；非零退出 / git 不可执行均返回 ok:false（不抛出）。
   *
   *  **固定前置 `-c core.quotepath=false`**（2026-10-08 CE-S11）：git 默认 `core.quotepath=true`，
   *  会把非 ASCII 路径输出成 `"\344\270\255\346\226\207..."` 八进制转义形式。某些机器的全局
   *  config 恰好设了 false（本仓库开发者即如此），于是「换个机器中文路径就变乱码」成为
   *  隐性故障——已实测 `-c core.quotepath=true` 可复现转义。在此处统一固定，全调用点受益。
   */
  private async run(cwd: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<RunResult> {
    try {
      const { stdout } = await execFileAsync(this.gitBin, ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
        windowsHide: true,
        timeout: timeoutMs,
      });
      return { ok: true, stdout, stderr: '' };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
    }
  }

  /** 本地分支列表（git 默认字典序，不含远程分支） */
  private async listBranches(cwd: string): Promise<string[]> {
    const r = await this.run(cwd, ['branch', '--format=%(refname:short)']);
    if (!r.ok) {
      return [];
    }
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
  }

  /** status --porcelain 非空即有未提交更改 */
  private async isDirty(cwd: string): Promise<boolean> {
    const r = await this.run(cwd, ['status', '--porcelain']);
    return r.ok && r.stdout.trim() !== '';
  }

  /**
   * 实时查询分支信息（PM-S05）：五态判定见模块注释。
   * @param cwd 项目路径（仓库子目录自然取仓库根分支）
   */
  async getBranchInfo(cwd: string): Promise<GitBranchInfo> {
    const inside = await this.run(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
      return NOT_A_REPO;
    }
    const cur = await this.run(cwd, ['branch', '--show-current']);
    const branchName = cur.stdout.trim();
    if (branchName === '') {
      // detached HEAD（或无法解析）：用短 SHA 作为 branch
      const short = await this.run(cwd, ['rev-parse', '--short', 'HEAD']);
      if (short.ok) {
        return {
          isGitRepo: true,
          branch: short.stdout.trim(),
          branches: await this.listBranches(cwd),
          dirty: await this.isDirty(cwd),
          detached: true,
        };
      }
      // detached 且 HEAD 不可解析：仓库但无有效 HEAD
      return { isGitRepo: true, branch: null, branches: await this.listBranches(cwd), dirty: await this.isDirty(cwd), detached: true };
    }
    const head = await this.run(cwd, ['rev-parse', 'HEAD']);
    if (!head.ok) {
      // unborn：HEAD 不存在但有 unborn 分支名，本地分支列表为空
      return { isGitRepo: true, branch: branchName, branches: [], dirty: await this.isDirty(cwd), detached: false };
    }
    return {
      isGitRepo: true,
      branch: branchName,
      branches: await this.listBranches(cwd),
      dirty: await this.isDirty(cwd),
      detached: false,
    };
  }

  /**
   * 切换本地分支（PM-S05，git switch 默认语义：远程同名自动建跟踪）。
   * @param cwd 项目路径
   * @param branch 目标本地分支名（非空白）
   * @returns 成功返回 { branch, changed }；git 拒绝返回 6001 + stderr（分支不变）
   */
  async switchBranch(cwd: string, branch: string): Promise<SwitchResult> {
    if (typeof branch !== 'string' || branch.trim() === '') {
      return { ok: false, code: 1001, message: 'branch 必须为非空字符串' };
    }
    const cur = await this.run(cwd, ['branch', '--show-current']);
    if (cur.ok && cur.stdout.trim() === branch) {
      // 幂等：目标即当前分支，git 无操作
      return { ok: true, data: { branch, changed: false } };
    }
    const sw = await this.run(cwd, ['switch', '--', branch]);
    if (!sw.ok) {
      return { ok: false, code: 6001, message: 'git 切换失败', stderr: sw.stderr };
    }
    return { ok: true, data: { branch, changed: true } };
  }

  /**
   * 提交弹窗数据源（模块 11 GC-F01，只读无副作用）：porcelain v1 文件数 +
   * numstat 增删汇总 + 暂存空判定/暂存文件数 + 未推送文件数。非 git 仓库返回 isGitRepo:false 空值。
   */
  async getStatus(cwd: string): Promise<GitStatusInfo> {
    const inside = await this.run(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
      return NOT_A_STATUS;
    }
    const status = await this.run(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
    const lines = status.ok ? status.stdout.split('\n').filter((l) => l.length >= 4) : [];
    // X 列（索引状态）非空格且非 ? 即有已暂存变更
    const isStagedLine = (l: string): boolean => (l.charCodeAt(0) ?? 32) !== 32 && l[0] !== '?';
    const stagedEmpty = !lines.some(isStagedLine);
    const stagedCount = lines.filter(isStagedLine).length;
    const files = lines.map(parseStatusLine).filter((f): f is GitStatusFile => f !== null);
    const head = await this.run(cwd, ['rev-parse', 'HEAD']);
    const hasHead = head.ok;
    const num = await this.run(
      cwd,
      hasHead ? ['diff', 'HEAD', '--numstat'] : ['diff', '--cached', '--numstat'],
    );
    let added = 0;
    let removed = 0;
    // 逐文件行数：路径 → [added, removed]。numstat 第三列是路径（重命名时形如
    // `old => new` 或 `{a => b}`，取 `=>` 后半——与 porcelain 的做法一致）。
    const perFile = new Map<string, { added: number; removed: number }>();
    if (num.ok) {
      for (const line of num.stdout.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 3) {
          continue;
        }
        const a = Number.parseInt(cols[0] ?? '', 10);
        const r = Number.parseInt(cols[1] ?? '', 10);
        // 二进制两侧都是 `-`，parseInt 出 NaN：既不累加也不写 perFile
        if (Number.isFinite(a)) added += a;
        if (Number.isFinite(r)) removed += r;
        if (!Number.isFinite(a) && !Number.isFinite(r)) continue;
        const p = (cols[2] ?? '').trim();
        if (p !== '') {
          const arrow = p.lastIndexOf('=>');
          perFile.set((arrow === -1 ? p : p.slice(arrow + 2)).trim(), {
            added: Number.isFinite(a) ? a : 0,
            removed: Number.isFinite(r) ? r : 0,
          });
        }
      }
    }
    // 逐文件回填。未跟踪文件不在 numstat 里（git 对它不报行数），
    // 自行读文件数行，否则变更视图上会是一个谎报事实的 +0。
    for (const f of files) {
      const hit = perFile.get(f.path);
      if (hit) {
        f.added = hit.added;
        f.removed = hit.removed;
      } else if (f.status === '?') {
        f.added = countUntrackedLines(cwd, f.path);
      }
    }
    const cur = await this.run(cwd, ['branch', '--show-current']);
    let branch: string | null = cur.stdout.trim();
    let detached = false;
    if (branch === '') {
      detached = true;
      const short = await this.run(cwd, ['rev-parse', '--short', 'HEAD']);
      branch = short.ok ? short.stdout.trim() : null;
    }
    // 未推送文件数（真机反馈修正 2026-09-24：本地新分支无 upstream 也要如实计数）：
    // 有 upstream 比 upstream；否则比 origin/<branch>；分支从未推送则数
    // 「本地有、任何远端分支没有」的提交涉及文件（--not --remotes）。
    // 仅无远端 / detached / 无 HEAD 时为 null（未知，UI 不显示）
    let unpushedCount: number | null = null;
    if (hasHead && !detached) {
      const remotes = await this.run(cwd, ['remote']);
      if (remotes.ok && remotes.stdout.trim() !== '') {
        const up = await this.run(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']);
        let baseRef = up.ok ? up.stdout.trim() : '';
        if (baseRef === '' && branch) {
          const rb = await this.run(cwd, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
          baseRef = rb.ok ? rb.stdout.trim() : '';
        }
        if (baseRef !== '') {
          const ud = await this.run(cwd, ['diff', '--name-only', `${baseRef}...HEAD`]);
          if (ud.ok) {
            unpushedCount = uniquePaths(ud.stdout);
          }
        } else {
          // 显式 HEAD：零远端跟踪引用时 `--not --remotes` 会把隐式 HEAD 一并吞掉（实测）
          const lg = await this.run(cwd, ['log', '--pretty=tformat:', '--name-only', 'HEAD', '--not', '--remotes']);
          if (lg.ok) {
            unpushedCount = uniquePaths(lg.stdout);
          }
        }
      }
    }
    return {
      isGitRepo: true,
      branch,
      detached,
      fileCount: lines.length,
      added,
      removed,
      stagedEmpty,
      stagedCount,
      unpushedCount,
      hasHead,
      files,
    };
  }

  /**
   * 单文件 diff（模块 12 代码查看器「并排 diff」数据源，只读无副作用）。
   *
   * 基线与 getStatus 的 numstat 同口径：有 HEAD 比 `diff HEAD`，无 HEAD 的空仓库
   * 比 `diff --cached`——对比的都是「全部未提交变更」，与变更视图的 +N −M 一致。
   *
   * 空输出的二义性在这里消解：跟踪文件无差异 = `''`，未跟踪文件 = `null`
   * （git 对未跟踪文件不产出任何 diff）。区分靠 `ls-files --error-unmatch`
   * 补的一刀，且只在 diff 为空时才多这一次调用——正常路径单进程往返。
   */
  async getFileDiff(cwd: string, relPath: string): Promise<GitFileDiffResult> {
    if (typeof relPath !== 'string' || !isSafeRelPath(relPath)) {
      return { ok: false, code: 1001, message: 'relPath 必须为仓库内的相对路径' };
    }
    const inside = await this.run(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
      // 非 git 目录：与 getStatus 的 NOT_A_STATUS 同口径（空值，不报错）
      return { ok: true, data: { diff: null } };
    }
    const head = await this.run(cwd, ['rev-parse', 'HEAD']);
    const d = await this.run(
      cwd,
      head.ok ? ['diff', 'HEAD', '--', relPath] : ['diff', '--cached', '--', relPath],
    );
    if (!d.ok) {
      return { ok: false, code: 6001, message: 'git diff 失败', stderr: d.stderr };
    }
    if (d.stdout !== '') {
      return { ok: true, data: { diff: d.stdout } };
    }
    const tracked = await this.run(cwd, ['ls-files', '--error-unmatch', '--', relPath]);
    return { ok: true, data: { diff: tracked.ok ? '' : null } };
  }

  /* ================================================================
   * CE-S11 提交历史
   *
   * 三条实测出来的硬约束贯穿下面三个方法（PRD 12 §3.7.2，均在临时仓库跑过）：
   * 1. `git show <merge>` 对 merge commit **输出 0 行 patch** → merge 一律走
   *    `git diff <sha>^1 <sha>`（第一父口径）；
   * 2. root commit 无 `<sha>^1`，用 `diff` 会 `fatal: ambiguous argument`
   *    → 按 parentCount 分派到 `git show`；
   * 3. rename 的 `--numstat` 不带 `-z` 时是 `a => b` 歧义写法（目录改名还可能是
   *    `sub/{a => b}/f` 的 brace 形式）→ 必须带 `-z`。
   *
   * 空仓库（unborn HEAD）的 `git log` 是 exit 128，属正常状态而非错误。
   * ================================================================ */

  /**
   * git/getCommitLog（api/11 §6）：查询当前分支提交历史，**只返元数据**。
   * 非 git 目录与空仓库均归一为「空历史 + 成功」，不报错（AC-CE-040/041）。
   */
  async getCommitLog(cwd: string, limit = 100, skip = 0): Promise<GitCommitLogResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return { ok: false, code: 1001, message: 'limit 必须为 1~500 的整数' };
    }
    if (!Number.isInteger(skip) || skip < 0) {
      return { ok: false, code: 1001, message: 'skip 必须为非负整数' };
    }
    const inside = await this.run(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
      return { ok: true, data: { commits: [], hasMore: false } };
    }
    // 多取一条用于判定 hasMore：拿到 limit+1 条就说明还有下一页。
    // **末尾必须自带记录分隔符**：`--pretty=format:` 只在记录间输出换行、不加分隔符，
    // 按 0x1e 切分会得到「一整块」，多条提交被当成一条（实测过这个坑）。
    const r = await this.run(cwd, [
      'log',
      `-n${String(limit + 1)}`,
      `--skip=${String(skip)}`,
      `--pretty=format:%H${LOG_FIELD_SEP}%h${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%at${LOG_FIELD_SEP}%P${LOG_RECORD_SEP}`,
    ]);
    // unborn HEAD：git 自身报错，但对 UI 而言这是「还没有提交」
    if (!r.ok) {
      if (isUnbornHead(r.stderr)) {
        return { ok: true, data: { commits: [], hasMore: false } };
      }
      return { ok: false, code: 6001, message: 'git log 失败', stderr: r.stderr };
    }

    const records = r.stdout
      .split(LOG_RECORD_SEP)
      // `format:` 会在记录之间插入换行，于是第 2 条起的记录带**前导 \n**，
      // 直接切会把换行进 sha 字段（实测过：git 报 `ambiguous argument '\n<sha>'`）。
      .map((s) => s.replace(/^\n+/, ''))
      .filter((s) => s.trim() !== '');
    const hasMore = records.length > limit;
    const commits: GitCommitSummary[] = [];
    for (const rec of records.slice(0, limit)) {
      const f = rec.split(LOG_FIELD_SEP);
      if (f.length < 7) continue;
      const [sha = '', shortSha = '', subject = '', authorName = '', authorEmail = '', at, parents = ''] = f;
      const parentCount = parents.trim() === '' ? 0 : parents.trim().split(/\s+/).length;
      commits.push({
        sha,
        shortSha,
        subject,
        authorName,
        authorEmail,
        authoredAt: Number(at) || 0,
        parentCount,
        isMerge: parentCount >= 2,
      });
    }
    return { ok: true, data: { commits, hasMore } };
  }

  /**
   * git/getCommitDetail（api/11 §7）：提交元数据 + 逐文件增删行数，**不含 patch**。
   *
   * 两级取数：实测 128 文件的 merge commit，全量 patch 是 1,595,751 bytes，
   * 而本方法的 meta+numstat 只要 5,951 bytes（**268 倍**）。patch 一律走
   * getCommitFileDiff 按文件懒取——合并两者会把 1.6MB 塞进 IPC 再塞进 DOM。
   */
  async getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetailResult> {
    if (typeof sha !== 'string' || sha.trim() === '') {
      return { ok: false, code: 1001, message: 'sha 必须为非空字符串' };
    }
    const fmt = [
      `%H${LOG_FIELD_SEP}%h${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%b${LOG_FIELD_SEP}`,
      `%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%at${LOG_FIELD_SEP}`,
      `%cn${LOG_FIELD_SEP}%ce${LOG_FIELD_SEP}%ct${LOG_FIELD_SEP}%P`,
    ].join('');
    const meta = await this.run(cwd, ['show', '-s', `--pretty=format:${fmt}`, sha]);
    if (!meta.ok) {
      return { ok: false, code: 6001, message: 'git show 失败', stderr: meta.stderr };
    }
    const f = meta.stdout.replace(/^\n+/, '').split(LOG_FIELD_SEP);
    // 11 个字段：H h s b an ae at cn ce ct P（%b 可能含换行，但不含 \x1f，切分安全）
    if (f.length < 11) {
      return { ok: false, code: 6001, message: '无法解析提交元信息' };
    }
    const [fullSha = '', shortSha = '', subject = '', body = '', an = '', ae = '', at, cn = '', ce = '', ct, parents = ''] = f;
    const parentCount = parents.trim() === '' ? 0 : parents.trim().split(/\s+/).length;
    const isRoot = parentCount === 0;
    const isMerge = parentCount >= 2;

    // 文件统计：merge 走第一父（git show 对 merge 的 numstat 口径不可靠），
    // root 无 ^1 走 show。
    const statArgs = isRoot
      ? ['show', '--numstat', '-z', '--format=', sha]
      : ['diff', '--numstat', '-z', `${sha}^1`, sha];
    const stat = await this.run(cwd, statArgs);
    if (!stat.ok) {
      return { ok: false, code: 6001, message: 'git 统计变更失败', stderr: stat.stderr };
    }
    const files = parseNumstatZ(stat.stdout);
    if (files === null) {
      return { ok: false, code: 6001, message: '无法解析文件变更统计' };
    }

    return {
      ok: true,
      data: {
        sha: fullSha,
        shortSha,
        subject,
        body: (body ?? '').trim(),
        authorName: an ?? '',
        authorEmail: ae ?? '',
        authoredAt: Number(at) || 0,
        committedAt: Number(ct) || 0,
        committerName: cn ?? '',
        committerEmail: ce ?? '',
        parentCount,
        isMerge,
        isRoot,
        files,
      },
    };
  }

  /**
   * git/getCommitFileDiff（api/11 §8）：取单条提交中**单个文件**的 unified diff，
   * 两级取数的第二级，文件块展开时才调。
   *
   * 基线按 parentCount 分派：root → `git show <sha>`（`diff <sha>^1` 会 fatal）；
   * 普通与 merge → `git diff <sha>^1 <sha>`（merge 走第一父；`git show <merge>`
   * 默认输出 0 行 patch，这是实测踩过的坑）。
   */
  async getCommitFileDiff(cwd: string, sha: string, relPath: string): Promise<GitCommitFileDiffResult> {
    if (typeof sha !== 'string' || sha.trim() === '') {
      return { ok: false, code: 1001, message: 'sha 必须为非空字符串' };
    }
    if (typeof relPath !== 'string' || !isSafeRelPath(relPath)) {
      return { ok: false, code: 1001, message: 'relPath 必须为仓库内的相对路径' };
    }
    const parents = await this.run(cwd, ['rev-list', '--parents', '-n', '1', sha]);
    if (!parents.ok) {
      return { ok: false, code: 6001, message: '无法解析提交', stderr: parents.stderr };
    }
    const parentCount = parents.stdout.trim() === '' ? 0 : parents.stdout.trim().split(/\s+/).length - 1;
    const parent = `${sha}^1`;

    // 重命名时 pathspec 必须同时含新旧路径：只给新路径，git 在父侧找不到该路径，
    // 会把重命名当「新增文件」输出全量 patch（实测：纯重命名拿到的是 +1 全量新增）。
    let pathspec = [relPath];
    if (parentCount > 0) {
      const ns = await this.run(cwd, ['diff', '--name-status', '-M', '-z', parent, sha], GIT_WRITE_TIMEOUT_MS);
      if (ns.ok) {
        const fields = ns.stdout.split('\0').filter((x) => x !== '');
        for (let i = 0; i < fields.length; i++) {
          const head = fields[i];
          if (head === undefined || (!head.startsWith('R') && !head.startsWith('C'))) continue;
          const oldPath = fields[i + 1];
          const newPath = fields[i + 2];
          if (oldPath === undefined || newPath === undefined) break;
          if (oldPath === relPath || newPath === relPath) {
            pathspec = oldPath === relPath ? [oldPath, newPath] : [newPath, oldPath];
          }
          i += 2;
        }
      }
    }

    const d =
      parentCount === 0
        ? await this.run(cwd, ['show', sha, '--', ...pathspec], GIT_WRITE_TIMEOUT_MS)
        : await this.run(cwd, ['diff', parent, sha, '--', ...pathspec], GIT_WRITE_TIMEOUT_MS);
    if (!d.ok) {
      return { ok: false, code: 6001, message: 'git 取提交差异失败', stderr: d.stderr };
    }
    if (d.stdout === '') {
      return { ok: true, data: { diff: '' } };
    }
    // 二进制：git 产出提示行而非真 patch → null，让 UI 区分「二进制」与「无变化」（后者是空串）
    if (/^Binary files .* differ$/m.test(d.stdout)) {
      return { ok: true, data: { diff: null } };
    }
    // 无 hunk 头 = 无行级变化（纯重命名 / 仅改文件权限），口径为 `''`
    if (!/^@@ /m.test(d.stdout)) {
      return { ok: true, data: { diff: '' } };
    }
    return { ok: true, data: { diff: d.stdout } };
  }

  /**
   * 提交（模块 11 GC-F03）：includeUnstaged=true 先 `git add -A`；提交前服务端
   * 二次校验暂存非空（AC-11-07）。message 数组化传 execFile，不经 shell 拼接。
   * 失败（身份未配置 / hook 拒绝 / index.lock）透传 6006 + git 原始 stderr；
   * add -A 已生效的不回退（PRD：错误区如实提示变更已暂存）。
   */
  async commit(cwd: string, message: string, includeUnstaged: boolean): Promise<CommitResult> {
    if (typeof message !== 'string' || message.trim() === '') {
      return { ok: false, code: 1001, message: 'message 必须为非空字符串' };
    }
    if (includeUnstaged) {
      const add = await this.run(cwd, ['add', '-A'], GIT_WRITE_TIMEOUT_MS);
      if (!add.ok) {
        return { ok: false, code: 6006, message: 'git add 失败', stderr: add.stderr };
      }
    }
    const staged = await this.run(cwd, ['diff', '--cached', '--name-only']);
    if (!staged.ok) {
      return { ok: false, code: 6006, message: 'git 暂存区检查失败', stderr: staged.stderr };
    }
    if (staged.stdout.trim() === '') {
      return { ok: false, code: 6006, message: '暂存区为空，无变更可提交', stderr: '' };
    }
    const cm = await this.run(cwd, ['commit', '-m', message], GIT_WRITE_TIMEOUT_MS);
    if (!cm.ok) {
      return { ok: false, code: 6006, message: 'git 提交失败', stderr: cm.stderr };
    }
    const short = await this.run(cwd, ['rev-parse', '--short', 'HEAD']);
    const files = await this.run(cwd, ['show', '--pretty=format:', '--name-only', 'HEAD']);
    const fileCount = files.ok
      ? files.stdout.split('\n').filter((l) => l.trim() !== '').length
      : 0;
    const shortHash = short.ok ? short.stdout.trim() : '';
    console.log(
      `[git] commit ok cwd=${cwd} hash=${shortHash} files=${fileCount} msg=${JSON.stringify(message.slice(0, 60))}`,
    );
    return { ok: true, data: { shortHash, fileCount } };
  }

  /**
   * 推送当前分支（模块 11 GC-F04）：有 upstream 直接 `git push`；无 upstream 自动
   * `-u origin <branch>`；分离 HEAD 拒绝。失败透传 6007 + git 原始 stderr（认证失败 /
   * non-fast-forward / 无远端均原样回显，不自动 pull、无 force 能力面）。
   */
  async push(cwd: string): Promise<PushResult> {
    const cur = await this.run(cwd, ['branch', '--show-current']);
    const branch = cur.stdout.trim();
    if (!cur.ok || branch === '') {
      return { ok: false, code: 6007, message: '无法推送：当前处于分离 HEAD 或分支不可解析', stderr: cur.stderr };
    }
    const up = await this.run(cwd, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    const pr = await this.run(
      cwd,
      up.ok ? ['push'] : ['push', '-u', 'origin', branch],
      GIT_WRITE_TIMEOUT_MS,
    );
    if (!pr.ok) {
      return { ok: false, code: 6007, message: 'git 推送失败', stderr: pr.stderr };
    }
    let remote = 'origin';
    if (up.ok) {
      const rs = await this.run(cwd, ['config', '--get', `branch.${branch}.remote`]);
      if (rs.ok && rs.stdout.trim() !== '') {
        remote = rs.stdout.trim();
      }
    }
    console.log(`[git] push ok cwd=${cwd} branch=${branch} remote=${remote}`);
    return { ok: true, data: { branch, remote } };
  }

  /**
   * 组装 AI 提交说明的 diff 上下文（模块 11 TD-GC-03）：文件清单全量（含未跟踪，
   * 二进制只列名）+ 每文件 diff 前 N 行，总长封顶截断。无 HEAD 空仓库退
   * `git diff --cached` 基线。只读无副作用。
   */
  async collectCommitDiff(cwd: string): Promise<CommitDiffContext> {
    const head = await this.run(cwd, ['rev-parse', 'HEAD']);
    const hasHead = head.ok;
    const numstat = await this.run(
      cwd,
      hasHead ? ['diff', 'HEAD', '--numstat'] : ['diff', '--cached', '--numstat'],
    );
    const untracked = await this.run(cwd, ['ls-files', '--others', '--exclude-standard']);
    interface Entry {
      name: string;
      binary: boolean;
      added: number;
      removed: number;
      untracked: boolean;
    }
    const entries: Entry[] = [];
    if (numstat.ok) {
      for (const line of numstat.stdout.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 3 || line.trim() === '') {
          continue;
        }
        const a = Number.parseInt(cols[0] ?? '', 10);
        const r = Number.parseInt(cols[1] ?? '', 10);
        entries.push({
          name: (cols[2] ?? '').trim(),
          // numstat 二进制文件两侧均为 '-'
          binary: !Number.isFinite(a) && !Number.isFinite(r),
          added: Number.isFinite(a) ? a : 0,
          removed: Number.isFinite(r) ? r : 0,
          untracked: false,
        });
      }
    }
    if (untracked.ok) {
      for (const line of untracked.stdout.split('\n')) {
        const name = line.trim();
        if (name === '' || entries.some((e) => e.name === name)) {
          continue;
        }
        entries.push({ name, binary: false, added: 0, removed: 0, untracked: true });
      }
    }
    if (entries.length === 0) {
      return { hasChanges: false, fileCount: 0, text: '' };
    }
    const list = entries.map((e) => {
      const tag = e.untracked ? 'new(untracked)' : e.binary ? 'bin' : `+${e.added} -${e.removed}`;
      return `${tag}  ${e.name}`;
    });
    let text = `Files (${entries.length}):\n${list.join('\n')}\n`;
    const diff = await this.run(
      cwd,
      hasHead ? ['diff', 'HEAD'] : ['diff', '--cached'],
      GIT_WRITE_TIMEOUT_MS,
    );
    if (diff.ok && diff.stdout.trim() !== '') {
      const sections = diff.stdout
        .split(/^diff --git /m)
        .filter((s) => s.trim() !== '')
        .map((s) => `diff --git ${s}`);
      let budget = AI_DIFF_MAX_CHARS - text.length - 12; // 预留 "\nDiffs:\n" 头
      const parts: string[] = [];
      for (const section of sections) {
        if (budget <= 0) {
          break;
        }
        const lines = section.split('\n');
        let clamped =
          lines.length > AI_DIFF_MAX_LINES_PER_FILE
            ? lines.slice(0, AI_DIFF_MAX_LINES_PER_FILE).join('\n') + '\n…(file diff truncated)\n'
            : section.endsWith('\n')
              ? section
              : `${section}\n`;
        if (clamped.length > budget) {
          clamped = `${clamped.slice(0, Math.max(0, budget - 28))}\n…(diff truncated at budget)\n`;
        }
        parts.push(clamped);
        budget -= clamped.length;
      }
      if (parts.length > 0) {
        text = `${text}\nDiffs:\n${parts.join('')}`;
      }
    }
    if (text.length > AI_DIFF_MAX_CHARS) {
      text = `${text.slice(0, AI_DIFF_MAX_CHARS)}\n…(truncated)`;
    }
    return { hasChanges: true, fileCount: entries.length, text };
  }
}
