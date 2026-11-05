import type { AppError, ErrorCode, Result, ConnectPhase } from './ipc-contract'

/** §3.1 union 的實際內容（D1 裁定：28 個，不是 29） */
export const ERROR_CODES = [
  'E_JUMP_DNS',
  'E_JUMP_TCP',
  'E_JUMP_AUTH',
  'E_TUNNEL',
  'E_TARGET_TCP',
  'E_TARGET_AUTH',
  'E_HOSTKEY_UNKNOWN',
  'E_HOSTKEY_MISMATCH',
  'E_TIMEOUT',
  'E_NETWORK',
  'E_CHANNEL_CLOSED',
  'E_ALGORITHM',
  'E_KEY_PARSE',
  'E_KEY_PASSPHRASE',
  'E_PASSWORD_FILE',
  'E_TELNET_NEGOTIATION',
  'E_SFTP_UNAVAILABLE',
  'E_SFTP_PERMISSION',
  'E_SFTP_NO_SPACE',
  'E_SFTP_NOT_FOUND',
  'E_LOCAL_IO',
  'E_VAULT_UNAVAILABLE',
  'E_VAULT_DECRYPT',
  'E_VALIDATION',
  'E_NOT_FOUND',
  'E_CONFLICT',
  'E_CANCELLED',
  'E_INTERNAL'
] as const satisfies readonly ErrorCode[]

/** 可重試的錯誤（UI 顯示 [重試]） */
const RETRYABLE = new Set<ErrorCode>([
  'E_JUMP_TCP',
  'E_TUNNEL',
  'E_TARGET_TCP',
  'E_TIMEOUT',
  'E_NETWORK',
  'E_CHANNEL_CLOSED',
  'E_LOCAL_IO',
  'E_SFTP_NO_SPACE'
])

/** 僅供 log 與 QA 對照的英文摘要（不是 UI 字串；UI 一律用 error.<code> i18n key） */
const SUMMARIES: Record<ErrorCode, string> = {
  E_JUMP_DNS: 'Jump host name could not be resolved',
  E_JUMP_TCP: 'Jump host is unreachable',
  E_JUMP_AUTH: 'Jump host authentication failed',
  E_TUNNEL: 'Tunnel could not be established',
  E_TARGET_TCP: 'Target host is unreachable',
  E_TARGET_AUTH: 'Target host authentication failed',
  E_HOSTKEY_UNKNOWN: 'Host key is not trusted yet',
  E_HOSTKEY_MISMATCH: 'Host key changed since last connection',
  E_TIMEOUT: 'Operation timed out',
  E_NETWORK: 'Network connection lost',
  E_CHANNEL_CLOSED: 'Channel closed unexpectedly',
  E_ALGORITHM: 'No compatible key exchange or cipher',
  E_KEY_PARSE: 'Private key could not be parsed',
  E_KEY_PASSPHRASE: 'Private key passphrase is missing or wrong',
  E_PASSWORD_FILE: 'Password file could not be read',
  E_TELNET_NEGOTIATION: 'Telnet option negotiation failed',
  E_SFTP_UNAVAILABLE: 'SFTP is not available for this session',
  E_SFTP_PERMISSION: 'SFTP operation denied by remote',
  E_SFTP_NO_SPACE: 'Remote is out of disk space',
  E_SFTP_NOT_FOUND: 'Remote path not found',
  E_LOCAL_IO: 'Local file operation failed',
  E_VAULT_UNAVAILABLE: 'Secure storage (DPAPI) unavailable',
  E_VAULT_DECRYPT: 'Stored secret could not be decrypted',
  E_VALIDATION: 'Input validation failed',
  E_NOT_FOUND: 'Resource not found',
  E_CONFLICT: 'Conflicting state',
  E_CANCELLED: 'Operation cancelled',
  E_INTERNAL: 'Unexpected internal error'
}

export function i18nKeyFor(code: ErrorCode): string {
  return `error.${code}`
}

export interface AppErrorOptions {
  phase?: ConnectPhase
  detail?: string
  /** 覆寫預設摘要（僅 log／QA 用；不得含秘密） */
  message?: string
  retryable?: boolean
}

export function appError(code: ErrorCode, options: AppErrorOptions = {}): AppError {
  const error: AppError = {
    code,
    message: options.message ?? SUMMARIES[code],
    i18nKey: i18nKeyFor(code),
    retryable: options.retryable ?? RETRYABLE.has(code)
  }
  if (options.phase) error.phase = options.phase
  if (options.detail) error.detail = options.detail
  return error
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail<T>(code: ErrorCode, options: AppErrorOptions = {}): Result<T> {
  return { ok: false, error: appError(code, options) }
}

export function failWith<T>(error: AppError): Result<T> {
  return { ok: false, error }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/** 把任何例外轉成 Result（不得把原始 Error 丟給 renderer） */
export function toFail<T>(cause: unknown, fallback: ErrorCode = 'E_INTERNAL'): Result<T> {
  if (cause instanceof Error) {
    return fail<T>(fallback, { detail: cause.message, message: cause.message })
  }
  return fail<T>(fallback, { detail: String(cause) })
}
