import { useCallback, useEffect, useRef, useState } from 'react'
import { SFTP_COLUMN_DEFAULTS } from '../../../shared/constants'
import type { RsApi, SftpColumnWidths } from '../../../shared/ipc-contract'

/**
 * v0.1.4 #8：SFTP／本機檔案表格欄寬（settings.ui.sftpColumns）。
 * - 掛載讀回持久化值（重啟保持）；settings API 缺席或形狀不完整（單元測試 mock）→ 退回預設，不拋錯。
 * - 拖曳過程只更新本地狀態（preview），放開滑鼠才寫回（commit）；雙擊回該欄預設值（reset）。
 * - 本機／遠端面板各掛一份，靠 main 廣播的 settingsChanged（onChange）同步。
 * - 雙面板的欄寬共用同一份設定（契約 ui.sftpColumns 為單一物件）。
 */

export type SftpColumnKey = keyof SftpColumnWidths

/** colgroup 與表頭一致的欄序（#7：名稱 → 權限 → 修改日期 → 大小） */
export const SFTP_COLUMN_KEYS: readonly SftpColumnKey[] = ['name', 'permissions', 'mtime', 'size']

/** 與 schema（main/store/schema.ts sftpColumns）一致的上限；UI 下限嚴於 schema 下限（40） */
export const COLUMN_WIDTH_MAX = 2000

/** UI 層逐欄最小寬度（主管裁定：name ≥120、其餘 ≥70；皆在 schema 40–2000 之內） */
export const COLUMN_MIN_WIDTHS: Record<SftpColumnKey, number> = {
  name: 120,
  permissions: 70,
  mtime: 70,
  size: 70
}

/** 欄寬夾限＋取整（逐欄下限）；非有限值防禦性歸該欄下限（拖曳／鍵盤路徑永遠是有限數） */
export function clampColumnWidth(key: SftpColumnKey, value: number): number {
  if (!Number.isFinite(value)) return COLUMN_MIN_WIDTHS[key]
  return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_MIN_WIDTHS[key], Math.round(value)))
}

/** 外來設定值逐欄夾限；缺欄或型別不對 → 用預設補 */
function normalizeWidths(input: Partial<SftpColumnWidths> | undefined): SftpColumnWidths {
  const out: SftpColumnWidths = { ...SFTP_COLUMN_DEFAULTS }
  if (!input) return out
  for (const key of SFTP_COLUMN_KEYS) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = clampColumnWidth(key, value)
  }
  return out
}

/** window.rs 在單元測試裡是 mock（可能整段缺 settings）→ 防禦式取得 */
function settingsApi(): RsApi['settings'] | undefined {
  const api = (window.rs as Partial<RsApi> | undefined)?.settings
  if (!api || typeof api.get !== 'function' || typeof api.patch !== 'function') return undefined
  return api
}

export interface SftpColumnWidthsController {
  widths: SftpColumnWidths
  /** 拖曳中：只寫本地（即時視覺生效，不落盤） */
  previewWidth: (key: SftpColumnKey, width: number) => void
  /** 拖曳結束／方向鍵：夾限後寫回 settings.ui.sftpColumns */
  commitWidth: (key: SftpColumnKey, width: number) => void
  /** 雙擊：該欄回預設值並寫回 */
  resetWidth: (key: SftpColumnKey) => void
}

export function useSftpColumnWidths(): SftpColumnWidthsController {
  const [widths, setWidths] = useState<SftpColumnWidths>(() => ({ ...SFTP_COLUMN_DEFAULTS }))
  /* 使用者動過欄寬後，不用 get() 的舊值覆蓋本地預覽（get 是掛載時的快取） */
  const touchedRef = useRef(false)

  useEffect(() => {
    const api = settingsApi()
    if (!api) return
    let cancelled = false
    /* Promise.resolve 包一層：mock 可能回非 thenable */
    void Promise.resolve(api.get()).then((result) => {
      if (!cancelled && !touchedRef.current && result?.ok) setWidths(normalizeWidths(result.data?.ui?.sftpColumns))
    })
    const off = typeof api.onChange === 'function'
      ? api.onChange((next) => setWidths(normalizeWidths(next.ui?.sftpColumns)))
      : undefined
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  const writeBack = useCallback((partial: Partial<SftpColumnWidths>) => {
    const api = settingsApi()
    if (!api) return
    void Promise.resolve(api.patch({ ui: { sftpColumns: partial } })).then((result) => {
      if (result && !result.ok) console.warn('[sftp] column width write-back failed', result.error)
    })
  }, [])

  const apply = useCallback((key: SftpColumnKey, value: number): number => {
    const next = clampColumnWidth(key, value)
    touchedRef.current = true
    setWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }))
    return next
  }, [])

  /* 單欄部分更新（deepMerge 保留其他欄；避免用整份狀態寫回時覆蓋另一面板的並行調整） */
  const patchKey = useCallback((key: SftpColumnKey, value: number): void => {
    const partial: Partial<SftpColumnWidths> = {}
    partial[key] = value
    writeBack(partial)
  }, [writeBack])

  const previewWidth = useCallback((key: SftpColumnKey, width: number) => {
    apply(key, width)
  }, [apply])

  const commitWidth = useCallback((key: SftpColumnKey, width: number) => {
    patchKey(key, apply(key, width))
  }, [apply, patchKey])

  const resetWidth = useCallback((key: SftpColumnKey) => {
    patchKey(key, apply(key, SFTP_COLUMN_DEFAULTS[key]))
  }, [apply, patchKey])

  return { widths, previewWidth, commitWidth, resetWidth }
}
