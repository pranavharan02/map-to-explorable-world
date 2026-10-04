import { defineConfig } from 'vite';

// base './' keeps every URL relative, so the build works from any sub-path (GitHub Pages, a CDN folder, file servers)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
});
