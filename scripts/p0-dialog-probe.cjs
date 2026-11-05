/**
 * P0 #2/#3 根因探針（不進生產程式碼）：
 * 終端連線中 → 開「編輯連線」對話框 → 取三項證據：
 *   1) document.elementFromPoint(對話框中心) 實際命中元素
 *   2) 命中元素祖先鏈的 z-index / transform / filter（stacking context）
 *   3) document.activeElement 是否被 xterm 佔住
 * 對照組：共用 Modal（設定對話框）在同一狀態下的命中結果。
 * 輸出：build/p0-dialog-probe/<tag>.json
 * 用法：node_modules/.bin/electron scripts/p0-dialog-probe.cjs [tag]
 * 前置：spikes/vm/up.js 已起（gw-edge 127.0.0.1:2201）。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'p0-dialog-probe')
const dataDir = path.join(os.tmpdir(), 'remoteshell-p0-probe-' + Date.now())
const PASS = 'M0spike!2026'
const TAG = process.argv[2] || 'before'

fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(`[PROBE] ${new Date().toISOString().slice(11, 19)} ${msg}`)
let win = null
const results = {}

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
  const logger = { filePath: path.join(dataDir, 'probe.log'), info: () => {}, warn: () => {}, error: (m) => console.log('[PROBE-ERR]', m) }
  const settings = new SettingsStore(path.join(dataDir, 'settings.json'), path.join(dataDir, 'dl'))
  const connections = new ConnectionsStore(path.join(dataDir, 'connections.json'))
  const vault = new VaultService({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (p) => safeStorage.encryptString(p),
    decryptString: (c) => safeStorage.decryptString(c)
  })
  const knownHosts = new KnownHostsStore(path.join(dataDir, 'known_hosts.json'))
  const broadcast = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })
  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({
    maxConcurrent: 3,
    broadcast: (batch) => broadcast('rs:evt:transfer:update', batch),
    runner: createTransferRunner({ sftp, sessions })
  })
  const ctx = { logger, settings, connections, sessions, sftp, transfers, vault, knownHosts, revealPath: () => undefined, broadcast, resolveWindow: () => BrowserWindow.getAllWindows()[0] ?? null }
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

async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(300)
  }
  throw new Error(`timeout waiting for ${label}`)
}

/** 開 session（ephemeral 臨時密碼；hostkey 首次提示自動接受） */
async function openSession(profileId) {
  const pending = js(
    `window.rs.session.open({ profileId: ${JSON.stringify(profileId)}, cols: 120, rows: 30, ephemeral: { secret: ${JSON.stringify(
      PASS
    )} } }).then(r => r.ok ? r.data.sessionId : 'ERR:' + r.error.code)`
  ).then((value) => ({ value }))
  let outcome = null
  for (let i = 0; i < 600 && !outcome; i++) {
    const modal = await js(`document.querySelector('.rs-modal') ? 'modal' : 'none'`).catch(() => 'none')
    if (modal === 'modal') {
      await js(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Accept and remember')); if(b) b.click() })()`)
    }
    outcome = await Promise.race([pending, sleep(100).then(() => null)])
  }
  if (!outcome || String(outcome.value).startsWith('ERR')) throw new Error('open failed ' + (outcome && outcome.value))
  return outcome.value
}

/** 三項證據 + 對照組（selector 指定要量測的對話框） */
const PROBE = (selector) =>
  `(() => {
    const dlg = document.querySelector(${JSON.stringify(selector)})
    if (!dlg) return JSON.stringify({ error: 'no dialog: ' + ${JSON.stringify(selector)} })
    const r = dlg.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const chain = []
    let el = hit
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el)
      chain.push({
        tag: el.tagName,
        cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 90),
        z: cs.zIndex, position: cs.position,
        transform: cs.transform === 'none' ? 'none' : cs.transform.slice(0, 60),
        filter: cs.filter, isolation: cs.isolation, opacity: cs.opacity
      })
      el = el.parentElement
    }
    const ae = document.activeElement
    const brief = (e) => e ? { tag: e.tagName, cls: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '').slice(0, 90), inDialog: !!e.closest('[role="dialog"]'), inXterm: !!e.closest('.xterm') } : null
    return JSON.stringify({
      dialogRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      hit: brief(hit),
      activeElement: brief(ae),
      hitChain: chain.slice(0, 14),
      dialogParentIsBody: dlg.parentElement === document.body,
      overlayParentIsBody: dlg.closest('.rs-modal')?.parentElement === document.body,
      sharedModalCount: document.querySelectorAll('.rs-modal').length
    }, null, 1)
  })()`

async function main() {
  const ctx = buildContext()
  /* 可編輯的連線：gw-edge 先建、prod-web-01 經跳板（直連 10.1.2.11 不通） */
  const jump = ctx.connections.create(
    base({ name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: { kind: 'none' } } })
  )
  const target = ctx.connections.create(
    base({
      name: 'prod-web-01',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )

  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(dist, 'preload', 'index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'renderer')

  /* 連上 prod-web-01：走 UI 流程（dblClick → 憑證框 → 輸入密碼 → useSessions.open）
     —— P1-01 之後 onState 忽略未知 id，直接 IPC 開 session 不會出現在分頁（這本身就是證據之一） */
  const sessionId = null
  await js(`(() => { const row = document.querySelector('[data-node-id^="profile:"]'); if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return Boolean(row) })()`)
  await waitFor(
    () => js(`Boolean(document.querySelector('input[type="password"]'))`).catch(() => false),
    10000,
    'credential dialog'
  )
  await js(
    `(() => { const i = document.querySelector('input[type="password"]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(i, ${JSON.stringify(PASS)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
  )
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'OK'); if (b) b.click(); return Boolean(b) })()`)
  log('credential submitted via UI')
  /* 等 xterm：期間 hostkey 首次提示（jump 與 target 各一）自動「永久接受」 */
  await waitFor(async () => {
    const accepted = await js(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('Accept and remember')); if (b) { b.click(); return true } return false })()`
    ).catch(() => false)
    if (accepted) return false
    return js(`Boolean(document.querySelector('.xterm'))`).catch(() => false)
  }, 30000, 'xterm')
  await sleep(800)
  results.activeElementBeforeDialog = await js(
    `(() => { const ae = document.activeElement; return JSON.stringify({ tag: ae && ae.tagName, inXterm: !!(ae && ae.closest && ae.closest('.xterm')) }) })()`
  )
  log('activeElement(before dialog) = ' + results.activeElementBeforeDialog)

  /* 開「編輯連線」：選樹第一個 profile 列 → F2 */
  await js(`(() => { const row = document.querySelector('[data-node-id^="profile:"]'); if (row) row.click(); return Boolean(row) })()`)
  await sleep(300)
  await js(`(() => { const tree = document.querySelector('.rs-tree'); tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); return true })()`)
  await waitFor(() => js(`Boolean(document.querySelector('[role="dialog"]'))`).catch(() => false), 5000, 'connection dialog')
  await sleep(500)

  /* 證據 1/2/3：連線對話框（inline、無 z-index 版本 = BEFORE） */
  results.connectionDialog = JSON.parse(await js(PROBE('[role="dialog"]')))
  log('connection dialog hit = ' + JSON.stringify(results.connectionDialog.hit))

  /* 對照組：共用 Modal（設定對話框，z-index:50）在同一 xterm 狀態下 */
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(400)
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`)
  await waitFor(() => js(`Boolean(document.querySelector('.rs-modal__dialog'))`).catch(() => false), 5000, 'settings dialog')
  await sleep(500)
  results.sharedModalControl = JSON.parse(await js(PROBE('.rs-modal__dialog')))
  log('shared modal hit = ' + JSON.stringify(results.sharedModalControl.hit))

  /* 命中 xterm 時的疊層：terminal 區域的 stacking 元素 */
  results.terminalStacking = JSON.parse(
    await js(
      `(() => {
        const out = []
        document.querySelectorAll('.rs-terminal, .rs-terminal *, .xterm, .xterm *').forEach((el) => {
          const cs = getComputedStyle(el)
          if ((cs.zIndex !== 'auto' && cs.zIndex !== '0') || cs.position === 'fixed' || cs.transform !== 'none' || cs.filter !== 'none') {
            out.push({ tag: el.tagName, cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 70), z: cs.zIndex, position: cs.position, transform: cs.transform === 'none' ? 'none' : cs.transform.slice(0, 50), filter: cs.filter })
          }
        })
        return JSON.stringify(out.slice(0, 25), null, 1)
      })()`
    )
  )

  const out = path.join(evidence, `${TAG}.json`)
  fs.writeFileSync(out, JSON.stringify({ tag: TAG, at: new Date().toISOString(), results }, null, 2))
  console.log('PROBE_DONE ' + out)
  app.exit(0)
}

app.whenReady()
  .then(main)
  .catch((error) => {
    console.log('PROBE_FATAL ' + String((error && error.stack) || error))
    app.exit(1)
  })
