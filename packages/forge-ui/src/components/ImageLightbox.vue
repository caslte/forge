<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';

/**
 * 图片全屏弹窗（lightbox）：半透明遮罩 + 居中原图。
 * 滚轮缩放（以鼠标位置为中心，1x~8x，缩回 1x 复位），Esc / 点击遮罩关闭。
 * 单窗口、多窗口、输入框待发预览共用。
 */
const props = defineProps<{
  /** 要展示的图片 data URL；null = 关闭 */
  src: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const MIN_SCALE = 1;
const MAX_SCALE = 8;

const scale = ref(1);
const tx = ref(0);
const ty = ref(0);

/** 打开/换图时复位缩放与偏移 */
watch(
  () => props.src,
  () => {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
  },
);

/**
 * 滚轮缩放：光标点在缩放前后保持不动。
 * 光标相对图片中心的偏移 p 满足 (p - t) * s = p - t'，得 t' = p - (p - t) * (s'/s)。
 */
function onWheel(e: WheelEvent): void {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  if (next === scale.value) return;
  const px = e.clientX - window.innerWidth / 2;
  const py = e.clientY - window.innerHeight / 2;
  const k = next / scale.value;
  tx.value = px - (px - tx.value) * k;
  ty.value = py - (py - ty.value) * k;
  scale.value = next;
  // 缩回初始大小即复位居中
  if (scale.value === MIN_SCALE) {
    tx.value = 0;
    ty.value = 0;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.src) emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <!-- Teleport 到 body：消息气泡的 rise 动画带 transform，会把 fixed 定位劫持为气泡内（弹窗被困在气泡里） -->
  <Teleport to="body">
    <div v-if="src" class="lightbox" @wheel.prevent="onWheel" @click.self="emit('close')">
      <img
        :src="src"
        class="lightbox-img"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        draggable="false"
        alt=""
      />
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.8);
  overflow: hidden;
  animation: lb-fade 0.15s ease;
  user-select: none;
}

.lightbox-img {
  max-width: 92vw;
  max-height: 92vh;
  cursor: default;
}

@keyframes lb-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
