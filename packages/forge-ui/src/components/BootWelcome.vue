<script setup lang="ts">
/**
 * 启动欢迎页（v3.87）：bootReady 门闩期间唯一可见界面。
 *
 * 硬约束：本组件在主进程 forge-core（含 pi SDK）组装完成期间显示，此时渲染进程
 * 主线程是唯一空闲资源——严禁在此 import renderMarkdown/hljs 等重模块或发任何
 * forge:invoke 请求（invoke handler 尚未注册）。底色走 --background 设计令牌
 * （与 index.html splash、正式 UI 三处同源，v3.78.5/v3.78.6）。
 *
 * v3.85.2 接管无缝铁律（用户报「加载页 FORGE 字样闪一下」的两处根因都在这）：
 * 1) 字标必须**静态在场**——曾有 0.4s 入场动画，在 splash（静态）被替换的瞬间重放
 *    = 字消失再淡入；不得再加任何 enter 动画。
 * 2) 字标必须与 splash 用**同一 URL**——曾有 src/assets 下的第二份同名文件，交接时
 *    新 URL 重新拉取解码，盒子先塌 0 再弹出。经 BASE_URL 拼 public 相对路径
 *    （dev '/'、prod './' 与 index.html 的 './logo-…' 解析到同一资源）。
 * 3) 尺寸与 LandingHero/conv-hero 同档（320px），全链路字标只有一个宽度。
 *
 * v3.87 氛围动效（G 档「心跳 · 循环」）：字直接在场、零入场动画。入场路线
 * （A 柔边擦除 / B 逐字升起 / C 锻打）全部废弃——逐字动画必须动 SVG 内部，
 * 拿不到合成器加速，真机预热期 CPU 被吃满时必卡（家族对照与取舍记录见
 * prototypes/boot-wordmark-entrance.html）。心跳循环挂在专用包裹层
 * .boot-wordmark-breath 上，**字标元素本身仍保持无动画**（bootHandoff-002 锁定），
 * 入场重放 bug 类在结构上不可能复发。循环相位无关：无发令、无最少停留、无兜底；
 * 交接帧安全由 0% 关键帧 = 满实（= splash 静态终态）保证。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const wmDark = import.meta.env.BASE_URL + 'logo-wordmark-on-dark.svg';
const wmLight = import.meta.env.BASE_URL + 'logo-wordmark-on-light.svg';

/**
 * 轮换文案：纯前端节奏，与主进程进度无关联（避免虚假进度条）。
 * v3.78：预热（pi 扩展加载，4.4~6s 同步冻结主进程）挪进了欢迎页窗口期，
 * 欢迎页常态时长从 ~2.7s 变 4~7s——轮换节奏放慢到 1600ms、档位加到四档，
 * 覆盖预热窗口；最后一档如实告知「还需几秒」，不承诺精确进度。
 */
const PHASES = computed(() => [
  t('app.bootPhasePrepareEnv'),
  t('app.bootPhaseLoadEngine'),
  t('app.bootPhaseSessionEngine'),
  t('app.bootPhaseAlmostReady'),
]);
const phaseIndex = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    if (phaseIndex.value < PHASES.value.length - 1) phaseIndex.value += 1;
  }, 1600);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});
</script>

<template>
  <div class="boot-welcome">
    <!-- 氛围动效专用包裹层：心跳只挂这里，两个字标 img 保持零动画（见文件头 v3.87 说明） -->
    <div class="boot-wordmark-breath" aria-hidden="true">
      <img class="boot-wordmark wm-dark" :src="wmDark" alt="FORGE" width="320" height="42" aria-hidden="true" draggable="false" />
      <img class="boot-wordmark wm-light" :src="wmLight" alt="FORGE" width="320" height="42" aria-hidden="true" draggable="false" />
    </div>
    <div class="boot-phase" role="status">{{ PHASES[phaseIndex] }}…</div>
  </div>
</template>

<style scoped>
.boot-welcome {
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--background);
  user-select: none;
}
/* 启动页仅字标（纯黑白，深浅主题各一版），不再放图形 LOGO。
   320px = LandingHero/conv-hero 同档（v3.85.2），接管零尺寸变化；无入场动画 */
.boot-wordmark {
  display: none;
  width: 320px;
  height: auto;
  user-select: none;
}
:root:not([data-theme='light']) .boot-wordmark.wm-dark,
:root[data-theme='light'] .boot-wordmark.wm-light {
  display: block;
}
/* 浅色主题下纯黑字标对比过强，降透明度柔化（与首屏同参数） */
:root[data-theme='light'] .boot-wordmark.wm-light {
  opacity: 0.8;
}

/* ---- v3.87 氛围动效：G 档「心跳 · 循环」（参数原样搬自 prototypes 的 G 档）----
   双搏脉冲后歇拍：两下快而深的透明度下探（心跳的 lub-dub），随后完全静止约 1.9s。
   挂在包裹层（HTML 元素）而非 img/内部：opacity 可走合成器线程，预热挤满主线程
   也照常 60fps。浅色主题字标本体自带 opacity .8，与父层脉冲相乘（谷值 .44），
   与 demo 的 calc(var(--wm-op) * x) 逐像素等效。 */
.boot-wordmark-breath {
  animation: boot-wm-heartbeat 3000ms ease-in-out infinite;
}
@keyframes boot-wm-heartbeat {
  0% {
    opacity: 1;
  }
  6% {
    opacity: 0.72;
  }
  12% {
    opacity: 0.88;
  }
  20% {
    opacity: 0.55;
  }
  32%,
  100% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  /* 减动效：循环整体消失，字标静态满实在场（基线即无动画态，无需补终态） */
  .boot-wordmark-breath {
    animation: none;
  }
}
.boot-phase {
  font-size: 13px;
  color: var(--muted-foreground);
  min-height: 1.4em; /* 文案轮换时高度稳定，不跳动 */
}
</style>
