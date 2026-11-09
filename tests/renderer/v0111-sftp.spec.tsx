import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { DualPane } from '../../src/renderer/features/sftp/DualPane'
import type { SessionInfo, SftpEntry } from '../../src/shared/ipc-contract'

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

const session: SessionInfo = { sessionId: 's1', profileId: 'p1', protocol: 'ssh', state: 'connected', phase: 'ready', host: '10.0.0.1', port: 22, cols: 120, rows: 30 }
const entry = (name: string, path: string): SftpEntry => ({ name, path, type: 'file', size: 1, mtimeMs: 1, isSymlink: false })
const folder = (name: string, path: string): SftpEntry => ({ ...entry(name, path), type: 'dir' })

let rs: {
  localFs: { home: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }
  sftp: { open: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  transfer: { plan: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; onUpdate: ReturnType<typeof vi.fn> }
}
let emitTransfer: ((batch: unknown[]) => void) | null = null

beforeEach(() => {
  rs = {
    localFs: {
      home: vi.fn().mockResolvedValue({ ok: true, data: 'C:\\Users\\demo\\' }),
      list: vi.fn().mockImplementation((path: string) =>
        Promise.resolve({ ok: true, data: { path, entries: [entry('l.txt', 'C:\\Users\\demo\\l.txt')], drives: ['C:\\'] } })
      )
    },
    sftp: {
      open: vi.fn().mockResolvedValue({ ok: true, data: { sftpId: 'sf1', home: '/home/u/' } }),
      list: vi.fn().mockImplementation((_id: string, path: string) =>
        Promise.resolve({ ok: true, data: { path, entries: [entry('r.txt', '/home/u/r.txt')] } })
      ),
      close: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    },
    transfer: {
      onUpdate: vi.fn().mockImplementation((cb: (batch: unknown[]) => void) => {
        emitTransfer = cb
        return () => undefined
      }),
      plan: vi.fn().mockResolvedValue({ ok: true, data: { items: [], skipped: [] } }),
      start: vi.fn().mockResolvedValue({ ok: true, data: [] })
    }
  }
  Object.defineProperty(window, 'rs', {
    configurable: true,
    value: {
      localFs: rs.localFs,
      sftp: { ...rs.sftp, mkdir: vi.fn(), rename: vi.fn(), remove: vi.fn() },
      transfer: rs.transfer
    }
  })
})

afterEach(() => cleanup())

describe('v0.1.11 #2：刷新路由只打一側', () => {
  it('本機刷新只呼叫 localFs.list；遠端刷新只呼叫 sftp.list', async () => {
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await waitFor(() => expect(rs.localFs.list).toHaveBeenCalled())
    await waitFor(() => expect(rs.sftp.list).toHaveBeenCalled())

    const localBefore = rs.localFs.list.mock.calls.length
    const remoteBefore = rs.sftp.list.mock.calls.length

    fireEvent.click(screen.getByLabelText('Refresh local files'))
    await waitFor(() => expect(rs.localFs.list.mock.calls.length).toBe(localBefore + 1))
    expect(rs.sftp.list.mock.calls.length).toBe(remoteBefore)

    const localAfter = rs.localFs.list.mock.calls.length
    const remoteAfter = rs.sftp.list.mock.calls.length
    fireEvent.click(screen.getByLabelText('Refresh remote files'))
    await waitFor(() => expect(rs.sftp.list.mock.calls.length).toBe(remoteAfter + 1))
    expect(rs.localFs.list.mock.calls.length).toBe(localAfter)
  })

  it('工具列刷新依 focusedPane 路由：預設遠端，點本機後改本機', async () => {
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await waitFor(() => expect(rs.sftp.list).toHaveBeenCalled())
    const toolbarRefresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    let localCount = rs.localFs.list.mock.calls.length
    let remoteCount = rs.sftp.list.mock.calls.length
    toolbarRefresh()
    await waitFor(() => expect(rs.sftp.list.mock.calls.length).toBe(remoteCount + 1))
    expect(rs.localFs.list.mock.calls.length).toBe(localCount)

    fireEvent.contextMenu(document.querySelector('.rs-sftp__dropzone[data-kind="local"]') as HTMLElement)
    fireEvent.mouseDown(document.querySelector('.rs-sftp__mask') as HTMLElement)
    localCount = rs.localFs.list.mock.calls.length
    remoteCount = rs.sftp.list.mock.calls.length
    toolbarRefresh()
    await waitFor(() => expect(rs.localFs.list.mock.calls.length).toBe(localCount + 1))
    expect(rs.sftp.list.mock.calls.length).toBe(remoteCount)
  })
})

describe('v0.1.11 #5：空白區右鍵與內部剪貼簿', () => {
  const menuItems = (): HTMLButtonElement[] => [...document.querySelectorAll('.rs-sftp__ctxmenu [role="menuitem"]')] as HTMLButtonElement[]
  const item = (text: string): HTMLButtonElement => menuItems().find((b) => (b.textContent || '').trim() === text) as HTMLButtonElement

  it('列右鍵＝完整選單（含複製）；空白右鍵＝目錄級可用、檔案相關 disabled', async () => {
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0))

    fireEvent.contextMenu(document.querySelector('tbody tr') as HTMLElement)
    const rowItems = menuItems().map((b) => (b.textContent || '').trim())
    expect(rowItems).toContain('Copy')
    expect(rowItems).toContain('Upload')
    expect(rowItems).not.toContain('Paste')

    fireEvent.mouseDown(document.querySelector('.rs-sftp__mask') as HTMLElement)

    const localZone = document.querySelector('.rs-sftp__dropzone[data-kind="local"]') as HTMLElement
    fireEvent.contextMenu(localZone)
    expect(item('New folder').disabled).toBe(false)
    expect(item('Refresh').disabled).toBe(false)
    expect(item('Show hidden files').disabled).toBe(false)
    for (const label of ['Upload', 'Download', 'Rename', 'Copy', 'Copy path', 'Delete', 'Properties']) {
      expect(item(label).disabled).toBe(true)
    }
    expect(item('Paste').disabled).toBe(true)
  })

  it('複製列項目後，另一側空白貼上可用；同側 disabled，貼上走 upload', async () => {
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBeGreaterThan(0))

    fireEvent.contextMenu(document.querySelector('[data-pane="local"] tbody tr') as HTMLElement)
    fireEvent.click(item('Copy'))

    fireEvent.contextMenu(document.querySelector('.rs-sftp__dropzone[data-kind="local"]') as HTMLElement)
    expect(item('Paste').disabled).toBe(true)
    fireEvent.mouseDown(document.querySelector('.rs-sftp__mask') as HTMLElement)

    fireEvent.contextMenu(document.querySelector('.rs-sftp__dropzone[data-kind="remote"]') as HTMLElement)
    expect(item('Paste').disabled).toBe(false)
    fireEvent.click(item('Paste'))

    await waitFor(() => expect(rs.transfer.plan).toHaveBeenCalled())
    const [sessionId, direction, items] = rs.transfer.plan.mock.calls[0] as [string, string, Array<{ source: string; target: string }>]
    expect(sessionId).toBe('s1')
    expect(direction).toBe('upload')
    expect(items[0]?.source).toContain('l.txt')
    expect(items[0]?.target).toContain('l.txt')
  })

  it('空白刷新只打該側（本機空白 → 只 localFs.list）', async () => {
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await waitFor(() => expect(rs.localFs.list).toHaveBeenCalled())
    const localCount = rs.localFs.list.mock.calls.length
    const remoteCount = rs.sftp.list.mock.calls.length

    fireEvent.contextMenu(document.querySelector('.rs-sftp__dropzone[data-kind="local"]') as HTMLElement)
    const menu = document.querySelector('.rs-sftp__ctxmenu') as HTMLElement
    fireEvent.click(within(menu).getByText('Refresh'))

    await waitFor(() => expect(rs.localFs.list.mock.calls.length).toBe(localCount + 1))
    expect(rs.sftp.list.mock.calls.length).toBe(remoteCount)
  })

  it('#3/#4 接線：upload completed 只刷新遠端，download completed 只刷新本機', async () => {
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await waitFor(() => expect(rs.localFs.list).toHaveBeenCalled())
    await waitFor(() => expect(rs.sftp.list).toHaveBeenCalled())
    await waitFor(() => expect(emitTransfer).not.toBeNull())

    let localCount = rs.localFs.list.mock.calls.length
    let remoteCount = rs.sftp.list.mock.calls.length
    act(() => emitTransfer?.([{ taskId: 't1', state: 'completed', sessionId: 's1', direction: 'upload', target: '/home/u/new.txt' }]))
    await waitFor(() => expect(rs.sftp.list.mock.calls.length).toBe(remoteCount + 1))
    expect(rs.localFs.list.mock.calls.length).toBe(localCount)

    localCount = rs.localFs.list.mock.calls.length
    remoteCount = rs.sftp.list.mock.calls.length
    act(() => emitTransfer?.([{ taskId: 't2', state: 'completed', sessionId: 's1', direction: 'download', target: 'C:\\Users\\demo\\new.txt' }]))
    await waitFor(() => expect(rs.localFs.list.mock.calls.length).toBe(localCount + 1))
    expect(rs.sftp.list.mock.calls.length).toBe(remoteCount)
  })

  it('剪貼簿記住複製當下目錄：/A 複製後導覽到 /B，貼上仍用 /A/name', async () => {
    rs.localFs.home.mockResolvedValue({ ok: true, data: 'C:\\A' })
    rs.localFs.list.mockImplementation((path: string) => {
      const inSub = path.endsWith('sub')
      return Promise.resolve({
        ok: true,
        data: {
          path: inSub ? 'C:\\A\\sub' : path,
          entries: inSub ? [entry('inside.txt', 'C:\\A\\sub\\inside.txt')] : [folder('sub', 'C:\\A\\sub'), entry('l.txt', 'C:\\A\\l.txt')],
          drives: ['C:\\']
        }
      })
    })
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    const localPane = () => document.querySelector('[data-pane="local"]') as HTMLElement
    await waitFor(() => expect(within(localPane()).getByText('l.txt')).toBeTruthy())

    fireEvent.contextMenu(within(localPane()).getByText('l.txt').closest('tr') as HTMLElement)
    fireEvent.click(item('Copy'))

    fireEvent.doubleClick(within(localPane()).getByText('sub').closest('tr') as HTMLElement)
    await waitFor(() => expect(rs.localFs.list.mock.calls.some(([p]) => String(p).endsWith('sub'))).toBe(true))
    await waitFor(() => expect(within(localPane()).getByText('inside.txt')).toBeTruthy())

    fireEvent.contextMenu(document.querySelector('.rs-sftp__dropzone[data-kind="remote"]') as HTMLElement)
    fireEvent.click(item('Paste'))

    await waitFor(() => expect(rs.transfer.plan).toHaveBeenCalled())
    const items = rs.transfer.plan.mock.calls[0]?.[2] as Array<{ source: string; target: string }>
    expect(items[0]?.source).toBe('C:\\A\\l.txt')
    expect(items[0]?.source).not.toContain('sub')
  })
})
