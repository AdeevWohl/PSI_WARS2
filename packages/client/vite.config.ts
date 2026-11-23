import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  server: { port: 5173, fs: { allow: [resolve(__dirname, '..', '..')] } },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  resolve: { alias: { '@data': resolve(__dirname, '..', '..', 'data') } },
});
