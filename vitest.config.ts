import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // renderer 元件測試需要 DOM（M2-05 Table／Modal）
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    // Windows 上 threads pool 偶發 `UNKNOWN: unknown error`（vite-node ssr 快取寫檔被鎖），
    // 改用 forks 並關閉檔案級平行，換取 `npm test` 穩定可重現。
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/main/store/**/*.ts', 'src/shared/**/*.ts', 'src/main/ipc/**/*.ts'],
      exclude: ['src/main/ipc/handlers/{vault,session,sftp,transfer,hostkey}.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 60
      }
    }
  }
})
