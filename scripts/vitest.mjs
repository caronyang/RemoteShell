/**
 * `npm test` / `npm run test:coverage` 的統一入口。
 *
 * Windows 上 vite-node 會在系統 TEMP 建 ssr 快取，偶發
 * `UNKNOWN: unknown error, open ...\Temp\...\ssr\...`（防毒／檔案鎖），
 * 會讓部分測試檔「整檔沒跑」但看起來像通過。把 TEMP/TMP 指到專案內 `.tmp/`
 * （已列入 .gitignore）可讓測試結果穩定可重現。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = path.join(root, '.tmp')
fs.mkdirSync(tmp, { recursive: true })

const args = ['vitest', 'run', ...process.argv.slice(2)]
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TEMP: tmp, TMP: tmp }
})

process.exit(result.status ?? 1)
