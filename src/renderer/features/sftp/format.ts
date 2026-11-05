/** 顯示格式輔助工具（M3-05）：不擅自做四捨五入以外的格式發明 */

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatSize(bytesPerSec)}/s`
}

export function formatMtime(mtimeMs: number): string {
  if (!mtimeMs) return ''
  return new Date(mtimeMs).toLocaleString()
}

export function formatEta(etaSec: number | null | undefined): string | null {
  if (etaSec === null || etaSec === undefined || !Number.isFinite(etaSec)) return null
  const total = Math.max(0, Math.round(etaSec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/** 由任一分隔符路徑（含 / 與 \）取檔名（衝突對話框用） */
export function baseName(path: string): string {
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return name ?? path
}

/** v0.1.4 #7：POSIX mode → 10 字元許可字串（例 drwxr-xr-x）。
 *  資料來源 SftpEntry.mode（遠端 SFTP attrs.mode）；mode 缺省時由呼叫端顯示空白。 */
export function formatMode(mode: number): string {
  if (!Number.isFinite(mode) || mode < 0) return ''
  const kind = mode & 0o170000
  const type =
    kind === 0o040000
      ? 'd'
      : kind === 0o120000
        ? 'l'
        : kind === 0o010000
          ? 'p'
          : kind === 0o020000
            ? 'c'
            : kind === 0o060000
              ? 'b'
              : kind === 0o140000
                ? 's'
                : '-'
  const triple = (read: number, write: number, exec: number, special: number, specialChar: string): string => {
    const canExec = (mode & exec) !== 0
    const x = mode & special ? (canExec ? specialChar : specialChar.toUpperCase()) : canExec ? 'x' : '-'
    return `${mode & read ? 'r' : '-'}${mode & write ? 'w' : '-'}${x}`
  }
  return (
    type +
    triple(0o400, 0o200, 0o100, 0o4000, 's') +
    triple(0o040, 0o020, 0o010, 0o2000, 's') +
    triple(0o004, 0o002, 0o001, 0o1000, 't')
  )
}

/** `file.ext` -> `file(1).ext`（同名衝突「保留兩者」的自動改名規則） */
export function autoRename(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}(1)`
  return `${name.slice(0, dot)}(1)${name.slice(dot)}`
}
