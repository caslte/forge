<script setup lang="ts">
/**
 * CE-S11 提交详情（右栏）。
 *
 * 为什么落在右栏而不是左栏：提交详情含逐文件并排 diff，左栏 292px 放不下
 * 对照阅读（PRD 12 §3.7）。左栏只发「选中哪条 sha」，取数由本组件自持——
 * 避免同一份数据被两个组件各拉一遍。
 *
 * **两级取数**（AC-CE-037）：进入只取 meta+numstat（列表立刻可见），
 * 单个文件的 patch 展开时才取。理由与实测数据见 composables/useGitHistory.ts。
 */
import { computed, ref, watch } from 'vue';
import { createGitHistoryLoader, type CommitFileStat } from '../composables/useGitHistory.ts';
import { avatarOf, absoluteTimeOf, relativeTimeSpec } from '../utils/gitHistory.ts';
import { parseGitUnifiedDiff } from '../utils/gitDiffRows.ts';
import type { SideBySideRow } from '@forge/core/side-by-side-diff';
import { detectDiffLanguage, highlightDiffLine } from '@forge/core/side-by-side-diff';
import { useI18n } from '../i18n/index.ts';

const props = defineProps<{
  projectPath: string;
  /** 当前选中的提交 sha；null = 未选中 */
  sha: string | null;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

const loader = createGitHistoryLoader();
const now = ref(Math.floor(Date.now() / 1000)); // epoch **秒**（契约口径）

/** 相对时间走 t()：utils/gitHistory 只给 i18n key，成串会把语言写死（AC-CE-031）。 */
function relativeLabel(authoredAt: number): string {
  const spec = relativeTimeSpec(authoredAt, now.value);
  return t(spec.key, spec.params);
}
const copied = ref(false);

loader.setProject(props.projectPath);

// sha 变 → 拉详情。这是唯一的取数入口：**只取 meta+numstat，不取 patch**。
// 少了这一步会渲染出一个永远停在「正在读取」的壳（e2e E-CE-33 第一个抓到的就是它）。
watch(
  () => props.sha,
  async (sha) => {
    if (sha === null) {
      loader.reset();
      tick.value++;
      return;
    }
    loader.setProject(props.projectPath);
    await loader.selectCommit(sha);
    tick.value++;
  },
  { immediate: true },
);

/** 响应式绞链：loader 内部是**普通闭包变量**（为了能在 node:test 里直接驱动、
 *  不给纯逻辑层引入 Vue 依赖），computed 追踪不到它。每做完一次操作手动 bump，
 *  让依赖它的 computed 重新求值——不接这根线就会出现「详情已取到但界面停在加载态」。 */
const tick = ref(0);

const detail = computed(() => (tick.value, loader.detail()));
const state = computed(() => (tick.value, loader.detailState()));

const avatar = computed(() =>
  detail.value
    ? avatarOf(detail.value.authorName, detail.value.authorEmail)
    : { initial: '', hue: 0 },
);

const files = computed<CommitFileStat[]>(() => (tick.value, loader.detail()?.files ?? []));

/** 大 diff 初始渲染行数上限（沿用 DiffView.INITIAL_ROWS 的既有口径） */
const MAX_ROWS = 200;
const expandedAll = ref<Record<string, boolean>>({});

// 文件块**默认全部折叠**：一个提交动辄十几个文件，全展开会把右栏撑成一片色块，
// 也把「哪几个文件改了」这个一眼可扫的信息埋掉。要看哪个点哪个。

/** 单个文件展开后的归一化视图（模板不写类型断言——Vue 模板表达式不认 `as`） */
type FileView =
  | { kind: 'collapsed' }
  | { kind: 'loading' }
  | { kind: 'fail' }
  | { kind: 'binary' }
  | { kind: 'noline' }
  | { kind: 'ready'; rows: SideBySideRow[]; total: number };
type HighlightedRow = { left: { line: number; type: string; html: string } | null; right: { line: number; type: string; html: string } | null };

/** 展开态：**必须经由这个函数读**，不能直接 `loader.isFileExpanded()`。
 *
 *  Vue 是依赖收集式的：展开态原先只在 `viewOf()` 里读，而那个函数位于
 *  `v-if="isFileExpanded"` 的**未成立分支**内 —— 初始渲染压根没执行到，
 *  于是渲染 effect 从未注册 tick 依赖，bump 之后不重渲染，展开看起来「点了没反应」。
 *  在无条件执行的 aria-expanded 上读一下，依赖就接上了。 */
function isExpanded(path: string): boolean {
  void tick.value;
  return loader.isFileExpanded(path);
}

/** 带高亮的并排行：按文件扩展名分派语言，与 DiffView / CodeViewer 同一套
 *  `detectDiffLanguage` + `highlightDiffLine`。不这么做提交详情就是一片纯文本，
 *  与项目里已有的 diff 视图（并排/行内）观感割裂。 */
function highlightRows(rows: SideBySideRow[], filePath: string) {
  const language = detectDiffLanguage(filePath);
  return rows.map((row) => ({
    left: row.left
      ? { ...row.left, html: highlightDiffLine(row.left.text, language) }
      : null,
    right: row.right
      ? { ...row.right, html: highlightDiffLine(row.right.text, language) }
      : null,
  }));
}

function fileView(file: CommitFileStat): FileView {
  // 先读 tick 建立依赖：展开态与 diff 缓存都存在 loader 的闭包里
  void tick.value;
  if (!loader.isFileExpanded(file.path)) return { kind: 'collapsed' };
  const st = loader.fileState(file.path);
  if (st === 'loading') return { kind: 'loading' };
  if (st === 'fail') return { kind: 'fail' };
  const diff = loader.fileDiff(file.path);
  // null = 二进制（git 不产出可读 patch）；与「无行级变化」（空串）严格区分
  if (diff === null) return { kind: 'binary' };
  const parsed = parseGitUnifiedDiff(diff);
  if (parsed.binary) return { kind: 'binary' };
  if (parsed.rows.length === 0) return { kind: 'noline' };
  const total = parsed.rows.length;
  const rows = expandedAll.value[file.path] ? parsed.rows : parsed.rows.slice(0, MAX_ROWS);
  return { kind: 'ready', rows, total };
}
function viewOf(file: CommitFileStat): FileView {
  return fileView(file);
}

/** 模板只调这两个窄化函数——Vue 模板表达式不认 `as` 断言 */
function rowsFor(file: CommitFileStat): SideBySideRow[] {
  const v = fileView(file);
  return v.kind === 'ready' ? v.rows : [];
}
function highlightedFor(file: CommitFileStat): HighlightedRow[] {
  const v = fileView(file);
  return v.kind === 'ready' ? highlightRows(v.rows, file.path) : [];
}
function totalFor(file: CommitFileStat): number {
  const v = fileView(file);
  return v.kind === 'ready' ? v.total : 0;
}

function onToggleFile(file: CommitFileStat) {
  if (isExpanded(file.path)) {
    loader.collapseFile(file.path);
    tick.value++;
  } else {
    void loader.expandFile(file.path).then(() => {
      tick.value++;
    });
  }
}

async function copySha(sha: string) {
  try {
    await navigator.clipboard.writeText(sha);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  } catch {
    // 剪贴板不可用（非安全上下文）时静默：复制是可选项，不该弹错打断
  }
}

const bodyOpen = ref(false);
const BODY_CLAMP_LINES = 6;

/** 提交正文很长（PRD/提交说明动辄十几行），全量展开会把整个右栏占满，
 *  把「改了哪几个文件」这个一眼可扫的信息挤到屏外。默认只给开头几行 + 展开入口。 */
const bodyIsLong = computed(() => (detail.value?.body ?? '').split('\n').length > BODY_CLAMP_LINES);

function close() {
  emit('close');
}
</script>

<template>
  <section class="cd">
    <!-- 未选中：空态（不是「请选择文件」那种死提示，明确告诉用户下一步做什么） -->
    <div v-if="sha === null" class="cd-empty">
      <p class="cd-empty-title">{{ t('code.pickCommitTitle') }}</p>
      <p class="cd-empty-hint">{{ t('code.pickCommitHint') }}</p>
    </div>

    <template v-else>
      <header class="cd-head">
        <div class="cd-top">
          <h2 class="cd-subject">{{ detail?.subject ?? t('code.historyLoading') }}</h2>
          <button
            v-if="detail"
            class="cd-btn"
            type="button"
            :title="t('code.historyCommitSha')"
            @click="copySha(detail.sha)"
          >{{ copied ? t('code.historyShaCopied') : t('code.historyCommitSha') }}</button>
          <button class="cd-btn cd-btn-icon" type="button" :title="t('code.noFile')" @click="close">×</button>
        </div>

        <div v-if="detail" class="cd-who">
          <span
            class="cd-av"
            :style="{ background: `oklch(0.62 0.13 ${avatar.hue})` }"
            aria-hidden="true"
          >{{ avatar.initial }}</span>
          <div class="cd-who-main">
            <div class="cd-name">{{ detail.authorName }}</div>
            <div class="cd-mail">&lt;{{ detail.authorEmail }}&gt;</div>
            <div class="cd-when">
              {{ absoluteTimeOf(detail.authoredAt) }} · {{ relativeLabel(detail.authoredAt) }}
              <span v-if="detail.isMerge" class="cd-tag">{{ t('code.historyMergeTag') }}</span>
              <span v-else-if="detail.isRoot" class="cd-tag">{{ t('code.historyFirstCommitTag') }}</span>
            </div>
          </div>
          <span class="cd-sha">{{ detail.shortSha }}</span>
        </div>

        <div v-if="detail?.body" class="cd-body-wrap">
          <p class="cd-body" :class="{ 'is-clamped': bodyIsLong && !bodyOpen }">{{ detail.body }}</p>
          <button
            v-if="bodyIsLong"
            class="cd-body-toggle"
            type="button"
            :aria-expanded="bodyOpen"
            @click="bodyOpen = !bodyOpen"
          >{{ bodyOpen ? t('tool.diffCollapseTo', { n: BODY_CLAMP_LINES }) : t('code.historyExpandBody') }}</button>
        </div>
      </header>

      <div class="cd-scroll">
        <p v-if="state === 'fail'" class="cd-note">{{ t('code.historyDiffFail') }}</p>
        <p v-else-if="files.length === 0" class="cd-note">{{ t('code.historyNoFiles') }}</p>
        <p v-else class="cd-count">{{ t('code.historyFilesTitle', { n: files.length }) }}</p>

        <div v-for="f in files" :key="f.path" class="cd-file">
          <button
            class="cd-file-head"
            type="button"
            :aria-expanded="isExpanded(f.path)"
            @click="onToggleFile(f)"
          >
            <span class="cd-caret" :class="{ 'is-open': isExpanded(f.path) }" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </span>
            <span class="cd-kind" :data-k="f.status">{{ f.status }}</span>
            <span class="cd-path" :title="f.oldPath ? `${f.oldPath} → ${f.path}` : f.path">{{ f.path }}</span>
            <span v-if="f.oldPath" class="cd-oldpath" :title="t('code.historyNoLineChange')">↔</span>
            <span class="cd-stat">
              <span v-if="f.binary" class="cd-stat-bin">{{ t('code.historyBinaryFile') }}</span>
              <template v-else><span class="cd-add">+{{ f.additions }}</span> <span class="cd-del">−{{ f.deletions }}</span></template>
            </span>
          </button>

          <!-- 只有展开才渲染正文：未展开时 patch 根本还没取 -->
          <div v-if="isExpanded(f.path)" class="cd-file-body">
            <p v-if="viewOf(f).kind === 'loading'" class="cd-note">{{ t('code.historyLoading') }}</p>
            <p v-else-if="viewOf(f).kind === 'fail'" class="cd-note">{{ t('code.historyDiffFail') }}</p>
            <div v-else-if="viewOf(f).kind === 'binary'" class="cd-note">
              {{ t('code.historyBinaryFile') }}<br /><span class="cd-note-hint">{{ t('code.historyBinaryHint') }}</span>
            </div>
            <p v-else-if="viewOf(f).kind === 'noline'" class="cd-note">{{ t('code.historyNoLineChange') }}</p>
            <template v-else-if="viewOf(f).kind === 'ready'">
              <div class="cd-diff">
                <div v-for="(row, i) in highlightedFor(f)" :key="i" class="cd-drow">
                  <span class="cd-dnum">{{ row.left ? row.left.line : '' }}</span>
                  <span class="cd-dcell" :class="row.left ? 'cell-' + row.left.type : 'cell-empty'"><span v-html="row.left ? row.left.html : ''"></span></span>
                  <span class="cd-dnum">{{ row.right ? row.right.line : '' }}</span>
                  <span class="cd-dcell" :class="row.right ? 'cell-' + row.right.type : 'cell-empty'"><span v-html="row.right ? row.right.html : ''"></span></span>
                </div>
              </div>
              <button
                v-if="totalFor(f) > 200"
                class="cd-expand"
                type="button"
                @click="expandedAll[f.path] = !expandedAll[f.path]"
              >{{ expandedAll[f.path] ? t('tool.diffCollapseTo', { n: 200 }) : t('tool.diffExpandAll', { n: totalFor(f) }) }}</button>
            </template>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cd {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background);
}
.cd-empty {
  flex: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  padding: 40px;
  text-align: center;
}
.cd-empty-title { font-size: 13.5px; color: var(--foreground); }
.cd-empty-hint { font-size: 12px; color: var(--muted-foreground); }

.cd-head { flex: none; padding: 14px 20px 13px; border-bottom: 1px solid var(--border); }
.cd-top { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.cd-subject { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.cd-btn {
  flex: none; display: inline-flex; align-items: center;
  padding: 4px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); color: var(--muted-foreground);
  font: inherit; font-size: 11.5px; cursor: pointer; transition: var(--transition-fast);
}
.cd-btn:hover { color: var(--foreground); border-color: color-mix(in oklab, var(--foreground) 22%, transparent); }
.cd-btn-icon { padding: 4px 8px; font-size: 14px; line-height: 1; }

.cd-who { display: flex; align-items: flex-start; gap: 10px; }
.cd-av {
  width: 30px; height: 30px; flex: none; border-radius: 999px;
  display: grid; place-items: center;
  font-size: 12px; font-weight: 600; line-height: 1; color: oklch(0.99 0 0);
  user-select: none;
}
.cd-who-main { flex: 1; min-width: 0; }
.cd-name { font-size: 12.5px; font-weight: 500; }
.cd-mail { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted-foreground); margin-top: 1px; }
.cd-when { font-size: 11.5px; color: var(--muted-foreground); margin-top: 3px; display: flex; align-items: center; gap: 6px; }
.cd-tag {
  font-size: 9.5px; font-weight: 600; line-height: 1; padding: 2.5px 5px; border-radius: 999px;
  background: color-mix(in oklab, var(--warning) 20%, transparent);
  color: color-mix(in oklab, var(--warning) 90%, var(--foreground));
}
.cd-sha {
  flex: none; font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground);
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px 7px;
}
.cd-body-wrap { margin-top: 11px; }
.cd-body {
  font-size: 12.5px; line-height: 1.6; color: var(--foreground);
  white-space: pre-wrap; word-break: break-word;
}
/* 钳到前几行：用 -webkit-line-clamp 而不是 max-height——后者会把
   「第几行被截断」交给盒模型，字号/行高一变就多露或少露一行。 */
.cd-body.is-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cd-body-toggle {
  margin-top: 6px; padding: 2px 0;
  border: 0; background: transparent;
  color: var(--muted-foreground);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.cd-body-toggle:hover { color: var(--foreground); }

.cd-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.cd-count, .cd-note { padding: 10px 20px; font-size: 11.5px; color: var(--muted-foreground); }
.cd-note { text-align: center; padding: 24px 20px; }
.cd-note-hint { opacity: .75; }

.cd-file { border-bottom: 1px solid var(--border); }
.cd-file-head {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 9px 20px; border: 0; background: color-mix(in oklab, var(--muted) 55%, transparent);
  font: inherit; font-size: 12px; color: inherit; text-align: left; cursor: pointer;
  transition: var(--transition-fast);
}
.cd-file-head:hover { background: var(--muted); }
.cd-caret { flex: none; display: grid; place-items: center; color: var(--muted-foreground); transition: var(--transition-fast); }
.cd-caret svg { width: 11px; height: 11px; }
.cd-caret.is-open { transform: rotate(90deg); }
.cd-kind {
  flex: none; width: 15px; height: 15px; border-radius: 3px;
  display: grid; place-items: center;
  font-family: var(--font-mono); font-size: 9.5px; font-weight: 700;
}
.cd-kind[data-k='A'] { background: color-mix(in oklab, var(--success) 22%, transparent); color: color-mix(in oklab, var(--success) 90%, var(--foreground)); }
.cd-kind[data-k='M'] { background: color-mix(in oklab, var(--warning) 22%, transparent); color: color-mix(in oklab, var(--warning) 90%, var(--foreground)); }
.cd-kind[data-k='D'] { background: color-mix(in oklab, var(--destructive) 20%, transparent); color: color-mix(in oklab, var(--destructive) 90%, var(--foreground)); }
.cd-kind[data-k='R'], .cd-kind[data-k='C'] { background: color-mix(in oklab, var(--brand) 20%, transparent); color: var(--foreground); }
.cd-path {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cd-oldpath { flex: none; font-size: 11px; color: var(--muted-foreground); }
.cd-stat { flex: none; font-family: var(--font-mono); font-size: 10.5px; }
.cd-add { color: var(--success); }
.cd-del { color: var(--destructive); }
.cd-stat-bin { color: var(--muted-foreground); font-size: 10px; }

.cd-file-body { padding-bottom: 6px; }
.cd-diff { font-family: var(--font-mono); font-size: 11px; line-height: 1.55; overflow-x: auto; }
.cd-drow { display: grid; grid-template-columns: 44px minmax(0,1fr) 44px minmax(0,1fr); min-width: 620px; }
.cd-dnum {
  text-align: right; padding: 0 7px; font-size: 10px; color: var(--muted-foreground);
  background: color-mix(in oklab, var(--muted) 45%, transparent);
  border-right: 1px solid var(--border); user-select: none;
}
.cd-dcell {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-all;
  border-right: 1px solid var(--border);
  /* 增删行只染背景**不强制字色**——语法 token 自己的颜色要能透出来；
     字色给 --foreground，否则高亮 HTML 落在深底上会看不清。 */
  color: var(--foreground);
}
.cd-drow:last-child .cd-dcell { border-right: 0; }
/* 类名必须对上 SideBySideCell.type 的真值（'equal' | 'removed' | 'added'）。
   早先写成 is-add/is-del/is-empty，结果三个都匹配不上 —— 背景一条没生效，
   深底上就是一片黑。值与 alpha 直接抄 DiffView，保持两处观感一致。 */
.cd-dcell.cell-equal { background: transparent; }
.cd-dcell.cell-removed { background: color-mix(in oklab, var(--destructive) 12%, transparent); }
.cd-dcell.cell-added { background: color-mix(in oklab, var(--success) 10%, transparent); }
.cd-dcell.cell-empty { background: var(--muted); }
.cd-expand {
  display: block; width: calc(100% - 40px); margin: 8px 20px 0; padding: 5px 0;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); color: var(--muted-foreground);
  font: inherit; font-size: 11px; cursor: pointer;
}
.cd-expand:hover { color: var(--foreground); }
</style>