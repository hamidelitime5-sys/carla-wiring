import { defineConfig } from 'vite';

// Réglages attendus par Tauri : port fixe, pas d'effacement de l'écran.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/crates/**'] } },
  build: { target: 'es2021', outDir: 'dist' },
});
