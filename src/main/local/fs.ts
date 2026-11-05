import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppError, EntryType, LocalEntry, LocalListResult } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'

/**
 * 本地面板（F-1）的檔案操作——§3.9 安全規則：
 * 1. 路徑一律 `path.resolve` 正規化，含 `..` 段落直接拒絕（不允許靠 resolve 逃逸）
 * 2. 只允許固定磁碟機根與使用者家目錄；拒絕 `\\?\` / `\\.\` 裝置命名空間
 * 3. 刪除由呼叫端決定 recursive，main 不自行遞迴
 * 4. 只回傳 metadata，不回傳檔案內容
 * 5. 錯誤映射沿用既有 ErrorCode（不新增）：權限→E_SFTP_PERMISSION、不存在→E_SFTP_NOT_FOUND、
 *    磁碟滿→E_SFTP_NO_SPACE、其他→E_LOCAL_IO
 */

const DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/

export interface LocalFsOptions {
  /** 使用者家目錄（預設 os.homedir()） */
  home?: string
  /** 可列出的磁碟機根（預設自動偵測 A:–Z:） */
  drives?: () => string[]
}

export function homeDir(options: LocalFsOptions = {}): string {
  return path.resolve(options.home ?? os.homedir())
}

export function listDrives(): string[] {
  const drives: string[] = []
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.existsSync(root)) drives.push(root)
    } catch {
      // 沒掛載的磁碟機 direct exist 會拋錯，忽略
    }
  }
  return drives
}

function mapFsError(error: unknown, detail: string): AppError {
  const code = (error as { code?: string } | undefined)?.code ?? ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'EACCES' || code === 'EPERM') {
    return appError('E_SFTP_PERMISSION', { detail: `${detail}: ${message}`, message })
  }
  if (code === 'ENOENT') {
    return appError('E_SFTP_NOT_FOUND', { detail: `${detail}: ${message}`, message })
  }
  if (code === 'ENOSPC') {
    return appError('E_SFTP_NO_SPACE', { detail: `${detail}: ${message}`, message })
  }
  return appError('E_LOCAL_IO', { detail: `${detail}: ${message}`, message })
}

/**
 * 把 renderer 傳來的路徑正規化並驗證。
 * `..` 一律拒絕（即使 resolve 後仍在磁碟機內），避免「看似合法、實際跳目錄」的攻擊面。
 */
export function resolveSafePath(input: string, options: LocalFsOptions = {}): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw appError('E_LOCAL_IO', { detail: 'empty path' })
  }
  if (input.includes('\0') || DEVICE_PREFIX.test(input)) {
    throw appError('E_LOCAL_IO', { detail: `device namespace is not allowed: ${input}` })
  }
  const normalisedInput = input.replace(/[\\/]+/g, path.sep)
  const segments = normalisedInput.split(path.sep)
  if (segments.includes('..')) {
    throw appError('E_LOCAL_IO', { detail: `path traversal is not allowed: ${input}` })
  }
  const resolved = path.resolve(normalisedInput)
  const root = path.parse(resolved).root
  const home = homeDir(options)
  const drives = (options.drives ?? listDrives)().map((d) => path.resolve(d))
  const insideHome = resolved === home || resolved.startsWith(home + path.sep)
  const onDrive = root.length > 0 && (drives.length === 0 || drives.includes(path.resolve(root)))
  if (!insideHome && !onDrive) {
    throw appError('E_LOCAL_IO', { detail: `path is outside allowed roots: ${resolved}` })
  }
  return resolved
}

function entryTypeOf(isDirectory: boolean, isSymbolicLink: boolean, isFile: boolean): EntryType {
  if (isSymbolicLink) return 'link'
  if (isDirectory) return 'dir'
  if (isFile) return 'file'
  return 'other'
}

/** 只回 metadata；用 lstat 不跟隨 symlink/junction */
export function listLocal(input: string, options: LocalFsOptions = {}): LocalListResult {
  const target = resolveSafePath(input, options)
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(target, { withFileTypes: true })
  } catch (error) {
    throw mapFsError(error, `list ${target}`)
  }
  const entries: LocalEntry[] = []
  for (const dirent of names) {
    const entryPath = path.join(target, dirent.name)
    try {
      const stat = fs.lstatSync(entryPath)
      entries.push({
        name: dirent.name,
        path: entryPath,
        type: entryTypeOf(stat.isDirectory(), stat.isSymbolicLink(), stat.isFile()),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isSymlink: stat.isSymbolicLink()
      })
    } catch {
      // 讀不到 metadata 的項目（例如被鎖住）跳過，不讓整個列表失敗
    }
  }
  return { path: target, entries, drives: (options.drives ?? listDrives)() }
}

export function mkdirLocal(input: string, options: LocalFsOptions = {}): void {
  const target = resolveSafePath(input, options)
  try {
    fs.mkdirSync(target, { recursive: false })
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return
    throw mapFsError(error, `mkdir ${target}`)
  }
}

export function renameLocal(from: string, to: string, options: LocalFsOptions = {}): void {
  const source = resolveSafePath(from, options)
  const destination = resolveSafePath(to, options)
  try {
    fs.renameSync(source, destination)
  } catch (error) {
    throw mapFsError(error, `rename ${source} → ${destination}`)
  }
}

/** recursive 由 UI 決定；main 不自行遞迴 */
export function removeLocal(input: string, recursive: boolean, options: LocalFsOptions = {}): void {
  const target = resolveSafePath(input, options)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    throw mapFsError(error, `remove ${target}`)
  }
  if (stat.isDirectory() && !recursive) {
    // 非空目錄用非遞迴刪除會失敗；這裡先自己判斷，錯誤訊息才有意義
    let hasChildren = false
    try {
      hasChildren = fs.readdirSync(target).length > 0
    } catch (error) {
      throw mapFsError(error, `remove ${target}`)
    }
    if (hasChildren) {
      throw appError('E_LOCAL_IO', { detail: `directory is not empty and recursive=false: ${target}` })
    }
  }
  try {
    fs.rmSync(target, { recursive, force: false })
  } catch (error) {
    throw mapFsError(error, `remove ${target}`)
  }
}
