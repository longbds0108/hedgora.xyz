import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [nodePolyfills()],
  build: {
    lib: {
      entry: 'circle-wallet-client.js',
      name: 'CircleWalletClient',
      formats: ['iife'],
      fileName: () => 'circle-wallet-client.js',
    },
    outDir: 'dist',
    emptyOutDir: false,
  },
})
