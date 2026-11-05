/**
 * M4-06：可回報的錯誤碼。
 *
 * 目的：使用者看到「白屏 / 閃退」時，能回報一組短碼，工程師用同一組碼在 log 裡
 * 找到同一件事。因此碼必須**穩定**：同一類錯誤（name + message）永遠得到同一個碼，
 * 不吃 stack（行號一改就變）也不吃時間。
 *
 * 格式：`RS-<MAIN|UI>-<4 位十六進位>`，例如 `RS-UI-1A2B`。
 * 只留在前端與 log，不參與 IPC 契約。
 */

export type CrashScope = 'MAIN' | 'UI'

/** FNV-1a 32-bit：短、無依賴、跨平台一致 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export interface CrashReport {
  code: string
  message: string
  stack: string | null
  at: string
}

export function crashCode(scope: CrashScope, error: unknown): string {
  const name = error instanceof Error ? (error.name || 'Error') : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const digest = fnv1a(`${name}\u0000${message}`).toString(16).toUpperCase().padStart(4, '0')
  return `RS-${scope}-${digest.slice(-4)}`
}

export function crashReport(scope: CrashScope, error: unknown, at = new Date().toISOString()): CrashReport {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack ? error.stack : null
  return { code: crashCode(scope, error), message, stack, at }
}

/** 給「複製詳細資料」用的純文字（含碼、時間、訊息、stack） */
export function formatCrashReport(report: CrashReport): string {
  return [
    `RemoteShell ${report.code}`,
    `time: ${report.at}`,
    `message: ${report.message}`,
    report.stack ? `\n${report.stack}` : ''
  ]
    .join('\n')
    .trim()
}
