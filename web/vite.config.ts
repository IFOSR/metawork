import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 模式下把 API 与 WebSocket 代理到本地 metawork web 服务（默认 127.0.0.1:8788，
// 与 METAWORK_WEB_PORT 一致，便于与其他实例共存）。
// 生产模式由 metawork 直接托管 dist/，不走这里。
const webPort = Number(process.env.METAWORK_WEB_PORT?.trim() || 8788);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${webPort}`,
        changeOrigin: true,
        configure: proxy => {
          proxy.on('proxyReq', request => {
            request.setHeader('origin', `http://127.0.0.1:${webPort}`);
          });
        },
      },
      '/ws': {
        target: `ws://127.0.0.1:${webPort}`,
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
