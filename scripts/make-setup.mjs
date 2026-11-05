/**
 * `npm run make:setup`：用 Inno Setup 編譯 build/inno/setup.iss（M5-01）。
 *
 * 前置檢查（避免「找不到工具」這種半路失敗）：
 *   - build/win-unpacked/RemoteShell.exe 存在（先跑 `npm run dist`）
 *   - ISCC.exe 存在（Inno Setup 6）
 * 版本號只有一個來源：package.json。透過 ISCC 的 `/DAppVersion=...` 傳進去，
 * setup.iss 內用 `#ifndef` 提供預設值，所以直接開 GUI 編譯也不會壞。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iss = path.join(root, 'build', 'inno', 'setup.iss')
const exe = path.join(root, 'build', 'win-unpacked', 'RemoteShell.exe')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const candidates = ['C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe']
const iscc = candidates.find((p) => fs.existsSync(p))

if (!fs.existsSync(iss)) {
  console.error(`setup.iss not found: ${iss} (M5-01)`)
  process.exit(1)
}
if (!fs.existsSync(exe)) {
  console.error(`build/win-unpacked/RemoteShell.exe not found; run \`npm run dist\` first (M5-01)`)
  process.exit(1)
}
if (!iscc) {
  console.error('Inno Setup 6 (ISCC.exe) not found; install it before running make:setup (M5-01)')
  process.exit(1)
}

const result = spawnSync(iscc, [`/DAppVersion=${pkg.version}`, iss], { stdio: 'inherit' })
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

const artifact = path.join(root, 'build', 'installer', `RemoteShell-Setup-${pkg.version}.exe`)
if (fs.existsSync(artifact)) {
  const size = fs.statSync(artifact).size
  console.log(`\n[make:setup] ${artifact} (${(size / 1024 / 1024).toFixed(1)} MB)`)
} else {
  console.error(`[make:setup] 編譯完成但找不到預期產物：${artifact}`)
  process.exit(1)
}
