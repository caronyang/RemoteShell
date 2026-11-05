/**
 * M5-02：10 個分頁 idle 記憶體量測。
 *
 * 用與正式版相同的 dist 程式碼（main/window + renderer bundle）開一個視窗，
 * 經跳板開 10 條 SSH session（每條都有自己的 xterm 分頁），idle 60 秒後量：
 *   - app.getAppMetrics()：所有行程的 workingSetSize 加總（Windows 工作管理員的「記憶體」）
 *   - privateBytes 加總（工作管理員的「認可大小」近似值）
 *
 * 前置：spikes/vm/up.js 已起（gw-edge 127.0.0.1:2201、prod-web-01 10.1.2.11）。
 * 用法：npx electron scripts/m5-demo.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'm5-evidence')
const dataDir = path.join(os.tmpdir(), 'remoteshell-m5-demo-' + Date.now())
const PASS = 'M0spike!2026'
const TABS = Number(process.env.M5_TABS || '10')
const IDLE_MS = Number(process.env.M5_IDLE_MS || '60000')

fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(`[M5] ${new Date().toISOString().slice(11, 19)} ${msg}`)

function buildContext() {
  const { registerIpc } = require(path.join(dist, 'main', 'ipc', 'register.js'))
  const { SettingsStore } = require(path.join(dist, 'main', 'store', 'settings.js'))
  const { ConnectionsStore } = require(path.join(dist, 'main', 'store', 'connections.js'))
  const { VaultService } = require(path.join(dist, 'main', 'vault', 'dpapi.js'))
  const { KnownHostsStore } = require(path.join(dist, 'main', 'transport', 'hostkey.js'))
  const { SessionManager } = require(path.join(dist, 'main', 'ipc', 'handlers', 'session.js'))
  const { SftpRegistry } = require(path.join(dist, 'main', 'sftp', 'registry.js'))
  const { TransferScheduler } = require(path.join(dist, 'main', 'queue', 'scheduler.js'))
  const { createTransferRunner } = require(path.join(dist, 'main', 'ipc', 'handlers', 'transfer.js'))
  const { safeStorage } = require('electron')
  const modules = ['app', 'window', 'settings', 'connections', 'vault', 'session', 'sftp', 'transfer', 'hostkey', 'local'].map(
    (name) => require(path.join(dist, 'main', 'ipc', 'handlers', name + '.js'))
  )

  const logger = {
    filePath: path.join(dataDir, 'demo.log'),
    info: () => {},
    warn: (m, meta) => log(`WARN ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) => log(`ERROR ${m} ${JSON.stringify(meta ?? {})}`)
  }
  const settings = new SettingsStore(path.join(dataDir, 'settings.json'), path.join(dataDir, 'dl'))
  const connections = new ConnectionsStore(path.join(dataDir, 'connections.json'))
  const vault = new VaultService({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (p) => safeStorage.encryptString(p),
    decryptString: (c) => safeStorage.decryptString(c)
  })
  const knownHosts = new KnownHostsStore(path.join(dataDir, 'known_hosts.json'))
  const broadcast = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }
  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })
  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({
    maxConcurrent: 3,
    broadcast: (batch) => broadcast('rs:evt:transfer:update', batch),
    runner: createTransferRunner({ sftp, sessions })
  })

  const ctx = {
    logger,
    settings,
    connections,
    sessions,
    sftp,
    transfers,
    vault,
    knownHosts,
    revealPath: () => undefined,
    broadcast,
    resolveWindow: () => BrowserWindow.getAllWindows()[0] ?? null
  }
  for (const mod of modules) mod.register()
  registerIpc(ctx)
  return ctx
}

const base = (over) => ({
  groupId: null,
  protocol: 'ssh',
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  ...over
})

let win = null
const js = (code) => win.webContents.executeJavaScript(code, true)

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

function memorySnapshot() {
  const metrics = app.getAppMetrics()
  const rows = metrics.map((m) => ({
    type: m.type,
    pid: m.pid,
    workingSetMB: +(m.memory.workingSetSize / 1024).toFixed(1),
    peakWorkingSetMB: +(m.memory.peakWorkingSetSize / 1024).toFixed(1),
    privateMB: +(m.memory.privateBytes / 1024).toFixed(1)
  }))
  const totalWorkingSetMB = +rows.reduce((sum, r) => sum + r.workingSetMB, 0).toFixed(1)
  const totalPrivateMB = +rows.reduce((sum, r) => sum + r.privateMB, 0).toFixed(1)
  return { rows, totalWorkingSetMB, totalPrivateMB }
}

async function main() {
  const ctx = buildContext()
  const secret = ctx.vault.encrypt(PASS)
  const jump = ctx.connections.create(
    base({ name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret } })
  )
  const target = ctx.connections.create(
    base({
      name: 'prod-web-01',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(dist, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'renderer')
  await sleep(1500)

  const baseline = memorySnapshot()
  log(`baseline：${baseline.totalWorkingSetMB} MB（${baseline.rows.length} 個行程）`)

  const sessionIds = []
  for (let i = 0; i < TABS; i++) {
    const pending = js(
      `window.rs.session.open({ profileId: ${JSON.stringify(target.id)}, cols: 120, rows: 30, ephemeral: { secret: ${JSON.stringify(
        PASS
      )} } }).then(r => r.ok ? r.data.sessionId : 'ERR:' + r.error.code)`
    ).then((value) => ({ value }))
    let outcome = null
    for (let k = 0; k < 600 && !outcome; k++) {
      const modal = await js(`document.querySelector('.rs-modal') ? 'modal' : 'none'`).catch(() => 'none')
      if (modal === 'modal') {
        await js(
          `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Accept and remember')); if(b) b.click() })()`
        )
      }
      outcome = await Promise.race([pending, sleep(100).then(() => null)])
    }
    if (!outcome || String(outcome.value).startsWith('ERR')) throw new Error(`tab ${i + 1} 開不起來：${outcome && outcome.value}`)
    sessionIds.push(outcome.value)
    log(`分頁 ${i + 1}/${TABS} 已連線（${outcome.value.slice(0, 8)}）`)
  }

  // 讓每個分頁都有一次互動輸出（xterm 真的畫過東西，不是空白的）
  for (const sessionId of sessionIds) {
    await js(`window.rs.session.write(${JSON.stringify(sessionId)}, 'echo tab-ready\\r')`)
    await sleep(120)
  }
  await waitFor(
    () =>
      js(`document.querySelectorAll('.rs-terminal__pane').length >= ${TABS}`).catch(() => false),
    30000,
    'terminal panes'
  )

  log(`idle ${IDLE_MS / 1000}s…`)
  await sleep(IDLE_MS)
  const idle = memorySnapshot()
  log(`idle：${idle.totalWorkingSetMB} MB / private ${idle.totalPrivateMB} MB（預算 1024 MB）`)

  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  win.moveTop()
  win.webContents.invalidate()
  await sleep(800)
  const image = await win.webContents.capturePage()
  const screenshot = path.join(evidence, `m5-02-${TABS}-tabs-idle.png`)
  fs.writeFileSync(screenshot, image.toPNG())
  win.setAlwaysOnTop(false)

  const summary = {
    at: new Date().toISOString(),
    tabs: TABS,
    idleMs: IDLE_MS,
    baseline,
    idle,
    budgetMB: 1024,
    pass: idle.totalWorkingSetMB <= 1024,
    screenshot
  }
  fs.writeFileSync(path.join(evidence, 'm5-02-memory.json'), JSON.stringify(summary, null, 2))
  log(`結果：${idle.totalWorkingSetMB} MB → ${summary.pass ? 'PASS' : 'FAIL'}`)
  ctx.sessions.closeAll()
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error('[M5] FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
)
