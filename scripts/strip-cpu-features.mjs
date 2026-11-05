/**
 * 移除 ssh2 的 optional 原生模組 cpu-features（§1.3-2：避免 Electron ABI 重編）。
 *
 * `npm i ssh2 --ignore-scripts` 只會「不安裝原生 binary」，但 npm 仍會把
 * `node_modules/cpu-features` 整個資料夾解出來。為了讓驗收條件（資料夾不存在）
 * 在任何一次 `npm ci` / `npm i` 之後都成立，這裡在 postinstall 直接移除它。
 * ssh2 對 cpu-features 是 `try { require('cpu-features') } catch {}`，缺少時會自動退回 JS 實作。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'node_modules', 'cpu-features')

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true })
  console.log('[postinstall] removed node_modules/cpu-features (ssh2 optional native module, EABI risk)')
} else {
  console.log('[postinstall] node_modules/cpu-features not present (ok)')
}
