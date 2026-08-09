import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * forge-ui Vite 配置。
 * base: './' 让打包产物用相对路径，供 Electron loadFile 加载。
 */
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
