/**
 * 版本更新说明弹窗全局状态（模块级单例，对齐 useGitCommitDialog/useToast 套路）。
 *
 * 数据源：安装包内置 release-notes.md（主进程 updater/getReleaseNotes 读取，
 * dev 回退仓库内文件）。弹窗本体 WhatsNewDialog.vue 挂 App.vue 根，显隐由本单例驱动。
 *
 * 时机：App.vue startPostBootInit（core 就绪后）调 ensureChecked()——shouldShow
 * （升级首启 + 本版本未展示过）自动弹窗并向主进程回写已展示版本；设置「关于」页
 * 入口手动 open 复用同一份数据。加载失败不锁死：checked 不置位，下次入口重试。
 */
import { computed, ref } from 'vue';
import { call } from '../bridge.ts';
import type { ReleaseNotesPayload } from '../bridge.ts';
import { renderMarkdown } from '@forge/core/markdown';
import { decorateMarkdownHtml } from '../utils/markdownLinks.ts';

const payload = ref<ReleaseNotesPayload | null>(null);
const visible = ref(false);
/** 已完成首查（成功或确定不可用）；失败保持 false 允许后续入口重试 */
const checked = ref(false);
let checking = false;

/** 说明是否可用（关于页「查看本次更新说明」入口显隐） */
const available = computed(() => checked.value && payload.value?.markdown != null);

/** 应用内展示前去掉文末「完整变更」compare 链接行——GitHub Release 描述保留它，弹窗内不需要 */
function stripCompareLine(md: string): string {
  return md
    .split('\n')
    .filter((line) => !line.startsWith('**完整变更**'))
    .join('\n')
    .trim();
}

/** 渲染好的说明 HTML（markdown 缺失为空串）；decorate 补复制按钮 tooltip 等自有标记 */
const notesHtml = computed(() => {
  const md = payload.value?.markdown;
  return md ? decorateMarkdownHtml(renderMarkdown(stripCompareLine(md))) : '';
});

/**
 * 打开弹窗（幂等；markdown 缺失不弹）。打开即向主进程回写「本版本已展示」——
 * 保证升级后只自动弹一次，关掉/崩溃/重启都不再弹，回看走关于页入口。
 */
function open(): void {
  if (!payload.value?.markdown) return;
  visible.value = true;
  void call('updater/markNotesShown').catch(() => {});
}

function close(): void {
  visible.value = false;
}

/** 首查（幂等；在途/已完成直接返回；失败静默且可重入） */
async function ensureChecked(): Promise<void> {
  if (checked.value || checking) return;
  checking = true;
  try {
    const res = await call<ReleaseNotesPayload>('updater/getReleaseNotes');
    payload.value = res;
    checked.value = true;
    if (res.shouldShow) open();
  } catch {
    // 静默：core 未装配/旧版主进程等；checked 不置位，下次入口（关于页打开）重试
  } finally {
    checking = false;
  }
}

export function useWhatsNew() {
  return { payload, visible, available, notesHtml, ensureChecked, open, close };
}
