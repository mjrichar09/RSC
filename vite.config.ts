import { defineConfig } from 'vite';

export default defineConfig({
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
