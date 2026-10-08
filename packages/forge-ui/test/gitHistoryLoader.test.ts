/**
 * CE-S11 两级取数编排单测（PRD 12 §3.7.1 / AC-CE-037，对应 unit.md 的 U-CE-15）。
 *
 * 守的是整个特性里最重要的一条契约：**详情不返 patch，单文件 patch 展开时才取**。
 * 实测依据：128 文件的 merge commit，全量 patch 是 1,595,751 bytes，
 * 而 meta+numstat 只要 5,951 bytes（268 倍）。一旦有人图省事改成一次性取全量，
 * 本文件立刻红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHistoryLoader, type GitHistoryBridge } from '../src/composables/useGitHistory.ts';

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** 记录调用序列的 fake bridge；getCommitDetail 故意**不含** diff 字段 */
function makeBridge(overrides: Partial<GitHistoryBridge> = {}): {
  bridge: GitHistoryBridge;
  calls: Call[];
} {
  const calls: Call[] = [];
  const bridge: GitHistoryBridge = {
    async getCommitLog(params) {
      calls.push({ method: 'git/getCommitLog', args: params });
      return {
        commits: [
          { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's1', authorName: '陈默', authorEmail: 'c@t.com', authoredAt: 1, parentCount: 1, isMerge: false },
          { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 's2', authorName: '王工', authorEmail: 'w@t.com', authoredAt: 2, parentCount: 1, isMerge: false },
        ],
        hasMore: false,
      };
    },
    async getCommitDetail(params) {
      calls.push({ method: 'git/getCommitDetail', args: params });
      return {
        sha: params.sha,
        shortSha: params.sha.slice(0, 7),
        subject: 'detail',
        body: '',
        authorName: '陈默',
        authorEmail: 'c@t.com',
        authoredAt: 1,
        committedAt: 1,
        committerName: '陈默',
        committerEmail: 'c@t.com',
        parentCount: 1,
        isMerge: false,
        isRoot: false,
        files: [
          { path: 'a.ts', oldPath: null, status: 'M', additions: 1, deletions: 1, binary: false },
          { path: 'b.ts', oldPath: null, status: 'M', additions: 2, deletions: 0, binary: false },
          { path: 'bin.png', oldPath: null, status: 'M', additions: -1, deletions: -1, binary: true },
        ],
      };
    },
    async getCommitFileDiff(params) {
      calls.push({ method: 'git/getCommitFileDiff', args: params });
      return { diff: `diff for ${params.file}` };
    },
    ...overrides,
  };
  return { bridge, calls };
}

const SHA = 'a'.repeat(40);

test('U-CE-15：选中提交只调 getCommitDetail，不调 getCommitFileDiff', async () => {
  const { bridge, calls } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);

  const detailCalls = calls.filter((c) => c.method === 'git/getCommitDetail');
  const fileCalls = calls.filter((c) => c.method === 'git/getCommitFileDiff');
  assert.equal(detailCalls.length, 1, '选中应调详情一次');
  assert.equal(fileCalls.length, 0, '**未展开任何文件时不得取 patch**（两级取数契约）');
  assert.equal(detailCalls[0]!.args.sha, SHA);
});

test('U-CE-15：展开某文件才调 getCommitFileDiff，且只调那一个', async () => {
  const { bridge, calls } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');

  const fileCalls = calls.filter((c) => c.method === 'git/getCommitFileDiff');
  assert.equal(fileCalls.length, 1);
  assert.equal(fileCalls[0]!.args.file, 'a.ts');
  assert.equal(fileCalls[0]!.args.sha, SHA);
});

test('U-CE-15：展开第二个文件不会重复取第一个', async () => {
  const { bridge, calls } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');
  await loader.expandFile('b.ts');

  const files = calls.filter((c) => c.method === 'git/getCommitFileDiff').map((c) => c.args.file);
  assert.deepEqual(files, ['a.ts', 'b.ts']);
});

test('U-CE-15：折叠后重新展开命中缓存，不再发 IPC', async () => {
  const { bridge, calls } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');
  await loader.collapseFile('a.ts');
  await loader.expandFile('a.ts');

  const files = calls.filter((c) => c.method === 'git/getCommitFileDiff');
  assert.equal(files.length, 1, '二次展开应命中缓存');
  assert.equal(loader.isFileExpanded('a.ts'), true);
});

test('U-CE-15：缓存键含 sha——切提交后同名文件重新取（不得串前一提交）', async () => {
  const { bridge, calls } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');
  await loader.selectCommit('b'.repeat(40));
  await loader.expandFile('a.ts');

  const fileCalls = calls.filter((c) => c.method === 'git/getCommitFileDiff');
  assert.equal(fileCalls.length, 2, '换提交后同名文件必须重新取，否则 diff 会串台');
  assert.equal(fileCalls[0]!.args.sha, SHA);
  assert.equal(fileCalls[1]!.args.sha, 'b'.repeat(40));
});

test('U-CE-15：切提交会清空上一提交的展开态', async () => {
  const { bridge } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');
  await loader.selectCommit('b'.repeat(40));
  assert.equal(loader.isFileExpanded('a.ts'), false, '展开态属于具体提交，不应跨提交保留');
});

test('U-CE-15：详情失败不抛，置为失败态', async () => {
  const { bridge } = makeBridge({
    getCommitDetail: async () => {
      throw new Error('boom');
    },
  });
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  assert.equal(loader.detailState(), 'fail');
  assert.equal(loader.detail(), null);
});

test('U-CE-15：单文件 diff 失败不影响其他文件（局部失败）', async () => {
  const { bridge } = makeBridge({
    getCommitFileDiff: async (p) => {
      if (p.file === 'a.ts') throw new Error('boom');
      return { diff: 'ok' };
    },
  });
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');
  await loader.expandFile('b.ts');
  assert.equal(loader.fileState('a.ts'), 'fail');
  assert.equal(loader.fileState('b.ts'), 'ready');
  assert.equal(loader.fileDiff('b.ts'), 'ok');
});

test('U-CE-15：二进制文件的 diff 为 null，状态 ready（交 UI 渲染二进制空态）', async () => {
  const { bridge } = makeBridge({
    getCommitFileDiff: async () => ({ diff: null }),
  });
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.selectCommit(SHA);
  await loader.expandFile('bin.png');
  assert.equal(loader.fileState('bin.png'), 'ready');
  assert.equal(loader.fileDiff('bin.png'), null);
});

test('U-CE-15：loadLog 走 getCommitLog 且按 limit/skip 透传', async () => {
  const { bridge, calls } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.loadLog({ limit: 50, skip: 100 });
  const c = calls.find((x) => x.method === 'git/getCommitLog')!;
  assert.equal(c.args.limit, 50);
  assert.equal(c.args.skip, 100);
  assert.equal(loader.commits().length, 2);
});

test('U-CE-15：追加分页按 sha 去重且不重排', async () => {
  const { bridge } = makeBridge({
    getCommitLog: async (p) =>
      p.skip === 0
        ? { commits: [{ sha: 'a'.repeat(40), shortSha: 'a', subject: 's', authorName: '陈默', authorEmail: 'c@t.com', authoredAt: 2, parentCount: 1, isMerge: false }], hasMore: true }
        : { commits: [{ sha: 'a'.repeat(40), shortSha: 'a', subject: 's', authorName: '陈默', authorEmail: 'c@t.com', authoredAt: 2, parentCount: 1, isMerge: false }, { sha: 'c'.repeat(40), shortSha: 'c', subject: 's3', authorName: '王工', authorEmail: 'w@t.com', authoredAt: 1, parentCount: 1, isMerge: false }], hasMore: false },
  });
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.loadLog({ limit: 10, skip: 0 });
  await loader.loadLog({ limit: 10, skip: 1 });
  const shas = loader.commits().map((c) => c.sha);
  assert.deepEqual(shas, ['a'.repeat(40), 'c'.repeat(40)], '重复 sha 应被去重且保持顺序');
  assert.equal(loader.hasMore(), false);
});

test('U-CE-15：切项目清空全部状态（不得串项目）', async () => {
  const { bridge } = makeBridge();
  const loader = createGitHistoryLoader(bridge);
  loader.setProject('D:/dev/p');
  await loader.loadLog({ limit: 10, skip: 0 });
  await loader.selectCommit(SHA);
  await loader.expandFile('a.ts');
  loader.reset();
  assert.equal(loader.commits().length, 0);
  assert.equal(loader.detail(), null);
  assert.equal(loader.isFileExpanded('a.ts'), false);
});

test('U-CE-15：竞态防护——后发先至的详情不得覆盖当前选中提交', async () => {
  const { bridge } = makeBridge();
  let resolveSlow: ((v: unknown) => void) | null = null;
  const loader = createGitHistoryLoader({
    ...bridge,
    getCommitDetail: async (p) => {
      if (p.sha === SHA) {
        // 第一个请求慢，第二个快：若不比对 sha，快的会被慢的覆盖
        await new Promise((r) => (resolveSlow = r));
      }
      return {
        sha: p.sha, shortSha: 'x', subject: `detail-${p.sha.slice(0, 4)}`, body: '',
        authorName: '陈默', authorEmail: 'c@t.com', authoredAt: 1, committedAt: 1,
        committerName: '陈默', committerEmail: 'c@t.com',
        parentCount: 1, isMerge: false, isRoot: false, files: [],
      } as never;
    },
  });
  loader.setProject('D:/dev/p');
  const slow = loader.selectCommit(SHA);
  const fast = loader.selectCommit('b'.repeat(40));
  await fast;
  resolveSlow?.(null);
  await slow;
  assert.equal(loader.detail()?.sha, 'b'.repeat(40), '当前详情必须属于最后选中的提交');
});