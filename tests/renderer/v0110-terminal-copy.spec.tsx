import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { AppSettings, SessionInfo } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { TerminalView } from '../../src/renderer/features/terminal/TerminalView'

/* v0.1.10 #2 終端複製／貼上：xterm mock 需能捕捉 onData / customKeyHandler / 選取 / paste */
interface XtermMock {
  selection: string
  onDataCb: ((data: string) => void) | null
  customKey: ((ev: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string; type?: string; preventDefault?: () => void }) => boolean) | null
  paste(text: string): void
}

const xt = vi.hoisted(() => ({
  last: null as XtermMock | null,
  pasted: [] as string[]
}))

vi.mock('@xterm/xterm', () => {
  class TerminalMock {
    cols = 120
    rows = 30
    options: Record<string, unknown> = {}
    selection = ''
    onDataCb: ((data: string) => void) | null = null
    customKey: ((ev: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string; type?: string; preventDefault?: () => void }) => boolean) | null = null
    constructor() {
      xt.last = this as unknown as XtermMock
    }
    loadAddon(): void { /* noop */ }
    open(): void { /* noop */ }
    dispose(): void { /* noop */ }
    write(): void { /* noop */ }
    focus(): void { /* noop */ }
    refresh(): void { /* noop */ }
    onData(cb: (data: string) => void): { dispose(): void } {
      this.onDataCb = cb
      return { dispose: () => undefined }
    }
    attachCustomKeyEventHandler(h: (ev: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string; type?: string; preventDefault?: () => void }) => boolean): void {
      this.customKey = h
    }
    hasSelection(): boolean {
      return this.selection.length > 0
    }
    getSelection(): string {
      return this.selection
    }
    paste(text: string): void {
      xt.pasted.push(text)
    }
  }
  return { Terminal: TerminalMock }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void { /* noop */ } } }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void { /* noop */ }
    dispose(): void { /* noop */ }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

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

const clip = { readText: vi.fn(), writeText: vi.fn() }
let write: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void { /* noop */ }
      unobserve(): void { /* noop */ }
      disconnect(): void { /* noop */ }
    }
  )
  xt.last = null
  xt.pasted.length = 0
  clip.readText.mockReset()
  clip.writeText.mockReset()
  clip.readText.mockResolvedValue('L1\nL2-中文-ABC')
  clip.writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { readText: clip.readText, writeText: clip.writeText },
    configurable: true
  })
  write = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  Object.defineProperty(window, 'rs', {
    configurable: true,
    value: {
      session: {
        onData: vi.fn().mockReturnValue(() => undefined),
        snapshot: vi.fn().mockResolvedValue({ ok: true, data: { bytes: new Uint8Array() } }),
        write,
        resize: vi.fn().mockResolvedValue({ ok: true, data: undefined })
      }
    }
  })
})

afterEach(() => {
  cleanup()
})

const renderTerminal = (): void => {
  render(wrap(<TerminalView session={session} settings={settings} active />))
}

const term = (): XtermMock => {
  expect(xt.last).toBeTruthy()
  return xt.last as XtermMock
}

describe('v0.1.10 #2 Ctrl+C（PM 裁決：選取→複製不送 SIGINT；無選取→照常中斷）', () => {
  it('有選取：複製到剪貼簿、不送 \\x03、選取保留', async () => {
    renderTerminal()
    term().selection = 'SELECTED 多行文字'
    term().onDataCb?.('\x03')

    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith('SELECTED 多行文字'))
    // 不送 SIGINT（PM 指定驗收格）
    expect(write).not.toHaveBeenCalled()
    // 複製後保留選取
    expect(term().selection).toBe('SELECTED 多行文字')
  })

  it('無選取：照常送 \\x03（使用者中斷習慣不能壞）', () => {
    renderTerminal()
    term().selection = ''
    term().onDataCb?.('\x03')
    expect(write).toHaveBeenCalledWith('s1', '\x03')
    expect(clip.writeText).not.toHaveBeenCalled()
  })

  it('PM 裁決（key 層攔截）：Ctrl+C 有選取 → customKey 回 false＋preventDefault、不送資料', async () => {
    // 攔截點在 customKeyEventHandler（xterm onUserInput 會在 triggerDataEvent 清選取 —— 實機實證）
    renderTerminal()
    term().selection = 'SELECTED'
    const ev = { type: 'keydown', ctrlKey: true, altKey: false, shiftKey: false, key: 'c', preventDefault: vi.fn() }
    const handled = term().customKey?.(ev)
    expect(handled).toBe(false)
    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith('SELECTED'))
    expect(write).not.toHaveBeenCalled()
    expect(term().selection).toBe('SELECTED')
  })
})

describe('v0.1.10 #2 Ctrl+V 與貼上', () => {
  it('Ctrl+V 被攔下（回 false）→ 讀剪貼簿 → term.paste 原文（多行/CJK；\\n→\\r 與 bracketed paste 由 xterm.paste 負責）', async () => {
    renderTerminal()
    const handled = term().customKey?.({ type: 'keydown', ctrlKey: true, altKey: false, shiftKey: false, key: 'v', preventDefault: vi.fn() })
    expect(handled).toBe(false)
    await waitFor(() => expect(clip.readText).toHaveBeenCalled())
    await waitFor(() => expect(xt.pasted).toContain('L1\nL2-中文-ABC'))
    // 沒有走 session.write 原始貼上
    expect(write).not.toHaveBeenCalled()
  })

  it('剪貼簿讀取失敗 → toast 顯示、不 crash、不送資料', async () => {
    renderTerminal()
    clip.readText.mockRejectedValue(new Error('denied'))
    term().customKey?.({ type: 'keydown', ctrlKey: true, altKey: false, shiftKey: false, key: 'v', preventDefault: vi.fn() })
    expect(await screen.findByText('Clipboard access denied')).toBeTruthy()
    expect(write).not.toHaveBeenCalled()
    expect(xt.pasted).toHaveLength(0)
  })

  it('keyup 不重貼（xterm keyup 也進 customKeyHandler —— 實機截圖實證的重複貼上回歸）', () => {
    renderTerminal()
    const ev = { type: 'keyup', ctrlKey: true, altKey: false, shiftKey: false, key: 'v', preventDefault: vi.fn() }
    const handled = term().customKey?.(ev)
    expect(handled).toBe(true) // 放開：不攔、不貼
    expect(ev.preventDefault).not.toHaveBeenCalled()
    expect(xt.pasted).toHaveLength(0)
  })
})

describe('v0.1.10 #2 右鍵選單（複製/貼上）', () => {
  it('無選取：Copy 停用、Paste 可用；有選取：Copy 可用', () => {
    renderTerminal()
    const pane = document.querySelector('[data-session-id="s1"]') as HTMLElement

    fireEvent.contextMenu(pane, { clientX: 40, clientY: 40 })
    const copy1 = screen.getByRole('menuitem', { name: 'Copy' }) as HTMLButtonElement
    expect(copy1.disabled).toBe(true)
    expect((screen.getByRole('menuitem', { name: 'Paste' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    term().selection = 'SELECTED'
    fireEvent.contextMenu(pane, { clientX: 40, clientY: 40 })
    const copy2 = screen.getByRole('menuitem', { name: 'Copy' }) as HTMLButtonElement
    expect(copy2.disabled).toBe(false)
  })

  it('選單 Copy → 寫入剪貼簿（保留選取）；選單 Paste → term.paste', async () => {
    renderTerminal()
    const pane = document.querySelector('[data-session-id="s1"]') as HTMLElement
    term().selection = 'SELECTED'

    fireEvent.contextMenu(pane, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    await waitFor(() => expect(clip.writeText).toHaveBeenCalledWith('SELECTED'))
    expect(term().selection).toBe('SELECTED')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(pane, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paste' }))
    await waitFor(() => expect(xt.pasted).toContain('L1\nL2-中文-ABC'))
  })
})
