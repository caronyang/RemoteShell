import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { ConnectionProfile, ConnectionGroup } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { ConnectionTree } from '../../src/renderer/features/connections/ConnectionTree'
import { ConnectionDialog } from '../../src/renderer/features/connections/ConnectionDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const i18n = initI18n('en-US')
/* ConnectionDialog 內含 useToast（vault/create 錯誤回饋）→ 必須包 ToastProvider */
const wrap = (ui: ReactNode): JSX.Element => (
  <I18nextProvider i18n={i18n}>
    <ToastProvider>{ui}</ToastProvider>
  </I18nextProvider>
)

const profile = (id: string, name: string, groupId: string | null): ConnectionProfile => ({
  id,
  name,
  groupId,
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
})

interface RsStub {
  connections: { list: () => Promise<unknown>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
}

const stubRs = (listResult: unknown): RsStub => {
  const rs = {
    connections: {
      list: vi.fn().mockResolvedValue(listResult),
      update: vi.fn().mockResolvedValue({ ok: true, data: null }),
      create: vi.fn().mockResolvedValue({ ok: true, data: null }),
      remove: vi.fn().mockResolvedValue({ ok: true, data: null })
    },
    groups: { update: vi.fn().mockResolvedValue({ ok: true, data: null }) }
  }
  Object.defineProperty(window, 'rs', { value: rs, configurable: true })
  return rs as unknown as RsStub
}

describe('M4-05 ConnectionTree（鍵盤導航 + Enter + F2）', () => {
  it('上下鍵移動選取、Enter 觸發 onConnect', async () => {
    stubRs({
      ok: true,
      data: {
        profiles: [profile('p1', 'alpha', 'g1'), profile('p2', 'beta', 'g1')],
        groups: [{ id: 'g1', name: 'Prod', parentId: null, collapsed: false, order: 0 }] as ConnectionGroup[]
      }
    })
    const onConnect = vi.fn()
    render(wrap(<ConnectionTree onConnect={onConnect} />))
    await screen.findByText('alpha')

    const tree = screen.getByRole('tree')
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(screen.getByRole('treeitem', { name: /alpha/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(screen.getByRole('treeitem', { name: /beta/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tree, { key: 'ArrowUp' })
    expect(screen.getByRole('treeitem', { name: /alpha/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(tree, { key: 'Enter' })
    expect(onConnect).toHaveBeenCalledWith('p1')
  })

  it('未分組連線顯示在樹上且可被選取（M4 修正）', async () => {
    stubRs({
      ok: true,
      data: {
        profiles: [profile('p1', 'alpha', 'g1'), profile('p0', 'loose', null)],
        groups: [{ id: 'g1', name: 'Prod', parentId: null, collapsed: false, order: 0 }] as ConnectionGroup[]
      }
    })
    render(wrap(<ConnectionTree />))
    expect(await screen.findByText('loose')).toBeTruthy()

    fireEvent.click(screen.getByRole('treeitem', { name: /loose/ }))
    expect(screen.getByRole('treeitem', { name: /loose/ }).getAttribute('aria-selected')).toBe('true')

    // 鍵盤導航也涵蓋未分組（分組成員在前、未分組在後）
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' })
    expect(screen.getByRole('treeitem', { name: /loose/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('F2 開啟改名對話框（不再用 window.prompt）', async () => {
    const rs = stubRs({
      ok: true,
      data: {
        profiles: [profile('p1', 'alpha', 'g1')],
        groups: [{ id: 'g1', name: 'Prod', parentId: null, collapsed: false, order: 0 }] as ConnectionGroup[]
      }
    })
    render(wrap(<ConnectionTree />))
    await screen.findByText('alpha')

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' })
    const dialog = screen.getByRole('dialog') as HTMLElement
    fireEvent.change(within(dialog).getByLabelText('Rename'), { target: { value: 'renamed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(rs.connections.update).toHaveBeenCalledWith('p1', { name: 'renamed' }))
  })
})

describe('M4-05 ConnectionDialog（驗證 + 協定 port）', () => {
  it('名稱為空時顯示必填錯誤（儲存被擋）', async () => {
    const rs = stubRs({ ok: true, data: { profiles: [], groups: [] } })
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Name is required')).toBeTruthy()
    expect(rs.connections.create).not.toHaveBeenCalled()
  })

  it('port 70000 顯示範圍錯誤', async () => {
    const rs = stubRs({ ok: true, data: { profiles: [], groups: [] } })
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Port must be between 1 and 65535')).toBeTruthy()
    expect(rs.connections.create).not.toHaveBeenCalled()
  })

  it('協定切到 telnet 時 port 帶成 23、切回 ssh 為 22', async () => {
    stubRs({ ok: true, data: { profiles: [], groups: [] } })
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[]} onClose={() => undefined} onSaved={() => undefined} />))
    const protocol = screen.getByLabelText('Protocol')
    fireEvent.change(protocol, { target: { value: 'telnet' } })
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('23')
    fireEvent.change(protocol, { target: { value: 'ssh' } })
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('22')
  })

  it('同分組同名顯示重名錯誤且不送出', async () => {
    const rs = stubRs({ ok: true, data: { profiles: [profile('p1', 'alpha', null)], groups: [] } })
    const existing = profile('p1', 'alpha', null)
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[existing]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.2' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('A connection with this name already exists in the group')).toBeTruthy()
    expect(rs.connections.create).not.toHaveBeenCalled()
  })

  it('不同分組同名允許送出', async () => {
    const rs = stubRs({ ok: true, data: { profiles: [profile('p1', 'alpha', 'g1')], groups: [] } })
    const existing = profile('p1', 'alpha', 'g1')
    render(wrap(<ConnectionDialog open connection={null} groups={[]} profiles={[existing]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.2' } })
    // 新連線 groupId=null，與既有 g1 不同組 → 允許
    fireEvent.click(screen.getByText('Save'))
    await vi.waitFor(() => expect(rs.connections.create).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('A connection with this name already exists in the group')).toBeNull()
  })

  it('編輯自己且未改名不算重複', async () => {
    const rs = stubRs({ ok: true, data: { profiles: [], groups: [] } })
    const existing = profile('p1', 'alpha', null)
    render(wrap(<ConnectionDialog open connection={existing} groups={[]} profiles={[existing]} onClose={() => undefined} onSaved={() => undefined} />))
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByText('Save'))
    await vi.waitFor(() => expect(rs.connections.update).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'alpha', host: '10.0.0.9' })))
    expect(screen.queryByText('A connection with this name already exists in the group')).toBeNull()
  })
})
