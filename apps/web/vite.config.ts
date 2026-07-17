import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PATH_PREFIX = '/api';
const apiProxy = {
  [API_PATH_PREFIX]: {
    changeOrigin: true,
    rewrite: (path: string) => path.slice(API_PATH_PREFIX.length),
    target:
      process.env.API_PROXY_URL ||
      process.env.VITE_API_URL ||
      'http://localhost:3000',
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    allowedHosts: [process.env.RAILWAY_PUBLIC_DOMAIN ?? 'localhost'],
    proxy: apiProxy,
  },
});
