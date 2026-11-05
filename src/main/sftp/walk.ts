import type { SftpEntry } from '../../shared/ipc-contract'
import type { SftpSession } from './session'

export interface WalkedFile {
  /** 遠端絕對路徑 */
  path: string
  /** 相對於走訪根的相對路徑（目錄任務的目標路徑用） */
  relative: string
  size: number
  isDirectory: boolean
}

export interface WalkOptions {
  /** 目錄走訪上限（保護：避免誤選 / 造成萬檔爆炸） */
  maxEntries?: number
  maxDepth?: number
  /** 同時進行的 readdir 數量 */
  concurrency?: number
  onProgress?: (count: number) => void
}

const DEFAULTS = { maxEntries: 50_000, maxDepth: 32, concurrency: 8 }

/**
 * 遞迴走訪遠端目錄（M3-01：萬檔目錄 <3s）。
 * 以固定併發批次展開目錄，逐層 BFS；不做任何檔案內容讀取。
 */
export async function walkRemote(session: SftpSession, root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const { maxEntries, maxDepth, concurrency } = { ...DEFAULTS, ...options }
  const rootStat = await session.stat(root)
  if (!rootStat.isDirectory) {
    return [{ path: root, relative: basename(root), size: rootStat.size, isDirectory: false }]
  }

  const out: WalkedFile[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (queue.length > 0) {
    const batch = queue.splice(0, concurrency)
    const listings = await Promise.all(
      batch.map(async ({ dir, depth }) => ({ dir, depth, result: await session.list(dir) }))
    )

    for (const { dir, depth, result } of listings) {
      for (const entry of result.entries) {
        if (out.length >= maxEntries) {
          throw Object.assign(new Error(`walk limit exceeded (${maxEntries})`), { code: 'E_LIMIT' })
        }
        out.push({
          path: entry.path,
          relative: relativeTo(root, entry.path),
          size: entry.size,
          isDirectory: entry.type === 'dir'
        })
        if (entry.type === 'dir' && depth + 1 <= maxDepth) {
          queue.push({ dir: entry.path, depth: depth + 1 })
        }
      }
      void dir
    }
    options.onProgress?.(out.length)
  }

  return out
}

export function relativeTo(root: string, target: string): string {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  return target.startsWith(normalizedRoot) ? target.slice(normalizedRoot.length) : basename(target)
}

function basename(target: string): string {
  const parts = target.split('/').filter(Boolean)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : target
}

/** 目錄走訪結果 → 實際要傳的檔案（不含目錄本身） */
export function filesOnly(items: WalkedFile[]): WalkedFile[] {
  return items.filter((item) => !item.isDirectory)
}

/** 給 UI 的彙總（目錄任務的 totalBytes） */
export function totalBytes(items: WalkedFile[]): number {
  return items.reduce((sum, item) => sum + (item.isDirectory ? 0 : item.size), 0)
}

export type { SftpEntry }
