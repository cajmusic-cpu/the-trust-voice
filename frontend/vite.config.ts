/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // amazon-cognito-identity-js uses `global` — alias it to globalThis in the browser
    global: 'globalThis',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Dummy VITE_* values so modules that read import.meta.env at import time
    // (api/client.ts, auth/cognito.ts) load in CI, which has no .env file.
    env: {
      VITE_API_BASE_URL: 'https://api.test.local/prod',
      VITE_USER_POOL_ID: 'us-east-1_testpool',
      VITE_USER_POOL_CLIENT_ID: 'testclientid',
    },
  },
});
