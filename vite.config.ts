import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site from a subdirectory, so the built asset
  // URLs have to carry it; everywhere else the game lives at the root. Reading
  // `process.env` is fine *here* — this file runs in Node at build time, not in
  // the browser, which is the rule `src/` has to follow.
  base: process.env.GITHUB_ACTIONS ? '/RSC/' : '/',
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // three.js and Rapier are large and change only on a dependency bump,
        // so they get their own chunks and stay cached across game updates.
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  // Rapier's compat build ships wasm inlined as base64, so no plugin is needed.
  optimizeDeps: { exclude: [] },
});
