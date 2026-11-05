import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { APP_NAME } from '../shared/constants'
import { crashCode } from '../shared/crash'
import { createLogger } from './logger'
import { installCrashHandlers } from './crash'
import { startBootTrace } from './diagnostics'
import { defaultDataDir, defaultDownloadDir, storePaths } from './store/paths'
import { SettingsStore } from './store/settings'
import { ConnectionsStore } from './store/connections'
import { VaultService, type SecureStorage } from './vault/dpapi'
import { KnownHostsStore } from './transport/hostkey'
import { SessionManager } from './ipc/handlers/session'
import { SftpRegistry } from './sftp/registry'
import { TransferScheduler } from './queue/scheduler'
import { createTransferRunner } from './ipc/handlers/transfer'
import { EVT } from '../shared/constants'
import { createMainWindow } from './window'
import { APP_ENTRY_URL, registerAppSchemePrivileges, installAppProtocol } from './protocol'
import { registerIpc, type AppContext } from './ipc/register'
import * as appHandlers from './ipc/handlers/app'
import * as windowHandlers from './ipc/handlers/window'
import * as settingsHandlers from './ipc/handlers/settings'
import * as connectionsHandlers from './ipc/handlers/connections'
import * as vaultHandlers from './ipc/handlers/vault'
import * as sessionHandlers from './ipc/handlers/session'
import * as sftpHandlers from './ipc/handlers/sftp'
import * as transferHandlers from './ipc/handlers/transfer'
import * as hostkeyHandlers from './ipc/handlers/hostkey'
import * as localHandlers from './ipc/handlers/local'

const devServerUrl = process.env['VITE_DEV_SERVER_URL'] ?? null

// M5-01：必須在 app ready 之前把 app:// 註冊成 standard + secure scheme
registerAppSchemePrivileges()

/** Windows 上就是 DPAPI；不可用時 VaultService 會拒絕儲存（不得降級明碼） */
function electronSecureStorage(): SecureStorage {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain: string) => safeStorage.encryptString(plain),
    decryptString: (cipher: Buffer) => safeStorage.decryptString(cipher)
  }
}

function buildContext(): AppContext {
  const paths = storePaths(defaultDataDir())
  const logger = createLogger(paths.logsDir)
  const settings = new SettingsStore(paths.settings, defaultDownloadDir())
  const connections = new ConnectionsStore(paths.connections)
  const vault = new VaultService(electronSecureStorage())
  const knownHosts = new KnownHostsStore(paths.knownHosts)

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  const sessions = new SessionManager({ connections, vault, knownHosts, logger, broadcast })

  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({
    maxConcurrent: settings.load().transfer.maxConcurrent,
    broadcast: (batch) => broadcast(EVT.transferUpdate, batch),
    runner: createTransferRunner({ sftp, sessions })
  })

  // 斷線 → 該 session 的傳輸暫停（可續傳）；重連由 session handler 重新綁定
  sessions.onStateChange = (info) => {
    if (info.state === 'disconnected' || info.state === 'failed') {
      transfers.pauseSession(info.sessionId)
      sftp.removeBySession(info.sessionId)
    }
  }

  return {
    logger,
    settings,
    connections,
    sessions,
    sftp,
    transfers,
    vault,
    knownHosts,
    revealPath: (localPath: string) => shell.showItemInFolder(localPath),
    broadcast,
    resolveWindow(event: IpcMainInvokeEvent | null): BrowserWindow | null {
      if (event) {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) return win
      }
      return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    }
  }
}

function bootstrap(): void {
  app.setPath('userData', defaultDataDir())
  app.setName(APP_NAME)

  const ctx = buildContext()

  // M4-06：main 未捕捉例外不得讓 app 白屏／閃退。先裝邊界，再註冊 IPC。
  installCrashHandlers({
    logger: ctx.logger,
    showError: (title, content) => dialog.showErrorBox(title, content)
  })

  appHandlers.register()
  windowHandlers.register()
  settingsHandlers.register()
  connectionsHandlers.register()
  vaultHandlers.register()
  sessionHandlers.register()
  sftpHandlers.register()
  transferHandlers.register()
  hostkeyHandlers.register()
  localHandlers.register()

  registerIpc(ctx)

  // M5-01：正式環境用 app:// 供應 dist/renderer（每個回應都帶 CSP header）；dev 仍走 Vite
  if (!devServerUrl) installAppProtocol(path.join(__dirname, '..', 'renderer'))

  const trace = startBootTrace()

  const win = createMainWindow({
    preloadPath: path.join(__dirname, '..', 'preload', 'index.js'),
    devServerUrl,
    appUrl: APP_ENTRY_URL,
    rendererEntry: path.join(__dirname, '..', 'renderer', 'index.html')
  })

  if (!devServerUrl) {
    win.once('ready-to-show', () => trace.shown(win.webContents.getURL()))
    win.webContents.once('did-finish-load', () => {
      trace.loaded(win.webContents.getURL())
      if (process.env['RS_BOOT_EXIT'] === '1') setTimeout(() => app.quit(), 250)
    })
  }

  ctx.logger.info('main window created', {
    version: app.getVersion(),
    dev: devServerUrl !== null,
    dataDir: app.getPath('userData'),
    vaultAvailable: ctx.vault.isAvailable()
  })

  win.on('closed', () => {
    ctx.sessions.closeAll()
    if (process.platform !== 'darwin') app.quit()
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    const code = crashCode('MAIN', error)
    console.error(`[bootstrap] failed ${code}`, error instanceof Error ? error.message : String(error))
    dialog.showErrorBox(
      `RemoteShell ${code}`,
      `RemoteShell could not start.\nPlease report this code together with the log file.\n\n${
        error instanceof Error ? error.message : String(error)
      }`
    )
    app.quit()
  })

  app.on('before-quit', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('rs:evt:app:quitting', {})
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) bootstrap()
  })
}
