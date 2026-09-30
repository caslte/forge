<script setup lang="ts">
/**
 * 工具调用行（Qoder 式扁平风格）：状态点 + 动作标签 + 参数 pill/plain，
 * 行内展开详情（左右双栏 diff / 结果文本）。无卡底、无状态徽章。
 * 类名 .tool-calls / .tool-calls-head 被 e2e 依赖，勿改名。
 */
import { computed, ref } from 'vue';
import type { ToolEvent } from '../types';
import { parseFileToolInput } from '../composables/useChangedFiles';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import DiffView from './DiffView.vue';

const { t } = useI18n();

const props = defineProps<{
  event: ToolEvent;
  hideDiff?: boolean;
}>();

const open = ref(false);

/** 工具名 → i18n 键（与 useStreamPhase 口径对齐）；key 是与后端工具名比对的逻辑串不动，展示值进字典；未知工具回退原名 */
const TOOL_LABELS: Record<string, MessageKey> = {
  ask_user_question: 'tool.askUser',
  read: 'tool.readFile',
  view: 'tool.readFile',
  write: 'tool.writeFile',
  apply_patch: 'tool.writeFile',
  edit: 'tool.editFile',
  multi_edit: 'tool.editFile',
  bash: 'tool.runCommand',
  powershell: 'tool.runCommand',
  shell: 'tool.runCommand',
  grep: 'tool.searchContent',
  find: 'tool.findFile',
  glob: 'tool.findFile',
  ls: 'tool.listDir',
  websearch: 'tool.webSearch',
  web_search: 'tool.webSearch',
  webfetch: 'tool.webFetch',
  web_fetch: 'tool.webFetch',
  todo: 'tool.updateTodo',
  agent: 'tool.spawnAgent',
  get_subagent_result: 'tool.waitAgentResult',
  steer_subagent: 'tool.steerAgent',
  subagentworkflow: 'tool.runAgentWorkflow',
};

/** 展示用工具名：有中文映射用中文，否则回退原始工具名 */
const displayName = computed(() => {
  const name = props.event.toolName;
  if (!name) return t('tool.fallbackName');
  const key = TOOL_LABELS[name.toLowerCase()];
  return key ? t(key) : name;
});

/** 问卷工具：标题摘要直接显示问题文本（比英文结果易懂） */
const askQuestions = computed<string[]>(() => {
  if ((props.event.toolName ?? '').toLowerCase() !== 'ask_user_question') return [];
  const input = props.event.input as { questions?: unknown } | undefined;
  const list = Array.isArray(input?.questions) ? input.questions : [];
  return list
    .map((q) => (q as { question?: unknown })?.question)
    .filter((q): q is string => typeof q === 'string' && q.trim() !== '');
});

const firstAskQuestion = computed(() => {
  if (askQuestions.value.length === 0) return '';
  const first = askQuestions.value[0] ?? '';
  return askQuestions.value.length > 1
    ? t('tool.askMultiQuestions', { question: first, n: askQuestions.value.length })
    : first;
});

/** 行参数：文件路径类取 basename 上 pill；命令/搜索/网页类与问卷问题用等宽 plain 文本 */
const FILE_ARG_KEYS = ['file_path', 'path'];
const PLAIN_ARG_KEYS = ['command', 'url', 'query', 'pattern'];

const arg = computed<{ text: string; plain: boolean } | null>(() => {
  if (askQuestions.value.length > 0) return { text: firstAskQuestion.value, plain: true };
  const input = props.event.input;
  if (input && typeof input === 'object') {
    for (const key of FILE_ARG_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '') {
        const path = value.trim();
        const base = path.replace(/\\/g, '/').split('/').pop() || path;
        return { text: base, plain: false };
      }
    }
    for (const key of PLAIN_ARG_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return { text: value.replace(/\s+/g, ' ').trim(), plain: true };
      }
    }
  }
  const s = props.event.summary;
  if (s) return { text: s.replace(/\s+/g, ' ').trim(), plain: true };
  return null;
});

/** 文件类型小图标：扩展名 → 品牌色单字标（Seti 风格，如 TS 蓝 / Vue 绿）；色值是品牌色不随主题变 */
const FILE_TYPE_ICONS: Record<string, { label: string; cls: string }> = {
  ts: { label: 'TS', cls: 'ft-ts' },
  tsx: { label: 'TS', cls: 'ft-ts' },
  mts: { label: 'TS', cls: 'ft-ts' },
  cts: { label: 'TS', cls: 'ft-ts' },
  js: { label: 'JS', cls: 'ft-js' },
  jsx: { label: 'JS', cls: 'ft-js' },
  mjs: { label: 'JS', cls: 'ft-js' },
  cjs: { label: 'JS', cls: 'ft-js' },
  vue: { label: 'VUE', cls: 'ft-vue' },
  json: { label: '{}', cls: 'ft-json' },
  md: { label: 'MD', cls: 'ft-md' },
  css: { label: '#', cls: 'ft-css' },
  scss: { label: '#', cls: 'ft-scss' },
  html: { label: '<>', cls: 'ft-html' },
  py: { label: 'PY', cls: 'ft-py' },
  java: { label: 'JAVA', cls: 'ft-java' },
  go: { label: 'GO', cls: 'ft-go' },
  c: { label: 'C', cls: 'ft-c' },
  h: { label: 'C', cls: 'ft-c' },
  cpp: { label: 'CPP', cls: 'ft-cpp' },
  cc: { label: 'CPP', cls: 'ft-cpp' },
  cxx: { label: 'CPP', cls: 'ft-cpp' },
  hpp: { label: 'CPP', cls: 'ft-cpp' },
  cs: { label: 'CS', cls: 'ft-cs' },
  rs: { label: 'RS', cls: 'ft-rs' },
  rb: { label: 'RB', cls: 'ft-rb' },
  php: { label: 'PHP', cls: 'ft-php' },
  kt: { label: 'KT', cls: 'ft-kt' },
  kts: { label: 'KT', cls: 'ft-kt' },
};

/** 文件名 pill 的类型图标：取 basename 末段扩展名（.spec.ts → TS）；仅文件类参数，命令/搜索 pill 不显示 */
const fileIcon = computed(() => {
  if (!arg.value || arg.value.plain) return null;
  const m = /\.([a-z0-9]+)$/i.exec(arg.value.text);
  return m ? (FILE_TYPE_ICONS[m[1]!.toLowerCase()] ?? null) : null;
});

/** 展开正文的结果文本：问卷回包英文前缀换成本地化文案，其余原样展示 */
const displaySummary = computed(() => {
  const s = props.event.summary;
  if (!s) return '';
  return s.replace(/^User has answered your questions:/, t('tool.answeredPrefix'));
});

/** 修改文件类工具的 diff 列表（pi edit 多 hunk 逐块一项；形状判定共享 parseFileToolInput，
 *  同时兼容 pi 真实 {path,edits}/{path,content} 与旧形状 {file_path,old_string,new_string}） */
const diffs = computed(() => {
  const parsed = parseFileToolInput(props.event.input);
  if (!parsed) return [];
  return parsed.parts.map((part, i) => ({
    filePath: parsed.path,
    oldString: part.oldText,
    newString: part.newText,
    showPath: i === 0,
  }));
});

const hasDetail = computed(() => (!props.hideDiff && diffs.value.length > 0) || displaySummary.value !== '');
</script>

<template>
  <div :class="['tool-calls trow', `tool-${event.status}`, { open }]">
    <button class="tool-calls-head trow-line" @click="open = !open">
      <!-- 状态图标叠放同格：根节点 tool-{status} 类驱动交叉淡化+对勾描线（0.5x 节奏，见 design-tokens --motion-*），
           不再 v-if 硬切；历史加载/折叠展开直接呈现终态，无首帧过渡 -->
      <span class="icon-slot" aria-hidden="true">
        <svg
          class="ico spinner"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        ><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        <svg
          class="ico ok"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        ><circle cx="12" cy="12" r="9" pathLength="1" /><polyline points="8.5 12.2 11 14.7 15.5 9.8" pathLength="1" /></svg>
        <svg
          class="ico err"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        ><circle cx="12" cy="12" r="9" /><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" /></svg>
      </span>
      <span class="lbl">{{ displayName }}</span>
      <span v-if="arg" :class="['arg', { plain: arg.plain }]">
        <span v-if="fileIcon" :class="['ft-ico', fileIcon.cls]" aria-hidden="true">{{ fileIcon.label }}</span>
        <span class="arg-text">{{ arg.text }}</span>
      </span>
    </button>
    <div class="trow-shell">
      <div class="trow-inner">
        <div v-if="hasDetail" class="trow-detail">
          <template v-if="!hideDiff">
            <DiffView
              v-for="(diff, i) in diffs"
              :key="i"
              class="tc-diff"
              :file-path="diff.showPath ? diff.filePath : null"
              :highlight-path="diff.filePath"
              :old-string="diff.oldString"
              :new-string="diff.newString"
            />
          </template>
          <pre v-if="displaySummary" class="tool-summary">{{ displaySummary }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-calls {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
}

.trow-line {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: calc(100% + 6px);
  padding: 4px 6px;
  margin-left: -6px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--muted-foreground);
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
  transition: background var(--transition-fast);
}

.trow-line:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
}

/* 状态图标叠放：三 svg 同格，状态类切换只动 opacity/scale/dashoffset */
.icon-slot {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.icon-slot > svg {
  grid-area: 1 / 1;
}

.ico {
  width: 15px;
  height: 15px;
}

.ico.ok {
  color: var(--success);
}

.ico.err {
  color: var(--destructive);
}

@keyframes tc-spin {
  to {
    transform: rotate(360deg);
  }
}

.ico.spinner {
  color: var(--muted-foreground);
  animation: tc-spin 0.9s linear infinite;
  transition: opacity var(--motion-icon-out);
}

.ico.ok,
.ico.err {
  opacity: 0;
  transform: scale(0.7);
  transition:
    opacity var(--motion-icon-in) calc(var(--motion-icon-out) / 2),
    transform var(--motion-icon-in) calc(var(--motion-icon-out) / 2);
}

/* 完成/失败：spinner 淡出并暂停旋转（避免定格随机角度被看见），对勾/叉淡入放大 */
.tool-completed .ico.spinner,
.tool-error .ico.spinner {
  opacity: 0;
  animation-play-state: paused;
}

.tool-completed .ico.ok,
.tool-error .ico.err {
  opacity: 1;
  transform: scale(1);
}

/* 对勾描线：pathLength=1，圆环先画、折线延迟接上 */
.ico.ok circle,
.ico.ok polyline {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transition: stroke-dashoffset var(--motion-check-draw);
}

.ico.ok circle {
  transition-delay: calc(var(--motion-icon-out) / 2);
}

.ico.ok polyline {
  transition-delay: calc(var(--motion-icon-out) / 2 + var(--motion-check-draw) * 0.45);
}

.tool-completed .ico.ok circle,
.tool-completed .ico.ok polyline {
  stroke-dashoffset: 0;
}

.lbl {
  flex-shrink: 0;
  white-space: nowrap;
}

.arg {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--foreground);
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 1px 8px 2px;
  white-space: nowrap;
  min-width: 0;
}

.arg-text {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 文件类型小标：Seti 式品牌色圆角方标 + 单字标（TS 蓝 / JS 黄 / Vue 绿…）；色值是品牌色，不随明暗主题变。
   v6.1 可读性调整时曾把它去饱和成单色方标，**用户定稿撤回**——颜色本身承载信息
   （一眼看出改的是 TS 还是 Vue），不是装饰性噪点，在抬亮后的底色上对比也依然够。 */
.ft-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 3.5px;
  font-family: var(--font-mono);
  font-size: 7.5px;
  font-weight: 700;
  /* 行高必须等于方标高度：line-height:1 的负 half-leading 会把字形整体顶到方标上方（实测偏上 1.5px），
     行高等于 14px 时 half-leading 正好抵消字体 ascent/descent 的不对称，字标才真正垂直居中 */
  line-height: 14px;
  letter-spacing: -0.3px;
  color: #fff;
  user-select: none;
}

.ft-ts { background: #3178c6; }
.ft-js { background: #f0db4f; color: #323302; }
.ft-vue { background: #42b883; }
.ft-json { background: #cbcb41; color: #4d4d00; }
.ft-md { background: #519aba; }
.ft-css { background: #519aba; }
.ft-scss { background: #cd6799; }
.ft-html { background: #e37933; }
.ft-py { background: #3572a5; }

/* 后端/系统语言：色值取 GitHub Linguist 语言色；JAVA 四字母用 17px 宽标；GO/RS 浅底配深字标（同 JS 黄的做法） */
.ft-java { background: #b07219; width: 17px; }
.ft-go { background: #00add8; color: #083d4d; }
.ft-c { background: #555555; }
.ft-cpp { background: #f34b7d; }
.ft-cs { background: #178600; }
.ft-rs { background: #dea584; color: #5a3417; }
.ft-rb { background: #701516; }
.ft-php { background: #4f5d95; }
.ft-kt { background: #7f52ff; }

/* 命令/搜索类参数：等宽但无底，避免整行都是灰块 */
.arg.plain {
  background: none;
  border-color: transparent;
  color: var(--muted-foreground);
  padding-left: 0;
}

/* 行展开详情：0fr↔1fr 网格动画，diff 与行状态点再缩进 23px 对齐 pill 左缘 */
.trow-shell {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-base);
}

.tool-calls.open .trow-shell {
  grid-template-rows: 1fr;
}

.trow-inner {
  min-height: 0;
  overflow: hidden;
}

.trow-detail {
  margin: 4px 0 8px 23px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--muted);
}

/* diff 块保持自己的浅底面板：否则 .diff-file 头部的 --muted 与灰底容器同色糊成一片 */
.trow-detail :deep(.diff-view) {
  background: var(--background);
}

/* 多 hunk 时多个 DiffView 的纵向间距 */
.tc-diff + .tc-diff {
  margin-top: 8px;
}

.tool-summary {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  max-height: 180px;
  overflow-y: auto;
}
</style>
