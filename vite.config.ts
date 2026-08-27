import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  build: { target: 'es2022' },
  // Rapier's compat build ships wasm inlined as base64, so no plugin is needed.
  optimizeDeps: { exclude: [] },
});
