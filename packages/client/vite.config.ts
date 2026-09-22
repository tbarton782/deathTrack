import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // The web bundle goes to `dist-web/`; `dist/` is reserved for the tsc
    // library emit (see tsconfig.build.json) that other packages import by path.
    outDir: 'dist-web',
  },
  resolve: {
    alias: {},
  },
});
