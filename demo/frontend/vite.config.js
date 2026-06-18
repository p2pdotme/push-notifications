import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: proxy the trigger API to the demo backend so `npm run dev` works
// end to end. In production the built app is served by that same backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/config.json': 'http://localhost:3000',
    },
  },
});
