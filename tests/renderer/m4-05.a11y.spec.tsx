import { useState } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider, useToast } from '../../src/renderer/components/Toast'
import { Modal } from '../../src/renderer/components/Modal'
import { SettingsDialog } from '../../src/renderer/features/settings/SettingsDialog'
import { ConflictDialog } from '../../src/renderer/features/sftp/ConflictDialog'
import { ConnectionDialog } from '../../src/renderer/features/connections/ConnectionDialog'
import type { AppSettings, ConnectionProfile } from '../../src/shared/ipc-contract'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const i18n = initI18n('en-US')
const wrap = (ui: React.ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

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

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'alpha',
  groupId: null,
  protocol: 'ssh',
  host: '10.0.0.1',
  port: 22,
  auth: { method: 'password', username: 'u', secret: { kind: 'none' } },
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}

/** 可開關對話框的宿主：模擬「從 trigger 開啟、關閉後焦點回歸」 */
function ModalHost(): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      <Modal open={open} title="Confirm" onClose={() => setOpen(false)}>
        <input aria-label="first" />
      </Modal>
    </>
  )
}

function ConflictHost(): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      <ConflictDialog
        open={open}
        items={[{ baseKey: '/a', displayName: 'a.txt', existingSize: 1 }]}
        onResolve={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  )
}

function ConnectionDialogHost(): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      <ConnectionDialog
        open={open}
        connection={profile}
        groups={[]}
        profiles={[]}
        onClose={() => setOpen(false)}
        onSaved={() => setOpen(false)}
      />
    </>
  )
}
describe('M4-05 焦點回歸（關閉後回開啟元素）', () => {
  it('Modal 關閉後焦點回到觸發按鈕', () => {
    render(wrap(<ModalHost />))
    const trigger = screen.getByText('open')
    trigger.focus()
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(screen.getByLabelText('first'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('ConflictDialog 取消後焦點回到觸發按鈕', () => {
    render(wrap(<ConflictHost />))
    const trigger = screen.getByText('open')
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('M4-05 Esc 關閉（未儲存變更走確認）', () => {
  it('ConnectionDialog 乾淨狀態 Esc 直接關閉；變更後 Esc 開 App 內 ConfirmDialog（原生 confirm 全程禁用）', () => {
    // P0 #2/#3：window.confirm 在 Electron 是原生同步對話框（阻塞 renderer）→ 永不呼叫
    const confirm = vi.fn().mockReturnValue(true)
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true })
    render(wrap(<ConnectionDialogHost />))
    const trigger = screen.getByText('open')
    fireEvent.click(trigger)

    // 乾淨狀態：Esc 直接關閉、不詢問
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()

    // 有變更：Esc → App 內未儲存確認（主對話框 + 確認框同時存在）
    fireEvent.click(trigger)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'beta' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(screen.getAllByRole('dialog')).toHaveLength(2)

    // 選 Discard → 兩個對話框都關
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('M4-05 Tab 循環（SettingsDialog 完整 focus trap）', () => {
  it('Tab 到最後一個可聚焦元素回第一個；Shift+Tab 反向', () => {
    render(wrap(<SettingsDialog open settings={settings} info={null} onPatch={() => undefined} onClose={() => undefined} />))
    const dialog = screen.getByRole('dialog')
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    )
    expect(focusables.length).toBeGreaterThan(2)
    const first = focusables[0] as HTMLElement
    const last = focusables[focusables.length - 1] as HTMLElement

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

describe('M4-05 Toast aria-live', () => {
  function ToastHost(): JSX.Element {
    const toast = useToast()
    return (
      <>
        <button type="button" onClick={() => toast.show('saved', 'success')}>info</button>
        <button type="button" onClick={() => toast.show('boom', 'error')}>error</button>
      </>
    )
  }

  it('容器為 role=status/aria-live=polite；錯誤 Toast 為 role=alert', () => {
    render(wrap(<ToastHost />))
    const container = screen.getByRole('status')
    expect(container.getAttribute('aria-live')).toBe('polite')

    fireEvent.click(screen.getByText('info'))
    expect(screen.getByText('saved').closest('.rs-toast')?.getAttribute('role')).toBeNull()

    fireEvent.click(screen.getByText('error'))
    expect(screen.getByText('boom').closest('.rs-toast')?.getAttribute('role')).toBe('alert')
  })
})

describe('M4-05 tokens 對比（WCAG 4.5:1）', () => {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const luminance = (hex: string): number =>
    0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * channel(parseInt(hex.slice(5, 7), 16))
  const contrast = (a: string, b: string): number => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
    const hi = values[0] ?? 0
    const lo = values[1] ?? 0
    return (hi + 0.05) / (lo + 0.05)
  }

  it('主文字組合 ≥ 4.5:1（含 --text-secondary on --surface-subtle，色票修正後全數通過）', () => {
    const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles', 'tokens.css'), 'utf8')
    const token = (name: string): string => {
      const match = css.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))
      expect(match).toBeTruthy()
      return (match as RegExpMatchArray)[1] as string
    }
    expect(contrast(token('--text'), token('--surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('--text-secondary'), token('--surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('--text-secondary'), token('--surface-subtle'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('--terminal-fg'), token('--terminal-bg'))).toBeGreaterThanOrEqual(4.5)
  })
})
