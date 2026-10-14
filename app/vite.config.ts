import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths: the Capacitor WebView serves the app from https://localhost/.
  base: './',
  plugins: [react()],
  // Debug builds keep a record of what the app spoke and did (src/debug.ts); release builds drop it.
  define: { __UCAP_DEBUG__: JSON.stringify(process.env.UCAP_RELEASE !== '1') },
  // The oldest WebView UCAP supports (lookup measured the shell down to Chromium 111).
  build: { target: 'chrome111', outDir: 'dist', emptyOutDir: true },
  server: {
    port: 8812,
    host: '127.0.0.1',
    strictPort: true,
    // In the browser the app talks to the stack through Vite (same origin); the Capacitor app uses its server address.
    proxy: { '/api': { target: 'http://localhost:8810', ws: true } },
  },
});
