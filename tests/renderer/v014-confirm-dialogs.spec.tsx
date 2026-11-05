import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { AppSettings, SftpEntry, TransferTask } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { Modal } from '../../src/renderer/components/Modal'
import { QueuePanel } from '../../src/renderer/features/queue/QueuePanel'
import { SettingsDialog } from '../../src/renderer/features/settings/SettingsDialog'
import { DualPane } from '../../src/renderer/features/sftp/DualPane'
import { ConnectionTree } from '../../src/renderer/features/connections/ConnectionTree'

const i18n = initI18n('en-US')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

const makeSettings = (): AppSettings => ({
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
  transfer: { maxConcurrent: 3, downloadDir: 'C:\\dl', afterDownload: 'notify', onConflict: 'ask', retryCount: 0 },
  ui: {
    sidebarWidth: 260,
    queueHeight: 200,
    queueCollapsed: true,
    sidebarCollapsed: false,
    sftpColumns: { name: 240, permissions: 110, mtime: 150, size: 100 }
  }
})

const makeTask = (over: Partial<TransferTask> = {}): TransferTask => ({
  taskId: 't1',
  sessionId: 's1',
  connectionLabel: 'demo',
  direction: 'upload',
  source: 'C:\\a.bin',
  target: '/a.bin',
  isDirectory: false,
  totalBytes: 100,
  transferredBytes: 10,
  bytesPerSec: 1,
  etaSec: 90,
  state: 'running',
  attempts: 0,
  createdAt: new Date().toISOString(),
  ...over
})

/* ---------- QueuePanel：Clear all ---------- */

describe('v0.1.4：Clear all 走 ConfirmDialog', () => {
  it('取消不送 cancel/remove；確認才送', async () => {
    const onRequest = vi.fn()
    const task = makeTask()
    render(
      wrap(
        <QueuePanel
          collapsed={false}
          height={200}
          onToggle={() => undefined}
          onHeightChange={() => undefined}
          tasks={[task]}
          onRequest={onRequest}
          onClearCompleted={() => undefined}
        />
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    const confirmDialog = (await screen.findByText('Clear all transfers')).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }))
    expect(onRequest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    const dialog = (await screen.findByText('Clear all transfers')).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(onRequest).toHaveBeenCalledWith('cancel', task))
    expect(onRequest).toHaveBeenCalledWith('remove', task)
  })
})

/* ---------- SettingsDialog：Restore defaults ---------- */

describe('v0.1.4：Restore defaults 走 ConfirmDialog', () => {
  it('取消不呼叫 settings.reset；確認才呼叫', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, data: makeSettings() })
    Object.defineProperty(window, 'rs', { value: { settings: { reset } }, configurable: true })

    render(wrap(<SettingsDialog open settings={makeSettings()} info={null} onPatch={() => undefined} onClose={() => undefined} />))

    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    expect(await screen.findByText(/Reset all settings to their defaults/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(reset).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }))
    const dialog = (await screen.findByText(/Reset all settings to their defaults/)).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore defaults' }))
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1))
  })
})

/* ---------- DualPane：刪除 ---------- */

describe('v0.1.4：SFTP 刪除走 ConfirmDialog', () => {
  it('取消不呼叫 sftp.remove；確認才呼叫', async () => {
    const entries: SftpEntry[] = [
      { name: 'backup.sql', path: '/home/u/backup.sql', type: 'file', size: 10, mtimeMs: 0, isSymlink: false }
    ]
    const localEntries: SftpEntry[] = [
      { name: 'local.txt', path: 'C:\\tmp\\local.txt', type: 'file', size: 5, mtimeMs: 0, isSymlink: false }
    ]
    const rs = {
      localFs: {
        home: vi.fn().mockResolvedValue({ ok: true, data: 'C:\\tmp' }),
        list: vi.fn().mockResolvedValue({ ok: true, data: { path: 'C:\\tmp', entries: localEntries, drives: ['C:\\'] } }),
        mkdir: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn().mockResolvedValue({ ok: true, data: undefined })
      },
      sftp: {
        open: vi.fn().mockResolvedValue({ ok: true, data: { sftpId: 'sf1', home: '/home/u' } }),
        close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        list: vi.fn().mockResolvedValue({ ok: true, data: { path: '/home/u', entries } }),
        mkdir: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn().mockResolvedValue({ ok: true, data: undefined })
      },
      transfer: { plan: vi.fn(), start: vi.fn() }
    }
    Object.defineProperty(window, 'rs', { value: rs, configurable: true })

    render(
      wrap(
        <DualPane
          session={{ sessionId: 's1', profileId: 'p1', protocol: 'ssh', state: 'connected', phase: 'ready', host: 'h', port: 22, cols: 120, rows: 30 }}
          onClose={() => undefined}
        />
      )
    )

    fireEvent.click(await screen.findByText('backup.sql'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete 1 items?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(rs.sftp.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('backup.sql'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = (await screen.findByText('Delete 1 items?')).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(rs.sftp.remove).toHaveBeenCalledWith('sf1', '/home/u/backup.sql', false))
  })
})

/* ---------- ConnectionTree：F2 改名／Delete ---------- */

const stubConnections = (): { update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } => {
  const profile = {
    id: 'p1',
    name: 'alpha',
    groupId: null,
    protocol: 'ssh' as const,
    host: '10.0.0.1',
    port: 22,
    auth: { method: 'password' as const, username: 'u', secret: { kind: 'none' as const } },
    jump: { enabled: false, connectionIds: [] },
    terminal: {},
    tags: [],
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }
  const update = vi.fn().mockResolvedValue({ ok: true, data: profile })
  const remove = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  Object.defineProperty(window, 'rs', {
    value: {
      connections: {
        list: vi.fn().mockResolvedValue({ ok: true, data: { profiles: [profile], groups: [] } }),
        update,
        remove,
        create: vi.fn()
      },
      groups: { update: vi.fn() }
    },
    configurable: true
  })
  return { update, remove }
}

describe('v0.1.4：ConnectionTree 的 F2／Delete 不用原生對話框', () => {
  it('F2 改名：取消不更新；確認才更新', async () => {
    const { update } = stubConnections()
    render(wrap(<ConnectionTree />))
    await screen.findByText('alpha')

    fireEvent.click(screen.getByText('alpha'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' })
    const dialog = screen.getByRole('dialog') as HTMLElement
    expect((within(dialog).getByLabelText('Rename') as HTMLInputElement).value).toBe('alpha')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('alpha'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' })
    const dialog2 = screen.getByRole('dialog') as HTMLElement
    fireEvent.change(within(dialog2).getByLabelText('Rename'), { target: { value: 'beta' } })
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('p1', { name: 'beta' }))
  })

  it('Delete：取消不刪除；確認才刪除', async () => {
    const { remove } = stubConnections()
    render(wrap(<ConnectionTree />))
    await screen.findByText('alpha')

    fireEvent.click(screen.getByText('alpha'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    const dialog = screen.getByText('Delete this connection? This cannot be undone.').closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('alpha'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    const dialog2 = screen.getByText('Delete this connection? This cannot be undone.').closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('p1'))
  })
})

/* ---------- 巢狀 Modal：Esc 只關最上層 ---------- */

function TwoModals(): JSX.Element {
  const [mainOpen, setMainOpen] = useState(true)
  const [topOpen, setTopOpen] = useState(true)
  return (
    <>
      <Modal open={mainOpen} title="Main dialog" onClose={() => setMainOpen(false)}>
        <p>main-body</p>
      </Modal>
      <Modal open={topOpen} title="Top dialog" onClose={() => setTopOpen(false)}>
        <p>top-body</p>
      </Modal>
    </>
  )
}

describe('v0.1.4：巢狀 Modal 的 Esc 只關最上層', () => {
  it('第一次 Esc 關確認框、主框仍在；第二次才關主框', () => {
    render(wrap(<TwoModals />))
    expect(screen.getByText('main-body')).toBeTruthy()
    expect(screen.getByText('top-body')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('top-body')).toBeNull()
    expect(screen.getByText('main-body')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('main-body')).toBeNull()
  })
})
