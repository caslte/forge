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
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** git 命令默认超时（ms） */
const GIT_TIMEOUT_MS = 5000;

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
  private async run(cwd: string, args: string[]): Promise<RunResult> {
    try {
      const { stdout } = await execFileAsync(this.gitBin, ['-C', cwd, ...args], {
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
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
}
