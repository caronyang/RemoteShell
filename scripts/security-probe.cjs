/**
 * M1-03 安全驗證探針（不是產品程式碼，只跑在 scripts/）。
 * 用正式建置產物（dist/main、dist/preload、dist/renderer）開一個與產品同設定的視窗，
 * 檢查：Node API 不可用、window.rs 只有白名單、CSP 生效、三區佈局有渲染，
 * 並輸出英文／中文兩張截圖作為 M1-10 验收證據。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const evidenceDir = path.join(root, 'build', 'm1-evidence')
const probeUserData = path.join(os.tmpdir(), 'remoteshell-probe-' + Date.now())

app.setPath('userData', probeUserData)
fs.mkdirSync(evidenceDir, { recursive: true })

// 探針入口不在專案根目錄，Electron 找不到 package.json → app.getVersion() 會回 Electron 版本。
// 這裡改成產品真實版本，讓 About／狀態列截圖與實際執行一致。
app.getVersion = () => require(path.join(root, 'package.json')).version

const checks = []
const record = (id, pass, detail) => checks.push({ id, pass, detail })

function registerRealHandlers() {
  const { registerIpc } = require(path.join(dist, 'main', 'ipc', 'register.js'))
  const { SettingsStore } = require(path.join(dist, 'main', 'store', 'settings.js'))
  const { ConnectionsStore } = require(path.join(dist, 'main', 'store', 'connections.js'))
  const handlerModules = [
    'app',
    'window',
    'settings',
    'connections',
    'vault',
    'session',
    'sftp',
    'transfer',
    'hostkey'
  ].map((name) => require(path.join(dist, 'main', 'ipc', 'handlers', name + '.js')))

  const settings = new SettingsStore(path.join(probeUserData, 'settings.json'), path.join(probeUserData, 'dl'))
  const connections = new ConnectionsStore(path.join(probeUserData, 'connections.json'))
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, filePath: path.join(probeUserData, 'log') },
    settings,
    connections,
    broadcast: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
    },
    resolveWindow: () => BrowserWindow.getAllWindows()[0] ?? null
  }
  for (const mod of handlerModules) mod.register()
  registerIpc(ctx)
}

async function shot(win, name) {
  const image = await win.webContents.capturePage()
  const file = path.join(evidenceDir, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  return file
}

async function main() {
  registerRealHandlers()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(dist, 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  await win.loadFile(path.join(dist, 'renderer', 'index.html'))
  win.show()
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const js = (code) => win.webContents.executeJavaScript(code, true)

  record('no-require', (await js('typeof require')) === 'undefined', `typeof require = ${await js('typeof require')}`)
  record('no-process', (await js('typeof process')) === 'undefined', `typeof process = ${await js('typeof process')}`)
  record('no-module', (await js('typeof module')) === 'undefined', `typeof module = ${await js('typeof module')}`)

  const apiKeys = await js('Object.keys(window.rs || {}).sort()')
  const expected = ['app', 'connections', 'groups', 'hostkey', 'localFs', 'session', 'settings', 'sftp', 'transfer', 'vault', 'window']
  record('rs-surface', JSON.stringify(apiKeys) === JSON.stringify(expected), 'window.rs keys = ' + JSON.stringify(apiKeys))

  const methodCount = await js('Object.values(window.rs).reduce((sum, group) => sum + Object.keys(group).length, 0)')
  record('rs-methods', methodCount === 56, `window.rs 方法總數 = ${methodCount}`)

  const generic = await js('typeof window.ipcRenderer + "," + typeof window.electron')
  record('no-generic-bridge', generic === 'undefined,undefined', 'window.ipcRenderer / window.electron = ' + generic)

  const evalBlocked = await js(
    "(() => { try { return String(eval('1+1')) === '2' ? 'allowed' : 'weird' } catch (e) { return 'blocked' } })()"
  )
  record('csp-eval-blocked', evalBlocked === 'blocked', 'eval() → ' + evalBlocked)

  const fetchBlocked = await js(
    "fetch('https://example.com/').then(() => 'allowed').catch(() => 'blocked')"
  )
  record('csp-connect-blocked', fetchBlocked === 'blocked', 'fetch(example.com) → ' + fetchBlocked)

  const scriptBlocked = await js(
    `new Promise((resolve) => {
      const s = document.createElement('script')
      s.src = 'https://example.com/x.js'
      s.onload = () => resolve('loaded')
      s.onerror = () => resolve('blocked')
      document.head.appendChild(s)
      setTimeout(() => resolve('blocked'), 1200)
    })`
  )
  record('csp-script-blocked', scriptBlocked === 'blocked', 'external <script> → ' + scriptBlocked)

  const layout = await js(
    "(() => { const app = document.querySelector('.rs-app'); return app ? Array.from(app.children).map(c => c.className).join('|') : 'missing' })()"
  )
  record(
    'layout-rendered',
    layout.includes('rs-titlebar') && layout.includes('rs-menubar') && layout.includes('rs-toolbar') && layout.includes('rs-statusbar'),
    'root children = ' + layout
  )

  // IPC 端到端：settings get → patch(zh-TW) → UI 立即切換 → 截圖
  const settingsOk = await js('window.rs.settings.get().then(r => r.ok ? r.data.locale : "fail")')
  record('ipc-settings-get', settingsOk === 'en-US', 'settings.get() → ' + settingsOk)
  const shotEn = await shot(win, 'm1-01-main-window-en')

  const patched = await js('window.rs.settings.patch({ locale: "zh-TW" }).then(r => r.ok ? r.data.locale : "fail")')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const menuText = await js("document.querySelector('.rs-menubar')?.textContent || ''")
  record('ipc-settings-patch-zh', patched === 'zh-TW' && menuText.includes('檔案'), 'zh-TW 選單 = ' + menuText.slice(0, 40))
  const shotZh = await shot(win, 'm1-02-main-window-zh')

  const unknown = await js(
    "window.rs.settings.patch({ terminal: { fontSize: 999 } }).then(r => r.ok ? 'ok' : r.error.code)"
  )
  record('ipc-validation', unknown === 'E_VALIDATION', '非法 fontSize → ' + unknown)

  // 最小視窗 1024×680 不破版
  win.setSize(1024, 680)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const overflow = await js(
    'JSON.stringify({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight })'
  )
  const dims = JSON.parse(overflow)
  record(
    'min-size-no-overflow',
    dims.scrollW <= dims.clientW && dims.scrollH <= dims.clientH,
    '1024×680 → ' + overflow
  )
  const shotMin = await shot(win, 'm1-03-min-size-1024x680')

  const payload = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    screenshots: [shotEn, shotZh, shotMin],
    checks
  }
  process.stdout.write('SECURITY_PROBE ' + JSON.stringify(payload) + '\n')
  app.exit(0)
}

app.whenReady().then(main).catch((error) => {
  process.stdout.write(
    'SECURITY_PROBE ' + JSON.stringify({ checks: [{ id: 'fatal', pass: false, detail: String(error) }] }) + '\n'
  )
  app.exit(1)
})
