import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The React dashboard builds to ./dist, which the Fastify server (src/index.ts)
// serves on :4801 with a same-origin /api/* proxy to the API. In `vite dev` we
// reproduce that proxy so the app talks to a locally-running API on :4800.
const API = process.env.API_URL ?? 'http://localhost:4800';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4811,
    proxy: {
      '/api': { target: API, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/docs': { target: API, changeOrigin: true },
      '/openapi.json': { target: API, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
