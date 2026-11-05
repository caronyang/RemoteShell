/**
 * 續傳判斷（§6.3）——純函式，單元測試可直接驗行為。
 *
 * 規則：
 * - 下載：本地長度 < 遠端長度 且 mtime 未變 → 從本地長度續傳；否則重傳
 * - 上傳：遠端長度 < 本地長度 且 mtime 未變 → 從遠端長度續傳；否則重傳
 * - 任何一端不存在 → 從 0 開始（不是續傳）
 */

export interface FileMeta {
  size: number
  mtimeMs: number
}

export type ResumeReason = 'resume' | 'no-target' | 'size-equal' | 'target-larger' | 'mtime-changed' | 'server-no-append'

export interface ResumePlan {
  /** 'resume' = 從 offset 接續；'restart' = 從 0 重傳 */
  mode: 'resume' | 'restart'
  offset: number
  reason: ResumeReason
}

/** mtime 容忍值（FAT/SFTP 秒級精度） */
export const MTIME_TOLERANCE_MS = 2000

function mtimeSame(a: number, b: number): boolean {
  return Math.abs(a - b) <= MTIME_TOLERANCE_MS
}

export function planDownload(remote: FileMeta, local: FileMeta | null): ResumePlan {
  if (!local) return { mode: 'restart', offset: 0, reason: 'no-target' }
  if (local.size === remote.size) return { mode: 'restart', offset: 0, reason: 'size-equal' }
  if (local.size > remote.size) return { mode: 'restart', offset: 0, reason: 'target-larger' }
  if (!mtimeSame(local.mtimeMs, remote.mtimeMs)) return { mode: 'restart', offset: 0, reason: 'mtime-changed' }
  return { mode: 'resume', offset: local.size, reason: 'resume' }
}

export function planUpload(local: FileMeta, remote: FileMeta | null): ResumePlan {
  if (!remote) return { mode: 'restart', offset: 0, reason: 'no-target' }
  if (remote.size === local.size) return { mode: 'restart', offset: 0, reason: 'size-equal' }
  if (remote.size > local.size) return { mode: 'restart', offset: 0, reason: 'target-larger' }
  if (!mtimeSame(remote.mtimeMs, local.mtimeMs)) return { mode: 'restart', offset: 0, reason: 'mtime-changed' }
  return { mode: 'resume', offset: remote.size, reason: 'resume' }
}

/** 上傳時伺服器不支援 r+ → 退回重傳（UI 顯示「需重傳」） */
export function downgradeToRestart(plan: ResumePlan): ResumePlan {
  return plan.mode === 'resume' ? { mode: 'restart', offset: 0, reason: 'server-no-append' } : plan
}
