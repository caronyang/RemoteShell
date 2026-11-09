import type { TransferTask } from '../../../shared/ipc-contract'

/** 目前兩個面板的路徑與 session 身分（v0.1.11 #3／#4） */
export interface TransferRefreshContext {
  sessionId: string
  localPath: string
  remotePath: string
}

export interface PanesToRefresh {
  local: boolean
  remote: boolean
}

const NONE: PanesToRefresh = { local: false, remote: false }

/** 本機路徑：統一分隔線、去尾斜線、大小寫不敏感（Windows） */
function normalizeLocal(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

/** 遠端路徑：POSIX 語意，容忍結尾斜線（大小寫敏感） */
function normalizeRemote(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

function localDirname(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

function remoteDirname(path: string): string {
  const normalized = normalizeRemote(path)
  if (normalized === '/') return '/'
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

/**
 * 判斷一個已完成任務應刷新哪一側面板。
 * - 只認 completed 且同 session 的任務
 * - upload 的完成檔落在遠端目標目錄；download 落在本機目標目錄
 * - 以目標檔案的 dirname 與面板目前路徑比對（面板在目標目錄才需要重抓）
 */
export function panesToRefresh(
  task: Pick<TransferTask, 'state' | 'sessionId' | 'direction' | 'target'>,
  ctx: TransferRefreshContext
): PanesToRefresh {
  if (task.state !== 'completed' || task.sessionId !== ctx.sessionId) return NONE

  if (task.direction === 'upload') {
    const remote = normalizeRemote(remoteDirname(task.target)) === normalizeRemote(ctx.remotePath)
    return { local: false, remote }
  }

  if (task.direction === 'download') {
    const local = normalizeLocal(localDirname(task.target)) === normalizeLocal(ctx.localPath)
    return { local, remote: false }
  }

  return NONE
}
