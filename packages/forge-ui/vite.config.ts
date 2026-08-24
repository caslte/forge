import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * forge-ui Vite 配置。
 * base: './' 让打包产物用相对路径，供 Electron loadFile 加载。
 */
export default defineConfig({
  define: {
    'import.meta.env.FORGE_DEV_SERVER_ORIGIN': JSON.stringify(
      process.env.FORGE_DEV_SERVER_ORIGIN ?? '',
    ),
  },
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.FORGE_VITE_PORT ?? 5173),
    strictPort: true,
  },
});
