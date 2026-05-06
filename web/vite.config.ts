import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Pull env from the repo root so a single .env file feeds both server and web.
  const env = loadEnv(mode, '..', '');
  const serverPort = env.VITE_SERVER_PORT ?? env.PORT ?? '4319';
  return {
    envDir: '..',
    plugins: [react()],
    // Surface the resolved port to the client even when only PORT is set
    // (Vite's default exposure is limited to VITE_-prefixed vars).
    define: {
      'import.meta.env.VITE_SERVER_PORT': JSON.stringify(serverPort),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      },
    },
  };
});
