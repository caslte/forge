/**
 * Toast 通知 composable。全局单一 toast，success/info/error 三类。
 */
import { ref } from 'vue';

export type ToastType = 'success' | 'info' | 'error';

const message = ref('');
const type = ref<ToastType>('success');
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function show(msg: string, t: ToastType = 'success'): void {
  message.value = msg;
  type.value = t;
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
  }
  hideTimer = setTimeout(() => {
    message.value = '';
    hideTimer = null;
  }, 3000);
}

function clear(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  message.value = '';
}

export function useToast() {
  return {
    message,
    type,
    show,
    clear,
    success: (msg: string) => show(msg, 'success'),
    info: (msg: string) => show(msg, 'info'),
    error: (msg: string) => show(msg, 'error'),
  };
}
