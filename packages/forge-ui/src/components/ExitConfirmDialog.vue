<script setup lang="ts">
const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <div class="overlay" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="exit-title">
      <header class="dialog-header">
        <h2 id="exit-title" class="dialog-title">确认退出</h2>
        <button class="ghost dialog-close" aria-label="关闭" @click="emit('cancel')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div class="dialog-body">
        <p class="dialog-text">是否关闭 forge 窗口？</p>
      </div>

      <footer class="dialog-footer">
        <button @click="emit('cancel')">取消</button>
        <button class="danger" @click="emit('confirm')">退出</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--transition-base);
}

.dialog {
  width: 380px;
  max-width: calc(100vw - 48px);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.dialog-close {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog-close svg {
  width: 16px;
  height: 16px;
}

.dialog-body {
  display: flex;
}

.dialog-text {
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
