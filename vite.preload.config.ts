import { defineConfig } from 'vite'
import path from 'node:path'

/**
 * preload 必須是「單一自帶檔」：sandbox:true 的 preload 不能 require 其他檔案
 * （只允許 electron 與少數內建模組），所以用 Vite lib mode 打包成一支 CJS。
 */
export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, 'dist/preload'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      external: ['electron']
    }
  }
})
