import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative paths: the Capacitor WebView serves the app from https://localhost/.
  base: './',
  plugins: [react()],
  // Debug builds keep a record of what the app spoke and did (src/debug.ts); release builds drop it.
  define: { __UCAP_DEBUG__: JSON.stringify(process.env.UCAP_RELEASE !== '1') },
  // The oldest WebView UCAP supports (lookup measured the shell down to Chromium 111).
  build: {
    target: 'chrome111',
    outDir: 'dist',
    emptyOutDir: true,
    // The browser's service worker (src/sw.ts) is its own entry, at a fixed name next to index.html.
    rollupOptions: {
      input: { main: 'index.html', sw: 'src/sw.ts' },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
  server: {
    port: 8812,
    host: '127.0.0.1',
    strictPort: true,
    // Vite serves files from the whole workspace; its default deny list plus the owner's local API keys.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '.secrets', '.secrets.*'] },
    // In the browser the app talks to the stack through Vite (same origin); the Capacitor app uses its server address.
    proxy: { '/api': { target: 'http://localhost:8810', ws: true } },
  },
});
