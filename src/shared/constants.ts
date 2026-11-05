import type { AppSettings } from './ipc-contract'

/** 資料檔 schema 版號（升版時同步 store/migrate.ts） */
export const SCHEMA_VERSION = 1

export const APP_NAME = 'RemoteShell'
export const APP_ID = 'com.remoteshell.app'

/** §3.4 通道名稱（register.ts 唯一註冊點；preload 只用這裡的常數） */
export const CH = {
  appInfo: 'rs:app:info',
  appPickDirectory: 'rs:app:pickDirectory',
  appPickFile: 'rs:app:pickFile',
  windowMinimize: 'rs:window:minimize',
  windowToggleMaximize: 'rs:window:toggleMaximize',
  windowClose: 'rs:window:close',
  settingsGet: 'rs:settings:get',
  settingsPatch: 'rs:settings:patch',
  settingsReset: 'rs:settings:reset',
  connectionsList: 'rs:connections:list',
  connectionsCreate: 'rs:connections:create',
  connectionsUpdate: 'rs:connections:update',
  connectionsRemove: 'rs:connections:remove',
  connectionsReorder: 'rs:connections:reorder',
  groupsCreate: 'rs:groups:create',
  groupsUpdate: 'rs:groups:update',
  groupsRemove: 'rs:groups:remove',
  vaultSetSecret: 'rs:vault:setSecret',
  vaultClearSecret: 'rs:vault:clearSecret',
  vaultInspectKeyFile: 'rs:vault:inspectKeyFile',
  sessionOpen: 'rs:session:open',
  sessionWrite: 'rs:session:write',
  sessionResize: 'rs:session:resize',
  sessionClose: 'rs:session:close',
  sessionReconnect: 'rs:session:reconnect',
  sessionSnapshot: 'rs:session:snapshot',
  hostkeyAnswer: 'rs:hostkey:answer',
  sftpOpen: 'rs:sftp:open',
  sftpClose: 'rs:sftp:close',
  sftpList: 'rs:sftp:list',
  sftpMkdir: 'rs:sftp:mkdir',
  sftpRename: 'rs:sftp:rename',
  sftpRemove: 'rs:sftp:remove',
  sftpRealpath: 'rs:sftp:realpath',
  transferPlan: 'rs:transfer:plan',
  transferStart: 'rs:transfer:start',
  transferPause: 'rs:transfer:pause',
  transferResume: 'rs:transfer:resume',
  transferCancel: 'rs:transfer:cancel',
  transferRetry: 'rs:transfer:retry',
  transferRemove: 'rs:transfer:remove',
  transferClearCompleted: 'rs:transfer:clearCompleted',
  transferList: 'rs:transfer:list',
  transferReorder: 'rs:transfer:reorder',
  transferReveal: 'rs:transfer:reveal',
  localHome: 'rs:local:home',
  localList: 'rs:local:list',
  localMkdir: 'rs:local:mkdir',
  localRename: 'rs:local:rename',
  localRemove: 'rs:local:remove'
} as const

export type Channel = (typeof CH)[keyof typeof CH]

/** §3.4 事件名稱 */
export const EVT = {
  sessionState: 'rs:evt:session:state',
  sessionData: 'rs:evt:session:data',
  hostkeyPrompt: 'rs:evt:hostkey:prompt',
  settingsChanged: 'rs:evt:settings:changed',
  transferUpdate: 'rs:evt:transfer:update',
  windowState: 'rs:evt:window:state'
} as const

export type EventChannel = (typeof EVT)[keyof typeof EVT]

/** §6.1／§6.6 定案參數（不得改用套件預設值） */
export const TIMING = {
  tcpTimeoutMs: 10_000,
  authTimeoutMs: 20_000,
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 1,
  /** 靜默斷網偵測上限 = (countMax + 1) × interval */
  silentDropDetectionMs: 30_000,
  dataBatchMs: 8,
  dataBatchBytes: 16 * 1024,
  ringBufferBytes: 256 * 1024,
  transferThrottleMs: 200
} as const

/** UI-01／§12 D2、D4 定案 */
export const LAYOUT = {  titleBar: 32,
  menuBar: 26,
  toolbar: 40,
  tabStrip: 32,
  statusBar: 28,
  sidebarWidth: 260,
  sidebarMin: 200,
  sidebarMax: 480,
  queueCollapsed: 28,
  queueDefault: 200,
  queueMax: 500,
  minWidth: 1024,
  minHeight: 680,
  defaultWidth: 1280,
  defaultHeight: 800
} as const

/** 本機／遠端檔案表格的預設欄寬（px）；可由 settings.ui.sftpColumns 覆寫（v0.1.4 #8）
 *  預設合計 460px，1280×800 單一 SFTP 面板（約 500px）不產生水平捲動。 */
export const SFTP_COLUMN_DEFAULTS = {
  name: 180,
  permissions: 90,
  mtime: 120,
  size: 70
} as const

export function defaultSettings(downloadDir: string): AppSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    locale: 'en-US',
    general: {
      restoreWorkspace: true,
      onCloseWithActive: 'ask',
      minimizeToTray: false,
      confirmDelete: true
    },
    terminal: {
      fontFamily: 'Cascadia Mono',
      fontSize: 11,
      themeId: 'dark',
      scrollback: 10000,
      cursorStyle: 'block',
      cursorBlink: true,
      ambiguousWidth: 'narrow'
    },
    transfer: {
      maxConcurrent: 3,
      downloadDir,
      afterDownload: 'notify',
      onConflict: 'ask',
      retryCount: 0
    },
    ui: {
      sidebarWidth: LAYOUT.sidebarWidth,
      queueHeight: 200,
      queueCollapsed: true,
      sidebarCollapsed: false,
      sftpColumns: { ...SFTP_COLUMN_DEFAULTS }
    }
  }
}
