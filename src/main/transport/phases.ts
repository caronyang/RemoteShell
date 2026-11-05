import type { ConnectPhase, ErrorCode } from '../../shared/ipc-contract'

/** 七階段（§6.1）；無跳板時從 target-tcp 起算 */
export const PHASE_ORDER: readonly ConnectPhase[] = [
  'jump-dns',
  'jump-tcp',
  'jump-auth',
  'tunnel',
  'target-tcp',
  'hostkey',
  'target-auth',
  'ready'
]

export interface SshErrorLike {
  message?: string
  code?: string
  level?: string
}

export interface PhaseFailure {
  phase: ConnectPhase
  code: ErrorCode
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'])

/**
 * 「連線階段 + ssh2 錯誤」→ 產品錯誤碼（§6.1 表格）。
 * 呼叫端只負責把回傳值轉成 AppError，不自行判斷階段。
 */
export function classifyConnectError(phase: ConnectPhase, error: SshErrorLike): PhaseFailure {
  const code = error.code ?? ''
  const level = error.level ?? ''

  switch (phase) {
    case 'jump-dns':
    case 'jump-tcp':
      /* v0.1.8：ssh2 的認證失敗（level=client-authentication）發生在 jump 連線階段，
         不能當成 DNS／TCP 失敗；一律回 E_JUMP_AUTH。 */
      if (
        level === 'client-authentication' ||
        code === 'E_JUMP_AUTH' ||
        /authentication methods failed/i.test(error.message ?? '')
      ) {
        return { phase: 'jump-auth', code: 'E_JUMP_AUTH' }
      }
      // 同一個 connect 失敗可能是 DNS 或 TCP；phase 要跟著實際失敗原因走（UI 才標得對）
      return DNS_CODES.has(code)
        ? { phase: 'jump-dns', code: 'E_JUMP_DNS' }
        : { phase: 'jump-tcp', code: 'E_JUMP_TCP' }
    case 'jump-auth':
      return { phase, code: 'E_JUMP_AUTH' }
    case 'tunnel':
      return { phase, code: 'E_TUNNEL' }
    case 'target-tcp':
      /* v0.1.6：ssh2 在 connect 內重新解析私鑰；加密金鑰若 passphrase 不對，錯誤會落在
         target-tcp 階段。不能誤報成「目標主機不可達」，要維持 E_KEY_PASSPHRASE。 */
      if (/bad passphrase|integrity check failed|no passphrase given|cannot parse privatekey/i.test(error.message ?? '')) {
        return { phase, code: 'E_KEY_PASSPHRASE' }
      }
      return { phase, code: level === 'client-timeout' ? 'E_TIMEOUT' : 'E_TARGET_TCP' }
    case 'hostkey':
      return { phase, code: code === 'E_HOSTKEY_MISMATCH' ? 'E_HOSTKEY_MISMATCH' : 'E_HOSTKEY_UNKNOWN' }
    case 'target-auth':
      return { phase, code: 'E_TARGET_AUTH' }
    case 'ready':
      return { phase: 'target-tcp', code: 'E_NETWORK' }
    default:
      return { phase, code: level === 'client-authentication' ? 'E_TARGET_AUTH' : 'E_INTERNAL' }
  }
}

/** 連線階段失敗是否「重試有用」 */
export function isRetryableCode(code: ErrorCode): boolean {
  return (
    code === 'E_JUMP_TCP' ||
    code === 'E_TUNNEL' ||
    code === 'E_TARGET_TCP' ||
    code === 'E_TIMEOUT' ||
    code === 'E_NETWORK' ||
    code === 'E_CHANNEL_CLOSED'
  )
}

/**
 * 已連線後的斷線歸屬（§6.4）：先斷跳板 → 隧道段／E_TUNNEL；先斷目的 → 目的段／E_NETWORK。
 * 呼叫端以「最先觸發的 event」決定 who，這裡只做映射。
 */
export function classifyDisconnect(who: 'jump' | 'target'): PhaseFailure {
  return who === 'jump'
    ? { phase: 'tunnel', code: 'E_TUNNEL' }
    : { phase: 'target-tcp', code: 'E_NETWORK' }
}

/** 給 UI 的階段文字 key（i18n 用 error.<code>，phase 只做診斷顯示） */
export function phaseLabelKey(phase: ConnectPhase): string {
  return `phase.${phase}`
}
