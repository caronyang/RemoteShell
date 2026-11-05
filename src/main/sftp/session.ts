import type { Client, OpenMode, SFTPWrapper, Stats } from 'ssh2'
import type { Readable, Writable } from 'node:stream'
import type { AppError, SftpEntry, SftpListResult } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'

export interface RemoteStat {
  size: number
  mtimeMs: number
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

function toEntry(base: string, name: string, attrs: Stats): SftpEntry {
  const mode = attrs.mode
  const isSymlink = attrs.isSymbolicLink()
  const isDir = attrs.isDirectory()
  return {
    name,
    path: base.endsWith('/') ? `${base}${name}` : `${base}/${name}`,
    type: isDir ? 'dir' : isSymlink ? 'link' : attrs.isFile() ? 'file' : 'other',
    size: attrs.size,
    mtimeMs: attrs.mtime * 1000,
    mode,
    isSymlink
  }
}

/** SFTP 錯誤碼 → 產品錯誤碼（沿用既有 ErrorCode，不新增）
 *  ssh2 的 SFTP 失敗會帶「數字」status code（2 = NO_SUCH_FILE、3 = PERMISSION_DENIED），
 *  這裡一併處理，否則任務失敗時只會剩下一個沒有文案的數字碼。 */
export function mapSftpError(error: unknown, detail: string): AppError {
  const raw = (error as { code?: string | number } | undefined)?.code
  const code = typeof raw === 'string' ? raw : ''
  const status = typeof raw === 'number' ? raw : -1
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ENOSPC' || /no space/i.test(message)) {
    return appError('E_SFTP_NO_SPACE', { detail: `${detail}: ${message}`, message })
  }
  if (code === 'EACCES' || code === 'EPERM' || status === 3 || /permission denied/i.test(message)) {
    return appError('E_SFTP_PERMISSION', { detail: `${detail}: ${message}`, message })
  }
  if (code === 'ENOENT' || status === 2 || /no such file/i.test(message)) {
    return appError('E_SFTP_NOT_FOUND', { detail: `${detail}: ${message}`, message })
  }
  return appError('E_SFTP_UNAVAILABLE', { detail: `${detail}: ${message}`, message })
}

function call<T>(fn: (cb: (error: Error | undefined, result: T) => void) => void, detail: string): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((error, result) => {
      if (error) reject(mapSftpError(error, detail))
      else resolve(result)
    })
  })
}

/** 沒有回傳值的 SFTP 操作（ssh2 用寬鬆的 Callback 型別） */
function run(fn: (cb: (error?: Error | null) => void) => void, detail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fn((error) => {
      if (error) reject(mapSftpError(error, detail))
      else resolve()
    })
  })
}

/**
 * 一個 SFTP session 對應一條既有 SSH 連線（含跳板隧道）——§6 鐵則 6：不另開連線。
 */
export class SftpSession {
  private constructor(
    private readonly sftp: SFTPWrapper,
    readonly home: string
  ) {}

  static async open(client: Client): Promise<SftpSession> {
    const sftp = await call<SFTPWrapper>((cb) => client.sftp(cb), 'sftp subsystem')
    let home = '.'
    try {
      home = await call<string>((cb) => sftp.realpath('.', cb), 'realpath .')
    } catch {
      home = '.'
    }
    return new SftpSession(sftp, home)
  }

  async list(dirPath: string): Promise<SftpListResult> {
    const list = await call<Array<{ filename: string; attrs: Stats }>>(
      (cb) => this.sftp.readdir(dirPath, cb),
      `list ${dirPath}`
    )
    const entries = list
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => toEntry(dirPath, item.filename, item.attrs))
    return { path: dirPath, entries }
  }

  async stat(target: string): Promise<RemoteStat> {
    const attrs = await call<Stats>((cb) => this.sftp.stat(target, cb), `stat ${target}`)
    return {
      size: attrs.size,
      mtimeMs: attrs.mtime * 1000,
      isDirectory: attrs.isDirectory(),
      isFile: attrs.isFile(),
      isSymlink: attrs.isSymbolicLink()
    }
  }

  /** 不存在時回 null（衝突偵測用，不當錯誤） */
  async tryStat(target: string): Promise<RemoteStat | null> {
    try {
      return await this.stat(target)
    } catch (error) {
      if ((error as AppError).code === 'E_SFTP_NOT_FOUND') return null
      throw error
    }
  }

  async mkdir(target: string): Promise<void> {
    await run((cb) => this.sftp.mkdir(target, cb), `mkdir ${target}`)
  }

  async rename(from: string, to: string): Promise<void> {
    await run((cb) => this.sftp.rename(from, to, cb), `rename ${from} → ${to}`)
  }

  async remove(target: string, isDir: boolean): Promise<void> {
    await run(
      (cb) => (isDir ? this.sftp.rmdir(target, cb) : this.sftp.unlink(target, cb)),
      `remove ${target}`
    )
  }

  async realpath(target: string): Promise<string> {
    return call<string>((cb) => this.sftp.realpath(target, cb), `realpath ${target}`)
  }

  /** offset 續傳用：以 'r+' 開啟（不支援時由呼叫端退回重傳） */
  async openForAppend(target: string): Promise<{ handle: Buffer; supported: boolean }> {
    try {
      const handle = await call<Buffer>((cb) => this.sftp.open(target, 'r+', cb), `open r+ ${target}`)
      return { handle, supported: true }
    } catch {
      // 伺服器不支援 r+（或檔案不存在）→ 由上層改成從 0 重傳
      return { handle: Buffer.alloc(0), supported: false }
    }
  }

  async closeHandle(handle: Buffer): Promise<void> {
    if (handle.length === 0) return
    await run((cb) => this.sftp.close(handle, cb), 'close handle')
  }

  writeToHandle(handle: Buffer, buffer: Buffer, offset: number, position: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.write(handle, buffer, offset, buffer.length, position, (error) => {
        if (error) reject(mapSftpError(error, 'write'))
        else resolve()
      })
    })
  }

  createReadStream(remotePath: string, start = 0): Readable {
    return this.sftp.createReadStream(remotePath, start > 0 ? { start } : undefined)
  }

  createWriteStream(remotePath: string, flags: OpenMode = 'w'): Writable {
    return this.sftp.createWriteStream(remotePath, { flags })
  }

  end(): void {
    try {
      this.sftp.end()
    } catch {
      // 已關閉
    }
  }
}
