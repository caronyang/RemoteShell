/**
 * M2 實機 demo（不是產品程式碼）：以正式建置產物開真實視窗，跑五情境並截圖。
 *   1 直連 SSH   2 跳板 SSH   3 金鑰登入   4 Telnet   5 斷線偵測（目的主機封包黑洞）
 *
 * 前置：spikes/vm/up.js 已起 gw-edge(127.0.0.1:2201) + prod-web-01(10.1.2.11)、
 *       spikes/s5/telnet-server.py 已在 127.0.0.1:2323。
 * 產出：build/m2-evidence/*.png 與 stdout 的 JSON 摘要。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const net = require('node:net')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'm2-evidence')
const dataDir = path.join(os.tmpdir(), 'remoteshell-m2-demo-' + Date.now())
const PASS = 'M0spike!2026'
const KEY_PATH = path.join(root, 'spikes', 'keys', 'id_ed25519')

fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const states = []
const hostKeyPrompts = []
const results = []
let win = null

function record(id, pass, detail) {
  results.push({ id, pass, detail })
  console.log(`[M2] ${pass ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

function registerHandlers() {
  const { registerIpc } = require(path.join(dist, 'main', 'ipc', 'register.js'))
  const { SettingsStore } = require(path.join(dist, 'main', 'store', 'settings.js'))
  const { ConnectionsStore } = require(path.join(dist, 'main', 'store', 'connections.js'))
  const { VaultService } = require(path.join(dist, 'main', 'vault', 'dpapi.js'))
  const { KnownHostsStore } = require(path.join(dist, 'main', 'transport', 'hostkey.js'))
  const { SessionManager } = require(path.join(dist, 'main', 'ipc', 'handlers', 'session.js'))
  const { safeStorage } = require('electron')

  const modules = ['app', 'window', 'settings', 'connections', 'vault', 'session', 'sftp', 'transfer', 'hostkey'].map(
    (name) => require(path.join(dist, 'main', 'ipc', 'handlers', name + '.js'))
  )

  const logger = {
    filePath: path.join(dataDir, 'demo.log'),
    info: () => {},
    warn: () => {},
    error: (m, meta) => console.error('[demo-log]', m, JSON.stringify(meta ?? {}))
  }
  const settings = new SettingsStore(path.join(dataDir, 'settings.json'), path.join(dataDir, 'dl'))
  const connections = new ConnectionsStore(path.join(dataDir, 'connections.json'))
  const vault = new VaultService({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (cipher) => safeStorage.decryptString(cipher)
  })
  const knownHosts = new KnownHostsStore(path.join(dataDir, 'known_hosts.json'))
  const broadcast = (channel, payload) => {
    if (channel === 'rs:evt:session:state') states.push(payload)
    if (channel === 'rs:evt:hostkey:prompt') hostKeyPrompts.push(payload)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }
  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })
  const ctx = {
    logger,
    settings,
    connections,
    sessions,
    vault,
    knownHosts,
    broadcast,
    resolveWindow: () => BrowserWindow.getAllWindows()[0] ?? null
  }
  for (const mod of modules) mod.register()
  registerIpc(ctx)
  return { connections, sessions, knownHosts, ctx }
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

async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}

async function waitFor(code, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await js(code).catch(() => null)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function shot(name) {
  const image = await win.webContents.capturePage()
  const file = path.join(evidence, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  return file
}

async function clickByText(text) {  return js(
    `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes(${JSON.stringify(
        text
      )}))
      if (!btn) return false
      btn.click()
      return true
    })()`
  )
}

async function focusTab(text) {
  const clicked = await js(
    `(() => {
      const tab = [...document.querySelectorAll('.rs-tab')].find((t) => (t.textContent || '').includes(${JSON.stringify(text)}))
      if (!tab) return false
      tab.click()
      return true
    })()`
  )
  await sleep(500)
  return clicked
}

async function waitState(sessionId, wanted, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = states.filter((s) => s.sessionId === sessionId).find((s) => s.state === wanted)
    if (hit) return hit
    await sleep(200)
  }
  throw new Error(`session ${sessionId} never reached ${wanted}`)
}

async function readSnapshot(sessionId) {
  const text = await js(
    `window.rs.session.snapshot(${JSON.stringify(sessionId)}).then((r) => r.ok ? new TextDecoder().decode(r.data.bytes) : '')`
  )
  return typeof text === 'string' ? text : ''
}

async function answerHostKey() {
  // 等 UI 跳出 TOFU 對話框，按下「Accept and remember」（同時驗證 M2-08 對話框）
  await waitFor(
    `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('Accept and remember'))`,
    15000,
    'hostkey dialog'
  )
  const clicked = await clickByText('Accept and remember')
  await sleep(300)
  return clicked
}

async function openSession(profileId, secret) {  const pending = js(
    `window.rs.session.open(${JSON.stringify({ profileId, cols: 120, rows: 30, ephemeral: { secret } })}).then((r) => r.ok ? r.data.sessionId : 'ERR:' + r.error.code)`
  ).then(
    (value) => ({ done: true, value }),
    (error) => ({ done: true, value: 'THROW:' + String(error) })
  )

  // 連線會被 TOFU 對話框擋住：邊等 IPC 結果、邊處理對話框（也順便驗證 M2-08 的 UI）
  let outcome = null
  for (let i = 0; i < 480 && !outcome; i++) {
    const modal = await js(`document.querySelector('.rs-modal') ? 'modal' : 'none'`).catch(() => 'none')
    if (modal === 'modal') {
      await clickByText('Accept and remember')
    }
    outcome = await Promise.race([pending, sleep(100).then(() => null)])
  }
  if (!outcome) throw new Error('session open timed out (no result in 60s)')
  if (typeof outcome.value !== 'string' || outcome.value.startsWith('ERR:') || outcome.value.startsWith('THROW:')) {
    throw new Error('open failed: ' + outcome.value)
  }
  await waitState(outcome.value, 'connected')
  await sleep(900)
  return outcome.value
}

async function freezeTarget() {
  await new Promise((resolve) => {
    const socket = net.connect(2512, '127.0.0.1', () => {
      socket.write('stop\n')
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 300)
    })
    socket.on('error', () => resolve())
  })
}

async function thawTarget() {
  await new Promise((resolve) => {
    const socket = net.connect(2512, '127.0.0.1', () => {
      socket.write('cont\n')
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 300)
    })
    socket.on('error', () => resolve())
  })
}

async function main() {
  const { connections } = registerHandlers()

  // 先把 profile 建好，再開視窗（樹才會載到）
  const jump = connections.create(
    base({ name: 'gw-edge (direct)', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: { kind: 'none' } } })
  )
  const target = connections.create(
    base({
      name: 'prod-web-01',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )
  const keyProfile = connections.create(
    base({
      name: 'gw-edge (key)',
      host: '127.0.0.1',
      port: 2201,
      auth: { method: 'publicKey', username: 'tester', keyPath: KEY_PATH, secret: { kind: 'none' } }
    })
  )
  const telnetProfile = connections.create(
    base({
      name: 'telnet-test',
      protocol: 'telnet',
      host: '127.0.0.1',
      port: 2323,
      auth: { method: 'password', username: 'n/a', secret: { kind: 'none' } }
    })
  )

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(dist, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await waitFor(`Boolean(document.querySelector('.rs-app .rs-tree'))`, 15000, 'renderer layout')
  await sleep(800)

  // ---- 1 直連 SSH ----
  const s1 = await openSession(jump.id, PASS)
  await focusTab('gw-edge (direct)')
  await js(
    `window.rs.session.write(${JSON.stringify(s1)}, "mkdir -p ~/測試目錄; printf '中文測試檔第一行\\n第二行：全形標點，。！？\\n' > ~/測試目錄/中文檔名.txt; ls -l ~/測試目錄; cat ~/測試目錄/中文檔名.txt; echo SSH-OK\\r")`
  )
  await sleep(2500)
  let snap = await readSnapshot(s1)
  record(
    'M2-1 直連 SSH',
    snap.includes('中文檔名.txt') && snap.includes('第二行：全形標點') && snap.includes('SSH-OK'),
    `snapshot ${snap.length} bytes，含中文檔名與內容`
  )
  record('M2-4 中文無 U+FFFD', !snap.includes('\uFFFD'), 'snapshot 無 replacement char')
  const shot1 = await shot('m2-01-direct-ssh')

  // ---- 2 跳板 SSH ----
  const s2 = await openSession(target.id, PASS)
  await focusTab('prod-web-01')
  await js(`window.rs.session.write(${JSON.stringify(s2)}, "hostname; ls -l 測試目錄; echo VIA-OK\\r")`)
  await sleep(2000)
  snap = await readSnapshot(s2)
  const statusText = await js(`document.querySelector('.rs-statusbar')?.textContent || ''`)
  record(
    'M2-2 跳板 SSH',
    snap.includes('prod-web-01') && snap.includes('中文檔名.txt') && statusText.includes('gw-edge') && statusText.includes('10.1.2.11'),
    `snapshot 含 prod-web-01 與中文檔名；狀態列「${statusText.slice(0, 90)}」`
  )
  const shot2 = await shot('m2-02-jump-ssh')

  // ---- 3 金鑰登入 ----
  const s3 = await openSession(keyProfile.id, undefined)
  await focusTab('gw-edge (key)')
  await js(`window.rs.session.write(${JSON.stringify(s3)}, "echo KEY-OK-$(whoami)\\r")`)
  await sleep(1200)
  snap = await readSnapshot(s3)
  record('M2-3 金鑰登入', snap.includes('KEY-OK-tester'), 'ed25519 金鑰登入並執行指令')
  const shot3 = await shot('m2-03-key-login')

  // ---- 4 Telnet ----
  const s4 = await openSession(telnetProfile.id, '')
  await focusTab('telnet-test')
  await sleep(800)
  snap = await readSnapshot(s4)
  record('M2-4 Telnet', snap.includes('Telnet') && !snap.includes('\u00ff'), '收到 Telnet banner 且無 IAC 外洩')
  const shot4 = await shot('m2-04-telnet')

  // ---- 5 斷線偵測（目的主機封包黑洞 → keepalive 30s 內）----
  await focusTab('prod-web-01')
  await js(`window.rs.session.write(${JSON.stringify(s2)}, "echo before-freeze\\r")`)
  await sleep(600)
  const t0 = Date.now()
  await freezeTarget()
  const dropped = await waitState(s2, 'disconnected', 45000)
  const detectMs = Date.now() - t0
  await thawTarget()
  await sleep(1500)
  await focusTab('prod-web-01')
  const statusAfter = await js(`document.querySelector('.rs-statusbar')?.textContent || ''`)
  const hasReconnect = await js(
    `[...document.querySelectorAll('.rs-statusbar button')].some((b) => (b.textContent || '').includes('Reconnect') || (b.textContent || '').includes('重連'))`
  )
  record(
    'M2-5 斷線偵測與階段標示',
    detectMs <= 35000 && dropped.error?.code === 'E_NETWORK' && hasReconnect && statusAfter.includes('Connection lost'),
    `${detectMs}ms、code=${dropped.error?.code}、phase=${dropped.error?.phase}、[立即重連]=${hasReconnect}、狀態「${statusAfter.slice(0, 80)}」`
  )
  const shot5 = await shot('m2-05-disconnected')

  const summary = {
    electron: process.versions.electron,
    dataDir,
    screenshots: { shot1, shot2, shot3, shot4, shot5 },
    sessions: { direct: s1, jump: s2, key: s3, telnet: s4 },
    hostKeyPrompts: hostKeyPrompts.length,
    results
  }
  fs.writeFileSync(path.join(evidence, 'm2-demo.json'), JSON.stringify(summary, null, 2))
  process.stdout.write('M2_DEMO ' + JSON.stringify(summary) + '\n')
  app.exit(results.every((r) => r.pass) ? 0 : 1)
}

app.whenReady().then(main).catch((error) => {
  process.stdout.write(
    'M2_DEMO ' + JSON.stringify({ results: [{ id: 'fatal', pass: false, detail: String(error && error.stack) }] }) + '\n'
  )
  app.exit(1)
})
