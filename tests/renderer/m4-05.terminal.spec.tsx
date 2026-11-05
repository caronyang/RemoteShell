import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { AppSettings, SessionInfo } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { TerminalView } from '../../src/renderer/features/terminal/TerminalView'

const xtermState = vi.hoisted(() => ({ created: 0 }))

vi.mock('@xterm/xterm', () => {
  class TerminalMock {
    cols = 120
    rows = 30
    options: Record<string, unknown> = {}
    constructor() {
      xtermState.created += 1
    }
    loadAddon(): void {
      /* noop */
    }
    open(): void {
      /* noop */
    }
    dispose(): void {
      /* noop */
    }
    write(): void {
      /* noop */
    }
    focus(): void {
      /* noop */
    }
    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    /* v0.1.10 #2：useTerminal 新呼叫（剪貼簿攔截） */
    attachCustomKeyEventHandler(): void {
      /* noop */
    }
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    paste(): void {
      /* noop */
    }
  }
  return { Terminal: TerminalMock }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      /* noop */
    }
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {
      /* noop */
    }
    dispose(): void {
      /* noop */
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {}
}))

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  xtermState.created = 0
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
  class ResizeObserverMock {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
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

const settings: AppSettings = {
  schemaVersion: 1,
  locale: 'en-US',
  general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete: true },
  terminal: {
    fontFamily: 'Cascadia Mono',
    fontSize: 11,
    themeId: 'dark',
    scrollback: 10000,
    cursorStyle: 'block',
    cursorBlink: true,
    ambiguousWidth: 'narrow'
  },
  transfer: { maxConcurrent: 3, downloadDir: 'C:\\Downloads', afterDownload: 'notify', onConflict: 'ask', retryCount: 0 },
  ui: { sidebarWidth: 260, queueHeight: 200, queueCollapsed: true, sidebarCollapsed: false }
}

const i18n = initI18n('en-US')
/* useTerminal 內含剪貼簿失敗 toast → 需 ToastProvider（useToast 無 provider 會 throw） */
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

describe('M4-05 TerminalView（keep-alive：非 active 不重建 xterm）', () => {
  it('active 切換只改顯示；xterm 實例不重建', () => {
    const { rerender } = render(wrap(<TerminalView session={session} settings={settings} active />))
    expect(xtermState.created).toBe(1)
    const pane = document.querySelector('[data-session-id="s1"]') as HTMLElement
    expect(pane).toBeTruthy()
    expect(pane.style.display).toBe('block')

    rerender(wrap(<TerminalView session={session} settings={settings} active={false} />))
    expect(pane.style.display).toBe('none')
    expect(document.querySelector('[data-session-id="s1"]')).toBe(pane)
    expect(xtermState.created).toBe(1)

    rerender(wrap(<TerminalView session={session} settings={settings} active />))
    expect(pane.style.display).toBe('block')
    expect(xtermState.created).toBe(1)
  })
})
