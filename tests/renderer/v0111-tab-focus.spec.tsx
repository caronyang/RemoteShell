import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { MainWindow } from '../../src/renderer/features/layout/MainWindow'
import type { AppSettings, ConnectionProfile, SessionInfo } from '../../src/shared/ipc-contract'

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

afterEach(() => cleanup())

const settings: AppSettings = {
  schemaVersion: 1,
  locale: 'en-US',
  general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete: true },
  terminal: { fontFamily: 'Cascadia Mono', fontSize: 11, themeId: 'dark', scrollback: 10000, cursorStyle: 'block', cursorBlink: true, ambiguousWidth: 'narrow' },
  transfer: { maxConcurrent: 3, downloadDir: 'C:\\dl', afterDownload: 'notify', onConflict: 'ask', retryCount: 0 },
  ui: { sidebarWidth: 260, queueHeight: 200, queueCollapsed: true, sidebarCollapsed: false }
}

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'alpha',
  groupId: null,
  protocol: 'ssh',
  host: '10.0.0.1',
  port: 22,
  auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id' },
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}

const session: SessionInfo = { sessionId: 's1', profileId: 'p1', protocol: 'ssh', state: 'connected', phase: 'ready', host: '10.0.0.1', port: 22, cols: 120, rows: 30 }

function stubRs() {
  Object.defineProperty(window, 'rs', {
    configurable: true,
    value: {
      connections: { list: vi.fn().mockResolvedValue({ ok: true, data: { profiles: [profile], groups: [] } }), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
      groups: { create: vi.fn() },
      vault: { setSecret: vi.fn(), clearSecret: vi.fn(), inspectKeyFile: vi.fn() },
      session: {
        onState: vi.fn().mockReturnValue(() => undefined),
        open: vi.fn().mockResolvedValue({ ok: true, data: session }),
        close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        reconnect: vi.fn(),
        write: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        resize: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        snapshot: vi.fn().mockResolvedValue({ ok: true, data: { bytes: new Uint8Array() } }),
        onData: vi.fn().mockReturnValue(() => undefined)
      },
      transfer: { onUpdate: vi.fn().mockReturnValue(() => undefined), list: vi.fn().mockResolvedValue({ ok: true, data: [] }), plan: vi.fn(), start: vi.fn() },
      localFs: {
        home: vi.fn().mockResolvedValue({ ok: true, data: 'C:\\Users\\demo\\' }),
        list: vi.fn().mockResolvedValue({ ok: true, data: { path: 'C:\\Users\\demo\\', entries: [], drives: ['C:\\'] } })
      },
      sftp: {
        open: vi.fn().mockResolvedValue({ ok: true, data: { sftpId: 'sf1', home: '/home/u/' } }),
        close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        list: vi.fn().mockResolvedValue({ ok: true, data: { path: '/home/u/', entries: [] } }),
        mkdir: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn()
      },
      settings: { reset: vi.fn() },
      window: { close: vi.fn() }
    }
  })
}

describe('v0.1.11 #1：混合分頁關閉不得黑屏（MainWindow 原案例）', () => {
  it('1 console＋1 SFTP，關 SFTP → 終端仍掛載、無空狀態', async () => {
    stubRs()
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      })
    })
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-tab').length).toBe(1))

    const sftpButton = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'SFTP') as HTMLButtonElement
    fireEvent.click(sftpButton)
    await waitFor(() => expect(document.querySelectorAll('.rs-tab').length).toBe(2))
    await waitFor(() => expect(document.querySelector('.rs-sftp')).toBeTruthy())

    /* 第二個分頁是 SFTP 孿生；按它的關閉鈕 */
    const sftpTab = document.querySelectorAll('.rs-tab')[1] as HTMLElement
    fireEvent.click(sftpTab.querySelector('.rs-tab__close') as HTMLElement)

    await waitFor(() => expect(document.querySelectorAll('.rs-tab').length).toBe(1))
    expect(document.querySelectorAll('.rs-terminal__empty').length).toBe(0)
    expect(document.querySelector('.rs-tab.is-active')).toBeTruthy()
    const view = document.querySelector('[data-session-id="s1"]') as HTMLElement | null
    expect(view).toBeTruthy()
    expect(view?.style.display).not.toBe('none')
  })
})
