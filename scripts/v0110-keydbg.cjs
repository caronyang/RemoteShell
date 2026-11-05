/**
 * v0.1.10 #2 除錯：驗證 synthetic keydown 是否進得了 xterm 鍵盤處理。
 *   1) 監聽 textarea 自身 keydown（證明 dispatch 打得到）
 *   2) 逐字送 'echo KTEST > /tmp/kt.txt' + Enter → exec cat 驗證（證明 xterm→pty 通路）
 *   3) 送 Ctrl+C → pgrep 驗證（有無選取兩態）
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const dataDir = path.join(os.tmpdir(), 'remoteshell-keydbg-' + Date.now())
const PASS = 'M0spike!2026'

app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[KEYDBG] ${m}`)
let win = null

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
  const logger = { filePath: path.join(dataDir, 'p.log'), info: () => {}, warn: () => {}, error: () => {} }
  const settings = new SettingsStore(path.join(dataDir, 'settings.json'), path.join(dataDir, 'dl'))
  const connections = new ConnectionsStore(path.join(dataDir, 'connections.json'))
  const vault = new VaultService({ isAvailable: () => safeStorage.isEncryptionAvailable(), encryptString: (p) => safeStorage.encryptString(p), decryptString: (c) => safeStorage.decryptString(c) })
  const knownHosts = new KnownHostsStore(path.join(dataDir, 'known_hosts.json'))
  const broadcast = (c, p) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(c, p) }
  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })
  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({ maxConcurrent: 3, broadcast: (b) => broadcast('rs:evt:transfer:update', b), runner: createTransferRunner({ sftp, sessions }) })
  const ctx = { logger, settings, connections, sessions, sftp, transfers, vault, knownHosts, revealPath: () => undefined, broadcast, resolveWindow: () => BrowserWindow.getAllWindows()[0] ?? null }
  for (const mod of modules) mod.register()
  registerIpc(ctx)
  return ctx
}

const js = (code) => win.webContents.executeJavaScript(code, true)
async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(250)
  }
  throw new Error('timeout: ' + label)
}
function remoteExec(ctx, sessionId, command) {
  return new Promise((resolve) => {
    ctx.sessions.sftpClient(sessionId).exec(command, (error, stream) => {
      if (error) return resolve('ERR:' + error.message)
      let out = ''
      stream.on('data', (d) => (out += d.toString()))
      stream.stderr.on('data', (d) => (out += d.toString()))
      stream.on('close', () => resolve(out.trim()))
    })
  })
}
const sendKey = (init) =>
  js(`(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (!ta) return 'NO_TA'; ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })})); return 'OK' })()`)

async function main() {
  const ctx = buildContext()
  ctx.connections.create({ groupId: null, protocol: 'ssh', jump: { enabled: false, connectionIds: [] }, terminal: {}, tags: [], description: '', name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: { kind: 'none' } } })
  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(dist, 'preload', 'index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'app')

  await js(`(() => { const row = document.querySelector('[data-node-id^="profile:"]'); if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return Boolean(row) })()`)
  await waitFor(() => js(`Boolean(document.querySelector('input[type="password"]'))`).catch(() => false), 10000, 'cred')
  await js(`(() => { const i = document.querySelector('input[type="password"]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(i, ${JSON.stringify(PASS)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'OK'); if (b) b.click(); return Boolean(b) })()`)
  await waitFor(async () => {
    const a = await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('Accept and remember')); if (b) { b.click(); return true } return false })()`).catch(() => false)
    if (a) return false
    return js(`Boolean(document.querySelector('.xterm'))`).catch(() => false)
  }, 30000, 'xterm')
  await sleep(700)
  const sid = await js(`document.querySelector('.rs-terminal__pane').getAttribute('data-session-id')`)
  log('session=' + sid)

  /* 1) dispatch 打得到 textarea 嗎 */
  const r1 = await js(`(() => { window.__keylog = []; const ta = document.querySelector('.xterm-helper-textarea'); if (!ta) return 'NO_TA'; ta.addEventListener('keydown', (e) => window.__keylog.push(e.key + '/' + e.ctrlKey)); return 'LISTENER_OK' })()`)
  log('listener=' + r1)
  const r2 = await sendKey({ key: 'c', ctrlKey: true })
  const keylog = await js(`JSON.stringify(window.__keylog)`)
  log('dispatch=' + r2 + ' keylog=' + keylog)

  /* 2) 逐字打指令 → pty */
  const cmd = 'echo KTEST > /tmp/kt.txt'
  for (const ch of cmd) {
    await sendKey({ key: ch, ctrlKey: false })
    await sleep(40)
  }
  await sendKey({ key: 'Enter', ctrlKey: false })
  await sleep(900)
  const cat = await remoteExec(ctx, sid, 'cat /tmp/kt.txt 2>/dev/null')
  log('typed-command result=' + JSON.stringify(cat))

  /* 3) 無選取 Ctrl+C → sleep 應被打斷 */
  await js(`window.rs.session.write(${JSON.stringify(sid)}, 'sleep 100\\r')`)
  await sleep(800)
  const before = await remoteExec(ctx, sid, 'pgrep -f "^sleep 100" | wc -l')
  await sendKey({ key: 'c', ctrlKey: true })
  await sleep(1500)
  const after = await remoteExec(ctx, sid, 'pgrep -f "^sleep 100" | wc -l')
  log('pgrep before=' + before + ' after=' + after)

  const summary = { listener: r1, dispatch: r2, keylog: JSON.parse(keylog || '[]'), typed: cat, pgrepBefore: before, pgrepAfter: after }
  fs.writeFileSync(path.join(dataDir, 'keydbg.json'), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(root, 'build', 'v0110-copy-probe', 'keydbg.json'), JSON.stringify(summary, null, 2))
  console.log('KEYDBG_DONE ' + JSON.stringify(summary))
  app.exit(0)
}

app.whenReady().then(main).catch((e) => { console.log('KEYDBG_FATAL ' + (e && e.stack || e)); app.exit(1) })
