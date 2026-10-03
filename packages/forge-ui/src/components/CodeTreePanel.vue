<script setup lang="ts">
/**
 * 内置代码树（模块 12 CE-S01 ~ CE-S07）。
 *
 * 与项目树并列而非嵌套：两者是「同一位置的两个视图」，靠 v-if 互斥切换。
 * 因此这里不接管 ProjectTree 的展开态，反过来 ProjectTree 也不会被销毁——
 * 退出代码态后展开/选中/滚动全部原样保留（这是「整栏替换」方案的核心收益）。
 *
 * 树的渲染是「已加载层 + 懒加载占位」的混合结构：某层没拉过数据就只渲染一行
 * 展开箭头占位，点开时才 listDir。这样项目根再大也只发一次请求。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useCodeExplorer, type ProjectCodeState, type TreeRow } from '../composables/useCodeExplorer';
import { fileBadgeOf } from '../utils/fileBadge';
import { absoluteFilePath, dirOf } from '../utils/pathSegments';
import { hasBrowserOpenableExt } from '../utils/browserOpen';
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue';
import type { GitStatusFile } from '../types';
import type { CodeViewerLayout } from '../composables/usePreferences';
import { useI18n } from '../i18n/index.ts';

const props = defineProps<{
  /** 当前项目绝对路径（所有寻址都以它为根，组件自己绝不拼绝对路径） */
  projectPath: string;
  projectName: string;
  /** 偏好是左右分割、但窗口窄到只能临时改用整屏（CE-S04）。只影响本次渲染，不改偏好。 */
  degraded?: boolean;
  /**
   * 当前布局**偏好**（注意不是本次生效的那个：窄窗降级时两者会不一致）。
   * 顶栏那个切换按钮的图标与选中态靠它渲染，App.vue 传的是同一个 ref，
   * 所以不需要组件自己再存一份 —— 两份状态迟早会不同步。
   */
  layout?: CodeViewerLayout;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'toggle-layout'): void;
}>();

const { t } = useI18n();
const { getState, loadDir, toggleDir, openFile, search, loadGitStatus } = useCodeExplorer();

/** 扁平化后的可见行（把 children 树拍平成带 depth 的线性列表） */
interface FlatRow {
  row: TreeRow;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

const gitFiles = ref<Map<string, GitStatusFile>>(new Map());
const rootLoaded = ref(false);
const searchInput = ref<'' | string>('');

/** 读项目级状态；shallow 内部按项目隔离，切项目自动换一份 */
const state = computed<ProjectCodeState>(() => getState(props.projectPath));
const expanded = computed(() => state.value.expanded);
const children = computed(() => state.value.children);
const activeRel = computed(() => state.value.activeRel);
const searchResults = computed(() => state.value.searchResults);

/**
 * 「最近打开」分组：本次会话已打开过的文件，最新的在前。
 * 读的是 `history`（打开历史），**不是** `openFiles`（标签页列表）。两者刻意解耦：
 * 关掉标签页只是不再显示那个签，历史里依然留着，再点一下就重新打开。否则这个分组
 * 只是标签页的影子，“刚看过但已经关掉”的文件就再也找不回来了。
 *
 * 上限 5 个（.slice(0, RECENT_LIMIT)）：这是一个**导航**分组，一个会话里能翻到的
 * 「刚才在看的那个」通常就在最近几个里；一旦不管它，这个分组会随会话单调变长，
 * 把整棵树顶下去，真要跳的文件被挤出视野。存储侧另有 HISTORY_LIMIT 上限兜底。
 * 头部插入意味着打开第 6 个文件自动把最旧的挤出去，不需要额外维护顺序。
 */
const RECENT_LIMIT = 5;
// 「最近打开」分组暂时隐藏（用处不大）；分组渲染与 e2e 用例都还留着，
// 要恢复把它翻回 true 即可。
const SHOW_RECENT_GROUP = false;
const recentFiles = computed(() =>
  state.value.history.slice(0, RECENT_LIMIT).map((relPath) => ({
    relPath,
    // 名字从 relPath 现算而不另存：文件被重命名后历史不会留下一个指向旧名的死条目
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
  })),
);

/** 树可见行；过滤态下改为「结果列表」而不是过滤后的树（树的祖先链会很难解释） */
const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = [];
  const walk = (relPath: string, depth: number): void => {
    const kids = children.value.get(relPath);
    if (!kids) return;
    for (const row of kids) {
      const isDir = row.kind === 'dir';
      const ex = isDir && expanded.value.has(row.relPath);
      out.push({ row, depth, expanded: ex, loading: row.loading });
      if (ex) walk(row.relPath, depth + 1);
    }
  };
  walk('', 0);
  return out;
});

/** 过滤态下展示的扁平文件列表（每个文件一条，可直接展开祖先） */
const filteredRows = computed<FlatRow[]>(() =>
  (searchResults.value ?? []).map((p) => ({
    row: {
      name: p.slice(p.lastIndexOf('/') + 1),
      relPath: p,
      kind: 'file' as const,
      size: 0,
      mtimeMs: 0,
      loading: false,
      error: null,
    },
    depth: 0,
    expanded: false,
    loading: false,
  })),
);

/** 是否显示搜索结果而不是树 */
const isFiltering = computed(() => searchResults.value !== null);

/** 树是否真的空：根已加载、且一层都没有（隐藏项另计） */
const isTreeEmpty = computed(
  () => rootLoaded.value && (children.value.get('')?.length ?? 0) === 0,
);

const visibleCount = computed(() =>
  isFiltering.value ? filteredRows.value.length : flatRows.value.length,
);

/** 目录行的 Git 徽标：任一子文件变更就标（不用递归——大目录会拖慢展开） */
function dirBadge(relPath: string): GitStatusFile['status'] | null {
  if (gitFiles.value.size === 0) return null;
  const prefix = `${relPath}/`;
  let seen = false;
  for (const f of gitFiles.value.values()) {
    if (!f.path.startsWith(prefix)) continue;
    if (f.status === 'U') return 'U';
    if (!seen) {
      seen = true;
    } else {
      return 'M';
    }
  }
  return seen ? 'M' : null;
}

/** 某文件/目录行的完整 Git 状态（供 title 用） */
function gitOf(relPath: string): GitStatusFile | null {
  return gitFiles.value.get(relPath) ?? null;
}

async function refreshGit(): Promise<void> {
  const files = await loadGitStatus(props.projectPath);
  gitFiles.value = new Map(files.map((f) => [f.path, f]));
}

// 切项目：重置根加载标记 + 拉根 + 拉 Git 状态
watch(
  () => props.projectPath,
  async (p) => {
    rootLoaded.value = false;
    searchInput.value = '';
    const res = await loadDir(p, '');
    rootLoaded.value = res.ok;
    void refreshGit();
  },
  { immediate: true },
);

async function onToggleDir(row: TreeRow): Promise<void> {
  if (row.kind !== 'dir') return;
  // loading 反馈由 composable 内部状态驱动（children 到位即重渲染），
  // 这里不做任何本地标记——改缓存对象会绕过 shallowRef，UI 根本不会更新。
  await toggleDir(props.projectPath, row.relPath);
}

function onClickRow(row: TreeRow): void {
  if (row.kind === 'dir') {
    void onToggleDir(row);
  } else {
    void openFile(props.projectPath, row.relPath, row.name);
  }
}

/** 过滤态点结果：自动补齐祖先目录的展开态，否则点开后「树」和「结果」对不上 */
async function onPickFiltered(relPath: string): Promise<void> {
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    const st = getState(props.projectPath);
    if (!st.expanded.has(dir)) {
      const res = await loadDir(props.projectPath, dir);
      if (!res.ok) break;
      // 补展开：直接改 Set 不走 toggleDir（它会再次加载）
      st.expanded.add(dir);
    }
  }
  await openFile(props.projectPath, relPath, relPath.slice(relPath.lastIndexOf('/') + 1));
  // 结果与树两套呈现会让人困惑：打开后回到树
  await search(props.projectPath, '');
  searchInput.value = '';
}

/** 最近打开项点击：切到那个文件（不退出分组，位置就是“回去”的意思）。
 *  展开祖先目录也一并补上：跳到深处的文件重新打开时，树上应该能看到它。 */
async function onPickRecent(relPath: string): Promise<void> {
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    const st = getState(props.projectPath);
    if (!st.expanded.has(dir)) {
      const res = await loadDir(props.projectPath, dir);
      if (!res.ok) break;
      st.expanded.add(dir);
    }
  }
  await openFile(props.projectPath, relPath, relPath.slice(relPath.lastIndexOf('/') + 1));
}

/** 右键菜单：目标行（null = 收起）+ 视口坐标。
 *  不做「右键先选中」：行的高亮与菜单目标分离反而更清楚（菜单项写的是动作，不是选中）。 */
const ctxTarget = ref<{ relPath: string; kind: 'file' | 'dir' } | null>(null);
const ctxX = ref(0);
const ctxY = ref(0);

function onRowContextMenu(ev: MouseEvent, relPath: string, kind: 'file' | 'dir'): void {
  ev.preventDefault();
  ctxTarget.value = { relPath, kind };
  ctxX.value = ev.clientX;
  ctxY.value = ev.clientY;
  // 每次右键都后台刷新一次编辑器列表：装了/卸了编辑器不用重启应用。
  // 当前菜单用上次的结果渲染（列表为空时是置灰提示），下一帧到的刷新下一次右键生效。
  void refreshEditors();
}

function closeContextMenu(): void {
  ctxTarget.value = null;
}

const ICON_FOLDER = 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z';
const ICON_GLOBE =
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20';
const ICON_EDITOR = 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 9l-3 3 3 3M16 9l3 3-3 3';
const ICON_COPY = 'M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1';

/**
 * 已安装的外部编辑器（主进程扫描：白名单 + PATH/常见安装路径，见 shell/editorScan.ts）。
 * 懒加载：首次右键/挂载时拉一次，之后每次右键后台刷新。
 */
const installedEditors = ref<{ id: string; label: string }[]>([]);

async function refreshEditors(): Promise<void> {
  try {
    installedEditors.value = await window.forge.shell.listEditors();
  } catch (e) {
    console.warn('[code-tree] listEditors 失败，右键菜单将显示置灰提示', e);
    installedEditors.value = [];
  }
}

/**
 * 菜单项。目录行与文件行不同：
 *  - 通用：「复制路径」（文件=文件本体，目录=目录本体，都是绝对路径）
 *  - 目录：打开**它自己**（与项目树「打开项目所在目录」同口径，都是系统文件管理器）
 *  - 文件：打开**父目录**；.html/.htm 多一项「用浏览器打开」；
 *    另按扫描结果给每个编辑器一项「用 VS Code 打开 / 用 Cursor 打开 / …」，
 *    一个都没装时保留一条置灰提示（解释为什么没有「用 … 打开」）。
 */
const ctxItems = computed<ContextMenuItem[]>(() => {
  const tgt = ctxTarget.value;
  if (!tgt) return [];
  const items: ContextMenuItem[] = [];
  if (tgt.kind === 'file') {
    if (hasBrowserOpenableExt(tgt.relPath)) {
      items.push({ key: 'browser', label: t('tool.openInBrowser'), icon: ICON_GLOBE });
    }
    if (installedEditors.value.length > 0) {
      for (const ed of installedEditors.value) {
        items.push({
          key: `editor:${ed.id}`,
          label: t('tool.openInEditorWith', { name: ed.label }),
          icon: ICON_EDITOR,
        });
      }
    } else {
      items.push({ key: 'editor-none', label: t('tool.openInEditorNone'), icon: ICON_EDITOR, disabled: true });
    }
  }
  items.push({ key: 'copy-path', label: t('tool.copyPath'), icon: ICON_COPY });
  items.push({
    key: 'dir',
    label: tgt.kind === 'dir' ? t('tool.openThisFolder') : t('tool.openContainingDir'),
    icon: ICON_FOLDER,
  });
  return items;
});

function onContextMenuSelect(key: string): void {
  const tgt = ctxTarget.value;
  closeContextMenu();
  if (!tgt) return;
  const abs = absoluteFilePath(props.projectPath, tgt.relPath);
  if (key === 'browser') return void window.forge.shell.openInBrowser(abs);
  if (key.startsWith('editor:')) {
    return void window.forge.shell.openInEditor(abs, key.slice('editor:'.length)).then((ok) => {
      if (!ok) console.warn('[code-tree] openInEditor 失败：', abs, key.slice('editor:'.length));
    });
  }
  if (key === 'copy-path') {
    // 与选区复制浮窗同通道（navigator.clipboard）；写失败静默——菜单动作不该弹错误
    return void navigator.clipboard.writeText(abs).catch(() => {});
  }
  if (key === 'dir') {
    // 目录行开它自己，文件行开父目录
    return void window.forge.shell.openPath(tgt.kind === 'dir' ? abs : dirOf(abs));
  }
}

/** 挂载时先扫一次：第一次右键菜单就能出分项，不用等到第二次 */
onMounted(() => {
  void refreshEditors();
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
function onFilterInput(v: string): void {
  searchInput.value = v as '' | string;
  if (searchTimer) clearTimeout(searchTimer);
  // 250ms 去抖：主进程那边要真扫盘，逐键发请求会在大仓库上打满 IPC
  searchTimer = setTimeout(() => {
    void search(props.projectPath, searchInput.value);
  }, 250);
}

function clearFilter(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchInput.value = '';
  void search(props.projectPath, '');
}

/** Esc 逐级退出：过滤框里有字先清过滤，空了才让事件冒去 App 关文件/退代码态 */
function onFilterEsc(e: KeyboardEvent): void {
  if (searchInput.value !== '') {
    clearFilter();
    e.stopPropagation();
  }
}

</script>

<template>
  <div class="ctp">
    <!-- 顶栏：返回 + 项目名 + 布局切换 -->
    <header class="ctp-head">
      <button class="ctp-back" type="button" :title="t('code.backToProjects')" @click="emit('back')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        <span class="ctp-back-text">{{ t('code.backToProjects') }}</span>
      </button>
      <span class="ctp-title" :title="projectName">{{ projectName }}</span>
      <!-- 窄窗徽标：解释「我明明选了分割，右侧怎么是满宽的」。title 挂整句，
           292px 的列里塞不下长文案，就不截断显示、只留一个可悬停的符号。 -->
      <span
        v-if="degraded"
        class="ctp-warn"
        role="status"
        :title="t('code.layoutDegraded')"
        :aria-label="t('code.layoutDegraded')"
      >⚠</span>
      <button
        class="ctp-icon"
        :class="{ 'is-split': layout === 'split' }"
        type="button"
        :title="t('settings.codeViewer.layout')"
        :aria-label="t('settings.codeViewer.layout')"
        :aria-pressed="layout === 'split'"
        @click="emit('toggle-layout')"
      >
        <!-- 图标画的是「点一下会变成的样子」，不是当前状态：图标随布局变形很容易
             看错（这正是之前那个「矩形+三根线」在 13px 下糊成一团的原因）。
             当前是分割时另给品牌色 + 浅底，状态和目标两处都不含糊。 -->
        <svg v-if="layout === 'cover'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M13 4v16" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <rect x="5.5" y="6.5" width="13" height="11" rx="1.2" />
        </svg>
      </button>
    </header>

    <!-- 过滤框 -->
    <div class="ctp-filter">
      <span class="ctp-filter-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </span>
      <input
        v-model="searchInput"
        class="ctp-filter-input"
        type="text"
        :placeholder="t('code.filterPlaceholder')"
        :title="t('code.filterHint')"
        spellcheck="false"
        @input="onFilterInput(($event.target as HTMLInputElement).value)"
        @keydown.esc="onFilterEsc"
      />
      <button
        v-if="searchInput !== ''"
        class="ctp-filter-clear"
        type="button"
        :title="t('code.filterClear')"
        :aria-label="t('code.filterClear')"
        @click="clearFilter"
      >
        ×
      </button>
    </div>

    <!-- 树 / 过滤结果 -->
    <div class="ctp-scroll">
      <!-- 过滤结果 -->
      <template v-if="isFiltering">
        <p v-if="state.searching" class="ctp-note">{{ t('code.filterSearching') }}</p>
        <p v-else-if="filteredRows.length === 0" class="ctp-note">{{ t('code.filterNone') }}</p>
        <p v-if="state.searchLimit" class="ctp-note ctp-note-warn">
          {{ t('code.filterTruncated', { n: filteredRows.length }) }}
        </p>
        <button
          v-for="r in filteredRows"
          :key="r.row.relPath"
          class="ctp-row"
          type="button"
          :class="{ 'is-active': r.row.relPath === activeRel }"
          @click="onPickFiltered(r.row.relPath)"
          @contextmenu.prevent="onRowContextMenu($event, r.row.relPath, r.row.kind)"
        >
          <span
            class="ctp-badge"
            :style="{ background: fileBadgeOf(r.row.name).bg, color: fileBadgeOf(r.row.name).fg }"
            aria-hidden="true"
          >{{ fileBadgeOf(r.row.name).label }}</span>
          <span class="ctp-name">{{ r.row.name }}</span>
          <span class="ctp-dir">{{ r.row.relPath.slice(0, r.row.relPath.length - r.row.name.length - 1) }}</span>
        </button>
      </template>

      <!-- 空态 -->
      <div v-else-if="isTreeEmpty" class="ctp-empty">
        <p class="ctp-empty-title">{{ t('code.treeEmpty') }}</p>
        <p class="ctp-empty-hint">{{ t('code.treeEmptyHint') }}</p>
      </div>

      <!-- 树 -->
      <template v-else>
        <!-- 最近打开：只看得到“树里已展开可见”的会漏掉跳转到深处的文件，
             所以这里列全部已打开项的上限 5 个（见 RECENT_LIMIT）。 -->
        <template v-if="SHOW_RECENT_GROUP && recentFiles.length > 0">
          <div class="ctp-group">{{ t('code.groupRecent') }}</div>
          <button
            v-for="f in recentFiles"
            :key="'recent:' + f.relPath"
            class="ctp-row is-recent"
            :class="{ 'is-active': f.relPath === activeRel }"
            type="button"
            :title="f.relPath"
            @click="onPickRecent(f.relPath)"
            @contextmenu.prevent="onRowContextMenu($event, f.relPath, 'file')"
          >
            <span
              class="ctp-badge"
              :style="{ background: fileBadgeOf(f.name).bg, color: fileBadgeOf(f.name).fg }"
              aria-hidden="true"
            >{{ fileBadgeOf(f.name).label }}</span>
            <span class="ctp-name">{{ f.name }}</span>
          </button>
        </template>

        <div class="ctp-group">{{ t('code.groupFiles') }}</div>
        <div
          v-for="r in flatRows"
          :key="r.row.relPath"
          class="ctp-row"
          :class="{
            'is-dir': r.row.kind === 'dir',
            'is-open': r.expanded,
            'is-active': r.row.kind === 'file' && r.row.relPath === activeRel,
          }"
          :style="{ paddingLeft: `${6 + r.depth * 14}px` }"
          role="treeitem"
          :aria-expanded="r.row.kind === 'dir' ? r.expanded : undefined"
          tabindex="-1"
          @click="onClickRow(r.row)"
          @keydown.enter.prevent="onClickRow(r.row)"
          @contextmenu.prevent="onRowContextMenu($event, r.row.relPath, r.row.kind)"
        >
          <template v-if="r.row.kind === 'dir'">
            <span class="ctp-caret" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
            </span>
            <span class="ctp-dir-icon" :title="t('code.groupDirs')" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a1 1 0 0 0 .84.45H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </span>
          </template>
          <span
            v-else
            class="ctp-badge"
            :style="{ background: fileBadgeOf(r.row.name).bg, color: fileBadgeOf(r.row.name).fg }"
            :title="r.row.name.slice(r.row.name.lastIndexOf('.') + 1)"
            aria-hidden="true"
          >{{ fileBadgeOf(r.row.name).label }}</span>
          <span class="ctp-name">{{ r.row.name }}</span>
          <span
            v-if="r.row.kind === 'dir' ? dirBadge(r.row.relPath) : gitOf(r.row.relPath)?.status"
            class="ctp-git"
            :data-git="r.row.kind === 'dir' ? dirBadge(r.row.relPath) : gitOf(r.row.relPath)?.status"
            >{{ r.row.kind === 'dir' ? dirBadge(r.row.relPath) : gitOf(r.row.relPath)?.status }}</span
          >
        </div>
      </template>
    </div>

    <!-- 底栏：文件数 / 忽略数 -->
    <footer class="ctp-foot">
      <div class="ctp-stats">
        <span v-if="isFiltering" class="ctp-stat">{{ t('code.filterCount', { n: filteredRows.length }) }}</span>
        <span v-else-if="visibleCount > 0" class="ctp-stat">{{ t('code.treeItems', { n: visibleCount }) }}</span>
      </div>
    </footer>

    <!-- 行右键菜单：打开所在目录 / 用浏览器打开（HTML）/ 用 VS Code、Cursor、Zed… 打开（扫描结果分项，写代码的唯一入口） -->
    <ContextMenu
      v-if="ctxTarget"
      :x="ctxX"
      :y="ctxY"
      :items="ctxItems"
      :min-width="176"
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />
  </div>
</template>

<style scoped>
.ctp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  height: 100%;
  outline: none;
}

.ctp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
/* 返回项目：药丸 + 描边，而不是一串带箭头的文字。
   之前只留了 chevron + 12px 灰字，在 292px 的顶栏里它跟项目名是同一视觉重量，
   没人会把它当成“可点的导航”—— 回不去就只能去左栏重新找。 */
/* 返回项目：去掉边框和卡片底。
   这一行挤的根源不是控件多，而是**框多**：返回是带框药丸、旁边还有一个带框圆钮，
   292px 的列里两个带框物并排，中间还要插项目名，视觉上就变成“堆了三样东西”。
   只留 hover 时的浅底（Forge 里 .icon-btn / ghost 按钮的共同语汇），一行就松开了。 */
.ctp-back {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 26px;
  padding: 0 9px 0 7px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast, 120ms), background var(--transition-fast, 120ms);
}
.ctp-back:hover {
  color: var(--foreground);
  background: color-mix(in oklab, var(--foreground) 8%, transparent);
}
.ctp-back svg {
  width: 13px;
  height: 13px;
}
.ctp-title {
  flex: 1 1 auto;
  min-width: 0;
  /* 项目名用等宽体：仓库名本质是标识符而非单词，等宽体的字形骨架比无衬线
     “像技术标识”，且 12.5px 下仍读得清（原型同款）。
     字重 600 而非 500：它要跟下面的文件树抢第一眼，500 太轻会糊进工具栏。 */
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 窄窗降级徽标。挂 warning 色的 fg 而不是给整行上黄底：
   降级是**临时**状态，不是错误，行内大面积告警色会让人以为出了故障。 */
.ctp-warn {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 1;
  color: var(--warning);
  cursor: help;
}
/* 圆形图标按钮（原型 .icon-btn 规格）：24px 圆 + 15px 图标。
   圆形是这套按钮的共同语汇——顶栏里它和返回药丸并列时不会读成另一个控件。

   padding: 0 不能省：global.css 的 `button { padding: 6px 14px }` 会漏进来，
   24px 宽减去 28px 横向 padding，内容盒被挤成 0，图标就溢出裁切成“变形”的一团。
   凡是**固定宽高**的 button 都要显式 padding: 0。 */
.ctp-icon {
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: color var(--transition-fast, 120ms), background var(--transition-fast, 120ms);
}
.ctp-icon svg {
  width: 15px;
  height: 15px;
}
.ctp-icon:hover {
  background: var(--surface-hover);
  color: var(--foreground);
}
/* 当前偏好为分割：挂品牌色，让“现在是哪种布局”不用点一下才知道 */
.ctp-icon.is-split {
  color: var(--brand-accent);
  background: color-mix(in oklab, var(--brand-accent) 10%, transparent);
}

.ctp-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.ctp-filter-icon {
  color: var(--muted-foreground);
  width: 13px;
  height: 13px;
  flex: none;
  display: grid;
  place-items: center;
}
.ctp-filter-icon svg {
  width: 13px;
  height: 13px;
}
.ctp-filter-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--foreground);
  font-size: 12.5px;
  outline: none;
}
.ctp-filter-input::placeholder {
  color: var(--muted-foreground);
}
.ctp-filter-clear {
  flex: none;
  width: 18px;
  height: 18px;
  /* 同 .ctp-icon：固定尺寸的按钮必须自己清掉全局 button 的 padding */
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.ctp-filter-clear:hover {
  background: var(--surface-hover);
  color: var(--foreground);
}

.ctp-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 6px;
  /* 进入代码态时整棵树从左轻推入位（demo：slide-in） */
  animation: ctp-slide-in 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes ctp-slide-in {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.ctp-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 26px;
  padding: 0 8px 0 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--foreground);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
  user-select: none;
  transition: background var(--transition-fast, 120ms);
}
.ctp-row:hover {
  background: var(--surface-hover);
}
/* 分组标题：等宽 + 字距 .06em + 大写。中文没有大写形变，但拉丁文件名多时
   （README / LICENSE 一组）大写能明显压低一档，形成“分组 → 条目”的层次。 */
/* 分组标签（最近打开 / 文件）。
 *
 * 字体统一到 **无衬线 12px**，与顶栏的「返回项目」完全同档。
 * 之前这里是 mono 10.5 + uppercase，于是左栏里同时存在四种排版：
 * mono 10.5 标签、sans 12 返回、mono 12.5/600 项目名、sans 12.5 文件名——
 * 两个字体族交错、三个字号，300px 宽的列里读起来像拼了三个界面。
 *
 * 分组层级不再靠「换字体 + 缩小」堆叠（中文本就没大小写，uppercase 是空转），
 * 而是：同族同号，靠 500 字重 + muted 色 + 上方 10px 留白区分。
 * 头部 mono 的项目名保留：它是一个标识符，不是标签，原型同款。 */
.ctp-group {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 4px;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  user-select: none;
}
/* 选中文件：品牌青瓷绿淡染，而不是灰底加粗——「正在读哪个文件」要一眼可辨 */
/* 选中行：用应用自己的 --surface-active，与项目树的选中会话同源。
   之前这里是 `color-mix(--brand-accent 16%)`——那是个高彩度青绿（chroma 0.1），
   而 --brand（项目树 hover/active 用的那个）是近乎中性的灰蓝（chroma 0.008），
   于是同一个左栏里两个列表的选中态是两种颜色。改用 token 后不可能再跑偏。 */
.ctp-row.is-active {
  background: var(--surface-active);
  color: var(--foreground);
}
.ctp-caret {
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--muted-foreground);
  display: inline-grid;
  place-items: center;
}
.ctp-caret svg {
  width: 12px;
  height: 12px;
  transition: transform var(--transition-base, 200ms);
}
/**
 * 目录图标样式。目录**不再**用带字的色块。
 *
 * 原型（.ftype + --ft-folder）用的是青蓝方块里一个字母 “D”，但实际项测不可用：
 * 8.5px 的 “D” 在 16px 方块里就是一团糊（截图里十几个目录连排时满屏同一个方块），
 * 而且它用的是品牌青绿——和选中行的绿撞在一起后，整列既认不出「这是目录」，
 * 又把真正需要着色的「选中」给盖过去了。原型自己的 --ft-folder 其实也是中性色
 * （oklch(0.62 0.02 265)），当初的青绿是实现时跑偏的。
 *
 * 换成线性文件夹轮廓：目录/文件一眼可分（文件色块是语言色），
 * 颜色交给 muted-foreground，整列不再和品牌色抢注意力。
 * 槽宽保持 16px，所以两类行的文件名左缘仍然对齐。
 */
.ctp-dir-icon {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  color: var(--muted-foreground);
}
.ctp-dir-icon svg {
  width: 14px;
  height: 14px;
}
.ctp-row.is-open .ctp-dir-icon {
  color: var(--foreground);
}
.ctp-row.is-open .ctp-caret svg {
  transform: rotate(90deg);
}
/* 目录与文件共用同一个方块（原型同款）。16px + mono 8.5/600 是能塞下两个字符的
   最小方块：再小一档 8px 的字会笔画粘连；再大一档 292px 的列里文件名少得只剩七八字。 */
.ctp-badge {
  flex: none;
  width: 16px;
  height: 16px;
  /* 目录行有折叠箭头（12px）+ 间距（5px），文件行没有；让出这 17px，
     两类行的文件名才会左缘对齐。写 calc 而非 17px：箭头改尺寸时不会默默错位。 */
  margin-left: calc(12px + 5px);
  border-radius: 4px;
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 600;
  line-height: 1;
  overflow: hidden;
}
.ctp-row.is-dir .ctp-badge {
  margin-left: 0;
}
.ctp-name {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctp-dir {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted-foreground);
  opacity: 0.7;
}
.ctp-git {
  flex: none;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  min-width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  text-align: center;
  border-radius: 4px;
  color: var(--muted-foreground);
  background: color-mix(in oklab, var(--muted) 45%, transparent);
}
.ctp-git[data-git='U'],
.ctp-git[data-git='?'] {
  color: var(--warning);
}

.ctp-note {
  margin: 6px 12px;
  font-size: 11px;
  color: var(--muted-foreground);
}
.ctp-note-warn {
  color: var(--warning);
}
.ctp-empty {
  padding: 20px 14px;
  text-align: center;
}
.ctp-empty-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--muted-foreground);
}
.ctp-empty-hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted-foreground);
  opacity: 0.8;
}

.ctp-foot {
  flex: none;
  border-top: 1px solid var(--border);
}
.ctp-stats {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
}
</style>
