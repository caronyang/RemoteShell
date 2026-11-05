import fs from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { appError } from '../../shared/errors'
import { planDownload, planUpload, downgradeToRestart, type ResumePlan } from './resume'
import { mapSftpError, type SftpSession } from './session'

export interface TransferOptions {
  signal?: AbortSignal
  onProgress?: (transferred: number, total: number) => void
  /** 續傳前的前置檢查（不支援 r+ 時退回重傳） */
  allowResume?: boolean
  /**
   * 同一任務被暫停後續傳：只比大小、不比 mtime
   * （傳輸中的檔案 mtime 一定會變，用嚴格規則會被迫從 0 重傳）
   */
  forceResume?: boolean
}

export interface TransferOutcome {
  bytes: number
  total: number
  plan: ResumePlan
  /** 伺服器不支援續寫 → UI 需顯示「需重傳」 */
  needsRetransfer: boolean
  /** 實際完成後的最終大小 */
  finalSize: number
}

const CHUNK = 256 * 1024

function isMissingError(error: unknown): boolean {
  const code = (error as { code?: string | number } | null)?.code
  if (code === 'E_SFTP_NOT_FOUND' || code === 'ENOENT' || code === 2) return true
  return error instanceof Error && /no such file/i.test(error.message)
}

/**
 * 上傳前建立遠端父目錄（等同 `mkdir -p`）。
 * P1-04：目錄上傳時遠端父目錄不存在，原本會讓每個子檔 E_SFTP_NOT_FOUND；
 * 這裡逐段建立，已存在就略過；權限不足由 mapSftpError 轉成 E_SFTP_PERMISSION。
 */
export async function ensureRemoteDir(session: SftpSession, remotePath: string): Promise<void> {
  const normalized = remotePath.replace(/\/+$/, '')
  if (normalized === '' || normalized === '.' || normalized === '/') return
  const absolute = normalized.startsWith('/')
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.')
  let current = absolute ? '' : '.'

  for (const part of parts) {
    current = `${current}/${part}`
    let stat: Awaited<ReturnType<SftpSession['stat']>> | null = null
    try {
      stat = await session.stat(current)
    } catch (error) {
      if (!isMissingError(error)) throw error
    }
    if (stat) {
      if (!stat.isDirectory) {
        throw appError('E_SFTP_UNAVAILABLE', {
          detail: `remote parent is not a directory: ${current}`,
          message: `Remote path exists but is not a directory: ${current}`
        })
      }
      continue
    }
    try {
      await session.mkdir(current)
    } catch (error) {
      // 併發／殘留：別人先建好了就不算失敗
      const again = await session.stat(current).catch(() => null)
      if (again?.isDirectory) continue
      const product = typeof error === 'object' && error !== null && 'code' in error && 'i18nKey' in error
      throw product ? error : mapSftpError(error, `mkdir ${current}`)
    }
  }
}

function abortError(): Error {
  return Object.assign(new Error('transfer cancelled'), { name: 'AbortError', code: 'E_CANCELLED' })
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/** 上傳：本地檔 → 遠端（支援 offset 續寫；不支援 r+ 時退回重傳） */
export async function uploadFile(
  session: SftpSession,
  localPath: string,
  remotePath: string,
  options: TransferOptions = {}
): Promise<TransferOutcome> {
  const localStat = fs.statSync(localPath)
  const total = localStat.size
  const remote = options.allowResume === false ? null : await session.tryStat(remotePath)
  let plan = options.forceResume
    ? remote && remote.size < localStat.size
      ? { mode: 'resume' as const, offset: remote.size, reason: 'resume' as const }
      : { mode: 'restart' as const, offset: 0, reason: 'no-target' as const }
    : planUpload(
        { size: localStat.size, mtimeMs: localStat.mtimeMs },
        remote ? { size: remote.size, mtimeMs: remote.mtimeMs } : null
      )

  let handle: Buffer | null = null
  let offset = 0
  if (plan.mode === 'resume') {
    const opened = await session.openForAppend(remotePath)
    if (opened.supported) {
      handle = opened.handle
      offset = plan.offset
    } else {
      plan = downgradeToRestart(plan)
    }
  }

  let transferred = offset
  let written = offset

  if (handle) {
    // 'r+' 續寫：手動分塊，確保 position 正確且可取消
    const reader = fs.createReadStream(localPath, { start: offset, highWaterMark: CHUNK })
    try {
      for await (const chunk of reader) {
        checkAborted(options.signal)
        const buffer = chunk as Buffer
        await session.writeToHandle(handle, buffer, 0, written)
        written += buffer.length
        transferred += buffer.length
        options.onProgress?.(transferred, total)
      }
    } finally {
      await session.closeHandle(handle)
    }
    return { bytes: transferred - offset, total, plan, needsRetransfer: false, finalSize: written }
  }

  // 一般上傳（或續傳失敗後重傳）：串流 + 進度
  checkAborted(options.signal)
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (options.signal?.aborted) {
        callback(abortError())
        return
      }
      transferred += chunk.length
      options.onProgress?.(transferred, total)
      callback(null, chunk)
    }
  })
  await pipeline(
    fs.createReadStream(localPath, { highWaterMark: CHUNK }),
    counter,
    session.createWriteStream(remotePath, 'w'),
    { signal: options.signal }
  )
  return {
    bytes: transferred,
    total,
    plan,
    needsRetransfer: plan.mode === 'restart' && plan.reason === 'server-no-append',
    finalSize: transferred
  }
}

/** 下載：遠端 → 本地（append 續傳；mtime/size 不合就重傳） */
export async function downloadFile(
  session: SftpSession,
  remotePath: string,
  localPath: string,
  options: TransferOptions = {}
): Promise<TransferOutcome> {
  const remote = await session.stat(remotePath)
  if (remote.isDirectory) {
    throw appError('E_SFTP_UNAVAILABLE', { detail: `download of a directory: ${remotePath}` })
  }
  const localExists = fs.existsSync(localPath)
  const localStat = localExists ? fs.statSync(localPath) : null
  const plan = options.forceResume
    ? localStat && localStat.size < remote.size
      ? { mode: 'resume' as const, offset: localStat.size, reason: 'resume' as const }
      : { mode: 'restart' as const, offset: 0, reason: 'no-target' as const }
    : options.allowResume === false
      ? ({ mode: 'restart', offset: 0, reason: 'no-target' } as ResumePlan)
      : planDownload(
          { size: remote.size, mtimeMs: remote.mtimeMs },
          localStat ? { size: localStat.size, mtimeMs: localStat.mtimeMs } : null
        )

  const offset = plan.mode === 'resume' ? plan.offset : 0
  let transferred = offset

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (options.signal?.aborted) {
        callback(abortError())
        return
      }
      transferred += chunk.length
      options.onProgress?.(transferred, remote.size)
      callback(null, chunk)
    }
  })

  checkAborted(options.signal)
  await pipeline(
    session.createReadStream(remotePath, offset),
    counter,
    fs.createWriteStream(localPath, { flags: offset > 0 ? 'a' : 'w' }),
    { signal: options.signal }
  )

  return {
    bytes: transferred - offset,
    total: remote.size,
    plan,
    needsRetransfer: false,
    finalSize: fs.statSync(localPath).size
  }
}

/** 只算檔案大小（目錄任務的 totalBytes） */
export function localFileSize(filePath: string): number {
  const stat = fs.statSync(filePath)
  return stat.isDirectory() ? 0 : stat.size
}
