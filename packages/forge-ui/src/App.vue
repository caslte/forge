<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe, getBootState } from './bridge';
import type { ProjectItem, SessionItem, ThemeMode, ProjectPickerDescriptor } from './types';
import { projectTagOf } from './utils/sessionView';
import { dropDraft } from './utils/composerDrafts';
import { useTheme } from './composables/useTheme';
import { usePreferences, codeLayoutDegraded } from './composables/usePreferences';
import { useCodeExplorer } from './composables/useCodeExplorer';
import { useToast } from './composables/useToast';
import { useI18n } from './i18n/index.ts';
import TitleBar from './components/TitleBar.vue';
import ProjectTree from './components/ProjectTree.vue';
import CodeTreePanel from './components/CodeTreePanel.vue';
import CodeExplorer from './components/CodeExplorer.vue';
import ConversationView from './components/ConversationView.vue';
import LandingHero from './components/LandingHero.vue';
import MultiWindowCanvas from './components/MultiWindowCanvas.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TrustAskDialog from './components/TrustAskDialog.vue';
import ToastNotification from './components/ToastNotification.vue';
import ExitConfirmDialog from './components/ExitConfirmDialog.vue';
import GitCommitDialog from './components/GitCommitDialog.vue';
import WhatsNewDialog from './components/WhatsNewDialog.vue';
import { useWhatsNew } from './composables/useWhatsNew';
import TerminalPanel from './components/TerminalPanel.vue';
import UpdateEntry from './components/UpdateEntry.vue';
import BootWelcome from './components/BootWelcome.vue';
import logoMain from './assets/logo-main.png';
// 标题栏左上角品牌字样：复用 landing/hero 同一对 public 字标（深浅各一版），
// 全链路共享同一次加载/解码，不新增资产
const logoWordmarkDark = import.meta.env.BASE_URL + 'logo-wordmark-on-dark.svg';
const logoWordmarkLight = import.meta.env.BASE_URL + 'logo-wordmark-on-light.svg';

const { t, activeLocale } = useI18n();

// 生效语言回报主进程（系统通知标题文案取词用；与 useTheme 的主题回报同构——
// localStorage 是唯一事实来源，主进程只持镜像）。locale 可选：浏览器 mock / 旧 preload
// 无此方法，可选链跳过。
watch(
  activeLocale,
  (locale) => {
    window.forge?.locale?.set(locale);
  },
  { immediate: true },
);

/**
 * 启动门闩（v3.76）：false 期间整个正式 UI 不挂载，只显示 BootWelcome。
 *
 * 主进程在窗口出现后才动态组装 forge-core（含 pi SDK ~2.4s），期间 forge:invoke
 * handler 尚未注册——门闩同时挡住了所有启动期请求（loadSessions/loadProjects/
 * loadModels），避免它们打在未注册的 channel 上报 "No handler registered"。
 * 放行信号：boot.ready 事件（推）或 getBootState().ready（拉），任一先到即可。
 */
const bootReady = ref(false);

/**
 * 项目首拉是否落地（v3.85.2）：门闩放行时 projects 恒为空数组（loadProjects 是放行后
 * 才发的异步 IPC），正式 UI 若同 tick 挂载，有项目的用户也会先闪现一帧「零项目落地页」
 * LandingHero（字标几何 A），project 落地后换成会话空态 hero（几何 B）——即用户报的
 * 「跳到新会话时 FORGE 字样调整了一下高度，跳了一下」。BootWelcome 多驻留到首拉落地，
 * 正式 UI 首帧即终态。loadProjects 的 finally 置位（报错/零项目同样放行，不成死门）。
 */
const projectsLoaded = ref(false);
/** 正式 UI 可挂载 = core 就绪 ∧ 项目首拉落地 */
const formalUiReady = computed(() => bootReady.value && projectsLoaded.value);

/**
 * 接管 veil（v3.85.2）：formalUiReady 后 BootWelcome 不再同 tick 硬卸载，而是留在
 * fixed 覆盖层上淡出 200ms 再卸载，把「切页硬切」变成连续过渡（字标两侧同尺寸 320，
 * 淡出即无闪跳）。卸载走 400ms 超时兜底：prefers-reduced-motion 下 transition 被禁用、
 * transitionend 不会来，只等事件就会 veil 常驻挡交互。
 */
const bootVeilLeaving = ref(false);
const bootVeilGone = ref(false);
watch(formalUiReady, (ready) => {
  if (!ready) return;
  requestAnimationFrame(() => {
    bootVeilLeaving.value = true;
  });
  setTimeout(() => {
    bootVeilGone.value = true;
  }, 400);
});

// 项目/会话
const projects = ref<ProjectItem[]>([]);
const sessions = ref<SessionItem[]>([]);
const currentProjectPath = ref<string | null>(null);
const currentSessionId = ref<string | null>(null);
/**
 * 草稿输入态：点击「新会话」后尚未真正创建 pi session（未发送首条消息）。
 * 发送首条消息时由 ConversationView 先创建会话（emit session-created），
 * 待会话列表出现该会话（别名已由首条消息生成）后退出草稿态。
 */
const draftMode = ref(false);

// 视图
type View = 'sessions' | 'settings';
const activeView = ref<View>('sessions');
const sidebarCollapsed = ref(false);

/* 侧栏宽度可拖拽调整：限制在 [220, 440]，记忆在 localStorage。
   宽度经 CSS 变量 --sidebar-w 驱动侧栏 / shell-topstrip / 折叠态标题栏让位，三处同源 */
const SIDEBAR_W_KEY = 'forge:sidebar:width';
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 440;
const SIDEBAR_DEFAULT = 292;
const sidebarWidth = ref(readSidebarWidth());
const sidebarResizing = ref(false);
let resizeStartX = 0;
let resizeStartW = 0;

function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_W_KEY));
    return Number.isFinite(raw) && raw >= SIDEBAR_MIN && raw <= SIDEBAR_MAX ? raw : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function onSidebarResizeStart(e: PointerEvent): void {
  if (e.button !== 0) return;
  resizeStartX = e.clientX;
  resizeStartW = sidebarWidth.value;
  sidebarResizing.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  document.body.classList.add('sidebar-resizing');
  e.preventDefault();
}

function onSidebarResizeMove(e: PointerEvent): void {
  (e.currentTarget as HTMLElement).style.setProperty('--seg-y', `${e.clientY}px`);
  if (!sidebarResizing.value) return;
  const next = resizeStartW + (e.clientX - resizeStartX);
  sidebarWidth.value = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next));
}

function onSidebarResizeEnd(e: PointerEvent): void {
  if (!sidebarResizing.value) return;
  sidebarResizing.value = false;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  document.body.classList.remove('sidebar-resizing');
  try {
    localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth.value));
  } catch {
    // 存储失败忽略（不影响运行）
  }
}

/** mac：traffic lights 画在窗口左上角（12,12），悬浮 toggle 需右移让位（见主进程 trafficLightPosition） */
const isMac = window.forge?.platform === 'darwin';
const showExitDialog = ref(false);
/** 待信任确认的项目（1005 弹窗） */
const trustAskPath = ref<string | null>(null);
const trustAskName = ref('');
/** 多窗口画布模式（单会话视图 ↔ 多窗口画布 切换） */
const multiWindow = ref(false);
/** 多窗口画布组件实例：顶部工具栏「自动布局 / 全部关闭」调用其方法 */
const mwCanvasRef = ref<InstanceType<typeof MultiWindowCanvas> | null>(null);
/** 已在多窗口画布上打开的会话 id 列表（供会话池标记灰态） */
const openedSessionIds = ref<string[]>([]);
/** 多窗口模式下聚焦查看的会话 id（非空时在画布上方叠加单会话视图，布局保留） */
const focusedSessionForWin = ref<string | null>(null);

// 会话树视角（SM-S06）：项目=按项目分组（现状）；任务=平摊全部会话。选择记忆在 localStorage
const TREE_VIEW_KEY = 'forge:sidebar:view';
const treeView = ref<'project' | 'task'>(readTreeView());
const projectTreeRef = ref<InstanceType<typeof ProjectTree> | null>(null);
/** 项目视角全部项目是否已折叠（收起/展开全部按钮两态，由 ProjectTree 上报） */
const allCollapsed = ref(false);

function readTreeView(): 'project' | 'task' {
  try {
    return localStorage.getItem(TREE_VIEW_KEY) === 'task' ? 'task' : 'project';
  } catch {
    return 'project';
  }
}

watch(treeView, (v) => {
  try {
    localStorage.setItem(TREE_VIEW_KEY, v);
  } catch {
    // 存储失败忽略（不影响运行）
  }
});

/* 滑动指示胶囊 JS 定位：CSS 50% 几何假设两键等宽，英文长词（Projects/Tasks）下
   内容收缩容器无剩余空间可分配、flex:1 也无法等分，改为按 active 按钮实测宽贴 */
const viewSegEl = ref<HTMLElement | null>(null);

/** 按 active 按钮实测几何贴胶囊；animate=false 抑制水滴（容器自身在改尺寸，跟着贴即可） */
function moveViewPill(animate = true): void {
  const seg = viewSegEl.value;
  if (!seg) return;
  const btn = seg.querySelector<HTMLElement>('.view-seg-btn.active');
  if (!btn || btn.offsetWidth === 0) return; // 侧栏折叠隐藏时跳过，展开后重贴
  if (!animate) seg.classList.add('no-anim');
  seg.style.setProperty('--pill-l', `${btn.offsetLeft}px`);
  seg.style.setProperty('--pill-r', `${seg.clientWidth - btn.offsetLeft - btn.offsetWidth}px`);
  if (!animate) requestAnimationFrame(() => seg.classList.remove('no-anim'));
}

/* 视角/语言切换：分段开关整体盒子多半不变（两键宽度互换），ResizeObserver 看不见 → 显式重贴 */
watch([treeView, activeLocale], () => {
  void nextTick(moveViewPill);
});

/**
 * 几何以**分段开关的实际盒子**为准：ResizeObserver 在 observe 时先补一次当前几何，
 * 之后盒子每变一次就重贴一次（不带水滴）。两处实测踩过的坑都收敛在这里：
 * - 首贴：`.view-seg` 在 v-if="formalUiReady" 里，onMounted 的 nextTick 早于它挂载，
 *   那时 viewSegEl 还是 null，首贴静默落空 → 英文（Projects/Tasks 不等宽）首帧停在
 *   CSS 50% 兜底几何上，胶囊不贴合，要等用户切一次视角才归位。
 * - 侧栏折叠/展开是 width 过渡（.sidebar），展开瞬间 .view-seg 被压到 min-content
 *   （94→70px、按钮 44→32px），此刻 sidebarCollapsed 的 watch 测出的 --pill-r 永久偏小：
 *   过渡结束后盒子回到 94/44，胶囊却被拉长成 56px（用户实测「项目胶囊变形」）。
 *   RO 在过渡结束按终态重贴自愈，途中也逐帧贴着按钮走，不再错位。
 */
let viewSegRo: ResizeObserver | null = null;
watch(viewSegEl, (el) => {
  viewSegRo?.disconnect();
  viewSegRo = null;
  if (!el) return;
  viewSegRo = new ResizeObserver(() => moveViewPill(false));
  viewSegRo.observe(el);
});

/** 切项目/任务视角：等同直接赋值，胶囊几何由上方 watch 在 nextTick 重贴。
 *  保留函数是为和模板里已存在的 @click="switchTreeView(...)" 对齐。 */
function switchTreeView(v: 'project' | 'task'): void {
  if (treeView.value === v) return;
  treeView.value = v;
}

function onFoldAll(): void {
  if (allCollapsed.value) projectTreeRef.value?.expandAll();
  else projectTreeRef.value?.collapseAll();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 内置代码浏览器（模块 12）
 *
 * 一个状态 codeOpenPath 驱动三处：左栏互斥切换、右栏代码纸、<> 入口高亮。
 * 之所以用一个标量而不是「面板是否打开 + 当前项目」两个 ref：它们在产品上是
 * 同一件事的两种说法，写成两个必然会写出「开着但没项目」的非法组合。
 *
 * 左栏用 v-if 互斥而非 v-show：退出代码态时项目树被重新挂载，而 ProjectTree 的
 * 展开态是组件内 ref，重挂载就丢了。所以改成 v-if 时必须确认 ProjectTree 不被销毁
 * ——现状是它始终在 DOM 里被 toggle 掉，这里靠「同一侧只渲染一个」保证互斥。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 当前打开代码浏览器的项目路径；null = 左栏显示项目树、右栏无代码纸 */
const codeOpenPath = ref<string | null>(null);

/** 代码浏览器的宿主项目（用于取项目名；与 ProjectTree 的显示名规则保持一致） */
const codeProjectName = computed(() => {
  const p = projects.value.find((x) => x.path === codeOpenPath.value);
  if (!p) return '';
  if (p.alias) return p.alias;
  const segs = p.path.split(/[\\/]/);
  return segs[segs.length - 1] || p.path;
});

function openCode(path: string): void {
  // 重复点同一个项目的 <>：当作「回到代码」，而不是无反应
  codeOpenPath.value = codeOpenPath.value === path ? null : path;
}

function closeCode(): void {
  codeOpenPath.value = null;
}

/**
 * Esc 逐级退出（CE-S05）：
 *   有选中文件 → 关掉文件（CodeExplorer 根节点先处理并 stopPropagation，window 收不到）
 *   只剩空态  → 退出代码浏览器，回到项目树
 *
 * 为什么挂在 window 而不是某个面板：焦点可能在项目树、过滤框、终端任何一处，
 * 冒泡链不经过它们。挂 window（泡泡阶段）能接住所有情况；内层用 stopPropagation
 * 切断冒泡，window 就只会看到真正没人消费的那次 Esc。
 */
const { getState: getCodeState, closeFile: closeCodeFile } = useCodeExplorer();

function onCodeEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || codeOpenPath.value === null) return;
  // 组合键（如 Esc 本身之外的修饰键）不抢：留给浏览器/别的快捷键
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Esc 是**逐级**退出的，这里是唯一做决定的地方：
  // 有激活文件 → 先关文件；没有文件 → 退出代码态。
  //
  // 为什么不能靠「焦点在哪、内层 stopPropagation」来决定层级：焦点可能在左栏代码树
  // （CodeTreePanel 是 .content 的兄弟子树），事件冒泡根本不经过 CodeExplorer，
  // 内层处理器再正确也接不到，实测表现为一次 Esc 就把整个代码浏览器关掉了。
  // 状态在这里读，内层只管自己的输入框等「先于文件」的行为。
  const s = getCodeState(codeOpenPath.value);
  if (s.activeRel) {
    closeCodeFile(codeOpenPath.value, s.activeRel);
    return;
  }
  closeCode();
}

function toggleCodeLayout(): void {
  const { setCodeViewerLayout } = usePreferences();
  setCodeViewerLayout(codeViewerLayout.value === 'split' ? 'cover' : 'split');
}

/** 设置页与任务视角不参与代码浏览器：切走时收起来，避免隐藏态里还挂着代码纸 */
watch([activeView, treeView], () => {
  if (codeOpenPath.value !== null && (activeView.value === 'settings' || treeView.value === 'task')) {
    codeOpenPath.value = null;
  }
});

/** 下拉项目排序记忆：最近使用置顶（新建项目/创建会话触发），localStorage 持久（SM-S01 v3.29，v3.45 改 MRU） */
const PICK_ORDER_KEY = 'forge:project-pick-order';
const pickOrder = ref<string[]>(readPickOrder());

function readPickOrder(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PICK_ORDER_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
  } catch {
    return [];
  }
}

watch(pickOrder, (v) => {
  try {
    localStorage.setItem(PICK_ORDER_KEY, JSON.stringify(v));
  } catch {
    // 存储失败忽略（不影响运行）
  }
});

/** 最近使用置顶（MRU）：重复使用也置顶，其余项目相对顺序不变；与项目树拖拽序无关 */
function bumpProjectToFront(path: string): void {
  pickOrder.value = [path, ...pickOrder.value.filter((p) => p !== path)];
}

/** 聚焦层「返回多窗口」行显示会话归属项目（别名优先，SM-S06 多窗口配套） */
const winFocusProjectName = computed(() => {
  const s = sessions.value.find((x) => x.sessionId === focusedSessionForWin.value);
  if (!s) return '';
  const p = projects.value.find((x) => x.path === s.projectPath);
  return p?.alias ?? basename(s.projectPath);
});

/**
 * 输入框项目选择器（SM-S01 v3.21）：草稿态=可选归属；会话中=只读信息。
 * 列表序（v3.45 改 MRU）：pickOrder（最近使用置顶）优先，未记录的按后端序排后。
 * 触发点仅两个：新建项目、创建会话成功；纯下拉选中不改序（与项目树拖拽序无关）。
 */
const orderedProjects = computed<ProjectItem[]>(() => {
  const rank = (p: string): number => {
    const idx = pickOrder.value.indexOf(p);
    return idx === -1 ? pickOrder.value.length : idx;
  };
  return [...projects.value].sort((a, b) => rank(a.path) - rank(b.path));
});

const projectPicker = computed<ProjectPickerDescriptor | null>(() => {
  if (projects.value.length === 0) {
    // 零项目（落地 hero，v3.77）：没有可归属项目，项目区只提供「打开项目…」入口。
    // currentPath:null 是类型既有的「未选归属」草稿语义；此时会话分支不渲染，
    // 该描述只被 LandingHero 消费，不影响其他使用点。
    return { mode: 'draft', currentPath: null, currentName: t('app.openProject'), items: [] };
  }
  const s = currentSession.value;
  const inSession = s !== null && !draftMode.value;
  const path = inSession ? s.projectPath : (currentProject.value?.path ?? null);
  if (!path) return null;
  return {
    mode: inSession ? 'session' : 'draft',
    currentPath: path,
    currentName: projectTagOf(path, projects.value),
    items: orderedProjects.value.map((p) => ({
      path: p.path,
      name: projectTagOf(p.path, projects.value),
    })),
  };
});

// 设置
const { themeMode, setTheme } = useTheme();
const { message: toastMessage, type: toastType, seq: toastSeq, show: showToast, clear: clearToast } = useToast();
const { terminalOpen, setTerminalOpen, codeViewerLayout } = usePreferences();
// 版本更新说明弹窗（升级后首启自动弹 + 关于页回看；弹窗本体见模板 WhatsNewDialog）
const { ensureChecked: ensureWhatsNewChecked } = useWhatsNew();

// ===== 内嵌终端（模块 10）入口状态 =====
// tab 标题的项目显示名：别名优先，回退目录名（与会话归属标签同口径）
const terminalProjectName = computed(() => {
  const p = currentProject.value;
  if (p === null) return '';
  return p.alias ?? basename(p.path);
});

/**
 * Ctrl+` 全局开合（TM-S01，与 VSCode 一致：输入框聚焦时同样生效）。
 * 只拦 ctrl+反引号这一组合（不吞普通反引号输入，Ctrl 组合本就不产出字符），
 * 故无需聚焦豁免逻辑；key 与 code 双判覆盖键盘布局差异。
 */
function onTerminalHotkey(ev: KeyboardEvent): void {
  if (!ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey) return;
  if (ev.key !== '`' && ev.code !== 'Backquote') return;
  ev.preventDefault();
  setTerminalOpen(!terminalOpen.value);
}

// 模型列表与会话模型（ConversationView 消费）
const models = ref<string[]>([]);
const currentSessionModel = ref<string | null>(null);

const currentProject = computed(() =>
  projects.value.find((p) => p.path === currentProjectPath.value) ?? null,
);
const currentSession = computed(() =>
  sessions.value.find((s) => s.sessionId === currentSessionId.value) ?? null,
);

/**
 * 草稿输入框的跨视图恢复由 InstructionInput 的模块级草稿仓库
 * （utils/composerDrafts）统一承担：落地 hero 与项目视图的输入框同为草稿态
 * key，hero 卸载 → ConversationView 挂载即自动衔接，无需事件接力。
 */
const convRef = ref<InstanceType<typeof ConversationView> | null>(null);

const sessionError = ref<string | null>(null);
let errorTimer: ReturnType<typeof setTimeout> | null = null;
function showError(msg: string): void {
  sessionError.value = msg;
  if (errorTimer !== null) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    sessionError.value = null;
  }, 6000);
}
function clearError(): void {
  sessionError.value = null;
  if (errorTimer !== null) clearTimeout(errorTimer);
}

async function loadProjects(): Promise<void> {
  try {
    const res = await call<{ projects: ProjectItem[] }>('project/queryProjectList');
    projects.value = res.projects;
    if (currentProjectPath.value === null && projects.value.length > 0) {
      await openProject(projects.value[0]!.path);
    }
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    // v3.85.2：首拉落地（含报错/零项目）才允许正式 UI 挂载——openProject 在 try 内
    // await，置位时 currentProject 已就绪，ConversationView 首帧即终态
    projectsLoaded.value = true;
  }
}

async function selectProject(path: string): Promise<void> {
  currentProjectPath.value = path;
  currentSessionId.value = null;
  draftMode.value = false;
  // 设置在设置页时，点击项目应关闭设置并回到会话视图
  if (activeView.value === 'settings') activeView.value = 'sessions';
  await loadSessions();
}

/**
 * 输入框选择器切换归属项目（SM-S01 v3.21）：与侧栏切项目不同，
 * 草稿保留（选择器语义就是“给当前未发送的会话换归属”），不关设置页。
 */
async function onPickProject(path: string): Promise<void> {
  // 纯选中不改下拉序（v3.45 MRU 粒度）：置顶只由新建项目/创建会话触发
  currentProjectPath.value = path;
  currentSessionId.value = null;
  await loadSessions();
}

/**
 * 打开项目（P2-A）：先走 project/openProject；含项目资源且信任未定时返回 1005，
 * 弹出信任确认；已确定状态直接进入。错误码 1005 特殊处理（带 prompt 载荷）。
 */
async function openProject(path: string): Promise<void> {
  try {
    await call('project/openProject', { path });
    await selectProject(path);
  } catch (e) {
    if (e instanceof Error && e.message.includes('1005')) {
      // 信任询问：附带路径进入弹窗，不阻断会话视图
      trustAskPath.value = path;
      trustAskName.value = basename(path);
      await selectProject(path);
    } else {
      // 其余错误：仍进入项目（基础会话可用），仅提示
      await selectProject(path);
      showError(e instanceof Error ? e.message : String(e));
    }
  }
}

/** 信任决策回传（P2-A）：写 pi 权威后关闭弹窗 */
async function onTrustDecide(decision: 'trust' | 'reject' | 'trustOnce'): Promise<void> {
  const path = trustAskPath.value;
  trustAskPath.value = null;
  if (!path) return;
  try {
    await call('project/setTrust', { path, decision });
    const toast =
      decision === 'trust'
        ? t('app.trustedToast', { name: basename(path) })
        : decision === 'reject'
          ? t('app.rejectedToast', { name: basename(path) })
          : t('app.trustedOnceToast', { name: basename(path) });
    showToast(toast, decision === 'reject' ? 'info' : 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function loadSessions(): Promise<void> {
  // 全量加载所有项目的会话（querySessionList 不传 projectPath 时返回全部），
  // 这样会话树里每个项目都能正确显示自己的会话，而非只显示当前项目。
  try {
    const res = await call<{ sessions: SessionItem[] }>('session/querySessionList', {});
    // core 会话状态值域（idle/running/done/error）映射到 UI 值域（running→streaming），
    // 保证会话树状态圆点 tone-* 样式类命中（后端运行时返回 'running'，宽化比较）
    sessions.value = res.sessions.map((s) => ({
      ...s,
      status: ((s.status as string) === 'running' ? 'streaming' : s.status) as SessionItem['status'],
    }));
    // 草稿态会话已真实创建（首条消息后自动命名入树）→ 退出草稿态。
    if (draftMode.value && currentSessionId.value !== null) {
      if (sessions.value.some((s) => s.sessionId === currentSessionId.value)) {
        draftMode.value = false;
      }
    }
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onAddProject(path: string): Promise<void> {
  try {
    await call('project/addProject', { path });
    await loadProjects();
    bumpProjectToFront(path);
    // 新建即选中：归属切到新项目（v3.48 用户反馈：排第一但未选中）；
    // 走 onPickProject 语义——草稿保留，与下拉选中一致
    await onPickProject(path);
    showToast(t('app.projectAdded'), 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 打开项目：不弹弹窗，直接弹系统目录选择器，选中即注册（取消/失败视为无操作） */
async function openFolderPicker(): Promise<void> {
  try {
    const dir = await window.forge.dialog.selectDirectory();
    if (dir) await onAddProject(dir);
  } catch {
    // 用户取消或桥接失败：无操作
  }
}

async function onRemoveProject(path: string): Promise<void> {
  try {
    // 级联删除：后端连同该项目名下会话（含 pi 会话文件）一并删除（v3.32 用户改判 TD-PM-05）
    const res = await call<{ removedSessions: number }>('project/removeProject', { path });
    pickOrder.value = pickOrder.value.filter((p) => p !== path);
    if (currentProjectPath.value === path) {
      currentProjectPath.value = null;
      currentSessionId.value = null;
    }
    await loadProjects();
    await loadSessions();
    showToast(res.removedSessions > 0 ? t('app.projectRemovedWithSessions', { count: res.removedSessions }) : t('app.projectRemoved'), 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onRenameProject(path: string, alias: string): Promise<void> {
  try {
    await call('project/updateProjectAlias', { path, alias });
    await loadProjects();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 清理项目下所有会话（保留项目）；当前会话被清时退出选中态（session.removed 订阅兜底） */
async function onClearProjectSessions(path: string): Promise<void> {
  try {
    const res = await call<{ removedSessions: number }>('project/clearSessions', { path });
    await loadSessions();
    showToast(
      res.removedSessions > 0
        ? t('app.projectSessionsCleared', { count: res.removedSessions })
        : t('app.projectSessionsAlreadyEmpty'),
      'success',
    );
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 项目拖拽排序：全量新顺序落盘后刷新列表 */
async function onReorderProjects(paths: string[]): Promise<void> {
  try {
    await call('project/reorderProjects', { paths });
    await loadProjects();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 新建会话：仅进入草稿输入态，不真正创建 pi session。
 * 发送首条消息时由 ConversationView 创建会话并 emit 'session-created'（见 onSessionCreated）。
 * 归属默认=项目选择器列表第一项（v3.38 用户裁定：顺序不变，默认选第一项）；
 * 项目树行内"新建会话"显式携带项目 path，优先于默认。
 */
function onCreateSession(sessionProjectPath?: string): void {
  if (projects.value.length === 0) return;
  // 多窗口画布无独立输入区，新建先退回单会话视图
  if (multiWindow.value) multiWindow.value = false;
  const target = sessionProjectPath ?? orderedProjects.value[0]?.path ?? null;
  if (target !== null && target !== currentProjectPath.value) void selectProject(target);
  currentSessionId.value = null;
  draftMode.value = true;
  // 新会话且输入为空：还原被手动拖高的输入框（等本 tick 会话切换 watch 清完文本再判定）
  nextTick(() => convRef.value?.resetInputHeightIfEmpty());
}

/**
 * ConversationView 草稿态发送首条消息时触发：会话已创建，绑定为当前会话。
 * 会话树标签等该会话别名生成（forge-core 自动命名 + session.updated → loadSessions）后自然出现，
 * 因此这里不主动刷新列表，保证左侧标签首次出现即带首条问题截取标题。
 */
function onSessionCreated(sessionId: string): void {
  currentSessionId.value = sessionId;
  // 会话归属落定 → 归属项目置顶（v3.45 MRU 粒度，草稿归属即 currentProjectPath）
  const p = currentProjectPath.value;
  if (p !== null) bumpProjectToFront(p);
}

async function onSelectSession(id: string): Promise<void> {
  currentSessionId.value = id;
  draftMode.value = false;
  // 会话归属项目要跟手：终端等「以当前项目为 cwd」的入口读的是 currentProjectPath，
  // 只从项目树点入才会更新——从会话树点入时必须按会话的 projectPath 对齐
  const owner = sessions.value.find((s) => s.sessionId === id)?.projectPath ?? null;
  if (owner !== null && owner !== currentProjectPath.value) currentProjectPath.value = owner;
  // 设置在设置页时，点击会话应关闭设置并回到会话视图
  if (activeView.value === 'settings') activeView.value = 'sessions';
  try {
    await call('session/attachSessionWindow', { sessionId: id });
  } catch {
    // 重复 attach 忽略
  }
}

async function onDeleteSession(id: string): Promise<void> {
  try {
    await call('session/deleteSession', { sessionId: id });
    dropDraft(id);
    if (currentSessionId.value === id) currentSessionId.value = null;
    await loadSessions();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onRenameSession(id: string, alias: string): Promise<void> {
  try {
    await call('session/updateSessionAlias', { sessionId: id, alias });
    await loadSessions();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 全局默认模型（草稿态预览/未配置会话级覆盖时展示） */
const defaultModel = ref<string | null>(null);

// 加载可用模型列表（SettingsPanel 操作 provider 后由 providersChanged 事件刷新）
async function loadModels(): Promise<void> {
  try {
    const res = await call<{ models: string[]; defaultModel: string | null }>('model/queryModels');
    models.value = res.models;
    defaultModel.value = res.defaultModel;
    // 无会话（含草稿输入态）时用全局默认模型做展示
    if (currentSessionId.value === null) currentSessionModel.value = res.defaultModel;
  } catch {
    models.value = [];
  }
}

// 加载当前会话生效模型（优先会话覆盖，其次全局默认）
async function loadSessionModel(sid: string): Promise<void> {
  try {
    const res = await call<{ model: string | null; effective: string }>('model/getSessionModel', {
      sessionId: sid,
    });
    currentSessionModel.value = res.model;
  } catch {
    currentSessionModel.value = null;
  }
}

// 会话级模型切换（写 modelOverride，不影响全局默认）
async function onModelChange(model: string): Promise<void> {
  currentSessionModel.value = model;
  // 草稿态（会话尚未创建）：仅本地回显预览；所选模型在创建会话时由
  // ConversationView 写入会话覆盖（见其草稿发送分支），发送即生效
  if (currentSessionId.value === null) {
    // 不弹 toast：模型选择器本身已回显所选模型，右下角提示此处无增量信息
    return;
  }
  try {
    await call('model/setSessionModel', { sessionId: currentSessionId.value, model });
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

function openSettings(): void {
  activeView.value = 'settings';
  multiWindow.value = false;
  focusedSessionForWin.value = null;
}

function closeSettings(): void {
  activeView.value = 'sessions';
}

/** 切换单会话视图 / 多窗口画布 */
function toggleMultiWindow(): void {
  multiWindow.value = !multiWindow.value;
  // 主动退出（或重新进入）多窗口时，清掉窗口单会话聚焦层
  focusedSessionForWin.value = null;
}

/**
 * 多窗口画布中点击窗口"单视图"：不退出多窗口，改为在画布上方叠加单个会话视图，
 * 保留画布上的窗口布局，可随时返回。
 */
function onMultiWindowFocus(sessionId: string): void {
  currentSessionId.value = sessionId;
  focusedSessionForWin.value = sessionId;
}

/** 从窗口单会话聚焦层返回多窗口画布 */
function closeWinFocus(): void {
  focusedSessionForWin.value = null;
}

/** 多窗口画布开窗集合变化：同步给会话池标记灰态 */
function onOpenedChange(sessionIds: string[]): void {
  openedSessionIds.value = sessionIds;
}

// 退出多窗口（画布卸载）时清掉会话树"已开窗"标记；
// 布局已持久化，重进多窗口时 restoreLayout 会重开窗并重新同步该集合
watch(multiWindow, (v) => {
  if (!v) openedSessionIds.value = [];
});

function requestExit(): void {
  showExitDialog.value = true;
}

function confirmExit(): void {
  showExitDialog.value = false;
  window.forge.window.close();
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

let unsubSessionRemoved: (() => void) | null = null;
let unsubSessionUpdated: (() => void) | null = null;
let unsubSessionStatus: (() => void) | null = null;
let unsubProjectRemoved: (() => void) | null = null;
let unsubProvidersChanged: (() => void) | null = null;
let unsubNotifyFocus: (() => void) | null = null;

// 会话切换时加载该会话生效模型；无会话（含草稿态）时展示全局默认模型
watch(currentSessionId, (sid) => {
  if (sid !== null) void loadSessionModel(sid);
  else currentSessionModel.value = defaultModel.value;
});

// 查看中的会话完成结果未读 → 调 session/markSessionRead 落盘已读（forge-store，
// 跨窗口/重启一致）。覆盖三种路径：点击已完成会话；正查看时会话 streaming→done
//（session.statusChanged → loadSessions 触发本 watch）；多窗口画布聚焦。
watch([sessions, currentSessionId], () => {
  if (currentSessionId.value === null) return;
  const s = sessions.value.find((it) => it.sessionId === currentSessionId.value);
  if (s && s.status === 'done' && !s.doneReadAt) {
    call('session/markSessionRead', { sessionId: s.sessionId }).catch(() => {
      // 标记失败不阻断会话视图（绿点会在下次触发时重试）
    });
  }
});

/** boot.ready 事件订阅句柄：放行后立即退订（推/拉双通道，只需一次） */
let bootUnsubscribe: (() => void) | null = null;
/** 门闩逃生计时器：放行时清除（见 onMounted 门闩段注释） */
let bootEscapeTimer: ReturnType<typeof setTimeout> | null = null;

/** 门闩放行：进入正式界面并执行启动期拉取（幂等，推/拉/逃生任一先到都只跑一次） */
function startPostBootInit(): void {
  if (bootReady.value) return;
  bootReady.value = true;
  if (bootUnsubscribe !== null) {
    bootUnsubscribe();
    bootUnsubscribe = null;
  }
  if (bootEscapeTimer !== null) {
    clearTimeout(bootEscapeTimer);
    bootEscapeTimer = null;
  }
  // 会话列表与项目列表并行拉取（而非串在 openProject 之后）：querySessionList 不传
  // projectPath 时返回全部会话，与「打开项目」本身无依赖。若保持串行，openProject
  // 触发的 pi 扩展预热（主进程 jiti 冷编译 3~9s 占满事件循环）会把会话查询一起堵住，
  // 表现为「项目已显示、会话树空白数秒」。并行后会话请求先于预热落地。
  void loadSessions();
  void loadProjects();
  void loadModels();
  // 版本更新说明：core 已就绪，检查并按需自动弹（升级首启 + 未展示过；幂等，失败静默）
  void ensureWhatsNewChecked();
}

onMounted(() => {
  // 指示胶囊首贴不在这里：.view-seg 挂在 v-if="formalUiReady" 里，此刻还没渲染，
  // 由 viewSegEl 的 ResizeObserver 在元素挂载时补首贴（见上方 viewSegRo）
  // 事件订阅先挂：订阅本身不发请求，core 未就绪期间主进程也不会推业务事件，
  // 挂早了无副作用（放行后 loadSessions 等才真正出发）
  unsubSessionRemoved = subscribe('session.removed', (payload) => {
    const p = payload as { sessionId: string };
    dropDraft(p.sessionId);
    if (p.sessionId === currentSessionId.value) currentSessionId.value = null;
    void loadSessions();
  });
  // 会话别名更新（手动重命名或首条消息自动命名）：刷新列表保持 UI 同步
  unsubSessionUpdated = subscribe('session.updated', () => {
    void loadSessions();
  });
  // 会话运行时状态变化（streaming/done/error）：刷新会话树状态圆点
  unsubSessionStatus = subscribe('session.statusChanged', () => {
    void loadSessions();
  });
  unsubProjectRemoved = subscribe('project.removed', () => {
    void loadProjects();
  });
  // SettingsPanel 增删 provider 后刷新模型列表
  unsubProvidersChanged = subscribe('model.providersChanged', () => {
    void loadModels();
    if (currentSessionId.value !== null) void loadSessionModel(currentSessionId.value);
  });
  // 系统通知点击跳转（主进程 notifyToast 直发）：主窗口已被通知聚焦，切到对应会话。
  // 复用会话树同一切换逻辑（含 attachSessionWindow），语义与手动点击会话完全一致
  unsubNotifyFocus = subscribe('notify.focusSession', (payload) => {
    const p = payload as { sessionId?: unknown };
    if (typeof p?.sessionId === 'string' && p.sessionId !== '') void onSelectSession(p.sessionId);
  });

  // 启动门闩（v3.76）：先拉 bootState 兜底（热重载/事件早于订阅的场景），
  // 未就绪再等 boot.ready 推送。ready=true 的拉取直接放行，欢迎页一帧即过。
  //
  // 逃生通道（v3.76 真机教训：门闩绝不能是死门）：
  // 1. 拉取异常（旧 preload 无 bootState 方法 / 任意 IPC 异常）→ 直接放行——
  //    旧主进程本就是「core 组装完才建窗口」，窗口可见即 core 已就绪，放行正确；
  // 2. 10s 超时强制放行——万一双通道都因未知原因断链，宁可进入正式界面让请求
  //    报错（有错误提示），也绝不永远卡在欢迎页。
  const BOOT_GATE_TIMEOUT_MS = 10_000;
  bootEscapeTimer = setTimeout(() => startPostBootInit(), BOOT_GATE_TIMEOUT_MS);
  void getBootState()
    .then((state) => {
      if (state.ready) {
        startPostBootInit();
      } else {
        bootUnsubscribe = subscribe('boot.ready', () => startPostBootInit());
      }
    })
    .catch(() => startPostBootInit());

  // 终端快捷键（TM-S01）：window 级 keydown，捕获阶段即可——Ctrl+` 在任何焦点下生效
  window.addEventListener('keydown', onTerminalHotkey);
  window.addEventListener('keydown', onCodeEscape);
});

onUnmounted(() => {
  unsubSessionRemoved?.();
  unsubSessionUpdated?.();
  unsubSessionStatus?.();
  unsubProjectRemoved?.();
  unsubProvidersChanged?.();
  unsubNotifyFocus?.();
  viewSegRo?.disconnect();
  viewSegRo = null;
  window.removeEventListener('keydown', onTerminalHotkey);
  window.removeEventListener('keydown', onCodeEscape);
  if (errorTimer !== null) clearTimeout(errorTimer);
});
</script>

<template>
  <!-- v3.76 启动门闩：core 就绪前只渲染欢迎页；正式 UI 的启动请求在 startPostBootInit。
       v3.85.2：放行条件收紧为 formalUiReady（core ∧ 项目首拉），且欢迎页改 veil 淡出接管 -->
  <BootWelcome
    v-if="!bootVeilGone"
    class="boot-veil"
    :class="{ 'boot-veil-leaving': bootVeilLeaving }"
  />
  <div
    v-if="formalUiReady"
    class="app-container"
    :class="{ 'sidebar-collapsed': sidebarCollapsed, 'sidebar-resizing': sidebarResizing }"
    :style="{ '--sidebar-w': `${sidebarWidth}px` }"
  >
    <!-- 一体化壳层（prototypes/unified-shell-full.html）：侧栏列通顶、标题栏只盖右列、
         toggle 悬浮钉死窗口左上角——折叠时侧栏从按钮底下抽走，按钮零位移不跳动。
         toggle 必须包在窗口级拖拽条内做 no-drag 后代：Electron 的 drag 区只认后代挖洞，
         同级悬浮会被原生拖拽吞掉 hover/click（旧版 TitleBar 内按钮可用的原因相同） -->
    <div class="shell-topstrip" :class="{ 'shell-topstrip-mac': isMac }">
      <button
        class="shell-toggle"
        :class="{ 'shell-toggle-mac': isMac }"
        :aria-label="sidebarCollapsed ? t('app.expandSidebar') : t('app.collapseSidebar')"
        @click="sidebarCollapsed = !sidebarCollapsed"
      >
        <!-- 默认显品牌 LOGO（切图），hover 交叉淡入为面板图标，箭头方向随折叠态翻转 -->
        <img class="tb-logo" :src="logoMain" alt="" aria-hidden="true" draggable="false" />
        <span class="tb-panel" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <template v-if="sidebarCollapsed">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M15 4v16" />
              <path d="m8 15 3-3-3-3" />
            </template>
            <template v-else>
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M9 4v16" />
              <path d="m16 15-3-3 3-3" />
            </template>
          </svg>
        </span>
      </button>
      <!-- 品牌字样：紧跟 LOGO 右侧，钉在同一 36px 带里（pointer-events:none，
           整条带仍是纯拖拽区，不给标题栏开新的可点区域） -->
      <img class="tb-name wm-dark" :src="logoWordmarkDark" alt="" aria-hidden="true" draggable="false" />
      <img class="tb-name wm-light" :src="logoWordmarkLight" alt="" aria-hidden="true" draggable="false" />
    </div>
    <!-- 整窗反光层（伪玻璃）：纯视觉，pointer-events:none -->
    <div class="shell-sheen" aria-hidden="true"></div>

    <section class="main-layout">
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <header class="workspace-header"></header>
        <div class="tree-panel" :class="{ 'is-code': codeOpenPath !== null }">
          <!-- 项目树：代码态下用 CSS 隐藏让位，而不是 v-if 卸载。
               ProjectTree 的展开/折叠/选中/滚动全是组件内 ref，v-if 卸载后全丢——
               用户「看一眼代码回来发现项目全折叠了」是最不能接受的体验。
               display:none 不销毁组件，ref 原样活着，视觉上仍是「整栏替换」，
               但退出代码态时展开态 / 选中项 / 滚动位置一点不差地回来。 -->
          <div class="tree-view" :class="{ 'is-hidden': codeOpenPath !== null }">
          <div class="sidebar-top">
            <div class="view-seg" :class="{ 'is-task': treeView === 'task' }" ref="viewSegEl" role="tablist" :aria-label="t('app.sessionListPerspective')">
              <button
                type="button"
                class="view-seg-btn"
                :class="{ active: treeView === 'project' }"
                @click="switchTreeView('project')"
              >{{ t('app.viewProject') }}</button>
              <button
                type="button"
                class="view-seg-btn"
                :class="{ active: treeView === 'task' }"
                @click="switchTreeView('task')"
              >{{ t('app.viewTask') }}</button>
            </div>
            <div class="sidebar-top-actions">
              <!-- ponytail: 不用 v-if/v-show——两者在 Vue 里都是 display:none，折叠按钮隐藏时
                   仍不占布局空间，导致 sidebar-top 高度从 44px 跳到 40px，
                   view-seg 在 center 对齐下上下跳 2px。用 visibility 保留占位。 -->
              <button
                type="button"
                class="fold-all-btn"
                :style="{
                  visibility: treeView === 'project' ? 'visible' : 'hidden',
                  pointerEvents: treeView === 'project' ? 'auto' : 'none',
                }"
                :aria-label="allCollapsed ? t('app.expandAllProjects') : t('app.collapseAllProjects')"
                :data-tooltip="allCollapsed ? t('app.expandAllProjects') : t('app.collapseAllProjects')"
                :tabindex="treeView === 'project' ? 0 : -1"
                @click="onFoldAll"
              >
                <svg v-if="allCollapsed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 展开全部：对角双箭头外扩 -->
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 收起全部：对角双箭头内收 -->
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          </div>
          <ProjectTree
            ref="projectTreeRef"
            :view="treeView"
            :projects="projects"
            :sessions="sessions"
            :current-project-path="currentProjectPath"
            :current-session-id="currentSessionId"
            :opened-session-ids="openedSessionIds"
            :code-open-path="codeOpenPath"
            @open-code="openCode"
            @select-project="selectProject"
            @remove-project="onRemoveProject"
            @clear-sessions="onClearProjectSessions"
            @rename-project="onRenameProject"
            @reorder-project="onReorderProjects"
            @create-session="onCreateSession"
            @select-session="onSelectSession"
            @delete-session="onDeleteSession"
            @rename-session="onRenameSession"
            @fold-state="allCollapsed = $event"
          />
          </div>

          <!-- 模块 12：左栏整栏切成代码树。与项目树同一位置的两个视图，不是嵌套关系 -->
          <CodeTreePanel
            v-if="codeOpenPath !== null"
            :project-path="codeOpenPath"
            :project-name="codeProjectName"
            :degraded="codeLayoutDegraded"
            :layout="codeViewerLayout"
            @back="closeCode"
            @toggle-layout="toggleCodeLayout"
          />
        </div>
        <div class="sidebar-footer">
          <button class="sidebar-link" @click="openSettings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{{ t('app.settings') }}</span>
          </button>
          <!-- 侧栏更新入口（07 改造）：仅更新相关时出现，紧跟设置 -->
          <UpdateEntry />
        </div>
        <!-- 右缘拖拽手柄：hover/拖拽时中缝高亮为品牌青绿 -->
        <div
          class="sidebar-resizer"
          :class="{ active: sidebarResizing }"
          role="separator"
          aria-orientation="vertical"
          :data-tooltip="t('app.resizeSidebar')"
          @pointerdown="onSidebarResizeStart"
          @pointermove="onSidebarResizeMove"
          @pointerup="onSidebarResizeEnd"
          @pointercancel="onSidebarResizeEnd"
        ></div>
      </aside>

      <div class="rightcol">
        <TitleBar @request-exit="requestExit" />
      <main class="content" :class="{ 'settings-mode': activeView === 'settings', 'code-mode': codeOpenPath !== null }">
      <!-- 模块 12：CodeExplorer 始终挂载并拥有这行 flex（无项目时退化为「只包对话列」）。
           不用「有项目才 v-if」：v-if 会把对话纸整块卸载重建，流式输出、滚动位置、
           输入框草稿全丢。始终挂载也让「谁决定布局」只有一个答案。 -->
      <CodeExplorer :project-path="codeOpenPath">
        <div v-if="sessionError" class="error-toast" @click="clearError">
          {{ sessionError }}
        </div>

        <div v-if="activeView !== 'settings'" class="app-toolbar">
          <button
            class="app-toolbar-btn"
            :data-tooltip="t('app.newSessionTooltip')"
            :disabled="projects.length === 0"
            @click="onCreateSession()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>{{ t('app.newSession') }}</span>
          </button>
          <button
            class="app-toolbar-btn"
            :class="{ 'is-active': multiWindow }"
            :data-tooltip="t('app.multiWindowTooltip')"
            @click="toggleMultiWindow"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
              <rect x="13" y="3" width="8" height="8" rx="1.5" />
              <rect x="3" y="13" width="8" height="8" rx="1.5" />
              <rect x="13" y="13" width="8" height="8" rx="1.5" />
            </svg>
            <span>{{ t('app.multiWindow') }}</span>
          </button>
          <template v-if="multiWindow">
            <button
              class="app-toolbar-btn"
              @click="mwCanvasRef?.arrangeAuto()"
            >
              <span>{{ t('app.autoLayout') }}</span>
            </button>
            <button
              class="app-toolbar-btn"
              @click="mwCanvasRef?.clearAll()"
            >
              <span>{{ t('app.closeAll') }}</span>
            </button>
          </template>
          <span class="app-toolbar-space"></span>
          <!-- 终端开关（模块 10 D5 定稿）：纯图标无边框，激活态品牌色底 -->
          <button
            class="app-toolbar-btn term-toggle"
            :class="{ 'is-active': terminalOpen }"
            :data-tooltip="t('terminal.toggle')"
            @click="setTerminalOpen(!terminalOpen)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
        </div>

        <section v-if="activeView === 'settings'" class="settings-stage">
          <SettingsPanel
            :theme-mode="themeMode"
            @theme-change="setTheme"
            @close="closeSettings"
          />
        </section>

        <template v-else>
          <!-- 多窗口画布模式 -->
          <div v-if="multiWindow" class="session-stage">
            <!-- 多窗口画布始终挂载，保留窗口布局 -->
            <MultiWindowCanvas
              ref="mwCanvasRef"
              :sessions="sessions"
              :models="models"
              @close="multiWindow = false"
              @focus-session="onMultiWindowFocus"
              @opened-change="onOpenedChange"
            />
            <!-- 窗口单会话聚焦层：不卸载画布，可返回多窗口 -->
            <div
              v-if="focusedSessionForWin && currentProject && currentSession"
              class="win-focus-overlay"
            >
              <div class="win-focus-bar">
                <button class="win-focus-back" @click="closeWinFocus">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </svg>
                  <span>{{ t('app.backToMultiWindow') }}</span>
                </button>
                <span class="win-focus-title">
                  {{ currentSession.alias || t('app.sessionFallback', { id: currentSession.sessionId.slice(-6) }) }}
                </span>
                <span class="win-focus-proj">{{ winFocusProjectName }}</span>
              </div>
              <ConversationView
                :session-id="currentSessionId!"
                :project="currentProject"
                :session="currentSession"
                :models="models"
                :current-model="currentSessionModel"
                :project-picker="projectPicker ?? undefined"
                @model-change="onModelChange"
                @pick-project="onPickProject"
                @open-project-picker="openFolderPicker"
                @remove-project="onRemoveProject"
              />
            </div>
          </div>
          <div v-else-if="currentProject" class="session-stage">
            <ConversationView
              ref="convRef"
              :session-id="currentSessionId"
              :project="currentProject"
              :session="currentSession"
              :models="models"
              :current-model="currentSessionModel"
              :project-picker="projectPicker ?? undefined"
              @model-change="onModelChange"
              @session-created="onSessionCreated"
              @pick-project="onPickProject"
              @open-project-picker="openFolderPicker"
              @remove-project="onRemoveProject"
            />
          </div>
          <!-- 零项目落地 hero（v3.77）：水印 + 居中输入框，项目区仅「打开项目…」入口 -->
          <LandingHero
            v-else
            :models="models"
            :current-model="currentSessionModel"
            :project-picker="projectPicker ?? undefined"
            @model-change="onModelChange"
            @pick-project="onPickProject"
            @open-project-picker="openFolderPicker"
            @remove-project="onRemoveProject"
          />
        </template>

        <!-- 内嵌终端面板（模块 10 D1）：.content 底部、session-stage 之后的兄弟节点；
             设置视图只 v-show 隐藏——组件保持挂载，tab/pty 在切设置往返间存活（收起保活同款语义） -->
        <TerminalPanel
          v-show="activeView !== 'settings'"
          :project-path="currentProjectPath"
          :project-name="terminalProjectName"
        />
      </CodeExplorer>
      </main>
      </div>
    </section>

    <TrustAskDialog
      v-if="trustAskPath !== null"
      :project-path="trustAskPath"
      :project-name="trustAskName"
      @decide="onTrustDecide"
    />

    <ExitConfirmDialog
      v-if="showExitDialog"
      @confirm="confirmExit"
      @cancel="showExitDialog = false"
    />

    <!-- 提交或推送弹窗（GC-S11）：入口在 InstructionInput 状态行 / BranchBadge 浮窗，经 useGitCommitDialog 单例开合 -->
    <GitCommitDialog />

    <!-- 版本更新说明弹窗（升级后首启自动弹 + 关于页回看）：useWhatsNew 单例开合 -->
    <WhatsNewDialog />

    <ToastNotification
      v-if="toastMessage"
      :key="toastSeq"
      :message="toastMessage"
      :type="toastType"
      @close="clearToast"
    />
  </div>
</template>

<style scoped>
/* v3.85.2 启动接管 veil（见 script 的 bootVeilLeaving 注释）。门闩期间它就是启动页本体
   （fixed 全屏自带底色，行为与原 100vh 布局等值）；放行后 opacity 淡出 200ms，把
   BootWelcome→正式 UI 的硬切变成连续过渡。z 档高于应用内一切浮层（dialog/toast 3000）。 */
.boot-veil {
  position: fixed;
  inset: 0;
  z-index: 4000;
  opacity: 1;
  transition: opacity 200ms ease-out;
}
.boot-veil-leaving {
  opacity: 0;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .boot-veil {
    transition: none;
  }
}

.app-container {
  height: 100vh;
  width: 100vw;
  /* 桌面层（「纸」层级）：浅色 #f7f7f6 / 深色 oklch(0.19 0.008 265)，见 design-tokens --desk；
     聊天主区 .content 在其上以「纸」浮起，层级 桌面 0 → 纸 1 → composer 2 */
  background: var(--desk);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.main-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
  overflow: hidden;
}

/* 一体化壳层：侧栏列通顶。左右结构不再靠整块压暗的色块台阶表达，
   而是同底色 + 左深右浅的淡出渐变 + 两端淡出的 1px 中缝（demo：prototypes/unified-shell-full.html） */
.sidebar {
  width: var(--sidebar-w, 292px);
  min-width: var(--sidebar-w, 292px);
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.035) 0%, rgba(0, 0, 0, 0.012) 72%, transparent 100%);
  transition: width var(--transition-base), min-width var(--transition-base), opacity var(--transition-base);
}

.sidebar::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 1px;
  /* 「纸」层级后，侧栏与主区之间是桌面留沟 + 纸缘阴影，1px 中缝不再承担分界（浅深色一致） */
  background: none;
}

/* 「纸」层级：侧栏属于桌面层（与标题栏/沟同一色），不再做"略高于主区的独立面"——
   原竖向微光会让左列与右侧大底的桌面色不一致（用户实测反馈），纸缘阶梯已替代它的职责 */
:root[data-theme='dark'] .sidebar {
  background: none;
}

.sidebar.collapsed {
  width: 0;
  min-width: 0;
  opacity: 0;
  pointer-events: none;
}

/* 拖拽调宽期间关掉宽度过渡，否则侧栏跟手滞后、松手后又继续滑行 */
.app-container.sidebar-resizing .sidebar {
  transition: none;
}

/* 右缘拖拽手柄：透明热区骑在中缝上（sidebar overflow:hidden，故全部置于内侧），
   hover/拖拽时以 2px 品牌青绿线覆盖默认 1px 灰缝作高亮反馈 */
.sidebar-resizer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 5;
  touch-action: none;
}

/* 高亮取 demo 方案 B 形态（两端渐隐的柔光段，中心前景色），但不自动流动：
   --seg-y 由 pointermove 写入视口 Y 坐标，鼠标停在哪光段就在哪；
   不做 top 过渡保证贴手；侧栏通顶且容器从 y=0 起，clientY 可直接用作 top */
.sidebar-resizer::after {
  content: '';
  position: absolute;
  top: var(--seg-y, 50%);
  right: 0;
  height: 110px;
  width: 2px;
  transform: translateY(-50%);
  border-radius: 1px;
  background: linear-gradient(180deg, transparent, color-mix(in oklab, var(--foreground) 65%, transparent) 50%, transparent);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.sidebar-resizer:hover::after,
.sidebar-resizer.active::after {
  opacity: 1;
}

/* 捕获指针后光标仍按命中元素渲染，拖拽中需在全局压住 col-resize 并禁选中 */
:global(body.sidebar-resizing) {
  cursor: col-resize;
  user-select: none;
}

.rightcol {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 侧栏列顶行：纯占位撑高 36px（拖拽已由窗口级 shell-topstrip 统一提供，
   此处不再声明 drag，避免与 toggle 悬浮洞产生同级重叠区） */
.workspace-header {
  height: 36px;
  min-height: 36px;
}

/* 窗口级顶部拖拽条：覆盖侧栏列顶部（含 toggle），toggle 作为其 no-drag 后代挖洞
   （Electron 只对后代做洞，同级悬浮元素会被 drag 吞掉交互）；宽度与侧栏同源
   （--sidebar-w），不伸进窗口按钮区。z 必须高于右列标题栏（200）：侧栏折叠后标题栏从 x=0 铺起，
   若标题栏 drag 叠在拖拽条之上，toggle 的洞会被其原生拖拽重新吞掉（折叠后无法展开） */
.shell-topstrip {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--sidebar-w, 292px);
  height: 36px;
  z-index: 205;
  -webkit-app-region: drag;
}

/* 折叠后右列从 x=0 铺起，右列标题栏的 drag 盒会盖住 toggle：Electron 的 no-drag
   洞只在自己的 drag 子树内生效（按祖先归属），跨子树重叠无效——所以折叠时标题栏
   整体让位一个侧栏宽度（--sidebar-w），该段顶部拖拽由 shell-topstrip 接管，两个 drag 区永不重叠 */
.app-container.sidebar-collapsed :deep(.titlebar) {
  margin-left: var(--sidebar-w, 292px);
  /* 覆盖 TitleBar 的 width:100%，否则整条右移把窗口按钮顶出可视区 */
  width: auto;
}

/* 悬浮 toggle：钉死窗口左上角，折叠/展开全程零位移，侧栏从它底下抽走 */
.shell-toggle {
  position: absolute;
  left: 8px;
  top: 2px;
  z-index: 2;
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.shell-toggle-mac {
  left: 78px;
}

.shell-toggle:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
  color: var(--foreground);
}

.tb-logo {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 24px;
  height: 24px;
  object-fit: contain;
  pointer-events: none;
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

/* 品牌字样（标题栏左上，跟在 LOGO 右侧）：同一对 public 字标按 data-theme 切版。
   亮度不用字标原色（纯黑 / 纯白）——36px 高的带子里纯色会压过旁边的图标；
   两主题分别降到与 toggle 图标 --muted-foreground 等亮（深 0.53 / 浅 0.58）。 */
.tb-name {
  position: absolute;
  left: 48px;
  top: 50%;
  transform: translateY(-50%);
  height: 11px;
  width: auto;
  display: none;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

:root:not([data-theme='light']) .tb-name.wm-dark,
:root[data-theme='light'] .tb-name.wm-light {
  display: block;
}

:root:not([data-theme='light']) .tb-name.wm-dark {
  opacity: 0.53;
}

:root[data-theme='light'] .tb-name.wm-light {
  opacity: 0.58;
}

/* macOS 红绿灯占掉左侧 78px，字样跟着 toggle 一起让位 */
.shell-topstrip-mac .tb-name {
  left: 118px;
}

.tb-panel {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: scale(0.85);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.shell-toggle:hover .tb-logo {
  opacity: 0;
  transform: scale(0.85);
}

.shell-toggle:hover .tb-panel {
  opacity: 1;
  transform: scale(1);
  color: var(--foreground);
}

.tb-panel svg {
  width: 18px;
  height: 18px;
}

/* 整窗反光层（伪玻璃）：窗口未开 transparent/vibrancy，设计稿的反光感用一层
   顶部椭圆柔光 + 右下角微光复现；纯视觉，压在 chrome 之上、悬浮 toggle 之下 */
.shell-sheen {
  position: absolute;
  inset: 0;
  z-index: 210;
  pointer-events: none;
  background:
    radial-gradient(120% 62% at 26% -12%, rgba(255, 255, 255, 0.55) 0%, transparent 58%),
    radial-gradient(80% 55% at 105% 108%, rgba(255, 255, 255, 0.3) 0%, transparent 60%);
}

/* 暗色：213.4° 对角线性光场 + 底部反光。
   与设计稿一致的整窗剖面：右上最亮向左下线性衰减、构造上无热点；
   盖顶而非沉底——面板保持不透明也被同一光场覆盖，整窗剖面连续。

   v6.1 可读性：峰值 0.096 → 0.035（衰减形状不变，整体等比缩到 0.365）。
   旧值把阅读区底色从 #0d0f13 抬到 #1f2228，**亮度差 3.35 倍**，而这层是 z-index:210
   盖在**文字之上**的——横向的色斑直接洗在正文行上，是「对话区看着脏」的主因
   （副因：用户气泡改冷调，见 MessageCard；文件类型徽章的 Linguist 色经复核保留）。
   0.035 下不均匀度降到 1.69 倍，正文对底色的对比从 10.10 回到 9.35，口感更平。

   v6.2 色带：0.035 → 0.006（衰减形状不变，整体等比缩到 0.171）。0.035 在 #18191d 纸面上
   整窗只把红通道从 25 抬到 29（总起伏 4/255），却因为分段色标斜率过缓——每 200~280px 才变化
   1 阶——8bit 取整后等值线退化成宽平台 + 硬直边（实测边界斜率 dy/dx≈0.71，正是 213.4° 的法线），
   在空状态整片平铺纸面上读作一条斜的「颜色切割条」：反光几乎看不见，色带却很明显。
   0.006 下整窗起伏 ≤1/255，等值线收进右上角，色带消失，剖面方向感仍在。 */
:root[data-theme='dark'] .shell-sheen {
  background:
    linear-gradient(213.4deg,
      rgba(205, 218, 235, 0.006) 0%,
      rgba(205, 218, 235, 0.003) 28%,
      rgba(205, 218, 235, 0.0015) 47%,
      rgba(205, 218, 235, 0.001) 60%,
      rgba(205, 218, 235, 0.0005) 72%,
      rgba(205, 218, 235, 0.000) 82%),
    linear-gradient(0deg, rgba(205, 218, 235, 0.0005) 0%, rgba(205, 218, 235, 0) 14%);
}

.tree-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
/* 代码态下项目树让位但**不卸载**：展开态/选中/滚动全是组件内 ref，
   v-if 卸载会让用户「看一眼代码回来发现项目全折叠了」。 */
.tree-view.is-hidden {
  display: none;
}

.tree-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-top {
  padding: 10px 18px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 视角分段开关（SM-S06）：项目 / 任务 */
.view-seg {
  position: relative;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  border-radius: 999px;
}

/* 滑动指示胶囊（果冻/水滴式）：不用整体平移，而是左右两条边各自动画。
   前进方向的那条边先行并带轻微回弹，另一条边延迟起步追随——
   途中胶囊被拉长成水滴，落位时两头先后回弹，形成 Q 弹的果冻收束感。
   位移方向不同 → 谁先谁后不同，故两套 transition 分别挂在两个状态上：
   基态（回到「项目」）左边先行；is-task（滑向「任务」）右边先行 */
.view-seg::before {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: var(--pill-l, 2px);
  right: var(--pill-r, calc(50% + 1px));
  border-radius: 999px;
  background: var(--surface-active);
  pointer-events: none;
  transition:
    left 240ms cubic-bezier(0.34, 1.45, 0.64, 1),
    right 260ms cubic-bezier(0.22, 0.61, 0.36, 1) 70ms;
}

/* 几何由 JS（--pill-l/--pill-r）按 active 按钮实测宽度给出，这里只切换方向时序 */
.view-seg.is-task::before {
  transition:
    right 240ms cubic-bezier(0.34, 1.45, 0.64, 1),
    left 260ms cubic-bezier(0.22, 0.61, 0.36, 1) 70ms;
}

/* 分段开关自身尺寸在变（侧栏宽度过渡 / 语言切换 / 首贴）：几何逐帧跟着贴，不播水滴。
   必须排在 .is-task 之后——两条选择器特异性相同，靠顺序取胜 */
.view-seg.no-anim::before {
  transition: none;
}

.view-seg-btn {
  position: relative; /* z 序抬到指示胶囊之上 */
  z-index: 1;
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--transition-fast);
}

.view-seg-btn.active {
  color: var(--foreground);
}

.view-seg-btn:not(.active):hover {
  color: var(--foreground);
}

.sidebar-top-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 收起全部/展开全部（仅项目视角）：无 边框 ghost 按钮（SM-S06）。
   默认隐藏，悬停侧栏顶部区/按钮自身或键盘聚焦时淡入（visibility 占位逻辑见模板注释，
   opacity 只负责显隐动画，两者叠加互不冲突） */
.fold-all-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: transparent;
  border: 0;
  color: var(--muted-foreground);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: background var(--transition-fast), color var(--transition-fast),
    opacity var(--transition-fast);
}

.sidebar-top:hover .fold-all-btn,
.fold-all-btn:hover,
.fold-all-btn:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.fold-all-btn:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
  color: var(--foreground);
}

.fold-all-btn svg {
  width: 15px;
  height: 15px;
}

.sidebar-footer {
  padding: 10px 12px 14px 28px;
  display: flex;
  align-items: center;
  gap: 18px;
}

.sidebar-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
}

.sidebar-link:hover {
  color: var(--foreground);
  background: transparent;
  border-color: transparent;
}

.sidebar-link svg {
  width: 16px;
  height: 16px;
}

.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
  overflow: hidden;
}

/* 代码态终端 = 全宽底部抽屉（CE-S10 终端唤醒的落位）：
   cover 布局的代码纸是 absolute inset:0 z-20 整张盖上去的，流内终端被压在纸**下面**
   （用户实测：右上角点了终端按钮但看不见面板）；split 下终端又只缩在左列底部，
   两种布局落点不一致。统一提为覆盖在纸之上的全宽抽屉（z-30 > 纸 z-20），
   宽度横贯 .content、grip 拖拽调高照旧；对话态（无 code-mode）保持原流内行为不动。
   锚定基准是 .content 自身的 position:relative（纸的定位参照同款，见上）。
   附注：分屏沟 .csp 是 z-60，恒压在这条抽屉之上——所以沟内那条 1px 竖线已删
   （CodeSplitter 宽度收到 4px），否则线会从纸顶一路画到终端顶边，读作「分割线伸进终端」。 */
.content.code-mode :deep(.term) {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
}

/* 「纸」层级（design-demos/light-theme-hierarchy.html 定稿，浅深色同构）：
   .content 成为浮在桌面上的纸 —— 四周留沟（上/右/下 10px、左 8px）+ 圆角 12 + --elev-sheet，
   取值随主题（浅色白纸 4~6.5%、深色黑投影 22~34%，见 design-tokens --elev-sheet）。
   纸面色 = --background：深色内容面不动，保住会话内「以 --card 抬卡片」的既有语言；
   composer 的 --elev-1/--elev-2 悬浮态原样保留，层级 桌面 0 → 纸 1 → 输入框 2；
   .content 自带 overflow:hidden，纸的圆角裁切与弹层行为与现状一致，无新增裁切风险。 */
.content {
  margin: 10px 10px 10px 8px;
  border-radius: 12px;
  position: relative;
  box-shadow: var(--elev-sheet);
}

/* 模块 12：对话列的布局规则已上收到 CodeExplorer（.cex-conv）。
   App 这里只负责一件事——.content 保持 position:relative，因为 cover 模式下
   代码纸是 absolute inset:0，靠它当定位参照；一旦改成 static 就会飞到窗口左上角。 */

/* 深色「纸」的边缘光：深色 UI 里唯一稳定有效的「抬起」信号（模拟纸边受光）。
   实现方式必须是伪元素覆盖层，不能用 inset 阴影或 outline：
   .content 带 overflow:hidden 且子元素（.app-toolbar / .conv-messages / .term）都铺到纸边，
   而 inset 阴影与 outline 都在子元素之下绘制 —— 实测三者左缘像素分别为
     inset   → 24（= 纸面色，完全被遮）
     outline → 24（同上）
     ::after → 33（可见）
   pointer-events:none 保证不拦点击，z-index 置于内容之上。 */
.content::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--paper-rim);
  border-radius: inherit;
  pointer-events: none;
  z-index: 5;
}

.content.settings-mode {
  padding: 16px 18px;
}

.app-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: color-mix(in oklab, var(--muted) 8%, var(--background));
  flex-shrink: 0;
}

/* 暗色（D 档）：工具栏去不透明底。设计稿顶部与光场是一体的（实测 27.7 连续），
   近不透明底会把对角光场切成「顶部亮带 + 下方暗区」的硬边界 */
:root[data-theme='dark'] .app-toolbar {
  background: transparent;
}

.app-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: none;
  border-radius: 999px;
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
  transition: background 0.12s ease, color 0.12s ease, transform 0.06s ease;
}

.app-toolbar-btn:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand);
}

/* 按下反馈：底色加深 + 轻微缩放，点击有明确"按到了"的效果 */
.app-toolbar-btn:active:not(:disabled) {
  background: color-mix(in oklab, var(--brand) 18%, var(--background));
  color: var(--brand);
  transform: scale(0.94);
}

.app-toolbar-btn.is-active {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 8%, var(--background));
  color: var(--brand);
}

.app-toolbar-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.app-toolbar-btn svg {
  width: 13px;
  height: 13px;
}

.app-toolbar-space {
  flex: 1;
}

/* 终端开关：纯图标方形按钮，无边框（用户 2026-09-29 去掉 1px 外框）；
   激活态底色/字色由 .is-active 既有规则接管 */
.app-toolbar-btn.term-toggle {
  padding: 6px;
  border: none;
  border-radius: var(--radius-md);
}

.app-toolbar-btn.term-toggle svg {
  width: 14px;
  height: 14px;
}

.session-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.win-focus-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: var(--background);
  display: flex;
  flex-direction: column;
  min-height: 0;
  animation: fadeIn 0.2s ease-out;
}

.win-focus-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 8%, var(--background));
}
.win-focus-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.win-focus-back:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.win-focus-back svg {
  width: 13px;
  height: 13px;
}
.win-focus-title {
  font-size: 12px;
  color: var(--muted-foreground);
}

/* 聚焦行项目 pill（SM-S06 多窗口配套）：点会话进来即可见归属项目 */
.win-focus-proj {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  background: color-mix(in oklab, var(--muted) 30%, transparent);
}

.settings-stage {
  flex: 1;
  min-height: 0;
  display: flex;
}

.error-toast {
  position: fixed;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3000;
  background: color-mix(in oklab, var(--destructive) 10%, var(--card));
  color: var(--foreground);
  padding: 10px 18px;
  border-radius: var(--radius-lg);
  font-size: 13px;
  cursor: pointer;
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, transparent);
  box-shadow: var(--shadow-lg);
  animation: fadeIn 0.2s ease-out;
  max-width: 70vw;
  text-align: center;
  word-break: break-word;
}
</style>
