import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { AppSettings, SessionInfo } from '../../../shared/ipc-contract'
import { useToast } from '../../components/Toast'
import { copyTerminalSelection, pasteIntoTerminal } from './clipboard'
import { terminalFontFamily, terminalTheme } from './theme'

export interface UseTerminalOptions {
  session: SessionInfo
  settings: AppSettings
  active: boolean
}

/** v0.1.9 #1：字型沒載入就建 xterm/WebGL 會把 fallback glyph 烘進 atlas（Win11 字型鏈症狀）。 */
const FONT_WAIT_TIMEOUT_MS = 1_500

export function fontSpec(fontFamily: string, fontSize: number): string {
  return `${fontSize}px "${fontFamily.replace(/"/g, '\\"')}"`
}

/**
 * 等字型真的可用（`fonts.load`＋`fonts.ready`）；最多等 timeoutMs，避免字型服務卡住時整個終端不開。
 * 回傳 true = 已就緒；false = 逾時，先用目前字型建立，之後 loadingdone 再 refresh atlas 一次。
 */
export async function waitForTerminalFont(fontFamily: string, fontSize: number, timeoutMs = FONT_WAIT_TIMEOUT_MS): Promise<boolean> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts || typeof fonts.load !== 'function') return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    const loaded = Promise.all([fonts.load(fontSpec(fontFamily, fontSize)), fonts.ready])
      .then(() => true)
      .catch(() => true)
    return await Promise.race([loaded, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 終端資料路徑（§6.6）：main 已用 8ms/16KB 批次送出，這裡：
 * 1. 每 session 一個 TextDecoder({stream:true})（重連必重建 → 依 sessionId 重建）
 * 2. term.write 後由 xterm 自己排隊，不在 renderer 再累積
 * 3. resize 走 FitAddon → rs:session:resize（main 送 window-change／NAWS）
 * 4. v0.1.9：Terminal/WebGL 建立前先等字型；逾時才 fallback，字型晚到再 refresh atlas 一次
 */
export function useTerminal({ session, settings, active }: UseTerminalOptions): {
  containerRef: React.RefObject<HTMLDivElement>
  termRef: React.RefObject<Terminal | null>
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const { t } = useTranslation()
  const toast = useToast()
  const showClipboardDenied = (): void => toast.show(t('terminal.clipboardDenied'), 'error')
  const webglRef = useRef<WebglAddon | null>(null)
  /* 建立是非同步的（等字型），用 ref 拿到「當下最新」的字型設定，避免等到舊值 */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    let cancelled = false
    let cleanup: (() => void) | undefined

    const start = (fontsReady: boolean): void => {
      if (cancelled) return
      const terminalSettings = settingsRef.current.terminal
      const term = new Terminal({
        cols: session.cols,
        rows: session.rows,
        fontFamily: terminalSettings.fontFamily || terminalFontFamily(),
        fontSize: terminalSettings.fontSize,
        cursorStyle: terminalSettings.cursorStyle,
        cursorBlink: terminalSettings.cursorBlink,
        scrollback: terminalSettings.scrollback,
        allowProposedApi: true,
        theme: terminalTheme()
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.open(container)
      let webgl: WebglAddon | null = null
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl?.dispose())
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        // WebGL 不可用時退回 DOM renderer（不影響功能）
      }
      fit.fit()
      termRef.current = term
      fitRef.current = fit

      /* 字型在 renderer 建立後才完成（逾時 fallback）：atlas 只重建一次，避免每字重繪 */
      let refreshedAfterFonts = false
      const refreshAfterFonts = (): void => {
        if (fontsReady || refreshedAfterFonts || cancelled) return
        refreshedAfterFonts = true
        webgl?.clearTextureAtlas?.()
        term.refresh?.(0, Math.max(0, term.rows - 1))
      }
      const fonts = typeof document !== 'undefined' ? document.fonts : undefined
      const fontsWithEvents = fonts as (FontFaceSet & { addEventListener?: (type: string, cb: () => void) => void }) | undefined
      if (!fontsReady && fontsWithEvents) {
        fontsWithEvents.addEventListener?.('loadingdone', refreshAfterFonts)
        void fontsWithEvents.ready.then(refreshAfterFonts).catch(() => undefined)
      }

      // 每個 session 一個增量解碼器；重連（sessionId 不變但重建）時整個 effect 會重跑
      let decoder = new TextDecoder('utf-8')

      const applyBytes = (bytes: Uint8Array): void => {
        const text = decoder.decode(bytes, { stream: true })
        if (text.length > 0) term.write(text)
      }

      const offData = window.rs.session.onData((event) => {
        if (event.sessionId !== session.sessionId) return
        applyBytes(event.bytes)
      })

      // 補回畫面（main 保留 256KB 環形緩衝）
      void window.rs.session.snapshot(session.sessionId).then((result) => {
        if (result.ok && result.data.bytes.length > 0) applyBytes(result.data.bytes)
        decoder = new TextDecoder('utf-8')
      })

      /* v0.1.10 #2 Ctrl+C（PM 裁決）：攔截點必須在 customKeyEventHandler ——
         xterm 的 coreService.onUserInput 在 triggerDataEvent 時會清選取，
         到 onData 才判斷 hasSelection 已經太晚（實機實證：選取被清、SIGINT 照送）。
         有選取 → preventDefault＋回 false（攔下：不送 SIGINT、不觸發清選取、複製後保留）；
         無選取 → 回 true 照常送 \x03（使用者中斷習慣不能壞）。 */
      term.attachCustomKeyEventHandler((ev) => {
        /* 注意：xterm 的 keydown 與 keyup 都會進這個 handler —— 必須只在 keydown 動作，
           否則 Ctrl+V 放開時會再貼一次（實機截圖實證：指令出現兩次）。 */
        if (ev.type !== 'keydown') return true
        if (ev.ctrlKey && !ev.altKey && !ev.shiftKey && (ev.key === 'c' || ev.key === 'C')) {
          if (term.hasSelection()) {
            ev.preventDefault()
            void copyTerminalSelection(term).catch(showClipboardDenied)
            return false
          }
          return true
        }
        /* Ctrl+V：統一走 clipboard → term.paste（\n→\r／bracketed paste／CJK 由 xterm 處理） */
        if (ev.ctrlKey && !ev.altKey && !ev.shiftKey && (ev.key === 'v' || ev.key === 'V')) {
          ev.preventDefault()
          void pasteIntoTerminal(term).catch(showClipboardDenied)
          return false
        }
        return true
      })

      const inputDisposable = term.onData((data) => {
        /* 防線：即使未來 key 層攔截失效，這裡也絕不在有選取時送 \x03 */
        if (data === '\x03' && term.hasSelection()) {
          void copyTerminalSelection(term).catch(showClipboardDenied)
          return
        }
        void window.rs.session.write(session.sessionId, data)
      })

      const sendResize = (): void => {
        fit.fit()
        // WebGL renderer 在容器縮小時 canvas 不會自動裁掉，補一次 refresh 避免蓋到隔壁面板
        term.refresh(0, Math.max(0, term.rows - 1))
        void window.rs.session.resize(session.sessionId, term.cols, term.rows)
      }
      const observer = new ResizeObserver(() => sendResize())
      observer.observe(container)

      cleanup = (): void => {
        fontsWithEvents?.removeEventListener?.('loadingdone', refreshAfterFonts)
        observer.disconnect()
        offData()
        inputDisposable.dispose()
        term.dispose()
        termRef.current = null
        fitRef.current = null
        webglRef.current = null
      }
    }

    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (fonts && typeof fonts.load === 'function') {
      const current = settingsRef.current.terminal
      void waitForTerminalFont(current.fontFamily || terminalFontFamily(), current.fontSize).then(start)
    } else {
      start(true)
    }

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [session.sessionId])

  // 只改字型大小時即時套用（keep-alive，不清屏）；等字型載入後再換，避免 atlas 用 fallback
  useEffect(() => {
    const term = termRef.current
    if (!term) return undefined
    let cancelled = false
    const { fontFamily: rawFamily, fontSize } = settings.terminal
    const fontFamily = rawFamily || terminalFontFamily()
    void waitForTerminalFont(fontFamily, fontSize).then(() => {
      if (cancelled || termRef.current !== term) return
      term.options.fontSize = fontSize
      term.options.fontFamily = fontFamily
      webglRef.current?.clearTextureAtlas?.()
      fitRef.current?.fit()
      term.refresh?.(0, Math.max(0, term.rows - 1))
      void window.rs.session.resize(session.sessionId, term.cols, term.rows)
    })
    return () => {
      cancelled = true
    }
  }, [settings.terminal.fontSize, settings.terminal.fontFamily, session.sessionId])

  useEffect(() => {
    if (active) {
      fitRef.current?.fit()
      termRef.current?.focus()
    }
  }, [active])

  return { containerRef, termRef }
}
