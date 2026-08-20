import path from 'node:path'
import { defineConfig } from 'vite'
import vueJsx from '@vitejs/plugin-vue-jsx'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [vueJsx()],
  resolve: {
    alias: {
      '#': path.resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'src/renderer/index.html'),
        configEditor: path.resolve(import.meta.dirname, 'src/renderer/config-editor.html'),
      },
    },
  },
})
