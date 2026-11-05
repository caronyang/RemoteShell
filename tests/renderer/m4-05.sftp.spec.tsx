import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { SessionInfo, SftpEntry } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { DualPane } from '../../src/renderer/features/sftp/DualPane'
import { FileTable, DRAG_MIME } from '../../src/renderer/features/sftp/FileTable'
import { ConflictDialog } from '../../src/renderer/features/sftp/ConflictDialog'

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

const entries: SftpEntry[] = [
  { name: 'index.html', path: '/home/u/index.html', type: 'file', size: 4096, mtimeMs: 1730000000000, isSymlink: false }
]

const stubSftp = (planResult?: { conflict: boolean }) => {
  const plan = vi
    .fn()
    .mockImplementation((_id: string, _direction: 'upload' | 'download', items: Array<{ source: string; target: string; conflict: boolean }>) =>
      Promise.resolve({
        ok: true,
        data: {
          items: items.map((item) => ({ ...item, conflict: planResult?.conflict ?? false, existingSize: planResult?.conflict ? 99 : undefined })),
          skipped: []
        }
      })
    )
  const start = vi.fn().mockResolvedValue({ ok: true, data: [{ taskId: 't1' }] })
  const localEntries = [
    { name: 'backup.sql', path: 'C:\\Users\\demo\\backup.sql', type: 'file', size: 2147483648, mtimeMs: Date.UTC(2026, 9, 29, 8, 30), isSymlink: false },
    { name: 'logs', path: 'C:\\Users\\demo\\logs', type: 'dir', size: 0, mtimeMs: Date.UTC(2026, 9, 30, 2, 0), isSymlink: false },
    { name: '\u5831\u8868_\u5341\u6708.xlsx', path: 'C:\\Users\\demo\\\u5831\u8868_\u5341\u6708.xlsx', type: 'file', size: 48123, mtimeMs: Date.UTC(2026, 9, 28, 15, 45), isSymlink: false }
  ]
  const rs = {
    localFs: {
      home: vi.fn().mockResolvedValue({ ok: true, data: 'C:\\Users\\demo\\' }),
      list: vi.fn().mockResolvedValue({ ok: true, data: { path: 'C:\\Users\\demo\\', entries: localEntries, drives: ['C:\\'] } }),
      mkdir: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      rename: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      remove: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    },
    sftp: {
      open: vi.fn().mockResolvedValue({ ok: true, data: { sftpId: 'sf1', home: '/home/u/' } }),
      close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      list: vi.fn().mockResolvedValue({ ok: true, data: { path: '/home/u/', entries } }),
      mkdir: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      rename: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      remove: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    },
    transfer: { plan, start }
  }
  Object.defineProperty(window, 'rs', { value: rs, configurable: true })
  return { plan, start }
}

const dragDataTransfer = (payload?: { kind: 'local' | 'remote'; names: string[] }): DataTransfer => {
  const store = payload ? new Map<string, string>([[DRAG_MIME, JSON.stringify(payload)]]) : new Map<string, string>()
  return {
    types: [...store.keys()],
    getData: (type: string) => store.get(type) ?? '',
    setData: (type: string, value: string) => void store.set(type, value),
    effectAllowed: 'none',
    dropEffect: 'none'
  } as unknown as DataTransfer
}

describe('M4-05 FileTable（排序切換 + aria-sort）', () => {
  it('點欄頭呼叫 onSort；aria-sort 反映排序狀態', () => {
    const onSort = vi.fn()
    const { rerender } = render(
      wrap(
        <FileTable
          entries={entries}
          selected={new Set<string>()}
          sort={{ key: 'name', asc: true }}
          dragKind="remote"
          hiddenCount={0}
          onSelectChange={() => undefined}
          onSelectRange={() => undefined}
          onOpen={() => undefined}
          onSort={onSort}
          onDropInto={() => undefined}
          onContextMenu={() => undefined}
        />
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(onSort).toHaveBeenCalledWith('size')
    expect(screen.getByRole('columnheader', { name: 'Size' }).getAttribute('aria-sort')).toBe('none')

    rerender(
      wrap(
        <FileTable
          entries={entries}
          selected={new Set<string>()}
          sort={{ key: 'size', asc: false }}
          dragKind="remote"
          hiddenCount={0}
          onSelectChange={() => undefined}
          onSelectRange={() => undefined}
          onOpen={() => undefined}
          onSort={onSort}
          onDropInto={() => undefined}
          onContextMenu={() => undefined}
        />
      )
    )
    expect(screen.getByRole('columnheader', { name: 'Size' }).getAttribute('aria-sort')).toBe('descending')
  })
})

describe('M4-05 DualPane（拖放浮標 + 跨面板 drop）', () => {
  it('拖曳中目的面板顯示浮標（含 count 與 target），drop 觸發 upload', async () => {
    const { start } = stubSftp()
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await screen.findByText('index.html')

    const row = screen.getByText('backup.sql').closest('tr')
    expect(row).toBeTruthy()
    fireEvent.dragStart(row as Element, { dataTransfer: dragDataTransfer() })
    // onDragStarted 由拖曳列發出（names 由選取推導）；單選 backup.sql
    const remoteZone = screen.getAllByLabelText('Remote')[1] ?? screen.getAllByLabelText('Remote')[0]
    fireEvent.dragOver(remoteZone as Element, { dataTransfer: dragDataTransfer({ kind: 'local', names: ['backup.sql'] }) })

    expect(await screen.findByText(/Drop to upload 1 items to \/home\/u\//)).toBeTruthy()

    fireEvent.drop(remoteZone as Element, { dataTransfer: dragDataTransfer({ kind: 'local', names: ['backup.sql'] }) })
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const request = start.mock.calls[0]?.[0] as { direction: string; items: Array<{ target: string }> }
    expect(request.direction).toBe('upload')
    expect(request.items[0]?.target).toBe('/home/u/backup.sql')
  })

  it('drop 目的為同面板（local→local）不觸發傳輸', async () => {
    const { start } = stubSftp()
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await screen.findByText('index.html')
    const localZone = screen.getAllByLabelText('Local')[0] as Element
    fireEvent.drop(localZone, { dataTransfer: dragDataTransfer({ kind: 'local', names: ['backup.sql'] }) })
    expect(start).not.toHaveBeenCalled()
  })
})

describe('M4-05 ConflictDialog（逐項決策 + 全部套用）', () => {
  const items = [
    { baseKey: '/src/a.txt', displayName: 'a.txt', existingSize: 1 },
    { baseKey: '/src/b.txt', displayName: 'b.txt', existingSize: 2 }
  ]

  it('選「保留兩者」逐項送出 rename 決策', () => {
    const onResolve = vi.fn()
    render(wrap(<ConflictDialog open items={items} onResolve={onResolve} onCancel={() => undefined} />))
    fireEvent.click(screen.getByText('Keep both (rename)'))
    expect(onResolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Keep both (rename)'))
    expect(onResolve).toHaveBeenCalledTimes(1)
    const decisions = onResolve.mock.calls[0]?.[0] as Array<{ baseKey: string; decision: string }>
    expect(decisions.map((entry) => entry.decision)).toEqual(['rename', 'rename'])
    expect(decisions.map((entry) => entry.baseKey)).toEqual(['/src/a.txt', '/src/b.txt'])
  })

  it('全部套用只送出一次、兩項同決策', () => {
    const onResolve = vi.fn()
    render(wrap(<ConflictDialog open items={items} onResolve={onResolve} onCancel={() => undefined} />))
    fireEvent.click(screen.getByText('Apply to all'))
    expect(onResolve).toHaveBeenCalledTimes(1)
    const decisions = onResolve.mock.calls[0]?.[0] as Array<{ decision: string }>
    expect(decisions.map((entry) => entry.decision)).toEqual(['overwrite', 'overwrite'])
  })

  it('契約 v1.11：rename 決策顯示最終名稱預覽 file(1).ext', () => {
    const onResolve = vi.fn()
    render(
      wrap(
        <ConflictDialog
          open
          items={[{ baseKey: '/src/backup.sql', displayName: 'backup.sql', existingSize: 1 }]}
          onResolve={onResolve}
          onCancel={() => undefined}
        />
      )
    )
    expect(screen.getByText('Keep both (rename): backup(1).sql')).toBeTruthy()
  })
})

describe('M4-05 契約 v1.11 plan direction + skip 不建任務', () => {
  it('plan 以 (sessionId, direction, items) 呼叫', async () => {
    const { plan } = stubSftp()
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await screen.findByText('index.html')
    fireEvent.click(screen.getByText('backup.sql'))
    fireEvent.click(screen.getByText('Upload'))
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1))
    expect(plan.mock.calls[0]?.[1]).toBe('upload')
    expect(plan.mock.calls[0]?.[0]).toBe('s1')
  })

  it('空目錄上傳 start 回 []（目錄已建、不落佇列）→ 不顯示 0 items toast', async () => {
    const { start } = stubSftp()
    start.mockResolvedValue({ ok: true, data: [] })
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await screen.findByText('index.html')
    fireEvent.click(screen.getByText('logs'))
    fireEvent.click(screen.getByText('Upload'))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(document.querySelectorAll('.rs-toast').length).toBe(0)
  })

  it('P1-03：決策以 source→target 為 key（對齊 main decideConflict 查表；Overwrite 不再被 skip）', async () => {
    const { start } = stubSftp({ conflict: true })
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await screen.findByText('index.html')
    fireEvent.click(screen.getByText('backup.sql'))
    fireEvent.click(screen.getByText('Upload'))
    await screen.findByText('File already exists')
    fireEvent.click(screen.getByText('Overwrite'))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const request = start.mock.calls[0]?.[0] as {
      items: Array<{ source: string; target: string }>
      decisions?: Record<string, string>
    }
    const item = request.items[0]
    expect(item).toBeTruthy()
    const key = `${item?.source}→${item?.target}`
    // main: decisions[target] ?? decisions[source→target]（src/main/queue/conflict.ts L35）
    expect(Object.keys(request.decisions ?? {})).toEqual([key])
    expect(request.decisions?.[key]).toBe('overwrite')
    // 舊的 source 單鍵不得再出現（那正是 QA T05d-1「0 任務」的根因）
    expect(Object.keys(request.decisions ?? {})).not.toContain(item?.source)
  })

  it('skip 決策不建立任務：start 只帶非 skip 項目', async () => {
    const { start } = stubSftp({ conflict: true })
    render(wrap(<DualPane session={session} onClose={() => undefined} />))
    await screen.findByText('index.html')
    // 多選兩個本機檔（Ctrl）
    fireEvent.click(screen.getByText('backup.sql'))
    fireEvent.click(screen.getByText('\u5831\u8868_\u5341\u6708.xlsx'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Upload'))
    await screen.findByText('File already exists')

    // 第一項 skip、第二項（CJK）overwrite → start 只帶第二項
    fireEvent.click(screen.getByText('Skip'))
    fireEvent.click(screen.getByText('Overwrite'))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const request = start.mock.calls[0]?.[0] as { items: Array<{ source: string }> }
    expect(request.items).toHaveLength(1)
    expect(request.items[0]?.source).toContain('\u5831\u8868_\u5341\u6708.xlsx')
  })
})
