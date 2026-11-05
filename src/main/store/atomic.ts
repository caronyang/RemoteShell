import fs from 'node:fs'
import path from 'node:path'

export interface AtomicDeps {
  writeFileSync: typeof fs.writeFileSync
  renameSync: typeof fs.renameSync
  copyFileSync: typeof fs.copyFileSync
  existsSync: typeof fs.existsSync
  unlinkSync: typeof fs.unlinkSync
  mkdirSync: typeof fs.mkdirSync
}

const defaultDeps: AtomicDeps = {
  writeFileSync: fs.writeFileSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  copyFileSync: fs.copyFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  unlinkSync: fs.unlinkSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs)
}

/**
 * 原子寫入（§5）：暫存檔 → rename 覆蓋，舊檔保留為 .bak。
 * 若 rename 失敗，原檔必須維持可用、暫存檔要清掉（M1-04 驗收項）。
 */
export function writeJsonAtomic(file: string, value: unknown, deps: Partial<AtomicDeps> = {}): void {
  const d: AtomicDeps = { ...defaultDeps, ...deps }
  const tmp = `${file}.tmp`
  const bak = `${file}.bak`
  const body = `${JSON.stringify(value, null, 2)}\n`

  d.mkdirSync(path.dirname(file), { recursive: true })
  d.writeFileSync(tmp, body, 'utf8')

  if (d.existsSync(file)) {
    // 舊檔先留一份 .bak，rename 失敗時使用者仍可回復
    d.copyFileSync(file, bak)
  }

  try {
    d.renameSync(tmp, file)
  } catch (error) {
    try {
      if (d.existsSync(tmp)) d.unlinkSync(tmp)
    } catch {
      // 清不掉暫存檔不影響原檔完整性，交給上層記 log
    }
    throw error
  }
}

/** 讀 JSON；檔案不存在或內容壞掉時回 null（由呼叫端決定預設值／回復 .bak） */
export function readJson<T>(file: string, deps: Partial<AtomicDeps> = {}): T | null {
  const d: AtomicDeps = { ...defaultDeps, ...deps }
  if (!d.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    const bak = `${file}.bak`
    if (d.existsSync(bak)) {
      try {
        return JSON.parse(fs.readFileSync(bak, 'utf8')) as T
      } catch {
        return null
      }
    }
    return null
  }
}
