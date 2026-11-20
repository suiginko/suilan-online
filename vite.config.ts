import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  /* 产物目录叫 web 不叫 dist：发布工具会把 dist/ 当成构建产物排除在打包之外，
     结果线上前端永远停在旧版本（server/index.ts 也优先读 web）。 */
  build: { outDir: 'web' },
  server: {
    host: '0.0.0.0',
    port: 5178,
    allowedHosts: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5178,
    allowedHosts: true,
  },
});
