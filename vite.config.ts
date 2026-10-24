import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  // Solana web3.js expects Node's Buffer in the browser.
  plugins: [react(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
  server: { proxy: { '/api': 'http://127.0.0.1:8788' } },
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
});
