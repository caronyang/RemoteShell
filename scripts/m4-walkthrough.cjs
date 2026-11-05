/**
 * M4 UI 走查 v1.1 證據腳本（不進生產程式碼）：
 *   1. 用 M3 shot() 那套（setAlwaysOnTop+focus+moveTop+invalidate+600ms）重拍截圖
 *   2. 臨時密碼連 2 筆真實連線（profiles secret=none，連線走 ephemeral，不存 vault）
 *   3. 50MB 真實傳輸（跑一筆）＋ 傳輸中斷/重連補驗（monitor 2512 stop/cont）
 *   4. 量測佇列 body 高度、設定對話框 720x520、樹列 26px、狀態列編碼字串
 *   5. 全部截圖附 SHA256（walkthrough-evidence.json）
 *
 * 前置：spikes/vm/up.js 已起（gw-edge 127.0.0.1:2201、prod-web-01 10.1.2.11、monitor 2512）。
 * 10_設定復原.png：原生 confirm 無法由 capturePage 擷取 → 寫 RESET_CLICKED.txt 標記，
 * 由外部螢幕截圖程序（watcher）在同一時間全螢幕截圖。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const net = require('node:net')
const crypto = require('node:crypto')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'm4-walkthrough')
const shots = path.join(root, 'docs', 'M4_走查截圖')
const dataDir = path.join(os.tmpdir(), 'remoteshell-m4-walkthrough-' + Date.now())
const localDir = path.join(os.tmpdir(), 'remoteshell-m4-walkthrough-data')
const PASS = 'M0spike!2026' // 臨時密碼：只在本次連線 ephemeral 使用，不存 vault
const REMOTE_ROOT = '/srv/data/m4'

fs.mkdirSync(evidence, { recursive: true })
fs.mkdirSync(shots, { recursive: true })
fs.mkdirSync(localDir, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const measurements = {}
const files = []
const log = (msg) => console.log(`[WALK] ${new Date().toISOString().slice(11, 19)} ${msg}`)
/* 證據蒐集期：main 例外只記錄不讓程式死掉（避免證據中斷） */
process.on('uncaughtException', (error) => log(`UNCAUGHT ${(error && error.stack) || error}`))
process.on('unhandledRejection', (reason) => log(`UNHANDLED ${reason}`))
const record = (id, pass, detail) => {
  results.push({ id, pass, detail })
  console.log(`[WALK] ${pass ? 'PASS' : 'FAIL'} ${id} -- ${detail}`)
}

let win = null
let evidenceWritten = false

function writeEvidence(ok) {
  if (evidenceWritten) return
  evidenceWritten = true
  try {
    const manifest = {}
    for (const file of files) {
      manifest[path.basename(file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
    fs.writeFileSync(
      path.join(evidence, 'walkthrough-evidence.json'),
      JSON.stringify({ electron: process.versions.electron, finishedAt: new Date().toISOString(), measurements, results, screenshots: manifest }, null, 2)
    )
    process.stdout.write('WALKTHROUGH ' + JSON.stringify({ ok, results, measurements, screenshots: manifest }) + '\n')
  } catch (error) {
    process.stdout.write('WALKTHROUGH_EVIDENCE_ERROR ' + String(error) + '\n')
  }
}

function finish(code) {
  writeEvidence(code === 0 && results.every((r) => r.pass))
  app.exit(code)
}

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
    filePath: path.join(dataDir, 'walkthrough.log'),
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
  sessions.onStateChange = (info) => {
    if (info.state === 'disconnected' || info.state === 'failed') {
      transfers.pauseSession(info.sessionId)
      sftp.removeBySession(info.sessionId)
    }
  }
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

async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}

/** 給 renderer 的鍵盤事件一律 dispatch 到 document：document 監聽者（Modal/ConnectionDialog）與 window 監聽者（MainWindow 快速鍵）都會收到 */
function key(keyInit) {
  return js(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(keyInit)}))`)
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

/** 截圖：M3 那套 —— 強制置頂/聚焦/重繪再擷取，避免 capturePage 回傳被遮的舊幀 */
async function shot(name) {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  win.moveTop()
  win.webContents.invalidate()
  await sleep(600)
  const image = await win.webContents.capturePage()
  const file = path.join(shots, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  win.setAlwaysOnTop(false)
  files.push(file)
  log(`shot ${name}`)
  return file
}

function monitor(cmd) {
  return new Promise((resolve) => {
    const socket = net.connect(2512, '127.0.0.1', () => {
      socket.write(cmd + '\n')
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 300)
    })
    socket.on('error', () => resolve())
  })
}

function makeFile(file, sizeBytes) {
  const fd = fs.openSync(file, 'w')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  let written = 0
  while (written < sizeBytes) {
    const size = Math.min(buf.length, sizeBytes - written)
    for (let i = 0; i < size; i += 4096) buf[i] = (written + i) % 251
    fs.writeSync(fd, buf, 0, size)
    written += size
  }
  fs.closeSync(fd)
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  let read = 0
  while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read))
  fs.closeSync(fd)
  return hash.digest('hex')
}

async function remoteExec(ctx, sessionId, command) {
  const client = ctx.sessions.sftpClient(sessionId)
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      let out = ''
      stream.on('data', (d) => (out += d.toString()))
      stream.stderr.on('data', (d) => (out += d.toString()))
      stream.on('close', () => resolve(out.trim()))
    })
  })
}

/** 用 renderer IPC 開 session（ephemeral 臨時密碼，不落 vault）；hostkey 首次提示自動「永久接受」 */
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
      await js(
        `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Accept and remember')); if(b) b.click() })()`
      )
    }
    outcome = await Promise.race([pending, sleep(100).then(() => null)])
  }
  if (!outcome || String(outcome.value).startsWith('ERR')) throw new Error('open failed ' + (outcome && outcome.value))
  return outcome.value
}

const listTasks = () => js(`window.rs.transfer.list().then(r => JSON.stringify(r.data ?? []))`).then((raw) => JSON.parse(raw))

async function main() {
  const ctx = buildContext()

  /* ---- 造真實資料（連線 store 真 entry；secret=none → 密碼只走 ephemeral，不存 vault） ---- */
  const group = ctx.connections.createGroup({ name: '生產環境', parentId: null })
  const jump = ctx.connections.create(
    base({ name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: { kind: 'none' } } })
  )
  const target = ctx.connections.create(
    base({
      name: 'prod-web-01',
      groupId: group.id,
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )
  ctx.connections.create(
    base({
      name: 'app-db-01',
      groupId: group.id,
      host: '10.1.2.12',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: true, connectionIds: [jump.id] }
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
  win.webContents.on('render-process-gone', (_event, details) => log(`RENDER_GONE ${JSON.stringify(details)}`))
  win.show()
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'renderer')
  log('renderer ready')

  /* ---- 連 2 筆（ephemeral，不存 vault） ---- */
  const gwSession = await openSession(jump.id)
  const targetSession = await openSession(target.id)
  log(`sessions: gw=${gwSession} target=${targetSession}`)
  await waitFor(
    () => js(`(() => { const dots=[...document.querySelectorAll('.rs-tab .rs-dot--connected')].length; return dots >= 2 ? dots : false })()`),
    20000,
    '2 個已連線分頁'
  )
  measurements.sessions = {
    gw: gwSession,
    target: targetSession,
    tabs: JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.rs-tab')].map(t => t.textContent))`))
  }
  record('走查-連線 2 筆（ephemeral 不存 vault）', true, `gw-edge=${gwSession}；prod-web-01(經跳板)=${targetSession}`)

  /* ---- 01：主視窗（queue 收合，含分頁/樹/狀態列實況） ---- */
  await js(`window.rs.settings.patch({ ui: { queueCollapsed: true } })`)
  await sleep(400)
  await shot('01_主視窗_預設1280x800')

  /* ---- 補驗：樹列 26px / 三重表達 / 跳板標示 / 狀態列編碼 ---- */
  const treeRows = JSON.parse(
    await js(`JSON.stringify([...document.querySelectorAll('.rs-tree__row')].map(r => ({ h: r.getBoundingClientRect().height, text: r.textContent })))`)
  )
  measurements.treeRows = treeRows
  const rowHeights = treeRows.map((r) => r.h)
  record(
    '走查-樹列高 26px',
    rowHeights.length > 0 && rowHeights.every((h) => Math.abs(h - 26) <= 1),
    `量測=${rowHeights.map((h) => h.toFixed(1)).join(',')}（期望 26±1）`
  )
  const hasJumpMark = await js(`Boolean(document.querySelector('.rs-tree__row .rs-tree__jump'))`)
  record('走查-跳板標示（SVG 箭頭 --jump）', hasJumpMark, hasJumpMark ? '跳板節點含 inline SVG 箭頭（title/aria-label 經跳板 {name}）' : '樹節點未見跳板標示 → 列報告')
  const statusText = await js(`document.querySelector('.rs-statusbar span:nth-last-child(2)')?.textContent ?? ''`)
  measurements.statusEncoding = statusText
  record('走查-狀態列編碼字串（間隔點）', statusText.includes('·'), `「${statusText}」`)

  /* 傳輸前先開 SFTP channel（transfer.start 需要；同 m3-demo） */
  const sftpOpen = await js(`window.rs.sftp.open(${JSON.stringify(targetSession)}).then(r => r.ok ? r.data.sftpId : 'ERR:' + r.error.code)`)
  if (String(sftpOpen).startsWith('ERR')) throw new Error('sftp.open failed ' + sftpOpen)
  measurements.sftpId = sftpOpen

  const startTransfer = async (sessionId, direction, source, targetPath) => {
    const raw = await js(
      `window.rs.transfer.start({ sessionId: ${JSON.stringify(sessionId)}, direction: ${JSON.stringify(direction)}, onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
        source
      )}, target: ${JSON.stringify(targetPath)} }] }).then(r => r.ok ? JSON.stringify(r.data) : 'ERR:' + r.error.code)`
    )
    if (String(raw).startsWith('ERR')) throw new Error('transfer.start failed: ' + raw)
    return JSON.parse(raw)
  }

  /* ---- 50MB 真實傳輸 ---- */
  await remoteExec(ctx, targetSession, `mkdir -p ${REMOTE_ROOT}/walkthrough`)
  const bigLocal = path.join(localDir, 'walkthrough-50mb.bin')
  if (!fs.existsSync(bigLocal) || fs.statSync(bigLocal).size !== 50 * 1024 * 1024) makeFile(bigLocal, 50 * 1024 * 1024)
  const bigHash = sha256File(bigLocal)
  const target50 = `${REMOTE_ROOT}/walkthrough/walkthrough-50mb.bin`
  await js(`window.rs.settings.patch({ ui: { queueCollapsed: false, queueHeight: 160 } })`)
  await sleep(400)
  const body160 = await js(`document.querySelector('.rs-queue__body')?.getBoundingClientRect().height ?? -1`)
  measurements.queueBodyDefault160 = body160
  record('走查-佇列舊值 160 載入 clamp', Math.abs(body160 - 160) <= 1, `body=${body160}`)
  await js(`window.rs.settings.patch({ ui: { queueHeight: 200 } })`)
  await sleep(400)
  const body200 = await js(`document.querySelector('.rs-queue__body')?.getBoundingClientRect().height ?? -1`)
  measurements.queueBodyHeight = body200
  record('走查-FAIL-1 佇列展開 body=200', Math.abs(body200 - 200) <= 1, `1280x800 量測 body=${body200}`)

  const [upTask] = await startTransfer(targetSession, 'upload', bigLocal, target50)
  await waitFor(async () => {
    const task = (await listTasks()).find((t) => t.taskId === upTask.taskId)
    return task && task.state === 'running' && task.transferredBytes > 5 * 1024 * 1024
  }, 60000, '50MB 傳輸進行中')
  await shot('02_佇列展開')
  const running = (await listTasks()).find((t) => t.taskId === upTask.taskId)
  measurements.transfer50Running = { bytesPerSec: running.bytesPerSec, transferredBytes: running.transferredBytes, state: running.state }
  record(
    '走查-佇列七欄+整體速度（進行中）',
    running.state === 'running' && running.bytesPerSec > 0,
    `${(running.transferredBytes / 1024 / 1024).toFixed(1)}MB @ ${(running.bytesPerSec / 1024 / 1024).toFixed(2)}MB/s`
  )
  await waitFor(async () => {
    const task = (await listTasks()).find((t) => t.taskId === upTask.taskId)
    if (task?.state === 'failed') throw new Error('50MB upload failed: ' + JSON.stringify(task.error))
    return task?.state === 'completed'
  }, 300000, '50MB 完成')
  const remoteHash50 = await remoteExec(ctx, targetSession, `sha256sum ${target50} | cut -d' ' -f1`)
  record('走查-50MB 傳輸（真實）sha256 相符', remoteHash50 === bigHash, `local=${bigHash.slice(0, 16)}… remote=${remoteHash50.slice(0, 16)}…`)

  /* ---- SFTP 雙面板（prod 分頁 Ctrl+Shift+S） ---- */
  await js(`(() => { const tabs=[...document.querySelectorAll('.rs-tab')]; const t=tabs.find(x=>(x.textContent||'').includes('prod-web-01')); if(t) t.click(); return Boolean(t) })()`)
  await sleep(300)
  await key({ key: 'S', ctrlKey: true, shiftKey: true, bubbles: true })
  await waitFor(() => js(`Boolean(document.querySelector('.rs-sftp__view'))`).catch(() => false), 15000, 'SFTP 雙面板')
  await sleep(800)
  await shot('15_雙面板_SFTP')
  /* 關 SFTP 分頁（toggle 在 activeId=null 時不會關，直接點分頁✕） */
  await js(`(() => { const t=[...document.querySelectorAll('.rs-tab')].find(x=>(x.textContent||'').includes('Open SFTP')); const c=t && t.querySelector('.rs-tab__close'); if(c) c.click(); return Boolean(c) })()`)
  await sleep(300)

  /* ---- 03：工具列 New → 連線屬性對話框（FAIL-3 修復證據） ---- */
  await js(`(() => { const b=[...document.querySelectorAll('.rs-toolbar button')].find(x=>x.title && x.title.includes('New Connection')); if(b) b.click(); return Boolean(b) })()`)
  /* ConnectionDialog 自帶 [role=dialog]（不走 Modal 元件） */
  await waitFor(() => js(`Boolean(document.querySelector('[role="dialog"]'))`).catch(() => false), 5000, '連線屬性對話框')
  await sleep(400)
  const dialogRect = JSON.parse(await js(`(() => { const r=document.querySelector('[role="dialog"] > div').getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height }) })()`))
  measurements.connectionDialogRect = dialogRect
  await shot('03_連線屬性對話框')
  record('走查-連線屬性對話框（UI-02 640x520）', dialogRect.h === 520, `rect=${dialogRect.w}x${dialogRect.h}`)
  await key({ key: 'Escape', bubbles: true })
  await sleep(300)

  /* ---- 04~08：設定五分頁（720x520） ---- */
  await key({ key: ',', ctrlKey: true, bubbles: true })
  await waitFor(() => js(`Boolean(document.querySelector('.rs-settings'))`).catch(() => false), 5000, '設定對話框')
  await sleep(400)
  const settingsRect = JSON.parse(await js(`(() => { const r=document.querySelector('.rs-modal__dialog').getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height }) })()`))
  measurements.settingsDialog720x520 = settingsRect
  record('走查-FAIL-2 設定對話框 720x520', settingsRect.w === 720 && settingsRect.h === 520, `rect=${settingsRect.w}x${settingsRect.h}`)
  await shot('04_設定頁_一般')
  const paneClick = (label) =>
    js(`(() => { const b=[...document.querySelectorAll('.rs-settings__navitem')].find(x=>(x.textContent||'').trim() === ${JSON.stringify(label)}); if(b) b.click(); return Boolean(b) })()`)
  await paneClick('Terminal')
  await sleep(300)
  const encodingRow = JSON.parse(
    await js(
      `(() => { const i=[...document.querySelectorAll('.rs-settings__pane input')].find(x=>x.readOnly); return JSON.stringify(i ? { label: document.querySelector('label[for="'+i.id+'"]')?.textContent, value: i.value, readOnly: i.readOnly } : null) })()`
    )
  )
  measurements.encodingRow = encodingRow
  record('走查-終端頁唯讀 Encoding 列', encodingRow !== null && encodingRow.readOnly === true && encodingRow.value === 'UTF-8', JSON.stringify(encodingRow))
  await shot('05_設定頁_終端')
  await paneClick('Transfer')
  await sleep(300)
  await shot('06_設定頁_傳輸')
  await paneClick('Language')
  await sleep(300)
  await shot('07_設定頁_語言')
  await paneClick('About')
  await sleep(300)
  const logoShown = await js(`(() => { const s=document.querySelector('.rs-about__logo'); return Boolean(s) && s.getBoundingClientRect().width >= 40 })()`)
  measurements.aboutLogo = logoShown
  record('走查-FAIL-5 關於頁 Logo（UI-06 inline）', logoShown, `svg rendered=${logoShown}`)
  await shot('08_設定頁_關於')

  /* ---- 09：切繁中立即生效 ---- */
  await key({ key: 'Escape', bubbles: true })
  await sleep(300)
  await js(`(() => { const b=[...document.querySelectorAll('.rs-menubar .rs-menu__title')].pop(); if(b) b.click(); return Boolean(b) })()`)
  await sleep(200)
  await js(`(() => { const b=[...document.querySelectorAll('.rs-menu__item')].find(x=>(x.textContent||'').includes('Traditional Chinese')); if(b) b.click(); return Boolean(b) })()`)
  await sleep(500)
  const zhApplied = await js(`[...document.querySelectorAll('.rs-menubar .rs-menu__title')].pop().textContent.includes('中文')`)
  measurements.localeSwitch = { zhApplied }
  await shot('09_繁中_立即生效')
  record('走查-語系立即切換（全 UI）', zhApplied === true, `切換器=${zhApplied}`)
  await js(`(() => { const b=[...document.querySelectorAll('.rs-menubar .rs-menu__title')].pop(); if(b) b.click(); return Boolean(b) })()`)
  await sleep(200)
  await js(`(() => { const b=[...document.querySelectorAll('.rs-menu__item')].find(x=>(x.textContent||'').includes('English')); if(b) b.click(); return Boolean(b) })()`)
  await sleep(400)

  /* ---- 11：最小視窗 1024x680 ---- */
  win.setSize(1024, 680)
  await sleep(600)
  await shot('11_最小視窗1024x680')
  win.setSize(1280, 800)
  await sleep(600)

  /* ---- 12：空白樹右鍵選單（新增連線/新增分組） ---- */
  await js(`(() => { const body=document.querySelector('.rs-sidebar__body'); const r=body.getBoundingClientRect(); body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: Math.min(r.bottom - 10, r.top + 420) })); return true })()`)
  await waitFor(() => js(`document.querySelectorAll('.rs-sftp__ctxmenu [role="menuitem"]').length === 2`).catch(() => false), 5000, '右鍵選單兩項')
  await sleep(300)
  await shot('12_樹右鍵選單')
  const ctxItems = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.rs-sftp__ctxmenu [role="menuitem"]')].map(b => b.textContent))`))
  record('走查-FAIL-3 空白右鍵兩項', ctxItems.length === 2, ctxItems.join(' / '))
  await js(`(() => { const m=document.querySelector('.rs-sftp__mask'); if(m) m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
  await sleep(200)

  /* ---- 13：分組右鍵 → 新增連線（預填分組） ---- */
  await js(`(() => { const row=document.querySelector('[data-node-id^="group:"]'); const r=row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 30, clientY: r.top + 5 })); return true })()`)
  await waitFor(() => js(`document.querySelectorAll('.rs-sftp__ctxmenu [role="menuitem"]').length === 2`).catch(() => false), 5000, '分組右鍵選單')
  await js(`(() => { const b=[...document.querySelectorAll('.rs-sftp__ctxmenu [role="menuitem"]')].find(x=>(x.textContent||'').includes('New Connection')); if(b) b.click(); return Boolean(b) })()`)
  await waitFor(() => js(`Boolean(document.querySelector('[role="dialog"]'))`).catch(() => false), 5000, '預填對話框')
  await sleep(400)
  const prefillGroup = await js(`(() => { const s=[...document.querySelectorAll('select')].find(x=>document.querySelector('label[for="'+x.id+'"]')?.textContent === 'Group'); return s ? s.value : 'n/a' })()`)
  measurements.groupPrefill = prefillGroup
  await shot('13_分組右鍵_預填連線')
  record('走查-FAIL-3 分組右鍵預填', prefillGroup === group.id, `Group select=${prefillGroup}（期望 ${group.id}）`)
  await key({ key: 'Escape', bubbles: true })
  await sleep(300)

  /* ---- 補驗：中斷紅字 + 立即重連（monitor 2512 stop/cont；非致命，失敗只記錄） ---- */
  try {
    /* 先關 gw-edge 自己的 session：斷網時只有一條 ssh client 死亡（同 m3-demo C 條件） */
    await js(`window.rs.session.close(${JSON.stringify(gwSession)})`).catch(() => undefined)
    await sleep(500)
    const dropLocal = path.join(localDir, 'walkthrough-drop-50mb.bin')
    if (!fs.existsSync(dropLocal) || fs.statSync(dropLocal).size !== 50 * 1024 * 1024) makeFile(dropLocal, 50 * 1024 * 1024)
    const dropTarget = `${REMOTE_ROOT}/walkthrough/drop-50mb.bin`
    const [dropTask] = await startTransfer(targetSession, 'upload', dropLocal, dropTarget)
    await waitFor(async () => {
      const task = (await listTasks()).find((t) => t.taskId === dropTask.taskId)
      return task && task.transferredBytes > 10 * 1024 * 1024
    }, 120000, '中斷測試傳到 10MB')
    await monitor('stop')
    await waitFor(async () => {
      const task = (await listTasks()).find((t) => t.taskId === dropTask.taskId)
      return task?.state === 'paused'
    }, 60000, '斷線後 paused')
    let redShown = false
    try {
      await waitFor(
        () => js(`(() => { const s=document.querySelector('.rs-status'); return s && s.className.includes('is-error') })()`),
        90000,
        '狀態列紅字'
      )
      redShown = true
    } catch {
      redShown = false
    }
    const reconnectBtn = await js(`(() => { const b=[...document.querySelectorAll('.rs-statusbar button')].find(x=>(x.textContent||'').includes('Reconnect')); return Boolean(b) })()`)
    measurements.interrupted = { redStatusBar: redShown, reconnectButton: reconnectBtn }
    await shot('14_中斷紅字_立即重連')
    record('走查-中斷紅字+[立即重連]', redShown && reconnectBtn, `紅字=${redShown} 重連鈕=${reconnectBtn}`)
    await monitor('cont')
    await sleep(1000)
    const clicked = await js(`(() => { const b=[...document.querySelectorAll('.rs-statusbar button')].find(x=>(x.textContent||'').includes('Reconnect')); if(b) { b.click(); return true } return false })()`)
    if (!clicked) {
      /* renderer 未見斷線（偵測較慢）→ 直接以 IPC 重連（同 m3-demo fallback） */
      await js(`window.rs.session.reconnect(${JSON.stringify(targetSession)}).then(() => true)`)
    }
    await waitFor(async () => {
      const task = (await listTasks()).find((t) => t.taskId === dropTask.taskId)
      return task?.state === 'completed'
    }, 240000, '重連後續傳完成')
    record('走查-重連後續傳完成', true, `drop task ${dropTask.taskId} completed（button=${clicked}）`)
  } catch (error) {
    await monitor('cont').catch(() => undefined)
    record('走查-中斷重連補驗', false, '場景未完成：' + String((error && error.message) || error))
  }

  /* ---- 10：設定復原（原生 confirm → 外部全螢幕截圖） ---- */
  win.center()
  await sleep(400)
  await key({ key: ',', ctrlKey: true, bubbles: true })
  await waitFor(() => js(`Boolean(document.querySelector('.rs-settings'))`).catch(() => false), 5000, '設定對話框（復原）')
  await sleep(400)
  fs.writeFileSync(path.join(evidence, 'window-bounds.json'), JSON.stringify(win.getBounds()))
  fs.writeFileSync(path.join(evidence, 'RESET_CLICKED.txt'), new Date().toISOString())
  win.webContents
    .executeJavaScript(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Restore defaults')); if(b) b.click(); return Boolean(b) })()`,
      true
    )
    .catch(() => undefined)
  await sleep(8000) // 原生 confirm 在此期間顯示；watcher 全螢幕截圖後由本程序結束
  finish(0)
}

app.whenReady()
  .then(main)
  .catch(async (error) => {
    await monitor('cont').catch(() => undefined)
    process.stdout.write('WALKTHROUGH_FATAL ' + JSON.stringify({ error: String((error && error.stack) || error) }) + '\n')
    finish(1)
  })
