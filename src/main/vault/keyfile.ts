import fs from 'node:fs'
import { utils } from 'ssh2'
import type { AppError, KeyFileInfo } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'

const PPK_HEADER = /^PuTTY-User-Key-File-\d/m

export function detectKeyFormat(text: string): KeyFileInfo['format'] {
  if (PPK_HEADER.test(text)) return 'ppk'
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) return 'openssh'
  if (/-----BEGIN (RSA |EC |DSA |)PRIVATE KEY-----/.test(text)) return 'pem'
  return 'unknown'
}

/**
 * §6.5：`ssh2.utils.parseKey()` 對加密金鑰是「回傳 Error」不是 throw。
 * 因此一定要檢查回傳值，否則加密金鑰會被誤判為未加密（UI 就不會跳 passphrase）。
 */
export function inspectKeyContent(raw: Buffer): KeyFileInfo {
  const text = raw.toString('utf8')
  const format = detectKeyFormat(text)
  if (format === 'ppk') return { format, encrypted: /^Encryption:\s*(?!none)/m.test(text) }
  if (format === 'pem') {
    const encrypted = /Proc-Type: 4,ENCRYPTED/.test(text)
    return { format, encrypted, ...(encrypted ? {} : { algorithm: text.includes('BEGIN RSA') ? 'RSA' : undefined }) }
  }
  if (format === 'openssh') {
    const parsed = utils.parseKey(raw)
    if (parsed instanceof Error) {
      return { format, encrypted: /passphrase/i.test(parsed.message) }
    }
    return { format, encrypted: false, ...(parsed ? { algorithm: parsed.type } : {}) }
  }
  return { format: 'unknown', encrypted: false }
}

export function inspectKeyFile(filePath: string): KeyFileInfo {
  let raw: Buffer
  try {
    raw = fs.readFileSync(filePath)
  } catch (error) {
    throw appError('E_LOCAL_IO', {
      detail: error instanceof Error ? error.message : 'read failed',
      message: 'cannot read key file'
    })
  }
  return inspectKeyContent(raw)
}

export function mapKeyError(error: unknown, filePath: string): AppError {
  const message = error instanceof Error ? error.message : String(error)
  let head = ''
  try {
    head = fs.readFileSync(filePath, 'utf8').slice(0, 96)
  } catch {
    head = ''
  }
  if (PPK_HEADER.test(head)) {
    return appError('E_KEY_PARSE', {
      message: 'PuTTY .ppk is not supported',
      detail: 'Convert with PuTTYgen to OpenSSH format (Conversions → Export OpenSSH key)'
    })
  }
  if (/no passphrase given/i.test(message)) {
    return appError('E_KEY_PASSPHRASE', { message: 'key requires a passphrase', detail: message })
  }
  if (/bad passphrase|bad decrypt|integrity check failed/i.test(message)) {
    return appError('E_KEY_PASSPHRASE', { message: 'incorrect passphrase', detail: message })
  }
  return appError('E_KEY_PARSE', { message: 'cannot parse private key', detail: message })
}

/** 讀私鑰並在 main 記憶體中解析（不得回傳明文給 renderer） */
export function loadPrivateKey(filePath: string, passphrase?: string): Buffer {
  let raw: Buffer
  try {
    raw = fs.readFileSync(filePath)
  } catch (error) {
    throw appError('E_LOCAL_IO', {
      detail: error instanceof Error ? error.message : 'read failed',
      message: 'cannot read key file'
    })
  }
  if (PPK_HEADER.test(raw.toString('utf8'))) {
    throw appError('E_KEY_PARSE', {
      message: 'PuTTY .ppk is not supported',
      detail: 'Convert with PuTTYgen to OpenSSH format (Conversions → Export OpenSSH key)'
    })
  }
  const parsed = utils.parseKey(raw, passphrase)
  if (parsed instanceof Error) throw mapKeyError(parsed, filePath)
  return raw
}

/** password file（G1）：讀第一行並去掉結尾換行，避免多餘字元造成驗證失敗 */
export function readPasswordFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.replace(/\r?\n$/, '')
  } catch (error) {
    throw appError('E_PASSWORD_FILE', {
      detail: error instanceof Error ? error.message : 'read failed',
      message: 'cannot read password file'
    })
  }
}
