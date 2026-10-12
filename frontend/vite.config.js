import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    // Dev-only proxy: business logo URLs are served as relative /media/ paths
    // (production Apache maps /media/ on the same origin). Route them to the
    // Django dev server so uploaded logos actually render in the browser.
    proxy: {
      '/media': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: false,
  },
  build: {
    // Keep vendor libs in separate chunks so no single file dominates load time.
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['recharts'],
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          http: ['axios'],
        },
      },
    },
  },
});
