import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 1) 先把 main / preload 編成 CJS（renderer 交給 Vite dev server）
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.main.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
// preload 必須打包成單一自帶檔（sandbox:true 的 preload 不能 require 其他 .js）
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', 'build', '--config', 'vite.preload.config.ts'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
)

// 2) 起 Vite dev server
const server = await createServer({ configFile: path.join(root, 'vite.config.ts') })
await server.listen()
const urls = server.resolvedUrls
const url = urls?.local?.[0] ?? 'http://localhost:5273/'
server.printUrls()

// 3) 起 Electron，指向 dev server
const electronPath = (await import('electron')).default
const child = spawn(electronPath, ['.'], {
  cwd: root,
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
  stdio: 'inherit'
})

const shutdown = async (code) => {
  await server.close()
  process.exit(code ?? 0)
}

child.on('exit', (code) => void shutdown(code ?? 0))
process.on('SIGINT', () => {
  child.kill()
  void shutdown(0)
})
