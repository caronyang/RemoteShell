/**
 * RemoteShell IPC 契約（唯一型別來源）
 * 來源：docs/技術實作文件_v1.0.md（v1.2）§3 —— 型別逐字照抄，不得自行調整。
 * main / preload / renderer 都只從這裡 import。
 */

/* ============ 3.1 共用封裝 ============ */
export type Ok<T> = { ok: true; data: T }
export type Fail = { ok: false; error: AppError }
export type Result<T> = Ok<T> | Fail

export interface AppError {
  code: ErrorCode
  /** 連線類錯誤才有；對應 UI-07 FLOW-B 的「失敗在第幾段」 */
  phase?: ConnectPhase
  /** 已在地化前的英文摘要（僅供 log 與 QA 對照，不直接顯示） */
  message: string
  /** 顯示用 i18n key，固定 `error.${code}` */
  i18nKey: string
  /** 可重試（決定 UI 是否顯示 [重試]） */
  retryable: boolean
  /** 給「錯誤詳情」的技術細節，已 redaction */
  detail?: string
}

export type ErrorCode =
  | 'E_JUMP_DNS' | 'E_JUMP_TCP' | 'E_JUMP_AUTH' | 'E_TUNNEL'
  | 'E_TARGET_TCP' | 'E_TARGET_AUTH' | 'E_HOSTKEY_UNKNOWN' | 'E_HOSTKEY_MISMATCH'
  | 'E_TIMEOUT' | 'E_NETWORK' | 'E_CHANNEL_CLOSED' | 'E_ALGORITHM'
  | 'E_KEY_PARSE' | 'E_KEY_PASSPHRASE' | 'E_PASSWORD_FILE'
  | 'E_TELNET_NEGOTIATION' | 'E_SFTP_UNAVAILABLE' | 'E_SFTP_PERMISSION'
  | 'E_SFTP_NO_SPACE' | 'E_SFTP_NOT_FOUND' | 'E_LOCAL_IO'
  | 'E_VAULT_UNAVAILABLE' | 'E_VAULT_DECRYPT' | 'E_VALIDATION'
  | 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_CANCELLED' | 'E_INTERNAL'

export type ConnectPhase =
  | 'jump-dns' | 'jump-tcp' | 'jump-auth' | 'tunnel'
  | 'target-tcp' | 'hostkey' | 'target-auth' | 'ready'

/* ============ 3.2 資料模型 ============ */
export type Protocol = 'ssh' | 'telnet'

/** 秘密的引用；不含任何可逆材料 */
export type SecretRef =
  | { kind: 'none' }
  | { kind: 'dpapi'; cipher: string; updatedAt: string }

export type AuthConfig =
  | { method: 'password'; username: string; secret: SecretRef }
  | { method: 'passwordFile'; username: string; secret: SecretRef; filePath: string }
  | { method: 'publicKey'; username: string; secret: SecretRef; keyPath: string }

export interface JumpConfig {
  enabled: boolean
  /** v1 長度 0 或 1（單跳）；型別保留多跳彈性，UI 不實作 */
  connectionIds: string[]
}

export interface TerminalOverride {
  fontFamily?: string
  fontSize?: number
  themeId?: ThemeId
  scrollback?: number
  cursorStyle?: 'block' | 'underline'
  cursorBlink?: boolean
}

export interface ConnectionProfile {
  id: string
  name: string
  groupId: string | null
  protocol: Protocol
  host: string
  port: number
  auth: AuthConfig
  jump: JumpConfig
  terminal: TerminalOverride
  tags: string[]
  description: string
  createdAt: string
  updatedAt: string
}

export interface ConnectionGroup {
  id: string
  name: string
  parentId: string | null
  collapsed: boolean
  order: number
}

/* ============ 3.3 設定 ============ */
export type ThemeId = 'dark' | 'light' | 'solarized' | 'monokai'
export type Locale = 'en-US' | 'zh-TW'
export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename'

/** v0.1.4 #8：SFTP／本機檔案表格欄寬（px），由 settings.ui.sftpColumns 持久化 */
export interface SftpColumnWidths {
  name: number
  permissions: number
  mtime: number
  size: number
}

export interface AppSettings {
  schemaVersion: number
  locale: Locale
  general: {
    restoreWorkspace: boolean
    onCloseWithActive: 'ask' | 'disconnect'
    minimizeToTray: boolean
    confirmDelete: boolean
  }
  terminal: {
    fontFamily: string
    fontSize: number
    themeId: ThemeId
    scrollback: number
    cursorStyle: 'block' | 'underline'
    cursorBlink: boolean
    ambiguousWidth: 'narrow' | 'wide'
  }
  transfer: {
    maxConcurrent: number            // 1–10
    downloadDir: string
    afterDownload: 'open' | 'notify'
    onConflict: ConflictPolicy
    retryCount: number
  }
  ui: {
    sidebarWidth: number
    queueHeight: number
    queueCollapsed: boolean
    /** v0.1.4 #5：側欄收合（預設 false） */
    sidebarCollapsed: boolean
    /** v0.1.4 #8：檔案表格欄寬；舊檔缺此欄時由 schema 補預設 */
    sftpColumns?: SftpColumnWidths
  }
}

/* ============ 3.4 連線工作階段 ============ */
export type SessionState = 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface SessionInfo {
  sessionId: string
  profileId: string
  protocol: Protocol
  state: SessionState
  phase: ConnectPhase
  /** 顯示用：final host，以及 via 跳板名（UI-07「永遠標示 via」） */
  host: string
  port: number
  viaProfileName?: string
  cols: number
  rows: number
  openedAt?: string
  error?: AppError
}

export interface OpenSessionRequest {
  profileId: string
  cols: number
  rows: number
  /** 本次連線臨時輸入的密碼／passphrase（不落盤、不記錄） */
  ephemeral?: { secret?: string; passwordFileOverride?: string }
}

export interface SessionDataEvent {
  sessionId: string
  seq: number
  /** 原始位元組；renderer 以每 session 一個 TextDecoder({stream:true}) 解碼 */
  bytes: Uint8Array
}

export interface HostKeyPrompt {
  requestId: string
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
  knownPrevious?: string   // 已知但變更時的前次指紋（→ E_HOSTKEY_MISMATCH 情境）
}

export type HostKeyDecision = 'once' | 'always' | 'reject'

/* ============ 3.5 SFTP ============ */
export type EntryType = 'file' | 'dir' | 'link' | 'other'

export interface SftpEntry {
  name: string
  path: string
  type: EntryType
  size: number
  mtimeMs: number
  mode?: number
  owner?: string
  group?: string
  isSymlink: boolean
}

export interface SftpListResult {
  path: string
  entries: SftpEntry[]
}

/* ============ 3.5b 本地面板（F-1，v1.8） ============ */
export interface LocalEntry {
  name: string
  path: string
  type: EntryType
  size: number
  mtimeMs: number
  isSymlink: boolean
}

export interface LocalListResult {
  path: string
  entries: LocalEntry[]
  /** Windows 磁碟機清單（C:\、D:\…），供路徑列切換 */
  drives: string[]
}

/* ============ 3.6 傳輸佇列（對應 UI-04 狀態機） ============ */
export type TransferState =
  | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface TransferTask {
  taskId: string
  /** 目錄任務的子任務會帶父列 taskId（v1.11） */
  parentId?: string
  sessionId: string
  connectionLabel: string      // 「prod-web-01 (經 gw-edge)」
  direction: 'upload' | 'download'
  source: string
  target: string
  /** 目錄任務的彙總 */
  isDirectory: boolean
  totalBytes?: number
  transferredBytes: number
  bytesPerSec: number
  etaSec?: number | null
  /** 目錄任務的展開明細（僅 UI 展開時使用） */
  children?: Array<{ taskId: string; source: string; target: string; size: number; state: TransferState }>
  /** 續傳不可行、必須從頭重傳（v1.11；UI 顯示「需重傳」） */
  needsRetransfer?: boolean
  state: TransferState
  attempts: number
  error?: AppError
  createdAt: string
}

export interface TransferPlanItem {
  source: string
  target: string
  conflict: boolean
  /** 同名且目標存在時的既有大小／時間，供對話框顯示 */
  existingSize?: number
}

export interface TransferPlan {
  items: TransferPlanItem[]
  skipped: Array<{ source: string; reason: AppError }>
}

/* ============ 3.7 Preload 暴露的 API 形狀（window.rs） ============ */
export interface RsApi {
  app: {
    info(): Promise<Result<AppInfo>>
    /** 系統資料夾選擇器（dialog.showOpenDialog）；取消回 null */
    pickDirectory(defaultPath?: string): Promise<Result<string | null>>
    /** v0.1.4 #1：單檔選擇器（dialog.showOpenDialog）；取消回 null */
    pickFile(defaultPath?: string): Promise<Result<string | null>>
  }
  window: {
    minimize(): Promise<Result<void>>
    toggleMaximize(): Promise<Result<boolean>>
    close(): Promise<Result<void>>
    onState(cb: (s: { maximized: boolean }) => void): () => void
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    patch(p: DeepPartial<AppSettings>): Promise<Result<AppSettings>>
    reset(): Promise<Result<AppSettings>>
    onChange(cb: (s: AppSettings) => void): () => void
  }
  connections: {
    list(): Promise<Result<{ profiles: ConnectionProfile[]; groups: ConnectionGroup[] }>>
    create(input: ConnectionInput): Promise<Result<ConnectionProfile>>
    update(id: string, patch: Partial<ConnectionInput>): Promise<Result<ConnectionProfile>>
    remove(id: string): Promise<Result<void>>
    reorder(ids: string[]): Promise<Result<void>>
  }
  groups: {
    create(input: { name: string; parentId: string | null }): Promise<Result<ConnectionGroup>>
    update(id: string, patch: { name?: string; parentId?: string | null; collapsed?: boolean }): Promise<Result<ConnectionGroup>>
    remove(id: string): Promise<Result<void>>
  }
  vault: {
    setSecret(scopeId: string, secret: string): Promise<Result<SecretRef>>
    clearSecret(scopeId: string): Promise<Result<void>>
    inspectKeyFile(path: string): Promise<Result<KeyFileInfo>>
  }
  session: {
    open(req: OpenSessionRequest): Promise<Result<SessionInfo>>
    write(sessionId: string, data: string): Promise<Result<void>>
    resize(sessionId: string, cols: number, rows: number): Promise<Result<void>>
    close(sessionId: string): Promise<Result<void>>
    reconnect(sessionId: string): Promise<Result<SessionInfo>>
    /** renderer 重載後補回捲動內容（main 保留 256KB 環形緩衝） */
    snapshot(sessionId: string): Promise<Result<{ bytes: Uint8Array }>>
    onState(cb: (s: SessionInfo) => void): () => void
    onData(cb: (e: SessionDataEvent) => void): () => void
  }
  hostkey: {
    answer(requestId: string, decision: HostKeyDecision): Promise<Result<void>>
    onPrompt(cb: (p: HostKeyPrompt) => void): () => void
  }
  sftp: {
    open(sessionId: string): Promise<Result<{ sftpId: string; home: string }>>
    close(sftpId: string): Promise<Result<void>>
    list(sftpId: string, path: string): Promise<Result<SftpListResult>>
    mkdir(sftpId: string, path: string): Promise<Result<void>>
    rename(sftpId: string, from: string, to: string): Promise<Result<void>>
    remove(sftpId: string, path: string, isDir: boolean): Promise<Result<void>>
    realpath(sftpId: string, path: string): Promise<Result<string>>
  }
  transfer: {
    plan(sessionId: string, direction: 'upload' | 'download', items: TransferPlanItem[]): Promise<Result<TransferPlan>>
    start(req: StartTransferRequest): Promise<Result<TransferTask[]>>
    pause(taskId: string): Promise<Result<void>>
    resume(taskId: string): Promise<Result<void>>
    cancel(taskId: string): Promise<Result<void>>
    retry(taskId: string): Promise<Result<void>>
    remove(taskId: string): Promise<Result<void>>
    /** UI-04 佇列優先權調整（僅等待中項目） */
    reorder(taskId: string, direction: 'up' | 'down'): Promise<Result<void>>
    /** 「開啟資料夾」：於檔案總管選取該傳輸的本地目標（只接受既有任務） */
    reveal(taskId: string): Promise<Result<void>>
    clearCompleted(): Promise<Result<void>>
    list(): Promise<Result<TransferTask[]>>
    onUpdate(cb: (batch: TransferTask[]) => void): () => void
  }
  /** 本地面板（F-1 本地端）；路徑限制見 §3.9 */
  localFs: {
    home(): Promise<Result<string>>
    list(path: string): Promise<Result<LocalListResult>>
    mkdir(path: string): Promise<Result<void>>
    rename(from: string, to: string): Promise<Result<void>>
    remove(path: string, recursive: boolean): Promise<Result<void>>
  }
}

export interface ConnectionInput {
  name: string
  groupId: string | null
  protocol: Protocol
  host: string
  port: number
  auth: AuthConfig
  jump: JumpConfig
  terminal: TerminalOverride
  tags: string[]
  description: string
}

export interface StartTransferRequest {
  sessionId: string
  direction: 'upload' | 'download'
  items: Array<{ source: string; target: string }>
  onConflict: ConflictPolicy
  /** onConflict='ask' 時由 UI 逐項決定 */
  decisions?: Record<string, Exclude<ConflictPolicy, 'ask'>>
}

export interface KeyFileInfo {
  format: 'openssh' | 'pem' | 'ppk' | 'unknown'
  encrypted: boolean
  algorithm?: string
}

/* ============ 3.8 §3 引用但未定義的輔助型別（M1 補齊，已在驗收紀錄列出） ============ */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  /** OpenSSH 引擎版本（ssh2 套件版本；M2 起改為實際引擎資訊） */
  sshEngine: string
}

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T
