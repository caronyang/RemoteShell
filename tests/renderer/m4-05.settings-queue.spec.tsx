import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { AppSettings, TransferTask } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { SettingsDialog } from '../../src/renderer/features/settings/SettingsDialog'
import { QueuePanel } from '../../src/renderer/features/queue/QueuePanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => (
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

const task = (taskId: string, state: TransferTask['state']): TransferTask => ({
  taskId,
  sessionId: 's1',
  connectionLabel: 'prod-web-01',
  direction: 'upload',
  source: `C:\\src\\${taskId}`,
  target: `/var/www/${taskId}`,
  isDirectory: false,
  totalBytes: 100,
  transferredBytes: state === 'completed' ? 100 : 50,
  bytesPerSec: 1024,
  etaSec: 1,
  state,
  attempts: 1,
  createdAt: '2026-10-30T00:00:00Z'
})

describe('M4-05 SettingsDialog（語系即時切換 + 還原預設值）', () => {
  it('選繁體中文呼叫 patch({locale})', () => {
    const onPatch = vi.fn()
    render(wrap(<SettingsDialog open settings={settings} info={null} onPatch={onPatch} onClose={() => undefined} />))
    fireEvent.click(screen.getByText('Language'))
    fireEvent.click(screen.getByLabelText('Traditional Chinese'))
    expect(onPatch).toHaveBeenCalledWith({ locale: 'zh-TW' })
  })

  it('還原預設值走 ConfirmDialog：取消不呼叫 reset、確認才呼叫', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, data: settings })
    Object.defineProperty(window, 'rs', {
      value: { settings: { reset } },
      configurable: true
    })

    render(wrap(<SettingsDialog open settings={settings} info={null} onPatch={() => undefined} onClose={() => undefined} />))
    fireEvent.click(screen.getByText('Restore defaults'))
    const dialog = (await screen.findByText(/Reset all settings to their defaults/)).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(reset).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Restore defaults'))
    const dialog2 = (await screen.findByText(/Reset all settings to their defaults/)).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Restore defaults' }))
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1))
  })

  it('pickDirectory：選到路徑會 patch downloadDir；取消（null）不覆寫', async () => {
    const onPatch = vi.fn()
    const pickDirectory = vi.fn().mockResolvedValue({ ok: true, data: 'D:\\Downloads\\RS' })
    Object.defineProperty(window, 'rs', { value: { app: { pickDirectory } }, configurable: true })

    render(wrap(<SettingsDialog open settings={settings} info={null} onPatch={onPatch} onClose={() => undefined} />))
    fireEvent.click(screen.getByText('Transfer'))
    fireEvent.click(screen.getByTitle('Browse...'))
    await vi.waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith({ transfer: { downloadDir: 'D:\\Downloads\\RS' } })
    )

    // 取消：回 null，不得覆寫原值
    onPatch.mockClear()
    pickDirectory.mockResolvedValueOnce({ ok: true, data: null })
    fireEvent.click(screen.getByTitle('Browse...'))
    await vi.waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(2))
    expect(onPatch).not.toHaveBeenCalled()
  })
})

describe('M4-05 QueuePanel（徽章 + aria-expanded）', () => {
  it('徽章顯示進行中數量（running+queued），完成項不計', () => {
    const tasks = [task('t1', 'running'), task('t2', 'queued'), task('t3', 'completed')]
    render(wrap(<QueuePanel collapsed height={200} tasks={tasks} onToggle={() => undefined} onHeightChange={() => undefined} onRequest={() => undefined} onClearCompleted={() => undefined} />))
    const badge = screen.getByLabelText('2 running')
    expect(badge.textContent).toBe('2')
  })

  it('收合/展開切換 aria-expanded 並呼叫 onToggle', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      wrap(<QueuePanel collapsed height={200} tasks={[]} onToggle={onToggle} onHeightChange={() => undefined} onRequest={() => undefined} onClearCompleted={() => undefined} />)
    )
    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(
      wrap(<QueuePanel collapsed={false} height={200} tasks={[]} onToggle={onToggle} onHeightChange={() => undefined} onRequest={() => undefined} onClearCompleted={() => undefined} />)
    )
    expect(screen.getByRole('button', { expanded: true }).getAttribute('aria-expanded')).toBe('true')
  })
})
