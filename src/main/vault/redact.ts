/**
 * 統一 redaction（§4）：log、錯誤 detail、IPC 事件都必須先過這一層。
 * 只看「欄位名稱」與常見的 key=value 字串，不做內容啟發式判斷（避免誤殺）。
 */
const SECRET_KEY = /(pass(word|phrase)?|secret|private_?key|privatekey|token|authorization|cipher|credential)/i
/** `password=xxx`、`"passphrase":"xxx"`、`secret: xxx` 都要遮蔽 */
const SECRET_ASSIGNMENT =
  /(["']?)(pass(?:word|phrase)?|secret|token|authorization|private_?key)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

/** 遞迴把秘密欄位換成 ***（物件／陣列都處理） */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? '***' : redactValue(item, depth + 1)
  }
  return out
}

/** 字串內的 `password=xxx`、`"passphrase":"xxx"` 一律遮蔽 */
export function redactText(text: string): string {
  return text.replace(
    SECRET_ASSIGNMENT,
    (_all, quote: string, key: string, separator: string) => `${quote}${key}${quote}${separator}***`
  )
}

/** 給測試／審查用：回傳在 text 中找到的秘密（不得為空） */
export function findSecrets(text: string, secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length > 0 && text.includes(secret))
}

/** 日誌一行：訊息 + redaction 後的 meta */
export function formatLogLine(level: string, message: string, meta: unknown, at: Date = new Date()): string {
  const suffix = meta === undefined ? '' : ` ${safeJson(redactValue(meta))}`
  return `${at.toISOString()} ${level} ${redactText(message)}${suffix}\n`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserialisable]'
  }
}
