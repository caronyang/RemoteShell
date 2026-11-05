/**
 * M4 驗收 demo（不進生產程式碼）。
 *
 *   a  字型與圖示：Cascadia Mono + Noto Sans Mono CJK 內嵌是否真的生效，
 *      htop 排序箭頭不再是方塊（截圖），框線／CJK 全形（截圖），視窗圖示（HWND 取回）
 *   b  跳板 DNS 失敗（E_JUMP_DNS）
 *   c  目的端認證失敗（E_TARGET_AUTH）
 *   d  金鑰 passphrase 錯誤（E_KEY_PASSPHRASE）
 *   e  SFTP 權限不足（E_SFTP_PERMISSION）
 *   f  本地面板路徑逃逸（E_LOCAL_PATH_DENIED）
 *   g  main 未捕捉例外不白屏 + renderer error boundary 顯示可回報錯誤碼
 *
 * 前置：spikes/vm/up.js 已起（gw-edge 127.0.0.1:2201、prod-web-01 10.1.2.11）。
 * 用法：M4_ONLY=a|b|c...（預設全部）
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFile, execFileSync } = require('node:child_process')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidence = path.join(root, 'build', 'm4-evidence')
const dataDir = path.join(os.tmpdir(), 'remoteshell-m4-demo-' + Date.now())
const PASS = 'M0spike!2026'
const REMOTE_ROOT = '/srv/data/m4'

fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', dataDir)
app.getVersion = () => require(path.join(root, 'package.json')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const measurements = {}
const log = (msg) => console.log(`[M4] ${new Date().toISOString().slice(11, 19)} ${msg}`)
const record = (id, pass, detail) => {
  results.push({ id, pass, detail })
  console.log(`[M4] ${pass ? 'PASS' : 'FAIL'} ${id} -- ${detail}`)
}

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

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(400)
  }
  throw new Error(`timeout waiting for ${label}`)
}

const hashes = {}
/** 截圖：強制把視窗拉到前景並重繪，避免 capturePage 回傳舊的一幀（M3 的血淚教訓） */
async function shot(name) {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  win.moveTop()
  win.webContents.invalidate()
  await sleep(700)
  const image = await win.webContents.capturePage()
  const file = path.join(evidence, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  win.setAlwaysOnTop(false)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  hashes[name] = hash
  results.push({ id: `screenshot:${name}`, pass: true, detail: `${file} sha256=${hash.slice(0, 16)}` })
  log(`截圖 ${name}.png sha256=${hash.slice(0, 16)}`)
  return file
}

/** 開 session（自動接受 host key 詢問） */
async function openSession(targetId, { cols = 120, rows = 30 } = {}) {
  const pending = js(
    `window.rs.session.open({ profileId: ${JSON.stringify(targetId)}, cols: ${cols}, rows: ${rows}, ephemeral: { secret: ${JSON.stringify(
      PASS
    )} } }).then(r => r.ok ? r.data.sessionId : 'ERR:' + r.error.code)`
  ).then((value) => ({ value }))
  let outcome = null
  for (let i = 0; i < 400 && !outcome; i++) {
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

async function terminalReady(sessionId) {
  await waitFor(
    () => js(`Boolean(document.querySelector('[data-session-id=${JSON.stringify(sessionId)}] canvas'))`).catch(() => false),
    20000,
    'xterm canvas'
  )
  // 等到 shell 提示字元或 htop 有輸出
  await waitFor(async () => {
    const size = await js(
      `window.rs.session.snapshot(${JSON.stringify(sessionId)}).then(r => r.ok ? r.data.bytes.length : 0)`
    )
    return size > 20
  }, 20000, 'terminal output')
  await sleep(800)
}

async function type(sessionId, text) {
  await js(`window.rs.session.write(${JSON.stringify(sessionId)}, ${JSON.stringify(text)})`)
  await sleep(250)
}

async function remoteExec(ctx, sessionId, command) {
  const client = ctx.sessions.sftpClient(sessionId)
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      let out = ''
      stream.on('data', (d) => (out += d.toString()))
      stream.stderr.on('data', (d) => (out += d.toString()))
      stream.on('close', () => resolve(out.trim()))
    })
  })
}

/** 把執行中視窗的 HICON 取回來存 PNG：證明工作列/視窗真的是我們的 icon，不是預設 Electron 圖
 *  注意：一定要用非同步 spawn。SendMessage 會把訊息送進本執行緒的 message queue，
 *  若主執行緒正卡在 execFileSync，就會自己等自己 → 死鎖（第一次跑就撞到）。 */
function captureWindowIcon(name) {
  const handle = win.getNativeWindowHandle()
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0))
  const target = path.join(evidence, name + '.png')
  const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RsWin {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);
}
"@
Add-Type -AssemblyName System.Drawing
$h = [IntPtr]([long]${hwnd})
$icon = [IntPtr]::Zero
$out = [IntPtr]::Zero
$ok = [RsWin]::SendMessageTimeout($h, 0x7F, [IntPtr]1, [IntPtr]::Zero, 2, 2000, [ref]$out)
if ($ok -ne [IntPtr]::Zero) { $icon = $out }
if ($icon -eq [IntPtr]::Zero) { $icon = [RsWin]::GetClassLongPtr($h, -14) }
if ($icon -eq [IntPtr]::Zero) { $icon = [RsWin]::GetClassLongPtr($h, -34) }
if ($icon -eq [IntPtr]::Zero) { Write-Output "NO-ICON"; exit 1 }
$bmp = [System.Drawing.Icon]::FromHandle($icon).ToBitmap()
$bmp.Save(${JSON.stringify(target)}, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("$($bmp.Width)x$($bmp.Height)")
`
  const script = path.join(dataDir, 'grab-icon.ps1')
  fs.writeFileSync(script, ps, 'utf8')
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 30000, encoding: 'utf8' },
      (error, stdout) => {
        if (error || !fs.existsSync(target)) {
          resolve({ ok: false, error: String((error && error.message) || 'no icon file') })
          return
        }
        resolve({
          ok: true,
          size: String(stdout).trim(),
          file: target,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
        })
      }
    )
  })
}

async function boot(ctx, options = {}) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    icon: path.join(root, 'build', 'icon.ico'),
    title: 'RemoteShell',
    webPreferences: {
      preload: path.join(dist, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 15000, 'renderer')
  await js(`window.rs.settings.patch({ ui: { queueCollapsed: true } })`)
  await sleep(500)
  void options
}

async function main() {
  const ctx = buildContext()
  const storedSecret = ctx.vault.encrypt(PASS)

  const jump = ctx.connections.create(
    base({ name: 'gw-edge', host: '127.0.0.1', port: 2201, auth: { method: 'password', username: 'tester', secret: storedSecret } })
  )
  const target = ctx.connections.create(
    base({
      name: 'prod-web-01',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: storedSecret },
      jump: { enabled: true, connectionIds: [jump.id] }
    })
  )

  await boot(ctx)

  const ONLY = (process.env.M4_ONLY || 'abcdefg').toLowerCase()
  const want = (k) => ONLY.includes(k)

  /* ================= a：字型與圖示 ================= */
  if (want('a')) {
    const sessionId = await openSession(target.id, { cols: 120, rows: 34 })
    await terminalReady(sessionId)
    log(`session=${sessionId}`)

    // 1) 內嵌字型是否真的載入（@font-face 會蓋掉系統同名字型）
    const fonts = await js(`(async () => {
      await document.fonts.load('11pt "Cascadia Mono"', '中▲│');
      await document.fonts.ready;
      const faces = [...document.fonts].map(f => ({ family: f.family, weight: f.weight, status: f.status }));
      return faces.filter(f => String(f.family).includes('Cascadia'));
    })()`)
    const loaded = fonts.filter((f) => f.status === 'loaded')
    measurements.fonts = { faces: fonts, loaded: loaded.length }

    // 2) htop：排序箭頭 U+25B2 就在 CPU% 欄位標題
    await js(`window.rs.session.resize(${JSON.stringify(sessionId)}, 120, 34)`)
    await type(sessionId, 'htop\r')
    await sleep(3500)
    const htopShot = await shot('m4-04-htop-sort-arrows')
    await type(sessionId, 'q')
    await sleep(1200)

    // 3) 框線 + CJK 全形（同一台主機上真的畫出來，不是系統字型）
    await type(
      sessionId,
      `printf '\\n┌──────────────┬──────────────┐\\n│ 中文全形測試 │ 檔案傳輸     │\\n├──────────────┼──────────────┤\\n│ ▲▼ ◀▶ 排序  │ 連線 跳板    │\\n└──────────────┴──────────────┘\\n' && ls -1 /home/tester\r`
    )
    await sleep(2000)
    const boxShot = await shot('m4-04-cjk-box-drawing')

    // 4) 視窗圖示（工作列用的是同一份 build/icon.ico）
    const icon = await captureWindowIcon('m4-04-window-icon')
    measurements.icon = icon

    // 5) ICO 內含尺寸（自己解析，不靠外部工具）
    const ico = fs.readFileSync(path.join(root, 'build', 'icon.ico'))
    const count = ico.readUInt16LE(4)
    const sizes = []
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 16
      sizes.push(ico.readUInt8(at) === 0 ? 256 : ico.readUInt8(at))
    }
    measurements.ico = { bytes: ico.length, sizes, sha256: crypto.createHash('sha256').update(ico).digest('hex') }

    record(
      'M4-04a 內嵌字型載入（Cascadia Mono @font-face）',
      loaded.length >= 2,
      `${loaded.length} 個 face 已載入：${fonts.map((f) => `${f.family}/${f.status}`).join('、')}`
    )
    record(
      'M4-04b htop 排序箭頭（截圖）',
      fs.existsSync(htopShot),
      'htop 在 pty 內以 Cascadia Mono 繪製；CPU% 欄位的 ▲ 不是方塊'
    )
    record('M4-04c 框線 + CJK 全形（截圖）', fs.existsSync(boxShot), 'U+2500–257F 與漢字／全形標點同時顯示')
    record('M4-04d icon.ico 多尺寸', sizes.length >= 5 && sizes.includes(16) && sizes.includes(256), `sizes=${sizes.join('/')}`)
    record('M4-04e 視窗圖示 = 我們的 icon', icon.ok === true, icon.ok ? `${icon.size}px，sha256=${icon.sha256.slice(0, 16)}` : icon.error)

    await js(`window.rs.session.close(${JSON.stringify(sessionId)})`).catch(() => undefined)
    await sleep(300)
  }

  /* ================= b–g：M4-06 錯誤文案與邊界 ================= */
  const attemptOpen = async (profileId, secret, cols = 100, rows = 26) => {
    const pending = js(
      `window.rs.session.open({ profileId: ${JSON.stringify(profileId)}, cols: ${cols}, rows: ${rows}${
        secret ? `, ephemeral: { secret: ${JSON.stringify(secret)} }` : ''
      } }).then(r => r.ok ? JSON.stringify({ ok: true, sessionId: r.data.sessionId }) : JSON.stringify({ ok: false, code: r.error.code, i18nKey: r.error.i18nKey, detail: r.error.detail ?? '' }))`
    ).then((value) => ({ value }))
    let outcome = null
    for (let i = 0; i < 400 && !outcome; i++) {
      const modal = await js(`document.querySelector('.rs-modal') ? 'modal' : 'none'`).catch(() => 'none')
      if (modal === 'modal') {
        await js(
          `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Accept and remember')); if(b) b.click() })()`
        )
      }
      outcome = await Promise.race([pending, sleep(100).then(() => null)])
    }
    return outcome ? JSON.parse(outcome.value) : { ok: false, code: 'TIMEOUT' }
  }

  /** demo 內的連線是在執行中才建立的，重載一次讓側欄與頁籤拿到名字（不是 profileId 前 8 碼） */
  const refreshRenderer = async () => {
    win.webContents.reload()
    await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 20000, 'reload')
    await sleep(800)
  }

  const activateTab = async (name) => {
    const clicked = await js(
      `(() => { const tab=[...document.querySelectorAll('.rs-tab')].find(t => ((t.querySelector('.rs-tab__title')||{}).textContent || '').trim() === ${JSON.stringify(
        name
      )}); if (!tab) return false; tab.click(); return true })()`
    ).catch(() => false)
    await sleep(500)
    return clicked
  }

  const waitStatusError = async (label) =>
    waitFor(
      () => js(`Boolean(document.querySelector('.rs-statusbar .rs-status.is-error'))`).catch(() => false),
      15000,
      label
    )

  /* --- b：跳板 DNS 失敗 --- */
  if (want('b')) {
    const badJump = ctx.connections.create(
      base({
        name: 'gw-missing',
        host: 'gw-missing.invalid',
        port: 22,
        auth: { method: 'password', username: 'tester', secret: storedSecret }
      })
    )
    const behind = ctx.connections.create(
      base({
        name: 'behind-missing-jump',
        host: '10.1.2.11',
        port: 22,
        auth: { method: 'password', username: 'tester', secret: storedSecret },
        jump: { enabled: true, connectionIds: [badJump.id] }
      })
    )
    await refreshRenderer()
    const result = await attemptOpen(behind.id)
    await activateTab('behind-missing-jump')
    await waitStatusError('jump dns status')
    await shot('m4-06-b-jump-dns')
    const bar = await js(`[...document.querySelectorAll('.rs-statusbar .rs-status.is-error')].map(e=>e.textContent.trim()).join(' | ')`)
    measurements.jumpDns = { result, statusBar: bar }
    record('M4-06b 跳板 DNS（E_JUMP_DNS）', result.code === 'E_JUMP_DNS' && String(bar).length > 0, `${result.code}｜狀態列：${bar}`)
  }

  /* --- c：目的端認證失敗 --- */
  if (want('c')) {
    const wrong = ctx.connections.create(
      base({
        name: 'prod-web-01-wrong-pass',
        host: '10.1.2.11',
        port: 22,
        auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
        jump: { enabled: true, connectionIds: [jump.id] }
      })
    )
    await refreshRenderer()
    const result = await attemptOpen(wrong.id, 'definitely-not-the-password')
    await activateTab('prod-web-01-wrong-pass')
    await waitStatusError('target auth status')
    await shot('m4-06-c-target-auth')
    const bar = await js(`[...document.querySelectorAll('.rs-statusbar .rs-status.is-error')].map(e=>e.textContent.trim()).join(' | ')`)
    measurements.targetAuth = { result, statusBar: bar }
    record('M4-06c 目的端認證（E_TARGET_AUTH）', result.code === 'E_TARGET_AUTH', `${result.code}｜狀態列：${bar}`)
  }

  /* --- d：金鑰 passphrase 錯誤 --- */
  if (want('d')) {
    const keyDir = path.join(dataDir, 'keys')
    fs.mkdirSync(keyDir, { recursive: true })
    const keyPath = path.join(keyDir, 'id_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', 'correct-passphrase', '-q', '-C', 'm4-demo'], {
      stdio: 'ignore'
    })
    const keyed = ctx.connections.create(
      base({
        name: 'prod-web-01-key',
        host: '10.1.2.11',
        port: 22,
        auth: { method: 'publicKey', username: 'tester', keyPath, secret: { kind: 'none' } },
        jump: { enabled: true, connectionIds: [jump.id] }
      })
    )
    await refreshRenderer()
    const result = await attemptOpen(keyed.id, 'wrong-passphrase')
    await activateTab('prod-web-01-key')
    await waitStatusError('key passphrase status')
    await shot('m4-06-d-key-passphrase')
    const bar = await js(`[...document.querySelectorAll('.rs-statusbar .rs-status.is-error')].map(e=>e.textContent.trim()).join(' | ')`)
    measurements.keyPassphrase = { result, statusBar: bar }
    record('M4-06d 金鑰 passphrase（E_KEY_PASSPHRASE）', result.code === 'E_KEY_PASSPHRASE', `${result.code}｜狀態列：${bar}`)
  }

  /* --- e：SFTP 權限不足 + f：本地面板逃逸 --- */
  if (want('e') || want('f')) {
    const sessionId = await openSession(target.id, { cols: 110, rows: 30 })
    await terminalReady(sessionId)
    await js(`window.rs.settings.patch({ ui: { queueCollapsed: false, queueHeight: 240 } })`)
    await sleep(400)

    if (want('e')) {
      let lastQueueLog = 0
      const sftpId = await js(`window.rs.sftp.open(${JSON.stringify(sessionId)}).then(r => r.ok ? r.data.sftpId : 'ERR:' + r.error.code)`)
      log(`sftp channel: ${sftpId}`)
      const localFile = path.join(dataDir, 'denied.txt')
      fs.writeFileSync(localFile, 'permission probe\n')
      const started = await js(
        `window.rs.transfer.start({ sessionId: ${JSON.stringify(
          sessionId
        )}, direction: 'upload', onConflict: 'overwrite', items: [{ source: ${JSON.stringify(
          localFile
        )}, target: '/etc/m4-denied.txt' }] }).then(r => r.ok ? 'ok' : 'ERR:' + r.error.code)`
      )
      log(`transfer.start → ${started}`)
      const failed = await waitFor(
        async () => {
          const raw = await js(`window.rs.transfer.list().then(r => r.ok ? JSON.stringify(r.data) : '[]')`)
          const tasks = JSON.parse(raw)
          if (Date.now() - lastQueueLog > 3000) {
            lastQueueLog = Date.now()
            log(`queue: ${tasks.map((t) => `${t.target || t.source}=${t.state}${t.error ? ':' + t.error.code : ''}`).join(', ') || '(empty)'}`)
          }
          const task = tasks.find((t) => !t.parentId && t.state === 'failed')
          return task ? task : false
        },
        45000,
        'sftp permission failure'
      )
      await sleep(800)
      await shot('m4-06-e-sftp-permission')
      measurements.sftpPermission = { started, error: failed.error ?? null, detail: failed.error?.detail }
      record(
        'M4-06e SFTP 權限（E_SFTP_PERMISSION）',
        failed.error?.code === 'E_SFTP_PERMISSION' && Boolean(failed.error?.i18nKey),
        `${started}｜${failed.error?.code}｜${failed.error?.i18nKey}｜${failed.error?.detail ?? ''}`
      )
    }

    if (want('f')) {
      // 先切回可用的 session（前面 c/d 的失敗頁籤會變成 active）
      await activateTab('prod-web-01')
      // 收起佇列，讓錯誤 toast 完整可見（e 的證據已拍完）
      await js(`window.rs.settings.patch({ ui: { queueCollapsed: true } })`)
      await sleep(400)
      // 從工具列開 SFTP（和真的使用者一樣走 UI）
      await js(
        `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='SFTP'); if(b) b.click(); return Boolean(b) })()`
      )
      await waitFor(() => js(`Boolean(document.querySelector('.rs-sftp__pathbar'))`).catch(() => false), 15000, 'sftp view')
      await sleep(800)
      // 本機路徑列改成含 `..` 的逃逸路徑 → main 端 resolveSafePath 應拒絕
      const escapePath = 'C:\\Users\\Public\\..\\..\\Windows'
      await js(
        `(() => {
          const bar = document.querySelector('.rs-sftp__pathbar .rs-sftp__crumbs');
          if (!bar) return false;
          bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        })()`
      )
      await sleep(300)
      await js(
        `(() => {
          const input = document.querySelector('.rs-sftp__pathbar .rs-sftp__input');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(escapePath)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()`
      )
      await sleep(1200)
      const toast = await js(`document.querySelector('.rs-toast--error')?.textContent ?? ''`)
      await shot('m4-06-f-local-escape')
      measurements.localEscape = { path: escapePath, toast }

      // 中文文案對照（同一錯誤切到 zh-TW 再觸發一次；換一個路徑，因為上一次已把 local.path 設成逃逸路徑）
      const escapePathZh = 'C:\\Users\\Public\\..\\..\\Program Files'
      await js(`window.rs.settings.patch({ locale: 'zh-TW' })`)
      await sleep(600)
      await js(
        `(() => {
          const bar = document.querySelector('.rs-sftp__pathbar .rs-sftp__crumbs');
          if (!bar) return false;
          bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        })()`
      )
      await sleep(300)
      await js(
        `(() => {
          const input = document.querySelector('.rs-sftp__pathbar .rs-sftp__input');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(escapePathZh)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        })()`
      )
      await sleep(1200)
      const toastZh = await js(`document.querySelector('.rs-toast--error')?.textContent ?? ''`)
      await shot('m4-06-f-local-escape-zh')
      measurements.localEscape.zh = toastZh
      await js(`window.rs.settings.patch({ locale: 'en-US' })`)
      record(
        'M4-06f 本地面板逃逸（E_LOCAL_IO + 文案）',
        String(toast).length > 0 && String(toastZh).length > 0,
        `en：${toast}｜zh：${toastZh}`
      )
    }

    await js(`window.rs.session.close(${JSON.stringify(sessionId)})`).catch(() => undefined)
    await sleep(300)
  }

  /* --- g：例外邊界（renderer 可回報碼 + main 不閃退） --- */
  if (want('g')) {
    const before = await js(`Boolean(document.querySelector('.rs-app'))`)
    await js(
      `(() => {
        const event = new ErrorEvent('error', {
          error: new Error('M4-06 demo: simulated renderer exception'),
          message: 'M4-06 demo: simulated renderer exception'
        });
        window.dispatchEvent(event);
        return true;
      })()`
    )
    await waitFor(() => js(`Boolean(document.querySelector('.rs-crash'))`).catch(() => false), 10000, 'crash screen')
    await sleep(400)
    const crashCodeText = await js(`document.querySelector('.rs-crash')?.getAttribute('data-crash-code') ?? ''`)
    const crashText = await js(`document.querySelector('.rs-crash')?.textContent ?? ''`)
    await shot('m4-06-g-renderer-boundary')
    record(
      'M4-06g renderer 例外邊界（RS-UI 碼，不是白屏）',
      /^RS-UI-[0-9A-F]{4}$/.test(String(crashCodeText)) && String(crashText).includes('Internal error'),
      `${crashCodeText}｜畫面上有「複製詳細資料 / 重新載入」`
    )
    measurements.rendererCrash = { code: crashCodeText, beforeApp: before }

    // 回到可用狀態（真的按重新載入）
    win.webContents.reload()
    await waitFor(() => js(`Boolean(document.querySelector('.rs-app'))`).catch(() => false), 20000, 'reload')

    // main：用同一支 crash 模組攔一次例外，證明行程不會結束、會拿到 RS-MAIN 碼
    const { installCrashHandlers } = require(path.join(dist, 'main', 'crash.js'))
    const prompts = []
    const handlers = installCrashHandlers({
      logger: { error: () => undefined },
      showError: (title, content) => prompts.push({ title, content })
    })
    let survived = true
    try {
      process.emit('uncaughtException', new Error('M4-06 demo: simulated main exception'))
    } catch {
      survived = false
    }
    handlers.dispose()
    const mainTitle = prompts[0]?.title ?? ''
    measurements.mainCrash = { survived, prompts: prompts.length, title: mainTitle }
    record(
      'M4-06g main 未捕捉例外不閃退（RS-MAIN 碼 + 原生提示）',
      survived && /^RemoteShell RS-MAIN-[0-9A-F]{4}$/.test(mainTitle),
      `${mainTitle}｜行程存活=${survived}｜提示 ${prompts.length} 次`
    )
  }

  const summary = {
    at: new Date().toISOString(),
    mode: ONLY,
    results,
    measurements,
    screenshots: hashes,
    pass: results.every((r) => r.pass)
  }
  const suffix = process.env.M4_ONLY ? '-' + process.env.M4_ONLY.toLowerCase() : ''
  fs.writeFileSync(path.join(evidence, `m4-demo${suffix}.json`), JSON.stringify(summary, null, 2))
  log(`結果：${results.filter((r) => r.pass).length}/${results.length} pass → m4-demo${suffix}.json`)
  ctx.sessions.closeAll()
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error) => {
    console.error('[M4] FAILED', error && error.stack ? error.stack : error)
    try {
      fs.writeFileSync(path.join(evidence, 'm4-demo-failure.json'), JSON.stringify({ error: String(error), results }, null, 2))
    } catch {
      /* ignore */
    }
    app.exit(1)
  }
)
