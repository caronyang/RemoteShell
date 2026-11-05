import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { AppSettings, SessionInfo } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { TerminalView } from '../../src/renderer/features/terminal/TerminalView'

const state = vi.hoisted(() => ({ created: 0, atlasCleared: 0, refresh: 0, options: [] as Record<string, unknown>[], webglFails: false }))

vi.mock('@xterm/xterm', () => {
  class TerminalMock {
    cols = 120
    rows = 30
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      state.created += 1
      this.options = { ...options }
      state.options.push(this.options)
    }
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    write(): void {}
    focus(): void {}
    refresh(): void {
      state.refresh += 1
    }
    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    /* v0.1.10 #2：useTerminal/TerminalView 新呼叫（剪貼簿攔截） */
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    paste(): void {}
  }
  return { Terminal: TerminalMock }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      if (state.webglFails) throw new Error('WebGL unavailable')
    }
    onContextLoss(): void {}
    dispose(): void {}
    clearTextureAtlas(): void {
      state.atlasCleared += 1
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'fonts')
})

beforeEach(() => {
  state.created = 0
  state.atlasCleared = 0
  state.refresh = 0
  state.options = []
  state.webglFails = false
  Object.defineProperty(window, 'rs', {
    value: {
      session: {
        onData: vi.fn().mockReturnValue(() => undefined),
        snapshot: vi.fn().mockResolvedValue({ ok: true, data: { bytes: new Uint8Array() } }),
        write: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        resize: vi.fn().mockResolvedValue({ ok: true, data: undefined })
      }
    },
    configurable: true
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

const session: SessionInfo = {
  sessionId: 's1',
  profileId: 'p1',
  protocol: 'ssh',
  state: 'connected',
  phase: 'ready',
  host: '10.0.0.1',
  port: 22,
  cols: 120,
  rows: 30
}

const settings = (fontSize = 11): AppSettings => ({
  schemaVersion: 1,
  locale: 'en-US',
  general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete: true },
  terminal: {
    fontFamily: 'Cascadia Mono',
    fontSize,
    themeId: 'dark',
    scrollback: 10000,
    cursorStyle: 'block',
    cursorBlink: true,
    ambiguousWidth: 'narrow'
  },
  transfer: { maxConcurrent: 3, downloadDir: 'C:\\Downloads', afterDownload: 'notify', onConflict: 'ask', retryCount: 0 },
  ui: { sidebarWidth: 260, queueHeight: 200, queueCollapsed: true, sidebarCollapsed: false }
})

/* v0.1.10 #2 起 TerminalView/useTerminal 依賴 useToast + useTranslation → 需 providers */
const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

const setFonts = (mock: Record<string, unknown>): void => {
  Object.defineProperty(document, 'fonts', { value: mock as unknown as FontFaceSet, configurable: true })
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('v0.1.9 #1：字型就緒前不建立 Terminal／WebGL renderer', () => {
  it('fonts 未 ready → 不建立 renderer；ready 後才建立一次', async () => {
    vi.useFakeTimers()
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    setFonts({ load: vi.fn(() => ready), ready, status: 'loading', addEventListener: vi.fn(), removeEventListener: vi.fn() })

    render(wrap(<TerminalView session={session} settings={settings()} active />))
    await flush()
    expect(state.created).toBe(0)

    resolveReady?.()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(state.created).toBe(1)
    vi.useRealTimers()
  })

  it('renderer 因逾時先用 fallback 建立，字型晚到只 refresh atlas 一次', async () => {
    vi.useFakeTimers()
    const listeners: Array<() => void> = []
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    setFonts({
      load: vi.fn(() => new Promise(() => undefined)),
      ready,
      status: 'loading',
      addEventListener: vi.fn((_type: string, cb: () => void) => listeners.push(cb)),
      removeEventListener: vi.fn()
    })

    render(wrap(<TerminalView session={session} settings={settings()} active />))
    await flush()
    expect(state.created).toBe(0)

    await vi.advanceTimersByTimeAsync(1_600)
    await flush()
    expect(state.created).toBe(1)
    expect(state.atlasCleared).toBe(0)

    resolveReady?.()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(state.atlasCleared).toBe(1)

    for (const listener of listeners) listener()
    await flush()
    expect(state.atlasCleared).toBe(1)
    vi.useRealTimers()
  })

  it('字型即時切換：更新 options 並清 atlas', async () => {
    setFonts({ load: vi.fn(() => Promise.resolve()), ready: Promise.resolve(), status: 'loaded', addEventListener: vi.fn(), removeEventListener: vi.fn() })

    const { rerender } = render(wrap(<TerminalView session={session} settings={settings(11)} active />))
    await waitFor(() => expect(state.created).toBe(1))

    rerender(wrap(<TerminalView session={session} settings={settings(16)} active />))
    await waitFor(() => expect(state.options[0]?.['fontSize']).toBe(16))
    expect(state.atlasCleared).toBeGreaterThanOrEqual(1)
  })

  it('WebGL 建立失敗 → fallback 到 DOM renderer，Terminal 仍建立且不拋錯', async () => {
    state.webglFails = true
    setFonts({ load: vi.fn(() => Promise.resolve()), ready: Promise.resolve(), status: 'loaded', addEventListener: vi.fn(), removeEventListener: vi.fn() })

    expect(() => render(wrap(<TerminalView session={session} settings={settings()} active />))).not.toThrow()
    await waitFor(() => expect(state.created).toBe(1))
    expect(state.options[0]?.['fontFamily']).toBe('Cascadia Mono')
  })
})
