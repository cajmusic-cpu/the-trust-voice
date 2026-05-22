import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // amazon-cognito-identity-js uses `global` — alias it to globalThis in the browser
    global: 'globalThis',
  },
});
