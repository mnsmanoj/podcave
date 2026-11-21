import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Keep everything as same-origin files so the strict CSP (no inline scripts) holds.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
