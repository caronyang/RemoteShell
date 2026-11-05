import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, logFileName } from './store/paths'
import { formatLogLine } from './vault/redact'

export interface Logger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  filePath: string
}

/**
 * 統一 logger（§4）：寫入 %APPDATA%\RemoteShell\logs\app-YYYYMMDD.log。
 * 內容一律先過 vault/redact（單一 redaction 實作），只使用 console.warn / console.error。
 */
export function createLogger(logsDir: string, consoleEcho = true): Logger {
  ensureDir(logsDir)
  const filePath = path.join(logsDir, logFileName())

  const write = (level: string, message: string, meta?: unknown): void => {
    const line = formatLogLine(level, message, meta)
    try {
      fs.appendFileSync(filePath, line, 'utf8')
    } catch {
      // 寫 log 失敗不得影響主流程
    }
    if (consoleEcho && (level === 'WARN' || level === 'ERROR')) {
      if (level === 'ERROR') console.error(line.trimEnd())
      else console.warn(line.trimEnd())
    }
  }

  return {
    filePath,
    info: (message, meta) => write('INFO', message, meta),
    warn: (message, meta) => write('WARN', message, meta),
    error: (message, meta) => write('ERROR', message, meta)
  }
}
