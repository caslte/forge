import { createApp } from 'vue';
import App from './App.vue';
// JetBrains Mono 随应用分发（OFL 1.1）：代码查看器的行号列宽就是按它量的，
// 不能靠系统装。必须在 design-tokens.css 之前导入？—— 顺序无关（@font-face 只注册），
// 但放在 token 之前读起来更顺：先有字体，再有引用它的 token。
import './assets/fonts/jetbrains-mono.css';
import './design-tokens.css';
import './global.css';
import './tooltip';
import './selectionPopover';

// 浏览器 dev 预览：无 Electron bridge 时注入内存种子数据（不含于生产构建）
if (import.meta.env.DEV) {
  const { ensureDevBridge } = await import('./mock-bridge');
  ensureDevBridge();
}

createApp(App).mount('#app');
