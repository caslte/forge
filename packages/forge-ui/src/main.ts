import { createApp } from 'vue';
import App from './App.vue';
import './design-tokens.css';
import './global.css';
import './tooltip';

// 浏览器 dev 预览：无 Electron bridge 时注入内存种子数据（不含于生产构建）
if (import.meta.env.DEV) {
  const { ensureDevBridge } = await import('./mock-bridge');
  ensureDevBridge();
}

createApp(App).mount('#app');
