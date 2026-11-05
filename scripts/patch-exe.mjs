/**
 * M5-01：把圖示與版本資訊寫進 build\win-unpacked\RemoteShell.exe。
 *
 * 為什麼自己跑 rcedit：electron-builder 的簽章／改 exe 步驟會先解壓 `winCodeSign`，
 * 裡面有 macOS 的 symlink；Windows 沒開 Developer Mode（或非管理員）時解壓會失敗，
 * 整個 `npm run dist` 就紅掉。我們不需要憑證，只需要「圖示＋版本字串」，
 * 直接用 rcedit 做同一件事，而且可以重跑。
 *
 * rcedit 來源（依序找）：
 *   1. build/tools/rcedit-x64.exe（想自己放的話）
 *   2. electron-builder 快取裡的 winCodeSign（本機已有）
 * 找不到就 hard fail（M5 裁決 4a）：靜默產出無圖示／無版本的安裝檔比建置失敗更危險。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(root, 'build', 'win-unpacked', 'RemoteShell.exe')
const icon = path.join(root, 'build', 'icon.ico')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function findRcedit() {
  const local = path.join(root, 'build', 'tools', 'rcedit-x64.exe')
  if (fs.existsSync(local)) return local
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  if (!fs.existsSync(cacheRoot)) return null
  for (const entry of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, entry, 'rcedit-x64.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

if (!fs.existsSync(exe)) {
  console.error(`[patch-exe] 找不到 ${exe}，請先跑 npm run dist`)
  process.exit(1)
}

const rcedit = findRcedit()
if (!rcedit) {
  console.error('[patch-exe] 找不到 rcedit-x64.exe，無法寫入 exe 圖示／版本 → 中止（M5 裁決 4a：不接受靜默無圖示的安裝檔）')
  process.exit(1)
}

const args = [
  exe,
  '--set-icon',
  icon,
  '--set-version-string',
  'ProductName',
  'RemoteShell',
  '--set-version-string',
  'FileDescription',
  'RemoteShell',
  '--set-version-string',
  'CompanyName',
  'RemoteShell Team',
  '--set-version-string',
  'OriginalFilename',
  'RemoteShell.exe',
  '--set-version-string',
  'LegalCopyright',
  `Copyright (c) 2026 RemoteShell`,
  '--set-file-version',
  pkg.version,
  '--set-product-version',
  pkg.version
]

const result = spawnSync(rcedit, args, { stdio: 'inherit' })
if (result.status !== 0) {
  console.error(`[patch-exe] rcedit 失敗（status=${result.status}）`)
  process.exit(result.status ?? 1)
}
console.log(`[patch-exe] 已寫入圖示與版本 ${pkg.version} → ${exe}`)
