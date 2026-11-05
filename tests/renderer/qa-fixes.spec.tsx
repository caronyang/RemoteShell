import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type {
  AppError,
  AppSettings,
  ConnectionProfile,
  SessionInfo,
  TransferTask
} from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { ConnectionDialog } from '../../src/renderer/features/connections/ConnectionDialog'
import { MainWindow } from '../../src/renderer/features/layout/MainWindow'
import { TerminalArea } from '../../src/renderer/features/layout/TerminalArea'
import { resolveTerminalSettings } from '../../src/renderer/features/terminal/resolveTerminalSettings'
import { TerminalPane } from '../../src/renderer/features/settings/TerminalPane'
import { QueuePanel } from '../../src/renderer/features/queue/QueuePanel'
import { StatusBar } from '../../src/renderer/features/layout/StatusBar'

/* 刪除後 session/SFTP 分頁清理測試會掛載 TerminalView → 與 walkthrough-fixes 同法 mock xterm */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    rows = 30
    options: Record<string, unknown> = {}
    loadAddon(): void { /* noop */ }
    open(): void { /* noop */ }
    dispose(): void { /* noop */ }
    write(): void { /* noop */ }
    focus(): void { /* noop */ }
    onData(): { dispose(): void } { return { dispose: () => undefined } }
    /* v0.1.10 #2：useTerminal 新呼叫（剪貼簿攔截） */
    attachCustomKeyEventHandler(): void { /* noop */ }
    hasSelection(): boolean { return false }
    getSelection(): string { return '' }
    paste(): void { /* noop */ }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void { /* noop */ } } }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void { /* noop */ }
    dispose(): void { /* noop */ }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void { /* noop */ }
    unobserve(): void { /* noop */ }
    disconnect(): void { /* noop */ }
  }
)

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

const profile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
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
  updatedAt: '2026-01-01T00:00:00Z',
  ...over
})

const gwProfile: ConnectionProfile = profile({ id: 'pgw', name: 'gw-edge', host: '127.0.0.1', port: 2201 })
const dpapiSecret = { kind: 'dpapi' as const, cipher: 'CIPHER', updatedAt: '2026-01-01T00:00:00Z' }

const makeSettings = (confirmDelete = true): AppSettings => ({
  schemaVersion: 1,
  locale: 'en-US',
  general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete },
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
})

/** ConnectionDialog 單測所需的 window.rs（connections + vault） */
const stubDialogRs = () => {
  const create = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
    ok: true,
    data: { ...profile({ id: 'p9' }), ...input }
  }))
  const update = vi.fn().mockResolvedValue({ ok: true, data: null })
  const setSecret = vi.fn().mockResolvedValue({ ok: true, data: dpapiSecret })
  const clearSecret = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  Object.defineProperty(window, 'rs', {
    configurable: true,
    value: { connections: { create, update, remove: vi.fn() }, vault: { setSecret, clearSecret, inspectKeyFile: vi.fn() } }
  })
  return { create, update, setSecret, clearSecret }
}

/** MainWindow 掛載所需的 window.rs（連線清單 + session/transfer 骨架；含 SFTP 分頁所需 localFs/sftp） */
const stubMainRs = (listImpl: () => Promise<unknown>, tasks: TransferTask[] = []) => {
  let stateCb: ((info: SessionInfo) => void) | null = null
  const list = vi.fn().mockImplementation(listImpl)
  const remove = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  const create = vi.fn().mockResolvedValue({ ok: true, data: null })
  const update = vi.fn().mockResolvedValue({ ok: true, data: null })
  const close = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  /* P2-01v2-2：佇列動作 mock（成功預設；個別測試覆寫成失敗） */
  const transferList = vi.fn().mockResolvedValue({ ok: true, data: tasks })
  const transferRetry = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  const transferPause = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  const transferResume = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  const transferCancel = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  const transferRemove = vi.fn().mockResolvedValue({ ok: true, data: undefined })
  /* P1-01 後 onState 不再接受未知 id → 分頁種子改走正規 open() 路徑 */
  const sessionOpen = vi.fn().mockResolvedValue({
    ok: true,
    data: { sessionId: 's5', profileId: 'p1', protocol: 'ssh', state: 'connected', phase: 'ready', host: '10.0.0.1', port: 22, cols: 120, rows: 30 } as SessionInfo
  })
  Object.defineProperty(window, 'rs', {
    configurable: true,
    value: {
      connections: { list, create, update, remove },
      groups: { create: vi.fn().mockResolvedValue({ ok: true, data: null }) },
      vault: { setSecret: vi.fn(), clearSecret: vi.fn(), inspectKeyFile: vi.fn() },
      session: {
        onState: vi.fn().mockImplementation((cb: (info: SessionInfo) => void) => {
          stateCb = cb
          return () => undefined
        }),
        open: sessionOpen,
        close,
        reconnect: vi.fn(),
        write: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        resize: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        snapshot: vi.fn().mockResolvedValue({ ok: true, data: { bytes: new Uint8Array() } }),
        onData: vi.fn().mockReturnValue(() => undefined)
      },
      transfer: {
        onUpdate: vi.fn().mockReturnValue(() => undefined),
        list: transferList,
        cancel: transferCancel,
        retry: transferRetry,
        remove: transferRemove,
        pause: transferPause,
        resume: transferResume
      },
      localFs: {
        home: vi.fn().mockResolvedValue({ ok: true, data: 'C:\\Users\\demo\\' }),
        list: vi.fn().mockResolvedValue({ ok: true, data: { path: 'C:\\Users\\demo\\', entries: [], drives: ['C:\\'] } })
      },
      sftp: {
        open: vi.fn().mockResolvedValue({ ok: true, data: { sftpId: 'sf1', home: '/home/u/' } }),
        close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        list: vi.fn().mockResolvedValue({ ok: true, data: { path: '/home/u/', entries: [] } }),
        mkdir: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        rename: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
        remove: vi.fn().mockResolvedValue({ ok: true, data: undefined })
      },
      settings: { reset: vi.fn() },
      window: { close: vi.fn() }
    }
  })
  return {
    list,
    remove,
    close,
    sessionOpen,
    emitState: (info: SessionInfo) => stateCb?.(info),
    transfer: { list: transferList, retry: transferRetry, pause: transferPause, resume: transferResume, cancel: transferCancel, remove: transferRemove }
  }
}

const task = (over: Partial<TransferTask> = {}): TransferTask => ({
  taskId: 't1',
  sessionId: 's1',
  connectionLabel: 'prod-web-01',
  direction: 'upload',
  source: 'C:\\src\\a.txt',
  target: '/var/www/a.txt',
  isDirectory: false,
  totalBytes: 100,
  transferredBytes: 50,
  bytesPerSec: 1024,
  etaSec: 1,
  state: 'running',
  attempts: 1,
  createdAt: '2026-10-30T00:00:00Z',
  ...over
})

describe('P0-01 連線對話框跳板（handleSave 寫入 jump state）', () => {
  const fillGeneralAndSave = async (): Promise<void> => {
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod-web-01' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
    fireEvent.click(screen.getByText('Save'))
  }

  it('新建：Jump 選 gw-edge → create 收到 jump.enabled=true + connectionIds', async () => {
    const { create } = stubDialogRs()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[gwProfile]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    fireEvent.click(screen.getByLabelText('Use jump host'))
    fireEvent.change(screen.getByLabelText('Jump host'), { target: { value: 'pgw' } })
    await fillGeneralAndSave()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      jump: { enabled: true, connectionIds: ['pgw'] }
    })
  })

  it('編輯既有跳板連線：Jump 分頁回填 selectedId；儲存保留 jump', async () => {
    const { update } = stubDialogRs()
    const conn = profile({ jump: { enabled: true, connectionIds: ['pgw'] } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[conn, gwProfile]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    expect((screen.getByLabelText('Jump host') as HTMLSelectElement).value).toBe('pgw')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[0]).toBe('p1')
    expect(update.mock.calls[0]?.[1]).toMatchObject({ jump: { enabled: true, connectionIds: ['pgw'] } })
  })

  it('編輯停用跳板 → jump.enabled=false、connectionIds=[]', async () => {
    const { update } = stubDialogRs()
    const conn = profile({ jump: { enabled: true, connectionIds: ['pgw'] } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[conn, gwProfile]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    fireEvent.click(screen.getByLabelText('Use jump host'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1]).toMatchObject({ jump: { enabled: false, connectionIds: [] } })
  })

  it('資料層自己跳自己 → validate 擋下（jumpSelf 錯誤、update 不呼叫）', async () => {
    const { update } = stubDialogRs()
    const selfJump = profile({ jump: { enabled: true, connectionIds: ['p1'] } })
    render(wrap(<ConnectionDialog open connection={selfJump} groups={[]} profiles={[selfJump, gwProfile]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    fireEvent.click(screen.getByText('Save'))
    expect((screen.getByRole('alert').textContent ?? '')).toContain('cannot use itself')
    expect(update).not.toHaveBeenCalled()
  })
})

describe('P1-01 記住密碼（vault setSecret/clearSecret 接線）', () => {
  it('新建＋輸入密碼：create(none) → setSecret → update(dpapi)，順序正確', async () => {
    const { create, update, setSecret } = stubDialogRs()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
    fireEvent.click(screen.getByText('Authentication'))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-123' } })
    expect((screen.getByLabelText('Remember password') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(setSecret).toHaveBeenCalledWith('p9', 'pw-123')
    expect(create.mock.calls[0]?.[0].auth.secret).toEqual({ kind: 'none' })
    expect(update.mock.calls[0]?.[1].auth.secret).toMatchObject({ kind: 'dpapi', cipher: 'CIPHER' })
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(setSecret.mock.invocationCallOrder[0] as number)
    expect(setSecret.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0] as number)
  })

  it('編輯取消勾選 → clearSecret 被呼叫、secret 回 none', async () => {
    const { update, setSecret, clearSecret } = stubDialogRs()
    const conn = profile({ auth: { method: 'password', username: 'u', secret: dpapiSecret } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Authentication'))
    expect((screen.getByLabelText('Remember password') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText('Remember password'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(clearSecret).toHaveBeenCalledWith('p1')
    expect(setSecret).not.toHaveBeenCalled()
    expect(update.mock.calls[0]?.[1].auth.secret).toEqual({ kind: 'none' })
  })

  it('編輯勾選但密碼留空 → 保留原 dpapi ref（不 clear、不 set）', async () => {
    const { update, setSecret, clearSecret } = stubDialogRs()
    const conn = profile({ auth: { method: 'password', username: 'u', secret: dpapiSecret } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(clearSecret).not.toHaveBeenCalled()
    expect(setSecret).not.toHaveBeenCalled()
    expect(update.mock.calls[0]?.[1].auth.secret).toEqual(dpapiSecret)
  })
})

describe('P1-02 既有連線的編輯/刪除入口（右鍵 + F2）', () => {
  it('連線節點右鍵 → Edit/Delete 兩項；Edit 開對話框且回填名稱', async () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } }))
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    fireEvent.contextMenu(row.closest('[data-node-id]') as Element)
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Edit', 'Delete'])
    fireEvent.click(items[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('alpha')
    expect(dialog).toBeTruthy()
  })

  it('F2 開啟編輯對話框', async () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } }))
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    fireEvent.click(row)
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' })
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('alpha')
  })

  it('confirmDelete=true：Delete → 輸入名稱二次確認 → remove + 列消失', async () => {
    const rs = stubMainRs(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } })
        .mockResolvedValue({ ok: true, data: { profiles: [], groups: [] } })
    )
    render(wrap(<MainWindow settings={makeSettings(true)} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    fireEvent.contextMenu(row.closest('[data-node-id]') as Element)
    fireEvent.click((await screen.findAllByRole('menuitem'))[1] as HTMLElement)

    // 二次確認：輸入名稱前 Delete 鈕 disabled
    expect(await screen.findByText('Delete connection')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText(/Type "alpha" to confirm/) as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText(/Type "alpha" to confirm/), { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(rs.remove).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
  })

  it('confirmDelete=false：直接刪（不出確認框）', async () => {
    const rs = stubMainRs(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } })
        .mockResolvedValue({ ok: true, data: { profiles: [], groups: [] } })
    )
    render(wrap(<MainWindow settings={makeSettings(false)} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    fireEvent.contextMenu(row.closest('[data-node-id]') as Element)
    fireEvent.click((await screen.findAllByRole('menuitem'))[1] as HTMLElement)
    await waitFor(() => expect(rs.remove).toHaveBeenCalledWith('p1'))
    expect(screen.queryByText('Delete connection')).toBeNull()
  })
})

describe('P1-07 佇列高度拖曳（local 預覽 + commit 最後位置）', () => {
  it('move 期間 body 即時變化；pointerup 以新高度 commit', () => {
    const onHeightChange = vi.fn()
    render(
      wrap(
        <QueuePanel
          collapsed={false}
          height={200}
          tasks={[task()]}
          onToggle={() => undefined}
          onHeightChange={onHeightChange}
          onRequest={() => undefined}
          onClearCompleted={() => undefined}
        />
      )
    )
    const resizer = screen.getByRole('separator')
    const body = document.querySelector('.rs-queue__body') as HTMLElement
    expect(body.style.height).toBe('200px')

    fireEvent.mouseDown(resizer, { clientY: 300 })
    fireEvent.mouseMove(window, { clientY: 350 })
    expect(body.style.height).toBe('250px') // 拖曳中即時預覽
    fireEvent.mouseMove(window, { clientY: 370 })
    expect(body.style.height).toBe('270px')
    fireEvent.mouseUp(window)
    expect(onHeightChange).toHaveBeenCalledWith(270, true) // commit 最後位置
    expect(body.style.height).toBe('270px') // commit 後交回 prop 高度前不失真
  })

  it('放開在原高度不重複 patch', () => {
    const onHeightChange = vi.fn()
    render(
      wrap(
        <QueuePanel
          collapsed={false}
          height={200}
          tasks={[]}
          onToggle={() => undefined}
          onHeightChange={onHeightChange}
          onRequest={() => undefined}
          onClearCompleted={() => undefined}
        />
      )
    )
    fireEvent.mouseDown(screen.getByRole('separator'), { clientY: 300 })
    fireEvent.mouseUp(window)
    expect(onHeightChange).not.toHaveBeenCalled()
  })
})

describe('P2-03 佇列表頭與資料列欄數一致（9 欄）', () => {
  it('columnheader 數 = 資料列 td 數 = 9（含 Connection）', () => {
    render(
      wrap(
        <QueuePanel
          collapsed={false}
          height={200}
          tasks={[task()]}
          onToggle={() => undefined}
          onHeightChange={() => undefined}
          onRequest={() => undefined}
          onClearCompleted={() => undefined}
        />
      )
    )
    const headers = screen.getAllByRole('columnheader')
    const cells = document.querySelectorAll('tbody tr td')
    expect(headers).toHaveLength(9)
    expect(cells).toHaveLength(9)
    expect(headers[8]?.textContent).toBe('Connection')
  })
})

describe('P2-02 錯誤文案 {host}:{port} 插值', () => {
  const base: SessionInfo = {
    sessionId: 's1',
    profileId: 'p1',
    protocol: 'ssh',
    state: 'failed',
    phase: 'target-tcp',
    host: '10.9.9.9',
    port: 22,
    cols: 120,
    rows: 30
  }
  const targetError: AppError = {
    code: 'E_TARGET_TCP',
    phase: 'target-tcp',
    message: 'unreachable',
    i18nKey: 'error.E_TARGET_TCP',
    retryable: true
  }

  it('E_TARGET_TCP 顯示目標 host:port，無 {host}:{port} 字面', () => {
    render(wrap(<StatusBar locale="en-US" info={null} session={{ ...base, error: targetError }} profileName="alpha" onReconnect={() => undefined} />))
    expect(screen.getByText(/10\.9\.9\.9:22/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('{host}')
    expect(document.body.textContent).not.toContain('{port}')
  })

  it('E_JUMP_TCP 用跳板主機（jumpHost/jumpPort props）', () => {
    const jumpError: AppError = { ...targetError, code: 'E_JUMP_TCP', phase: 'jump-tcp', i18nKey: 'error.E_JUMP_TCP' }
    render(
      wrap(
        <StatusBar
          locale="en-US"
          info={null}
          session={{ ...base, error: jumpError }}
          profileName="alpha"
          onReconnect={() => undefined}
          jumpHost="127.0.0.1"
          jumpPort={2201}
        />
      )
    )
    expect(screen.getByText(/127\.0\.0\.1:2201/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('{host}')
  })
})

describe('CodeReview P0-01 補強：jumpRequired／ssh-only／stale id', () => {
  it('啟用跳板但未選主機 → jumpRequired 擋下（不 create）', async () => {
    const { create } = stubDialogRs()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[gwProfile]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    fireEvent.click(screen.getByLabelText('Use jump host'))
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod-web-01' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
    fireEvent.click(screen.getByText('Save'))
    fireEvent.click(screen.getByText('Jump Host'))
    expect((screen.getByRole('alert').textContent ?? '')).toContain('Please select a jump host')
    expect(create).not.toHaveBeenCalled()
  })

  it('JumpTab 只列 ssh 主機（telnet 被排除）', () => {
    stubDialogRs()
    const telnet = profile({ id: 'pt', name: 'legacy-telnet', protocol: 'telnet' })
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[gwProfile, telnet]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    const optionLabels = screen.getAllByRole('option').map((option) => option.textContent)
    expect(optionLabels).toContain('gw-edge')
    expect(optionLabels).not.toContain('legacy-telnet')
  })

  it('selectedId 指向已刪除的跳板（stale）→ 視同未選，jumpRequired 擋下', () => {
    const { update } = stubDialogRs()
    const conn = profile({ jump: { enabled: true, connectionIds: ['p-gone'] } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[conn]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Jump Host'))
    fireEvent.click(screen.getByText('Save'))
    expect((screen.getByRole('alert').textContent ?? '')).toContain('Please select a jump host')
    expect(update).not.toHaveBeenCalled()
  })
})

describe('CodeReview P1-01 補強：失敗路徑不關窗＋連點＋終端頁入檔', () => {
  it('編輯 update 失敗 → onSaved 不呼叫（對話框保持開啟）', async () => {
    const { update } = stubDialogRs()
    update.mockResolvedValue({ ok: false, error: { code: 'E_VALIDATION', message: 'bad', i18nKey: 'error.E_VALIDATION', retryable: false } })
    const onSaved = vi.fn()
    const conn = profile()
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={onSaved} />))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('新建 setSecret 失敗 → 回滾草稿 profile（remove）、onSaved 不呼叫', async () => {
    const { update, setSecret } = stubDialogRs()
    const remove = vi.fn().mockResolvedValue({ ok: true, data: undefined })
    ;(window.rs.connections as unknown as { remove: typeof remove }).remove = remove
    setSecret.mockResolvedValue({ ok: false, error: { code: 'E_VAULT_DECRYPT', message: 'x', i18nKey: 'error.E_VAULT_DECRYPT', retryable: true } })
    const onSaved = vi.fn()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={onSaved} />))
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
    fireEvent.click(screen.getByText('Authentication'))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-123' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('p9'))
    expect(update).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('編輯 update 失敗（本次有 setSecret）→ clearSecret 回滾、onSaved 不呼叫', async () => {
    const { update, clearSecret } = stubDialogRs()
    update.mockResolvedValue({ ok: false, error: { code: 'E_VALIDATION', message: 'bad', i18nKey: 'error.E_VALIDATION', retryable: false } })
    const onSaved = vi.fn()
    const conn = profile()
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={onSaved} />))
    fireEvent.click(screen.getByText('Authentication'))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-123' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(clearSecret).toHaveBeenCalledWith('p1')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('Save 連點只送一次（in-flight 按鈕 disabled）', async () => {
    const { create } = stubDialogRs()
    create.mockImplementation(() => new Promise(() => undefined)) // 永不解析 → 模擬 in-flight
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(save)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('#13 終端頁設定存檔保留（terminal 寫入 profile，不再 terminal:{}）', async () => {
    const { update } = stubDialogRs()
    const conn = profile()
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Terminal'))
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '14' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1].terminal).toMatchObject({
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      themeId: 'dark',
      scrollback: 10000,
      cursorStyle: 'block',
      cursorBlink: true
    })
  })
})

describe('CodeReview P1-02 補強：E_CONFLICT／session 清理／選單邊界', () => {
  it('刪除被引用的跳板 → E_CONFLICT 顯示 N 條依賴、擋刪除（列不消失）', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } }))
    rs.remove.mockResolvedValue({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'in use', i18nKey: 'error.E_CONFLICT', retryable: false, detail: 'jump dependents (2): gw-edge, bastion' }
    })
    render(wrap(<MainWindow settings={makeSettings(true)} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    fireEvent.contextMenu(row.closest('[data-node-id]') as Element)
    fireEvent.click((await screen.findAllByRole('menuitem'))[1] as HTMLElement)
    fireEvent.change(screen.getByLabelText(/Type "alpha" to confirm/), { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText(/2 connections use this connection as a jump host/)).toBeTruthy()
    expect(screen.getByText(/gw-edge, bastion/)).toBeTruthy()
    // 擋刪除：清單未重載、列仍在
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(rs.list).toHaveBeenCalledTimes(1)
  })

  it('刪除後 selectedId 被清（重新載入後無殘留選取）', async () => {
    stubMainRs(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' }), profile({ id: 'p2', name: 'beta' })], groups: [] } })
        .mockResolvedValue({ ok: true, data: { profiles: [profile({ id: 'p2', name: 'beta' })], groups: [] } })
    )
    render(wrap(<MainWindow settings={makeSettings(true)} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByText('alpha')) // 先選取 alpha
    expect(document.querySelector('.rs-tree__row.is-selected')).toBeTruthy()
    fireEvent.contextMenu(screen.getByText('alpha').closest('[data-node-id]') as Element)
    fireEvent.click((await screen.findAllByRole('menuitem'))[1] as HTMLElement)
    fireEvent.change(screen.getByLabelText(/Type "alpha" to confirm/), { target: { value: 'alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
    expect(screen.getByText('beta')).toBeTruthy()
    expect(document.querySelector('.rs-tree__row.is-selected')).toBeNull()
  })

  it('刪除後關閉該 profile 的 session 與 SFTP 分頁', async () => {
    const rs = stubMainRs(
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          data: {
            profiles: [
              profile({
                id: 'p1',
                name: 'alpha',
                // publicKey 免密碼提示 → dblClick 直接走 open()
                auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id_ed25519' }
              })
            ],
            groups: []
          }
        })
        .mockResolvedValue({ ok: true, data: { profiles: [], groups: [] } })
    )
    render(wrap(<MainWindow settings={makeSettings(true)} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    // P1-01 修法後 onState 不再接受未知 id → 分頁種子改走正規連線入口（open() 是唯一合法新分頁來源）
    fireEvent.dblClick(row)
    expect(await screen.findByText('alpha', { selector: '.rs-tab__title' })).toBeTruthy()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true }))
    await waitFor(() => expect(document.querySelector('.rs-sftp__view')).toBeTruthy())

    // 刪除 → session 與 SFTP 分頁都要消失（Delete 鈕限定在確認框內 —— DualPane 工具列也有 Delete）
    fireEvent.contextMenu(row.closest('[data-node-id]') as Element)
    fireEvent.click((await screen.findAllByRole('menuitem'))[1] as HTMLElement)
    fireEvent.change(screen.getByLabelText(/Type "alpha" to confirm/), { target: { value: 'alpha' } })
    const confirmDialog = screen.getByText('Delete connection').closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(rs.close).toHaveBeenCalledWith('s5'))
    await waitFor(() => expect(document.querySelector('.rs-sftp__view')).toBeNull())
    expect(document.querySelector('.rs-tab')).toBeNull()
  })

  it('右鍵選單座標收斂於視窗內，Esc 關閉', async () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } }))
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('alpha')
    fireEvent.contextMenu(row.closest('[data-node-id]') as Element, { clientX: 9999, clientY: 9999 })
    const menu = document.querySelector('.rs-sftp__ctxmenu') as HTMLElement
    expect(menu).toBeTruthy()
    expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 180)
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight - 110)
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.rs-sftp__ctxmenu')).toBeNull()
  })
})

describe('P2-02：Delete 鍵（樹節點 → 既有刪除流程）', () => {
  it('選取節點按 Delete → 刪除入口 1 次（confirmDelete=false 直接刪、無確認框）', async () => {
    const rs = stubMainRs(
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } })
        .mockResolvedValue({ ok: true, data: { profiles: [], groups: [] } })
    )
    render(wrap(<MainWindow settings={makeSettings(false)} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByText('alpha'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    await waitFor(() => expect(rs.remove).toHaveBeenCalledWith('p1'))
    expect(rs.remove).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Delete connection')).toBeNull()
  })

  it('confirmDelete=true 按 Delete → 開確認框（不可繞過）', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [profile({ id: 'p1', name: 'alpha' })], groups: [] } }))
    render(wrap(<MainWindow settings={makeSettings(true)} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByText('alpha'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    expect(await screen.findByText('Delete connection')).toBeTruthy()
    expect(rs.remove).not.toHaveBeenCalled()
  })

  it('分組節點按 Delete 不動作', async () => {
    const rs = stubMainRs(() =>
      Promise.resolve({
        ok: true,
        data: {
          profiles: [profile({ id: 'p1', name: 'alpha', groupId: 'g1' })],
          groups: [{ id: 'g1', name: 'Prod', parentId: null, collapsed: false, order: 0 }]
        }
      })
    )
    render(wrap(<MainWindow settings={makeSettings(true)} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByText('Prod'))
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    expect(rs.remove).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete connection')).toBeNull()
  })
})

describe('#5 側欄收合（sidebarCollapsed 持久化）', () => {
  const sidebarSettings = (collapsed: boolean): AppSettings => {
    const s = makeSettings()
    s.ui.sidebarCollapsed = collapsed
    return s
  }

  it('展開狀態：收合鈕 → patch 恰一次、class 變化；雙擊邊界同效果', () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }))
    const onPatch = vi.fn()
    const { rerender } = render(wrap(<MainWindow settings={sidebarSettings(false)} info={null} onPatch={onPatch} />))
    expect(document.querySelector('.rs-sidebar')).toBeTruthy()
    // 收合鈕（header，chevron 旋轉）
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ ui: { sidebarCollapsed: true } })
    // class 變化：收合態 aside 消失（持久化後的 render）
    rerender(wrap(<MainWindow settings={sidebarSettings(true)} info={null} onPatch={onPatch} />))
    expect(document.querySelector('.rs-sidebar')).toBeNull()
    expect(document.querySelector('.rs-sidebar__expand')).toBeTruthy()

    // 切回展開態再測雙擊邊界
    rerender(wrap(<MainWindow settings={sidebarSettings(false)} info={null} onPatch={onPatch} />))
    expect(document.querySelector('.rs-resizer')).toBeTruthy()
    onPatch.mockClear()
    // 雙擊邊界（UI-01：雙擊邊界收合）
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Resize sidebar' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ ui: { sidebarCollapsed: true } })
  })

  it('收合狀態：remount（collapsed=true）仍收合；展開後寬度還原、sidebarWidth 不被歸零', () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }))
    const onPatch = vi.fn()
    const widthSettings = (collapsed: boolean): AppSettings => {
      const s = sidebarSettings(collapsed)
      s.ui.sidebarWidth = 300
      return s
    }
    // remount 帶 collapsed=true → 仍收合（展開鈕在、aside 不在）
    const first = render(wrap(<MainWindow settings={widthSettings(true)} info={null} onPatch={onPatch} />))
    expect(document.querySelector('.rs-sidebar')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy()

    // 點展開 → 只 patch sidebarCollapsed，絕不把寬度寫回 0
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ ui: { sidebarCollapsed: false } })
    for (const call of onPatch.mock.calls) {
      // 只允許 sidebarCollapsed 鍵（不可夾帶 sidebarWidth 歸零）
      expect(Object.keys(call[0].ui)).toEqual(['sidebarCollapsed'])
    }

    // 展開後還原原寬 300（sidebarWidth 未被改動）
    first.rerender(wrap(<MainWindow settings={widthSettings(false)} info={null} onPatch={onPatch} />))
    const aside = document.querySelector('.rs-sidebar') as HTMLElement
    expect(aside).toBeTruthy()
    expect(aside.style.width).toBe('300px')
  })

  it('Ctrl+Shift+B 切換收合（UI-01 快速鍵）', () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }))
    const onPatch = vi.fn()
    render(wrap(<MainWindow settings={sidebarSettings(false)} info={null} onPatch={onPatch} />))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true, bubbles: true }))
    expect(onPatch).toHaveBeenCalledWith({ ui: { sidebarCollapsed: true } })
    expect(document.querySelector('.rs-sidebar')).toBeTruthy()
  })

  it('P3 拖曳門檻：拖曳(>4px)後 300ms 內 dblclick 不收合；純雙擊才收合', async () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }))
    const onPatch = vi.fn()
    render(wrap(<MainWindow settings={sidebarSettings(false)} info={null} onPatch={onPatch} />))
    const resizer = screen.getByRole('button', { name: 'Resize sidebar' })

    // 拖曳 40px（document listeners）
    fireEvent.mouseDown(resizer, { clientX: 260 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document, { clientX: 300 })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith({ ui: { sidebarWidth: 300 } })

    // 拖曳收尾的 dblclick → 被門檻擋下（只有寬度 commit，沒有收合）
    fireEvent.doubleClick(resizer)
    expect(onPatch).toHaveBeenCalledTimes(1)

    // 300ms 後的純雙擊 → 正常收合
    await new Promise((resolve) => setTimeout(resolve, 320))
    fireEvent.doubleClick(resizer)
    expect(onPatch).toHaveBeenCalledTimes(2)
    expect(onPatch).toHaveBeenLastCalledWith({ ui: { sidebarCollapsed: true } })
  })
})

describe('P2-01v2-2 佇列動作錯誤顯示（Result 檢查＋try/catch＋失敗仍刷新）', () => {
  const failedTask = task({
    state: 'failed',
    error: { code: 'E_CONFLICT', message: 'conflict', i18nKey: 'error.E_CONFLICT', retryable: false, detail: 'directory task still has active children' }
  })
  const expandedSettings = (): AppSettings => {
    const s = makeSettings()
    s.ui.queueCollapsed = false
    return s
  }

  it('retry 回 E_CONFLICT → toast 顯示錯誤（含 detail）、佇列清單仍刷新', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }), [failedTask])
    rs.transfer.retry.mockResolvedValue({
      ok: false,
      error: { code: 'E_CONFLICT', message: 'conflict', i18nKey: 'error.E_CONFLICT', retryable: false, detail: 'directory task still has active children' }
    })
    render(wrap(<MainWindow settings={expandedSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(rs.transfer.retry).toHaveBeenCalledWith('t1'))
    // §1：錯誤必須顯示（原本靜默）
    expect(await screen.findByText(/directory task still has active children/)).toBeTruthy()
    // §3：失敗後清單仍刷新
    await waitFor(() => expect(rs.transfer.list.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('success 路徑：無錯誤 toast、清單仍刷新、不跳錯', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }), [failedTask])
    render(wrap(<MainWindow settings={expandedSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(rs.transfer.retry).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(rs.transfer.list.mock.calls.length).toBeGreaterThanOrEqual(2))
    // 成功路徑不產生任何 toast（列內的錯誤文案是 task.error 不算 toast）
    expect(document.querySelectorAll('.rs-toast').length).toBe(0)
  })
})

describe('P0 #2/#3 連線對話框（共用 Modal：portal／z-index／焦點）', () => {
  it('overlay portal 到 body 且使用 .rs-modal（z-index:50 契約類別；不再 inline 掛在樹裡）', () => {
    stubDialogRs()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    const overlay = document.querySelector('.rs-modal')
    expect(overlay).toBeTruthy()
    expect(overlay?.parentElement).toBe(document.body)
    // 對話框內容在 .rs-modal 內（z-index:50 由該類別提供）
    expect(document.querySelector('[role="dialog"]')?.closest('.rs-modal')).toBeTruthy()
  })

  it('開啟時 activeElement 移入對話框內（不再留在 xterm helper textarea）', async () => {
    stubDialogRs()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    await waitFor(() => {
      expect(document.activeElement).toBeTruthy()
      expect(document.activeElement?.closest('[role="dialog"]')).toBeTruthy()
    })
  })

  it('連開關 3 次：每次 Esc 關閉、onClose 累計正確、再開 activeElement 仍在對話框', async () => {
    stubDialogRs()
    const onClose = vi.fn()
    const { rerender } = render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={onClose} onSaved={() => undefined} />))
    for (let round = 1; round <= 3; round++) {
      expect(screen.getByRole('dialog')).toBeTruthy()
      await waitFor(() => expect(document.activeElement?.closest('[role="dialog"]')).toBeTruthy())
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(round)
      rerender(wrap(<ConnectionDialog open={false} connection={null} groups={[]} profiles={[]} onClose={onClose} onSaved={() => undefined} />))
      expect(screen.queryByRole('dialog')).toBeNull()
      if (round < 3) {
        rerender(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={onClose} onSaved={() => undefined} />))
      }
    }
  })
})

describe('#4 儲存並連線（saveAndConnect 回傳 profile 並立即 open）', () => {
  const fillGeneral = (): void => {
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod-web-01' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
  }

  it('新建 Save and Connect：create 成功 → onConnect 收到存好的 profile（id=p9）', async () => {
    const { create } = stubDialogRs()
    // 貼近真實：create 回傳「輸入內容＋儲存後的 id」
    create.mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({ ok: true, data: { ...profile({ id: 'p9' }), ...(input as Partial<ConnectionProfile>) } })
    )
    const onConnect = vi.fn()
    const onSaved = vi.fn()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onConnect={onConnect} onClose={() => undefined} onSaved={onSaved} />))
    fillGeneral()
    fireEvent.click(screen.getByText('Save and Connect'))
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onConnect.mock.calls[0]?.[0]).toMatchObject({ id: 'p9', name: 'prod-web-01', host: '10.1.2.11' })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('編輯 Save and Connect：update 成功 → onConnect 收到 update 回傳的 profile', async () => {
    const { update } = stubDialogRs()
    const conn = profile()
    update.mockResolvedValue({ ok: true, data: { ...conn, name: 'alpha-renamed' } })
    const onConnect = vi.fn()
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onConnect={onConnect} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Save and Connect'))
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
    expect(onConnect.mock.calls[0]?.[0]).toMatchObject({ id: 'p1', name: 'alpha-renamed' })
    expect(update).toHaveBeenCalledWith('p1', expect.anything())
  })

  it('失敗（create !ok）→ onConnect/onSaved 都不呼叫（錯誤已 toast、不靜默）', async () => {
    const { create } = stubDialogRs()
    create.mockResolvedValue({ ok: false, error: { code: 'E_VALIDATION', message: 'bad', i18nKey: 'error.E_VALIDATION', retryable: false } })
    const onConnect = vi.fn()
    const onSaved = vi.fn()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onConnect={onConnect} onClose={() => undefined} onSaved={onSaved} />))
    fillGeneral()
    fireEvent.click(screen.getByText('Save and Connect'))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(onConnect).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('P3 連點 Save and Connect 兩次 → 只開一個 session（create×1、session.open×1）', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }))
    const create = (window.rs.connections as unknown as { create: ReturnType<typeof vi.fn> }).create
    // 回傳 publicKey profile → openProfile 免密碼提示直通 session.open
    create.mockResolvedValue({
      ok: true,
      data: { ...profile({ id: 'p9', name: 'prod-web-01', host: '10.1.2.11', auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id_ed25519' } }) }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByTitle('New Connection (Ctrl+Shift+N)'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod-web-01' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })

    // 連點兩下（第二下應被 saving/disabled 擋下）
    fireEvent.click(screen.getByText('Save and Connect'))
    fireEvent.click(screen.getByText('Save and Connect'))

    await waitFor(() => expect(rs.sessionOpen).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(rs.sessionOpen).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('#13 讀取端：profile.terminal 逐欄合併（resolveTerminalSettings）', () => {
  const global = makeSettings().terminal

  it('profile 設了 fontFamily/fontSize → 用 profile 值，其餘五欄 fallback 全域', () => {
    const merged = resolveTerminalSettings(global, { fontFamily: 'JetBrains Mono', fontSize: 14 })
    expect(merged.fontFamily).toBe('JetBrains Mono')
    expect(merged.fontSize).toBe(14)
    expect(merged.themeId).toBe(global.themeId)
    expect(merged.scrollback).toBe(global.scrollback)
    expect(merged.cursorStyle).toBe(global.cursorStyle)
    expect(merged.cursorBlink).toBe(global.cursorBlink)
    expect(merged.ambiguousWidth).toBe(global.ambiguousWidth)
  })

  it('profile 未設定 terminal → 原樣回傳全域（fallback 落地）', () => {
    expect(resolveTerminalSettings(global, undefined)).toBe(global)
    expect(resolveTerminalSettings(global)).toBe(global)
    // profile 有 jump 等其他欄但 terminal 為空物件 → 也全部走全域
    expect(resolveTerminalSettings(global, {})).toEqual(global)
  })

  it('TerminalArea 依 session.profileId 啟用合併設定（wire-up）', () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [], groups: [] } }))
    const spy = vi.fn().mockImplementation(() => global)
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
    render(
      wrap(
        <TerminalArea
          sessions={[session]}
          activeId="s1"
          settings={makeSettings()}
          sftpSessionIds={[]}
          sftpViewId={null}
          profileName={() => 'alpha'}
          terminalSettingsFor={spy}
          onSelect={() => undefined}
          onClose={() => undefined}
          onSelectSftp={() => undefined}
          onCloseSftp={() => undefined}
          closeSftpTab={() => undefined}
          onQuickConnect={() => undefined}
        />
      )
    )
    expect(spy).toHaveBeenCalledWith('p1')
  })
})

describe('配色主題只留 dark（裁決：無調色盤的假選項退場）', () => {
  it('TerminalPane：Color scheme 只列 dark；legacy monokai 顯示 dark 且不觸發 patch', () => {
    const onPatch = vi.fn()
    const legacy = makeSettings()
    legacy.terminal.themeId = 'monokai'
    render(wrap(<TerminalPane settings={legacy} onPatch={onPatch} />))
    const select = screen.getByLabelText('Color scheme') as HTMLSelectElement
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['dark'])
    expect(select.value).toBe('dark')
    // 只顯示不靜默改寫
    expect(onPatch).not.toHaveBeenCalled()
    expect(screen.getByText('Other color schemes need design palettes; v1.0 supports dark only.')).toBeTruthy()
  })

  it('連線對話框終端頁：只列 dark；legacy 顯示 dark、儲存保留原值', async () => {
    const { update } = stubDialogRs()
    const conn = profile({ terminal: { themeId: 'monokai' } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Terminal'))
    const select = screen.getByLabelText('Color scheme') as HTMLSelectElement
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Dark'])
    expect(select.value).toBe('dark')
    expect(update).not.toHaveBeenCalled() // 載入不改寫
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    // 使用者未動配色 → 存回原值（不靜默改寫 legacy themeId）
    expect(update.mock.calls[0]?.[1].terminal).toMatchObject({ themeId: 'monokai' })
    expect(screen.getByText('Other color schemes need design palettes; v1.0 supports dark only.')).toBeTruthy()
  })
})

describe('P2 regression：終端設定「未動就不寫」（terminalDirty）', () => {
  const fillGeneralAndSave = (): void => {
    fireEvent.click(screen.getByText('General'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'prod-web-01' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.1.2.11' } })
    fireEvent.click(screen.getByText('Save'))
  }

  it('① 全域 fontSize=16、新連線不碰終端分頁 → 顯示 16 但 create payload.terminal 為 {}', async () => {
    const { create } = stubDialogRs()
    const live = makeSettings()
    live.terminal.fontSize = 16
    render(
      wrap(
        <ConnectionDialog open connection={null} groups={[]} profiles={[]} settings={live} onClose={() => undefined} onSaved={() => undefined} />
      )
    )
    // 初值顯示來源 = 全域（不是硬編 11）
    fireEvent.click(screen.getByText('Terminal'))
    expect((screen.getByLabelText('Font size') as HTMLInputElement).value).toBe('16')
    // 不碰終端分頁 → 存檔不寫 override（沿用全域）
    fillGeneralAndSave()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0].terminal).toEqual({})
  })

  it('② 新連線改字級 → payload 六欄完整、fontSize=14', async () => {
    const { create } = stubDialogRs()
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Terminal'))
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '14' } })
    fillGeneralAndSave()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const terminal = create.mock.calls[0]?.[0].terminal
    expect(Object.keys(terminal)).toHaveLength(6)
    expect(terminal).toMatchObject({
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      themeId: 'dark',
      scrollback: 10000,
      cursorStyle: 'block',
      cursorBlink: true
    })
  })

  it('③ 編輯既有 profile（已有 terminal 值）不動終端 → update payload 保留原值', async () => {
    const { update } = stubDialogRs()
    const conn = profile({ terminal: { fontFamily: 'Fira Code', fontSize: 13 } })
    render(wrap(<ConnectionDialog open connection={conn} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]?.[1].terminal).toMatchObject({ fontFamily: 'Fira Code', fontSize: 13 })
  })
})

describe('v0.1.5 #4：open 失敗不可靜默', () => {
  const pkProfile = () =>
    profile({ id: 'p1', name: 'alpha', auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id_ed25519' } })

  it('非憑證錯誤（E_TARGET_TCP）→ 出現 error toast、不新增分頁', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pkProfile()], groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_TARGET_TCP', message: 'unreachable', i18nKey: 'error.E_TARGET_TCP', retryable: true, phase: 'target-tcp' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(1))
    expect(document.querySelectorAll('.rs-tab').length).toBe(0)
    // P2：E_TARGET_TCP 的 host/port 要插值，不能留字面 {host}:{port}
    const text = document.querySelector('.rs-toast--error')?.textContent ?? ''
    expect(text).toContain('10.0.0.1:22')
    expect(text).not.toContain('{host}')
    // v0.1.8：toast 之外，狀態列也要留錯誤（沒有分頁時）
    expect(document.querySelector('.rs-statusbar')?.textContent ?? '').toContain('Target host is unreachable (10.0.0.1:22)')
  })

  /* v0.1.7：E_JUMP_TCP 的 {host}:{port} 是跳板，不是 target */
  const jumpHostProfile = () =>
    profile({ id: 'j1', name: 'jump-bad', host: '127.0.0.1', port: 1, auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id_ed25519' } })
  const jumpTargetProfile = () =>
    profile({
      id: 'p1',
      name: 'alpha',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id_ed25519' },
      jump: { enabled: true, connectionIds: ['j1'] }
    })
  const jumpProfiles = () => [jumpHostProfile(), jumpTargetProfile()]

  it('v0.1.7：E_JUMP_TCP → toast 顯示跳板 127.0.0.1:1、不含 target', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: jumpProfiles(), groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_JUMP_TCP', message: 'jump unreachable', i18nKey: 'error.E_JUMP_TCP', retryable: true, phase: 'jump-tcp' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(1))
    const text = document.querySelector('.rs-toast--error')?.textContent ?? ''
    expect(text).toContain('127.0.0.1:1')
    expect(text).not.toContain('10.1.2.11')
  })

  it('v0.1.7：有跳板時 E_TARGET_TCP → 仍顯示 target 10.1.2.11:22', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: jumpProfiles(), groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_TARGET_TCP', message: 'target unreachable', i18nKey: 'error.E_TARGET_TCP', retryable: true, phase: 'target-tcp' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(1))
    const text = document.querySelector('.rs-toast--error')?.textContent ?? ''
    expect(text).toContain('10.1.2.11:22')
    expect(text).not.toContain('127.0.0.1:1')
  })

  it('v0.1.7：E_JUMP_DNS（無佔位符）→ 顯示 DNS 文案、無字面大括號', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: jumpProfiles(), groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_JUMP_DNS', message: 'dns failed', i18nKey: 'error.E_JUMP_DNS', retryable: true, phase: 'jump-dns' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(1))
    const text = document.querySelector('.rs-toast--error')?.textContent ?? ''
    expect(text).toContain('Cannot resolve jump host name')
    expect(text).not.toContain('{')
  })

  it('v0.1.7：E_JUMP_AUTH（無佔位符）→ 顯示驗證文案、無字面大括號', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: jumpProfiles(), groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_JUMP_AUTH', message: 'jump auth failed', i18nKey: 'error.E_JUMP_AUTH', retryable: false, phase: 'jump-auth' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(1))
    const text = document.querySelector('.rs-toast--error')?.textContent ?? ''
    expect(text).toContain('Jump host authentication failed')
    expect(text).not.toContain('{')
  })

  it('成功路徑不跳錯誤 toast，且產生分頁', async () => {
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pkProfile()], groups: [] } }))
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-tab').length).toBe(1))
    expect(document.querySelectorAll('.rs-toast--error').length).toBe(0)
  })

  it('憑證類錯誤（E_TARGET_AUTH）→ 跳 CredentialDialog、不跳錯誤 toast', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pkProfile()], groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_TARGET_AUTH', message: 'auth failed', i18nKey: 'error.E_TARGET_AUTH', retryable: false, phase: 'target-auth' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-modal input[type="password"]').length).toBe(1))
    expect(document.querySelectorAll('.rs-toast--error').length).toBe(0)
    // v0.1.8：憑證類沒有 toast，但狀態列仍要有錯誤
    expect(document.querySelector('.rs-statusbar')?.textContent ?? '').toContain('Target host authentication failed')
  })

  it('連續兩次失敗 → 兩次 toast（不疊加成 4 次）', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pkProfile()], groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_TARGET_TCP', message: 'unreachable', i18nKey: 'error.E_TARGET_TCP', retryable: true, phase: 'target-tcp' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    const row = await screen.findByText('alpha')
    fireEvent.dblClick(row)
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(1))
    fireEvent.dblClick(row)
    await waitFor(() => expect(document.querySelectorAll('.rs-toast--error').length).toBe(2))
    expect(rs.sessionOpen).toHaveBeenCalledTimes(2)
  })

  it('P1：憑證重送（第一次 E_TARGET_AUTH、第二次成功）→ 對話框關閉、分頁出現', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pkProfile()], groups: [] } }))
    const authError = { code: 'E_TARGET_AUTH', message: 'auth failed', i18nKey: 'error.E_TARGET_AUTH', retryable: false, phase: 'target-auth' }
    rs.sessionOpen
      .mockResolvedValueOnce({ ok: false, error: authError })
      .mockResolvedValueOnce({
        ok: true,
        data: { sessionId: 's2', profileId: 'p1', protocol: 'ssh', state: 'connected', phase: 'ready', host: '10.0.0.1', port: 22, cols: 120, rows: 30 }
      })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    const input = await screen.findByLabelText('Password')
    fireEvent.change(input, { target: { value: 'pw-correct' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.querySelectorAll('.rs-tab').length).toBe(1)
    expect(rs.sessionOpen).toHaveBeenCalledTimes(2)
    expect(rs.sessionOpen.mock.calls[1]?.[0]).toMatchObject({ ephemeral: { secret: 'pw-correct' } })
  })

  it('P1：憑證重送仍失敗 → 回到憑證框、不卡住、不跳錯誤 toast', async () => {
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pkProfile()], groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: false,
      error: { code: 'E_TARGET_AUTH', message: 'auth failed', i18nKey: 'error.E_TARGET_AUTH', retryable: false, phase: 'target-auth' }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    const input = await screen.findByLabelText('Password')
    fireEvent.change(input, { target: { value: 'pw-wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(rs.sessionOpen).toHaveBeenCalledTimes(2))
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(document.querySelectorAll('.rs-tab').length).toBe(0)
    expect(document.querySelectorAll('.rs-toast--error').length).toBe(0)
  })

  it('v0.1.6：passwordFile（secret=none）→ 直接 open、不跳憑證框', async () => {
    const pfProfile = () =>
      profile({
        id: 'p1',
        name: 'alpha',
        auth: { method: 'passwordFile', username: 'u', secret: { kind: 'none' }, filePath: 'C:\\secrets\\pw.txt' }
      })
    const rs = stubMainRs(() => Promise.resolve({ ok: true, data: { profiles: [pfProfile()], groups: [] } }))
    rs.sessionOpen.mockResolvedValue({
      ok: true,
      data: { sessionId: 's3', profileId: 'p1', protocol: 'ssh', state: 'connected', phase: 'ready', host: '10.0.0.1', port: 22, cols: 120, rows: 30 }
    })
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    fireEvent.dblClick(await screen.findByText('alpha'))
    await waitFor(() => expect(document.querySelectorAll('.rs-tab').length).toBe(1))
    expect(document.querySelectorAll('.rs-modal input[type="password"]').length).toBe(0)
    expect(rs.sessionOpen).toHaveBeenCalledTimes(1)
  })
})

describe('v0.1.9 #4：跳板主機縮排', () => {
  it('jump 參照節點多 12px、直連不變，群組深度單調遞增', async () => {
    const group = { id: 'g1', name: 'Prod', parentId: null, collapsed: false, order: 0 }
    const profiles = [
      profile({ id: 'j1', name: 'jump-host', groupId: 'g1', host: '127.0.0.1', port: 2201 }),
      profile({ id: 'p1', name: 'direct-host', groupId: 'g1', host: '10.0.0.1' }),
      profile({
        id: 'p2',
        name: 'via-jump',
        groupId: 'g1',
        host: '10.1.2.11',
        jump: { enabled: true, connectionIds: ['j1'] }
      })
    ]
    stubMainRs(() => Promise.resolve({ ok: true, data: { profiles, groups: [group] } }))
    render(wrap(<MainWindow settings={makeSettings()} info={null} onPatch={() => undefined} />))

    await screen.findByText('jump-host')
    const padding = (text: string): string =>
      ((screen.getByText(text).closest('[data-node-id]') as HTMLElement).style.paddingLeft)
    expect(padding('Prod')).toBe('8px')
    expect(padding('direct-host')).toBe('22px')
    expect(padding('jump-host')).toBe('34px')
    expect(padding('via-jump')).toBe('22px')
  })
})
