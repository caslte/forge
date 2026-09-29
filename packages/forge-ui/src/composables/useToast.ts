/**
 * Toast 通知 composable。全局单一 toast，success/info/error 三类。
 * 自动消失/hover 暂停/退场动画由 ToastNotification.vue 自持（对齐右下角系统通知的
 * 交互），这里只保存内容与类型；seq 供 App.vue 作为组件 key，同文案连发也能重置计时。
 */
import { ref } from 'vue';

export type ToastType = 'success' | 'info' | 'error';

const message = ref('');
const type = ref<ToastType>('success');
const seq = ref(0);

function show(msg: string, t: ToastType = 'success'): void {
  message.value = msg;
  type.value = t;
  seq.value += 1;
}

function clear(): void {
  message.value = '';
}

export function useToast() {
  return {
    message,
    type,
    seq,
    show,
    clear,
    success: (msg: string) => show(msg, 'success'),
    info: (msg: string) => show(msg, 'info'),
    error: (msg: string) => show(msg, 'error'),
  };
}
