import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { AppSettings, ConnectionGroup, ConnectionProfile, SessionInfo } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { AboutPane } from '../../src/renderer/features/settings/AboutPane'
import { TerminalPane } from '../../src/renderer/features/settings/TerminalPane'
import { MenuBar } from '../../src/renderer/features/layout/MenuBar'
import { MainWindow } from '../../src/renderer/features/layout/MainWindow'
import { NewGroupDialog } from '../../src/renderer/features/layout/NewGroupDialog'
import { Sidebar } from '../../src/renderer/features/layout/Sidebar'
import { TerminalArea } from '../../src/renderer/features/layout/TerminalArea'

/* xterm 在 jsdom 無法實例化（缺 matchMedia）；本檔測試需在樹上出現 session 狀態，
   因此與 m4-05.terminal.spec 相同方式 mock xterm 與 addons */
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

const groups: ConnectionGroup[] = [{ id: 'g1', name: 'Prod', parentId: null, collapsed: false, order: 0 }]
const profiles: ConnectionProfile[] = [
  {
    id: 'p1',
    name: 'app-db-01',
    groupId: 'g1',
    protocol: 'ssh',
    host: '10.1.2.11',
    port: 22,
    auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
    jump: { enabled: false, connectionIds: [] },
    terminal: {},
    tags: [],
    description: '',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z'
  }
]

/** MainWindow 掛載所需的最小 window.rs mock（真實契約形狀；不含任何視覺斷言複製）。
 *  回傳 emitState：模擬 main 的 session state broadcast（N-1 狀態點測試用）。 */
function mockRs(
  over: Record<string, unknown> = {},
  data?: { profiles: ConnectionProfile[]; groups: ConnectionGroup[] }
): { emitState: (info: SessionInfo) => void } {
  let stateCb: ((info: SessionInfo) => void) | null = null
  Object.defineProperty(
    window,
    'rs',
    {
      configurable: true,
      value: {
        connections: { list: vi.fn().mockResolvedValue({ ok: true, data: data ?? { profiles, groups } }), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
        groups: { create: vi.fn().mockResolvedValue({ ok: true, data: { id: 'g2', name: 'New', parentId: null, collapsed: false } }) },
        session: {
          onState: vi.fn().mockImplementation((cb: (info: SessionInfo) => void) => {
            stateCb = cb
            return () => undefined
          }),
          /* P1-01 後 onState 忽略未知 id → 測試種子分頁一律走 open()（合法新分頁來源） */
          open: vi
            .fn()
            .mockImplementation((req: { profileId: string }) =>
              Promise.resolve({
                ok: true,
                data: {
                  sessionId: `s-${req.profileId}`,
                  profileId: req.profileId,
                  protocol: 'ssh',
                  state: 'connected',
                  phase: 'ready',
                  host: '10.0.0.1',
                  port: 22,
                  cols: 120,
                  rows: 30
                }
              })
            ),
          close: vi.fn(),
          reconnect: vi.fn(),
          write: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
          resize: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
          snapshot: vi.fn().mockResolvedValue({ ok: true, data: { bytes: new Uint8Array() } }),
          onData: vi.fn().mockReturnValue(() => undefined)
        },
        transfer: {
          onUpdate: vi.fn().mockReturnValue(() => undefined),
          list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
          cancel: vi.fn(),
          retry: vi.fn(),
          remove: vi.fn(),
          pause: vi.fn(),
          resume: vi.fn()
        },
        settings: { reset: vi.fn() },
        window: { close: vi.fn() },
        ...over
      }
    }
  )
  return { emitState: (info: SessionInfo) => stateCb?.(info) }
}

describe('M4 走查 FAIL-3：UI-02 全入口可開新增連線', () => {
  it('工具列 New 鈕開啟連線屬性對話框（role=dialog）', async () => {
    mockRs()
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByTitle('New Connection (Ctrl+Shift+N)'))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('空白樹右鍵出現「新增連線/新增分組」兩項，點新增連線可開窗', async () => {
    mockRs()
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    await screen.findByText('app-db-01')
    const body = document.querySelector('.rs-sidebar__body')
    expect(body).toBeTruthy()
    fireEvent.contextMenu(body as Element)
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['New Connection', 'New Group'])
    fireEvent.click(items[0] as HTMLElement)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('分組上右鍵點新增連線：對話框 Group 預填該分組', async () => {
    mockRs()
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    const groupRow = await screen.findByText('Prod')
    fireEvent.contextMenu(groupRow.closest('[data-node-id]') as Element)
    const items = await screen.findAllByRole('menuitem')
    expect(items).toHaveLength(2)
    fireEvent.click(items[0] as HTMLElement)
    const groupSelect = (await screen.findByLabelText('Group')) as HTMLSelectElement
    expect(groupSelect.value).toBe('g1')
  })

  it('File 選單：快速連線/新增連線啟用且可開窗；匯入/匯出死選項已移除；Connection 選單也有新增連線', async () => {
    mockRs()
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    fireEvent.click(await screen.findByRole('button', { name: 'File' }))
    const fileItems = await screen.findAllByRole('menuitem')
    const labels = fileItems.map((item) => item.textContent)
    expect(labels).toContain('Quick Connect…')
    expect(labels).toContain('New Connection…')
    expect(labels).not.toContain('Import Settings')
    expect(labels).not.toContain('Export Settings')
    expect(fileItems.every((item) => !(item as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(fileItems.find((item) => item.textContent === 'New Connection…') as HTMLElement)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('M4 走查 FAIL-4/5/6 與編碼列', () => {
  it('分頁列 [＋] 呼叫 onQuickConnect', () => {
    const onQuickConnect = vi.fn()
    render(
      wrap(
        <TerminalArea
          sessions={[]}
          activeId={null}
          settings={settings}
          sftpSessionIds={[]}
          sftpViewId={null}
          profileName={() => 'x'}
          terminalSettingsFor={() => settings.terminal}
          onSelect={() => undefined}
          onClose={() => undefined}
          onSelectSftp={() => undefined}
          onCloseSftp={() => undefined}
          closeSftpTab={() => undefined}
          onQuickConnect={onQuickConnect}
        />
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Quick Connect (Ctrl+Q)' }))
    expect(onQuickConnect).toHaveBeenCalledTimes(1)
  })

  it('關於頁顯示 UI-06 Logo（inline SVG）與文字版名稱', () => {
    render(wrap(<AboutPane info={{ version: '0.1.0', electron: '32.3.3', chrome: 'x', node: '20.18.1', platform: 'win32', arch: 'x64', sshEngine: '1.17.0' }} />))
    expect(screen.getByRole('img', { name: 'RemoteShell logo' })).toBeTruthy()
    expect(screen.getByText('RemoteShell')).toBeTruthy()
    expect(screen.getByText('RemoteShell v0.1.0')).toBeTruthy()
  })

  it('關於頁列出兩個字型名與 OFL 授權（授權值不再寫死 UNLICENSED）', () => {
    render(wrap(<AboutPane info={null} />))
    expect(screen.getByText('Cascadia Mono · Noto Sans Mono CJK TC')).toBeTruthy()
    expect(screen.getByText('Licensed under SIL Open Font License 1.1')).toBeTruthy()
    expect(screen.getByText('OFL-CascadiaMono.txt · OFL-NotoSansMonoCJK.txt')).toBeTruthy()
    expect(screen.queryByText('UNLICENSED')).toBeNull()
  })

  it('FAIL-6：空清單且無查詢 → 引導語；查詢無結果 → No matching items', () => {
    const base = {
      width: 260,
      onWidthChange: () => undefined,
      search: '',
      onSearch: () => undefined,
      nodes: [],
      selectedId: null,
      onSelect: () => undefined,
      onActivate: () => undefined,
      onNewConnection: () => undefined,
      onNewGroup: () => undefined,
      onEditConnection: () => undefined,
      onDeleteConnection: () => undefined,
      collapsed: false,
      onToggleCollapse: () => undefined
    }
    const { rerender } = render(wrap(<Sidebar {...base} />))
    expect(screen.getByText('No connections yet — click + to create one.')).toBeTruthy()

    rerender(wrap(<Sidebar {...base} search="zzz" />))
    expect(screen.getByText('No matching items')).toBeTruthy()
  })

  it('終端設定頁有唯讀 Encoding: UTF-8 列', () => {
    render(wrap(<TerminalPane settings={settings} onPatch={() => undefined} />))
    const encoding = screen.getByLabelText('Encoding') as HTMLInputElement
    expect(encoding.readOnly).toBe(true)
    expect(encoding.value).toBe('UTF-8')
  })

  it('新增分組對話框：輸入名稱按 OK 呼叫 onCreate(name, parentId)', () => {
    const onCreate = vi.fn()
    render(wrap(<NewGroupDialog open parentId="g1" onClose={() => undefined} onCreate={onCreate} />))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Staging' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onCreate).toHaveBeenCalledWith('Staging', 'g1')
  })

  it('MenuBar：File 快速連線與新增連線都呼叫 onNewConnection', async () => {
    const onNewConnection = vi.fn()
    render(wrap(<MenuBar locale="en-US" onLocaleChange={() => undefined} onOpenSettings={() => undefined} onNewConnection={onNewConnection} />))
    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click((await screen.findAllByRole('menuitem')).find((item) => item.textContent === 'Quick Connect…') as HTMLElement)
    expect(onNewConnection).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Connection' }))
    fireEvent.click((await screen.findAllByRole('menuitem')).find((item) => item.textContent === 'New Connection') as HTMLElement)
    expect(onNewConnection).toHaveBeenCalledTimes(2)
  })
})

/* N-1/N-2 裁決（走查 v1.2）：樹節點三重表達補「色」，跳板節點補 ⛓ 標示 */
describe('N-1 樹節點狀態點（4 態 × token class × aria-label）', () => {
  /* P1-01 後 onState 只更新已存在 id：種子分頁改走 open()（publicKey 免密碼提示），再用 onState 轉態 */
  const makeProfile = (id: string): ConnectionProfile => ({
    ...(profiles[0] as ConnectionProfile),
    id,
    name: id,
    groupId: null,
    auth: { method: 'publicKey', username: 'u', secret: { kind: 'none' }, keyPath: 'C:\\keys\\id_ed25519' }
  })

  it('4 種 session 狀態各渲染對應 dot class 與 aria-label', async () => {
    const ids = ['p-c', 'p-i', 'p-d', 'p-f']
    const { emitState } = mockRs({}, { profiles: ids.map(makeProfile), groups: [] })
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    await screen.findByText('p-c')

    const expectStates: Array<[SessionInfo['state'], string, string]> = [
      ['connected', 'rs-dot--connected', 'Connected'],
      ['connecting', 'rs-dot--connecting', 'Connecting'],
      ['disconnected', 'rs-dot--idle', 'Disconnected'],
      ['failed', 'rs-dot--failed', 'Failed']
    ]
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index] as string
      const state = expectStates[index]?.[0] as SessionInfo['state']
      // 合法新分頁來源：dblClick → open()
      fireEvent.dblClick(screen.getByText(id))
      await screen.findByText(id, { selector: '.rs-tab__title' })
      // id 已在清單 → onState 轉到目標狀態
      await act(async () => {
        emitState({
          sessionId: `s-${id}`,
          profileId: id,
          protocol: 'ssh',
          state,
          phase: state === 'connected' ? 'ready' : 'target-auth',
          host: '10.0.0.1',
          port: 22,
          cols: 120,
          rows: 30
        })
      })
    }

    for (const [state, cls, label] of expectStates) {
      const dot = document.querySelector(`[data-node-id="profile:${ids[expectStates.findIndex(([s]) => s === state)]}"] .rs-dot`)
      expect(dot, `dot for ${state}`).toBeTruthy()
      expect((dot as Element).className).toContain(cls)
      expect((dot as Element).getAttribute('aria-label')).toBe(label)
    }
  })

  it('未開 session 的連線節點顯示未連線點（不缺色）', async () => {
    mockRs({}, { profiles: [makeProfile('p-idle')], groups: [] })
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    const row = await screen.findByText('p-idle')
    const dot = (row.closest('[data-node-id]') as Element).querySelector('.rs-dot')
    expect(dot?.className).toContain('rs-dot--idle')
    expect(dot?.getAttribute('aria-label')).toBe('Disconnected')
  })
})

describe('N-2 跳板標示（inline SVG 箭頭 --jump 色 + title/aria-label 帶跳板名）', () => {
  it('jump.enabled 節點渲染 SVG 箭頭（aria-label 含跳板名，位置在名稱之後小字之前）；非跳板節點無標示', async () => {
    const gw: ConnectionProfile = { ...(profiles[0] as ConnectionProfile), id: 'pgw', name: 'gw-edge', groupId: null, host: '127.0.0.1', port: 2201, jump: { enabled: false, connectionIds: [] } }
    const viaJump: ConnectionProfile = {
      ...(profiles[0] as ConnectionProfile),
      id: 'ptarget',
      name: 'prod-web-01',
      groupId: null,
      host: '10.1.2.11',
      jump: { enabled: true, connectionIds: ['pgw'] }
    }
    mockRs({}, { profiles: [gw, viaJump], groups: [] })
    render(wrap(<MainWindow settings={settings} info={null} onPatch={() => undefined} />))
    await screen.findByText('prod-web-01')

    /* v1.4：字元 ⛓ 不再使用（fallback 字型會壞）；改 inline SVG 箭頭（tooltip 用 <title> 子元素） */
    const jumpMark = document.querySelector('svg.rs-tree__jump')
    expect(jumpMark).toBeTruthy()
    expect(jumpMark?.querySelector('path')).toBeTruthy()
    expect(jumpMark?.textContent ?? '').not.toContain('\u26D3')
    expect(jumpMark?.querySelector('title')?.textContent).toBe('via jump host gw-edge')
    expect(jumpMark?.getAttribute('aria-label')).toBe('via jump host gw-edge')

    const gwRow = screen.getByText('gw-edge').closest('[data-node-id]') as Element
    expect(gwRow.querySelector('.rs-tree__jump')).toBeNull()

    /* regression 護欄：節點列 svg 存在；跳板箭頭在名稱 span 之後、小字 span 之前 */
    const targetRow = screen.getByText('prod-web-01').closest('[data-node-id]') as Element
    expect(targetRow.querySelector('svg')).toBeTruthy()
    const labelEl = targetRow.querySelector('.rs-tree__label')
    const secondaryEl = targetRow.querySelector('.rs-tree__secondary')
    expect(labelEl).toBeTruthy()
    expect(secondaryEl).toBeTruthy()
    const order = Array.from(targetRow.children)
    expect(order.indexOf(labelEl as Element)).toBeLessThan(order.indexOf(jumpMark as Element))
    expect(order.indexOf(jumpMark as Element)).toBeLessThan(order.indexOf(secondaryEl as Element))
  })
})
