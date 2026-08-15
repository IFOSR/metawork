import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 模式下把 API 与 WebSocket 代理到本地 metawork web 服务（127.0.0.1:8788）。
// 生产模式由 metawork 直接托管 dist/，不走这里。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8788',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
