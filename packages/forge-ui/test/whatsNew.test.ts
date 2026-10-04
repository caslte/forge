/**
 * 版本更新说明弹窗（useWhatsNew）单测。
 *
 * 测试策略（同 codeExplorerGitStatus.test.ts）：mock 的是 **IPC 边界**——
 * window.forge.invoke 忠实复刻信封语义（code!==0 由 bridge.call 抛错），
 * 断言业务行为（弹窗显隐、已展示回写、正文渲染）而非「某个 mock 被调用了几次」。
 *
 * useWhatsNew 是模块级单例：同文件内用例按叙事顺序共享状态（node:test 同文件顺序
 * 执行）——首查失败可重试 → 成功自动弹 → 关闭重开/幂等 → markdown 缺失降级，
 * 正好是一条真实使用时间线。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const NOTES_MD = '### 新功能\n- 添加 Git 单文件 diff 能力及变更视图功能';

/** 记录生产代码实际发出的方法名，供契约/幂等断言 */
const calls: string[] = [];

/** getReleaseNotes 的可编程响应：Error 实例 = IPC 抛错（bridge.call 会被 reject） */
let getNotesResult: { code: number; message: string; data: unknown } | Error;

function invoke(method: string): { code: number; message: string; data: unknown } {
  calls.push(method);
  if (method === 'updater/getReleaseNotes') {
    if (getNotesResult instanceof Error) throw getNotesResult;
    return getNotesResult;
  }
  if (method === 'updater/markNotesShown') {
    return { code: 0, message: 'success', data: null };
  }
  return { code: 1001, message: `未 mock 的方法: ${method}`, data: null };
}

let useWhatsNew: typeof import('../src/composables/useWhatsNew.ts').useWhatsNew;

before(async () => {
  (globalThis as Record<string, unknown>)['window'] = {
    addEventListener: () => {},
    forge: {
      invoke: (m: string) => Promise.resolve(invoke(m)),
      on: () => () => {},
    },
  };
  const mod = await import('../src/composables/useWhatsNew.ts');
  useWhatsNew = mod.useWhatsNew;
});

test('首查失败（core 未就绪等）：静默不弹、入口不可用，checked 不置位可重试', async () => {
  getNotesResult = new Error('core not ready');
  const { ensureChecked, visible, available } = useWhatsNew();
  await ensureChecked();
  assert.equal(visible.value, false, '失败不弹');
  assert.equal(available.value, false, '入口依赖首查结果，失败应隐藏');
});

test('重试成功且 shouldShow=true：自动弹 + 打开即回写已展示 + 正文渲染出分组标题', async () => {
  getNotesResult = {
    code: 0,
    message: 'success',
    data: { version: '0.2.3', markdown: NOTES_MD, shouldShow: true },
  };
  const { ensureChecked, visible, available, notesHtml } = useWhatsNew();
  await ensureChecked();
  assert.equal(visible.value, true, '升级首启 + 未展示 → 自动弹');
  assert.ok(calls.includes('updater/markNotesShown'), '打开即向主进程回写（只弹一次标记）');
  assert.equal(available.value, true, '入口可用（关于页回看）');
  assert.ok(notesHtml.value.includes('新功能'), 'markdown 应渲染出分组标题');
});

test('关闭后可从关于页重开；ensureChecked 幂等不重复发请求', async () => {
  const { visible, open, close, ensureChecked } = useWhatsNew();
  close();
  assert.equal(visible.value, false);
  open();
  assert.equal(visible.value, true, '关于页入口重开的是同一份弹窗状态');
  close();
  const before = calls.filter((m) => m === 'updater/getReleaseNotes').length;
  await ensureChecked();
  const after = calls.filter((m) => m === 'updater/getReleaseNotes').length;
  assert.equal(after, before, '已首查过 → 幂等，不再发请求');
});

test('markdown 缺失（极老安装包）：open 无动作、入口隐藏', () => {
  const { payload, visible, available, open } = useWhatsNew();
  payload.value = { version: '0.2.3', markdown: null, shouldShow: false };
  open();
  assert.equal(visible.value, false, '无说明可展示，open 应无动作');
  assert.equal(available.value, false, '入口应隐藏');
});

test('「完整变更」compare 行只在网页 Release 保留，应用内渲染时去除', () => {
  const { payload, notesHtml } = useWhatsNew();
  payload.value = {
    version: '0.2.3',
    markdown: '### 新功能\n- 某个功能\n\n**完整变更**：https://github.com/a/b/compare/v0.2.1...v0.2.2',
    shouldShow: false,
  };
  assert.ok(!notesHtml.value.includes('完整变更'), '应用内不渲染 compare 行');
  assert.ok(notesHtml.value.includes('某个功能'), '其余内容原样保留');
});
