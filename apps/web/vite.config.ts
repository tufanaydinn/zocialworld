import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@chainsafe/webzjs-wallet': path.resolve(__dirname, '../../node_modules/@chainsafe/webzjs-wallet/webzjs_wallet.js'),
      '@chainsafe/webzjs-keys': path.resolve(__dirname, '../../node_modules/@chainsafe/webzjs-keys/webzjs_keys.js'),
    },
  },
  optimizeDeps: {
    exclude: ['@chainsafe/webzjs-wallet', '@chainsafe/webzjs-keys'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      external: ['@chainsafe/webzjs-wallet', '@chainsafe/webzjs-keys'],
      output: {
        format: 'es',
        globals: {
          '@chainsafe/webzjs-wallet': 'webzjsWallet',
          '@chainsafe/webzjs-keys': 'webzjsKeys',
        },
      },
    },
  },
});
