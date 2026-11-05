/**
 * M5-02：冷啟量測（正式打包後的 exe）。
 *
 * 量的是「使用者感覺到的」：spawn 這個 exe → 視窗可見（ready-to-show）。
 * 內部時間由 src/main/diagnostics.ts 寫進 RS_BOOT_TRACE 指定的 JSON（絕對時間戳），
 * 所以不需要在產品裡放計時器，也不受主控台輸出影響。
 *
 * 用法：
 *   node scripts/m5-perf.mjs                # 預設跑 3 次，用安裝後的 exe
 *   node scripts/m5-perf.mjs --runs 5
 *   node scripts/m5-perf.mjs --exe "build\win-unpacked\RemoteShell.exe"
 *
 * 注意：真正的「重開機後量 3 次」會終止工作階段，這裡用「每次都是新的行程、
 * 冷檔案快取盡量排除」替代，並在輸出標記離群值（例如第一次較慢）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
const runs = Number(argOf('--runs', '3'))
const defaultExe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'RemoteShell', 'RemoteShell.exe')
const exe = path.resolve(argOf('--exe', defaultExe))
const evidence = path.join(root, 'build', 'm5-evidence')

if (!fs.existsSync(exe)) {
  console.error(`找不到 exe：${exe}\n先安裝（build/installer/RemoteShell-Setup-*.exe）或指定 --exe`)
  process.exit(1)
}
fs.mkdirSync(evidence, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function once(index) {
  const traceFile = path.join(evidence, `boot-${index}.json`)
  fs.rmSync(traceFile, { force: true })
  const startedAt = Date.now()
  const child = spawn(exe, [], {
    env: { ...process.env, RS_BOOT_TRACE: traceFile, RS_BOOT_EXIT: '1' },
    stdio: 'ignore',
    detached: false
  })

  let trace = null
  for (let i = 0; i < 300; i++) {
    await sleep(50)
    if (fs.existsSync(traceFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(traceFile, 'utf8'))
        if (parsed.shownAt) {
          trace = parsed
          break
        }
      } catch {
        // 檔案剛建立、還沒寫完
      }
    }
    if (Date.now() - startedAt > 20000) break
  }

  // 等它自己退出（RS_BOOT_EXIT=1）；不退出就砍掉
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
    if (child.exitCode !== null) resolve(true)
  })
  if (!exited) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    await sleep(300)
    // 保險：打包後的 exe 會轉生真正的 app 行程，用 taskkill 收乾淨
    spawn('taskkill', ['/IM', 'RemoteShell.exe', '/F'], { stdio: 'ignore' })
  }

  if (!trace) return { index, ok: false, note: 'no trace (timeout)' }
  const shownMs = trace.shownAt - startedAt
  const loadedMs = trace.loadedAt ? trace.loadedAt - startedAt : null
  const moduleLoadMs = trace.startedAt - startedAt
  console.log(
    `run ${index}: shown=${shownMs}ms loaded=${loadedMs ?? '-'}ms (module load ${moduleLoadMs}ms) url=${trace.url}`
  )
  return { index, ok: true, shownMs, loadedMs, moduleLoadMs, url: trace.url, csp: trace.csp }
}

async function main() {
  console.log(`[m5-perf] exe = ${exe}`)
  console.log(`[m5-perf] runs = ${runs}`)
  const results = []
  for (let i = 1; i <= runs; i++) {
    results.push(await once(i))
    await sleep(1200)
  }

  const shown = results.filter((r) => r.ok).map((r) => r.shownMs).sort((a, b) => a - b)
  const median = shown.length === 0 ? null : shown[Math.floor((shown.length - 1) / 2)]
  const csp = results.find((r) => r.ok && r.csp)?.csp ?? null
  const summary = {
    exe,
    at: new Date().toISOString(),
    runs: results,
    medianShownMs: median,
    maxShownMs: shown.at(-1) ?? null,
    minShownMs: shown[0] ?? null,
    budgetMs: 3000,
    pass: median !== null && median <= 3000,
    url: results.find((r) => r.ok)?.url ?? null,
    csp
  }
  fs.writeFileSync(path.join(evidence, 'm5-02-cold-start.json'), JSON.stringify(summary, null, 2))
  console.log(`\n[m5-perf] 中位數 ${median}ms（預算 3000ms）→ ${summary.pass ? 'PASS' : 'FAIL'}`)
  console.log(`[m5-perf] 原始值：${shown.join(' / ')} ms`)
  if (csp) console.log(`[m5-perf] CSP header：${csp.slice(0, 80)}…`)
  process.exit(summary.pass ? 0 : 1)
}

main().catch((error) => {
  console.error('[m5-perf] FAILED', error)
  process.exit(1)
})
