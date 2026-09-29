<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

/**
 * Mermaid 图表渲染组件（P2-C）。
 *
 * 输入：base64 编码的 mermaid 源码（来自 renderMarkdown 输出的 md-mermaid 占位）。
 * - 渲染成功：替换为 mermaid 生成的 SVG。
 * - 语法非法 / 渲染异常：降级显示原始代码 + 错误提示，不崩溃、不影响消息流。
 * - 并发控制：mermaid.initialize 全局配置 securityLevel='strict' 且只允许 http/https 资源，
 *   由 MessageCard 在消息结束时批量扫描占位并逐个渲染。
 */
const props = defineProps<{
  /** base64 编码的 mermaid 源码 */
  encoded: string;
}>();

let source = '';
try {
  // base64 → UTF-8（编码端为 UTF-8 base64；仅 atob 会得到 Latin-1 二进制串，需 TextDecoder 还原）
  const binary = atob(props.encoded);
  source = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
} catch {
  source = '';
}

const svg = ref('');
const error = ref<string | null>(null);
/** 源码不是任何 mermaid 图类型（如模型把 ASCII 框图误包进 ```mermaid 围栏）：按代码块展示，不弹红色报错 */
const notMermaid = ref(false);

// mermaid 渲染结果（mermaid.render 返回 { svg } 或字符串视图，随版本略异）
type RenderResult = { svg: string } | string;

let disposed = false;

onMounted(async () => {
  if (!source.trim()) {
    error.value = t('tool.mermaidEmpty');
    return;
  }
  try {
    const mermaid = await import('mermaid');
    mermaid.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
      // 只允许 http/https 外部图片资源；theme CSS 内联，避免 CSP 外链
      themeVariables: {},
    });
    const id = `forge-mermaid-${Math.random().toString(36).slice(2, 10)}`;
    const rendered = await mermaid.default.render(id, source);
    const svgText = typeof rendered === 'string' ? rendered : rendered.svg;
    if (disposed) return;
    // 包裹一层容器补齐 svg 内联样式缺失时的基础尺寸
    svg.value = svgText;
  } catch (e) {
    if (disposed) return;
    const msg = e instanceof Error ? e.message : String(e);
    // mermaid detectType 失败（内容不是图语法）：源码本来就不可渲染，按普通代码块展示即可
    if (msg.includes('No diagram type detected')) {
      notMermaid.value = true;
    } else {
      error.value = msg;
    }
  }
});

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div class="md-mermaid-block">
    <!-- 渲染成功：mermaid SVG -->
    <div v-if="svg" class="md-mermaid-svg" v-html="svg"></div>
    <!-- 渲染失败 / 空：降级显示原始代码 + 错误提示 -->
    <div v-else class="md-mermaid-fallback">
      <div v-if="error" class="md-mermaid-error">{{ t('tool.mermaidFailed') }}{{ error }}</div>
      <div v-else-if="notMermaid" class="md-mermaid-hint">{{ t('tool.mermaidNotDiagram') }}</div>
      <pre class="md-mermaid-source"><code>{{ source }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.md-mermaid-block {
  margin: 10px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--foreground) 3%, var(--background));
  padding: 10px 12px;
  overflow-x: auto;
}

.md-mermaid-svg :deep(svg) {
  max-width: 100%;
  height: auto;
}

.md-mermaid-error {
  font-size: 12px;
  color: var(--destructive);
  margin-bottom: 8px;
}

.md-mermaid-hint {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-bottom: 8px;
}

.md-mermaid-source {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  color: var(--foreground);
}
</style>