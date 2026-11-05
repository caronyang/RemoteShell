/**
 * M5-02：冷啟量測用的「開機軌跡」。
 *
 * 只有在設定 `RS_BOOT_TRACE=<檔案路徑>` 時才啟用（平常完全不執行、不影響使用者）。
 * 內容是絕對時間戳，讓外部的量測腳本可以算「行程啟動 → 視窗可見 → 載入完成」。
 *
 * 另外會攔一次 `app://` 回應的 header，把 M5-01 的 CSP header 實際值記錄下來
 * ——證明 header 真的有下發（而不是只寫在程式碼裡）。
 */
import fs from 'node:fs'
import { session } from 'electron'

/** 模組載入時間：越早 import 越接近行程啟動 */
export const bootStartedAt = Date.now()

export interface BootTrace {
  startedAt: number
  shownAt: number | null
  loadedAt: number | null
  url: string | null
  csp: string | null
  exitAfterLoad: boolean
}

export interface BootTraceHandle {
  shown: (url: string) => void
  loaded: (url: string) => void
  csp: () => string | null
}

export function startBootTrace(): BootTraceHandle {
  const file = process.env['RS_BOOT_TRACE'] ?? ''
  if (file.length === 0) {
    return { shown: () => undefined, loaded: () => undefined, csp: () => null }
  }

  const trace: BootTrace = {
    startedAt: bootStartedAt,
    shownAt: null,
    loadedAt: null,
    url: null,
    csp: null,
    exitAfterLoad: process.env['RS_BOOT_EXIT'] === '1'
  }

  const flush = (): void => {
    try {
      fs.writeFileSync(file, JSON.stringify(trace, null, 2))
    } catch {
      // 量測失敗不影響產品
    }
  }

  const onHeaders = (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void
  ): void => {
    if (!trace.csp && details.url.startsWith('app://')) {
      const raw =
        details.responseHeaders?.['Content-Security-Policy'] ??
        details.responseHeaders?.['content-security-policy']
      if (raw) trace.csp = Array.isArray(raw) ? raw.join('; ') : String(raw)
    }
    callback({ responseHeaders: details.responseHeaders })
  }
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, onHeaders)

  return {
    shown: (url) => {
      trace.shownAt = Date.now()
      trace.url = url
      flush()
    },
    loaded: (url) => {
      trace.loadedAt = Date.now()
      if (url) trace.url = url
      flush()
    },
    csp: () => trace.csp
  }
}
