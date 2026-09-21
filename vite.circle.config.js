import { defineConfig } from 'vite'
import { transform } from 'esbuild'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Vite leaves whitespace in ES library output; these files ship to browsers as-is, so minify them fully.
const minifyChunks = {
  name: 'minify-chunks',
  apply: 'build',
  enforce: 'post',
  // generateBundle runs after every renderChunk hook, including Vite's own reformatting of ES output.
  async generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === 'chunk') file.code = (await transform(file.code, { minify: true, format: 'esm', target: 'es2020' })).code
    }
  },
}

export default defineConfig({
  plugins: [nodePolyfills(), minifyChunks],
  // public/ is the build output here (Vercel serves it), not a folder of assets to copy.
  publicDir: false,
  build: {
    lib: {
      entry: 'circle-wallet-client.js',
      // ES modules let the heavy Circle SDK load as a separate chunk, only when a Circle window opens.
      formats: ['es'],
      fileName: () => 'circle-wallet-client.js',
    },
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      // Fixed names so each build overwrites the previous chunks instead of piling up hashed copies.
      output: { chunkFileNames: 'circle-[name].js' },
    },
  },
})
