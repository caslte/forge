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
};

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

  /** 执行 `git -C <cwd> <args>`；非零退出 / git 不可执行均返回 ok:false（不抛出） */
  private async run(cwd: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<RunResult> {
    try {
      const { stdout } = await execFileAsync(this.gitBin, ['-C', cwd, ...args], {
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
    const head = await this.run(cwd, ['rev-parse', 'HEAD']);
    const hasHead = head.ok;
    const num = await this.run(
      cwd,
      hasHead ? ['diff', 'HEAD', '--numstat'] : ['diff', '--cached', '--numstat'],
    );
    let added = 0;
    let removed = 0;
    if (num.ok) {
      for (const line of num.stdout.split('\n')) {
        const cols = line.split('\t');
        if (cols.length < 3) {
          continue;
        }
        const a = Number.parseInt(cols[0] ?? '', 10);
        const r = Number.parseInt(cols[1] ?? '', 10);
        if (Number.isFinite(a)) added += a;
        if (Number.isFinite(r)) removed += r;
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
    };
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
