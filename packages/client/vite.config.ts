import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  server: {
    port: 5173,
    fs: { allow: [resolve(__dirname, '..', '..')] },
    // In development the game server runs separately (npm run serve, port 8787).
    proxy: { '/api': 'http://localhost:8787', '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  resolve: { alias: { '@data': resolve(__dirname, '..', '..', 'data') } },
});
