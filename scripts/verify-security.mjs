import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = (await import('electron')).default
const probe = path.join(root, 'scripts', 'security-probe.cjs')

const child = spawn(electronPath, [probe], {
  cwd: root,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
  stdio: ['ignore', 'pipe', 'inherit']
})

let out = ''
child.stdout.on('data', (chunk) => {
  out += chunk.toString()
})

child.on('exit', (code) => {
  const line = out
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('SECURITY_PROBE '))
  if (line) {
    const result = JSON.parse(line.slice('SECURITY_PROBE '.length))
    console.log(JSON.stringify(result, null, 2))
    const failed = result.checks.filter((c) => !c.pass)
    if (failed.length > 0) {
      console.error(`FAILED: ${failed.map((c) => c.id).join(', ')}`)
      process.exit(1)
    }
    console.log(`All ${result.checks.length} security checks passed.`)
    process.exit(0)
  }
  console.error('probe produced no result, exit code', code)
  process.exit(1)
})
