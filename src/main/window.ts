import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { LAYOUT } from '../shared/constants'
import { APP_ORIGIN } from './protocol'

/**
 * M4-04／M5-01：視窗／工作列圖示。
 * - 打包後：`resources/icon.ico`（electron-builder 的 extraResources 帶進來，
 *   與 exe 內嵌圖示、安裝檔圖示是同一份 build/icon.ico）
 * - 開發時：專案根目錄的 build/icon.ico
 */
function windowIcon(): string | undefined {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', '..', 'build', 'icon.ico')
  return fs.existsSync(candidate) ? candidate : undefined
}

export interface WindowOptions {
  preloadPath: string
  /** 開發模式時為 Vite dev server URL；正式為 null（走 app:// protocol，M5-01） */
  devServerUrl: string | null
  /**
   * 正式環境的入口網址（M5-01）。由 `src/main/protocol.ts` 的 `app://bundle/index.html`
   * 提供，response header 帶完整 CSP（含 frame-ancestors）。
   */
  appUrl?: string
  /** 舊介面：直接載入檔案（沒有 appUrl 也沒有 devServerUrl 時使用） */
  rendererEntry?: string
  showOnReady?: boolean
}

/** §2 鐵則 1 / M1-03：sandbox + contextIsolation、禁 nodeIntegration、CSP、外部開啟一律攔阻 */
export function createMainWindow(options: WindowOptions): BrowserWindow {
  const icon = windowIcon()
  const win = new BrowserWindow({
    width: LAYOUT.defaultWidth,
    height: LAYOUT.defaultHeight,
    minWidth: LAYOUT.minWidth,
    minHeight: LAYOUT.minHeight,
    frame: false,
    show: false,
    title: 'RemoteShell',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  win.setMenuBarVisibility(false)

  // 不允許 renderer 自行開窗；外部連結交給系統瀏覽器（僅 http/https）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 不允許導航離開應用程式本身
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = options.devServerUrl ?? null
    if (allowed && url.startsWith(allowed)) return
    if (url.startsWith(APP_ORIGIN)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })

  const emitState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('rs:evt:window:state', { maximized: win.isMaximized() })
  }
  win.on('maximize', emitState)
  win.on('unmaximize', emitState)
  win.once('ready-to-show', () => {
    if (options.showOnReady !== false) win.show()
  })

  if (options.devServerUrl) {
    void win.loadURL(options.devServerUrl)
  } else if (options.appUrl) {
    void win.loadURL(options.appUrl)
  } else if (options.rendererEntry) {
    void win.loadFile(path.join(options.rendererEntry))
  } else {
    throw new Error('createMainWindow: devServerUrl / appUrl / rendererEntry 三者必須有一個')
  }

  return win
}
