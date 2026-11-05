/**
 * v0.1.10 #2 實機驗證探針（不進生產程式碼）：
 *  A. 選取（行含 CJK+ANSI）→ Ctrl+C → 剪貼簿內容正確、sleep 仍活著（未送 SIGINT）
 *  B. 無選取 → Ctrl+C → sleep 100 被打斷（PM 指定驗收格；以 pgrep ^sleep 證證，不依賴 DOM 文字）
 *  C. 外部剪貼簿（main electron.clipboard 寫多行+CJK）→ 終端 Ctrl+V → 兩行都執行、CJK 不掉字（寫檔後 exec cat 驗證）
 *  D. 右鍵選單：無選取 Copy 停用、有選取 Copy 可用（＋2 張截圖）
 * 輸出：build/v0110-copy-probe/evidence.json + 01/02 截圖
 * 前置：spikes/vm/up.js 已起（gw-edge 127.0.0.1:2201）。
 * 註：WebGL 渲染下無 .xterm-rows DOM 文字 → 文字類等證改走 shell 側（pgrep / 檔案）。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, BrowserWindow, clipboard } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'v0110-copy-probe')
const dataDir = path.join(os.tmpdir(), 'remoteshell-v0110-probe-' + Date.now())
const PASS = 'M0spike!2026'
const PGREP = 'pgrep -f "^sleep 100" | wc -l'

fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(`[V0110] ${new Date().toISOString().slice(11, 19)} ${msg}`)
const results = {}
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
  const logger = { filePath: path.join(dataDir, 'probe.log'), info: () => {}, warn: () => {}, error: (m) => console.log('[ERR]', m) }
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

async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${label}`)
}

/** M3 shot() 那套：置頂/聚焦/重繪再擷取 */
async function shot(name) {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  win.moveTop()
  win.webContents.invalidate()
  await sleep(600)
  const image = await win.webContents.capturePage()
  const file = path.join(evidence, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  win.setAlwaysOnTop(false)
  log(`shot ${name}`)
  return file
}

/** 以 exec 通道執行遠端命令（shell 側等證；sftp exec 與互動 shell 同一 ssh 連線） */
function remoteExec(ctx, sessionId, command) {
  return new Promise((resolve) => {
    const client = ctx.sessions.sftpClient(sessionId)
    client.exec(command, (error, stream) => {
      if (error) {
        resolve('ERR:' + error.message)
        return
      }
      let out = ''
      stream.on('data', (d) => (out += d.toString()))
      stream.stderr.on('data', (d) => (out += d.toString()))
      stream.on('close', () => resolve(out.trim()))
    })
  })
}

/** 對終端送「受信任」按鍵（Electron sendInputEvent → 真實 keyCode/isTrusted；
 *  合成 KeyboardEvent 的 keyCode 恆為 0，會被 xterm evaluateKeyboardEvent 吞掉 —— 除錯實證） */
const sendKey = (keyCode, modifiers = []) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

/**
 * 三擊選「第 0 列」（clear 後 marker 指令列）：列高取自 .xterm-cursor 高度，
 * 座標取自頁面 getBoundingClientRect，以 clickCount 1/2/3 送受信任連點（xterm 三擊=選整行）。
 */
const tripleClickRow0 = async () => {
  const pos = JSON.parse(
    await js(
      `(() => { const sc = document.querySelector('.xterm-screen').getBoundingClientRect(); const cur = document.querySelector('.xterm-cursor'); const rowH = cur && cur.getBoundingClientRect().height > 4 ? cur.getBoundingClientRect().height : sc.height / 30; return JSON.stringify({ x: Math.round(sc.left + 40), y: Math.round(sc.top + rowH / 2) }) })()`
    )
  )
  for (let clickCount = 1; clickCount <= 3; clickCount++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount })
  }
}

/** 清除選取：下段空白列受信任 mousedown（xterm mousedown 清選取） */
const clearSelection = async () => {
  const pos = JSON.parse(
    await js(
      `(() => { const sc = document.querySelector('.xterm-screen').getBoundingClientRect(); return JSON.stringify({ x: Math.round(sc.left + 4), y: Math.round(sc.top + sc.height * 0.9) }) })()`
    )
  )
  win.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
}

/** 右鍵選單狀態 */
const menuState = () =>
  js(
    `(() => {
      const menu = document.querySelector('[role="menu"]')
      if (!menu) return JSON.stringify({ open: false })
      const copy = [...menu.querySelectorAll('[role="menuitem"]')].find(b => (b.textContent || '').trim() === 'Copy')
      const paste = [...menu.querySelectorAll('[role="menuitem"]')].find(b => (b.textContent || '').trim() === 'Paste')
      return JSON.stringify({ open: true, copyDisabled: copy ? copy.disabled : null, pasteDisabled: paste ? paste.disabled : null })
    })()`
  )

const openContextMenu = () =>
  js(
    `(() => { const pane = document.querySelector('.rs-terminal__pane'); if (!pane) return false; pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 640, clientY: 400 })); return true })()`
  )

const closeMenu = () =>
  js(`(() => { const m = document.querySelector('[role="menu"]'); if (m) m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)

async function main() {
  const ctx = buildContext()
  ctx.connections.create({
    groupId: null,
    protocol: 'ssh',
    jump: { enabled: false, connectionIds: [] },
    terminal: {},
    tags: [],
    description: '',
    name: 'gw-edge',
    host: '127.0.0.1',
    port: 2201,
    auth: { method: 'password', username: 'tester', secret: { kind: 'none' } }
  })

  win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { preload: path.join(dist, 'preload', 'index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'renderer')

  /* 連線：UI dblClick → 憑證框 → 密碼（hostkey 自動接受） */
  await js(`(() => { const row = document.querySelector('[data-node-id^="profile:"]'); if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return Boolean(row) })()`)
  await waitFor(() => js(`Boolean(document.querySelector('input[type="password"]'))`).catch(() => false), 10000, 'credential dialog')
  await js(
    `(() => { const i = document.querySelector('input[type="password"]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(i, ${JSON.stringify(PASS)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
  )
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'OK'); if (b) b.click(); return Boolean(b) })()`)
  await waitFor(async () => {
    const accepted = await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('Accept and remember')); if (b) { b.click(); return true } return false })()`).catch(() => false)
    if (accepted) return false
    return js(`Boolean(document.querySelector('.xterm'))`).catch(() => false)
  }, 30000, 'xterm')
  await sleep(800)
  const sessionId = await js(`document.querySelector('.rs-terminal__pane').getAttribute('data-session-id')`)
  log('session=' + sessionId)

  /* ===== 準備：clear → marker 指令（第 0 列）→ sleep 100 ===== */
  await js(`window.rs.session.write(${JSON.stringify(sessionId)}, 'clear\\r')`)
  await sleep(500)
  await js(`window.rs.session.write(${JSON.stringify(sessionId)}, 'echo COPYMARK_123_CJK中文\\r')`)
  await sleep(600)
  await js(`window.rs.session.write(${JSON.stringify(sessionId)}, 'sleep 100\\r')`)
  await sleep(900)
  const pgrepBefore = await remoteExec(ctx, sessionId, PGREP)
  log('pgrep(before)=' + pgrepBefore)
  results.setup = { pgrepBefore }

  /* ===== A. 選取 marker 列 → Ctrl+C → 剪貼簿正確、sleep 仍活著（未送 SIGINT） ===== */
  /* 視窗需先聚焦（shot() 會 focus，但 A 在其之前；失焦時 mouse 選取不成） */
  win.focus()
  await sleep(500)
  clipboard.clear()
  await tripleClickRow0()
  await sleep(300)
  /* 診斷：三擊後選取層是否存在；不存在就改雙擊 marker 單字（cursor 寬度=字寬） */
  let hasSel = await js(`Boolean(document.querySelector('.xterm-selection'))`)
  if (!hasSel) {
    const wordPos = JSON.parse(
      await js(
        `(() => { const sc = document.querySelector('.xterm-screen').getBoundingClientRect(); const cur = document.querySelector('.xterm-cursor'); const charW = cur && cur.getBoundingClientRect().width > 2 ? cur.getBoundingClientRect().width : 7; return JSON.stringify({ x: Math.round(sc.left + 18 * charW), y: Math.round(sc.top + (cur && cur.getBoundingClientRect().height > 4 ? cur.getBoundingClientRect().height : sc.height / 30) / 2) }) })()`
      )
    )
    win.webContents.sendInputEvent({ type: 'mouseDown', x: wordPos.x, y: wordPos.y, button: 'left', clickCount: 2 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: wordPos.x, y: wordPos.y, button: 'left', clickCount: 2 })
    await sleep(300)
    hasSel = await js(`Boolean(document.querySelector('.xterm-selection'))`)
  }
  results.A_selectionDebug = hasSel
  log('A selection layer=' + hasSel)
  sendKey('c', ['control'])
  await sleep(900)
  const clipA = clipboard.readText()
  const pgrepAfterCopy = await remoteExec(ctx, sessionId, PGREP)
  results.A = {
    clipboard: clipA,
    clipboardHasMarker: clipA.includes('COPYMARK'),
    clipboardHasCJK: /[一-鿿]/.test(clipA),
    sleepAliveAfterCopy: Number(pgrepAfterCopy) >= 1
  }
  log('A=' + JSON.stringify(results.A))

  /* ===== B. 清選取 → 無選取 Ctrl+C → sleep 被打斷（PM 指定驗收格） ===== */
  await clearSelection()
  await sleep(250)
  sendKey('c', ['control'])
  const pgrepAfterSigint = await waitFor(async () => {
    const out = await remoteExec(ctx, sessionId, PGREP)
    return Number(out) === 0 ? '0' : null
  }, 8000, 'sleep interrupted')
  results.B = { sleepKilled: pgrepAfterSigint === '0' }
  log('B=' + JSON.stringify(results.B))

  /* ===== C. 外部剪貼簿多行+CJK → Ctrl+V → 兩行都執行、CJK 不掉字、只貼一次 ===== */
  clipboard.clear()
  /* p2 用 >> 追加：若被貼兩次（keyup 重貼 bug）wc -l 會 =2 */
  clipboard.writeText('echo PASTE_OK_中文 > /tmp/v0110_p1.txt\necho SECOND_LINE >> /tmp/v0110_p2.txt\n')
  await js(`window.rs.session.write(${JSON.stringify(sessionId)}, 'rm -f /tmp/v0110_p2.txt\\r')`)
  await sleep(400)
  sendKey('v', ['control'])
  await sleep(1500)
  const catOut = await remoteExec(ctx, sessionId, 'cat /tmp/v0110_p1.txt /tmp/v0110_p2.txt 2>/dev/null')
  const pasteLines = await remoteExec(ctx, sessionId, 'wc -l < /tmp/v0110_p2.txt')
  results.C = {
    catOutput: catOut,
    firstLine: catOut.includes('PASTE_OK_中文'),
    secondLine: catOut.includes('SECOND_LINE'),
    pastedOnce: Number(pasteLines) === 1
  }
  log('C=' + JSON.stringify(results.C))

  /* ===== D. 右鍵選單狀態（+截圖） ===== */
  await clearSelection()
  await sleep(250)
  await openContextMenu()
  await sleep(350)
  results.D_noSelection = JSON.parse(await menuState())
  await shot('01_menu_noselection')
  await closeMenu()
  await sleep(250)

  await tripleClickRow0()
  await sleep(300)
  await openContextMenu()
  await sleep(350)
  results.D_withSelection = JSON.parse(await menuState())
  await shot('02_menu_selection')
  log('D=' + JSON.stringify(results.D_noSelection) + ' / ' + JSON.stringify(results.D_withSelection))

  const checks = {
    'A clipboard has marker+CJK': results.A.clipboardHasMarker && results.A.clipboardHasCJK,
    'A copy with selection does NOT send SIGINT (sleep alive)': results.A.sleepAliveAfterCopy,
    'B no-selection Ctrl+C interrupts sleep (PM acceptance)': results.B.sleepKilled,
    'C external clipboard multiline+CJK pasted (two lines ran, single paste)': results.C.firstLine && results.C.secondLine && results.C.pastedOnce,
    'D no-selection: Copy disabled / Paste enabled': results.D_noSelection.open === true && results.D_noSelection.copyDisabled === true && results.D_noSelection.pasteDisabled === false,
    'D with-selection: Copy enabled': results.D_withSelection.open === true && results.D_withSelection.copyDisabled === false
  }
  results.checks = checks
  results.allPass = Object.values(checks).every(Boolean)

  fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify(results, null, 2))
  console.log('V0110_PROBE ' + JSON.stringify({ ok: results.allPass, checks }))
  app.exit(results.allPass ? 0 : 1)
}

app.whenReady()
  .then(main)
  .catch((error) => {
    console.log('V0110_FATAL ' + String((error && error.stack) || error))
    app.exit(1)
  })
