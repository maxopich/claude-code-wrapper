import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_PORT } from '@cebab/shared/net';

export default defineConfig(({ mode }) => {
  // Pull env from the repo root so a single .env file feeds both server and web.
  const env = loadEnv(mode, '..', '');
  const serverPort = env.VITE_SERVER_PORT ?? env.PORT ?? String(DEFAULT_PORT);
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
      // Register H09: fail instead of shifting to the next free port. The API
      // server trusts this origin only because `npm run dev` declares it (see
      // scripts/dev-origins.mjs), and Vite's default `strictPort: false` would
      // make that declaration a lie the moment another Vite project already
      // holds 5173 — Cebab's UI would move to 5174 and 403 itself, while the
      // trusted origin belonged to that other project. A loud failure is the
      // correct outcome: the operator frees the port or declares another one.
      strictPort: true,
      proxy: {
        '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      },
    },
  };
});
