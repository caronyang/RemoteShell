import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import type { SftpEntry, SessionInfo } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components/Toast'
import { AuthTab } from '../../src/renderer/features/connections/AuthTab'
import { DualPane } from '../../src/renderer/features/sftp/DualPane'

const i18n = initI18n('en-US')

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await i18n.changeLanguage('en-US')
})

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

/* ---------- v0.1.4 #1 UI：AuthTab 金鑰檔瀏覽 ---------- */

describe('v0.1.4 #1：AuthTab 金鑰檔改用 app.pickFile', () => {
  const authValues = {
    method: 'publicKey' as const,
    username: 'tester',
    password: '',
    rememberPassword: true,
    filePath: '',
    keyPath: 'C:\\keys\\old_ed25519',
    passphrase: '',
    rememberPassphrase: false
  }

  it('選到檔案 → onChange(keyPath)；取消（null）不覆寫原值', async () => {
    const pickFile = vi.fn().mockResolvedValueOnce({ ok: true, data: 'C:\\keys\\id_ed25519' })
    Object.defineProperty(window, 'rs', { value: { app: { pickFile } }, configurable: true })
    const onChange = vi.fn()

    render(
      wrap(
        <AuthTab
          values={authValues}
          onChange={onChange}
          errors={{}}
          connectionId={null}
        />
      )
    )

    fireEvent.click(screen.getByRole('button', { name: /^Browse/ }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ keyPath: 'C:\\keys\\id_ed25519' }))
    expect(pickFile).toHaveBeenCalledWith('C:\\keys\\old_ed25519')

    onChange.mockClear()
    pickFile.mockResolvedValueOnce({ ok: true, data: null })
    fireEvent.click(screen.getByRole('button', { name: /^Browse/ }))
    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(2))
    expect(onChange).not.toHaveBeenCalled()
  })
})

/* ---------- v0.1.4 #9：DualPane 本地面板 mount-once ---------- */

const localEntries: SftpEntry[] = [
  { name: 'logs', path: 'C:\\Users\\demo\\logs', type: 'dir', size: 0, mtimeMs: 0, isSymlink: false }
]

const installDualPaneRs = (): { home: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } => {
  const home = vi.fn().mockResolvedValue({ ok: true, data: 'C:\\Users\\demo' })
  const list = vi.fn().mockImplementation((path: string) =>
    Promise.resolve({
      ok: true,
      data: { path, entries: localEntries, drives: ['C:\\'] }
    })
  )
  const rs = {
    localFs: {
      home,
      list,
      mkdir: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn()
    },
    sftp: {
      open: vi.fn().mockResolvedValue({ ok: true, data: { sftpId: 'sf1', home: '/home/u' } }),
      close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      list: vi.fn().mockResolvedValue({ ok: true, data: { path: '/home/u', entries: [] } }),
      mkdir: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn()
    },
    transfer: { plan: vi.fn(), start: vi.fn() }
  }
  Object.defineProperty(window, 'rs', { value: rs, configurable: true })
  return { home, list }
}

describe('v0.1.4 #9：DualPane 本地面板只初始化一次', () => {
  it('rerender／語系變更（listLocal identity 改變）不再重新導回 home', async () => {
    const { home, list } = installDualPaneRs()
    const { rerender } = render(wrap(<DualPane session={session} onClose={() => undefined} />))

    await waitFor(() => expect(home).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(list).toHaveBeenCalledWith('C:\\Users\\demo'))

    // 模擬「開收佇列／切換語系」造成的 rerender（t／toast identity 改變 → listLocal 換新）
    rerender(wrap(<DualPane session={{ ...session }} onClose={() => undefined} />))
    await act(async () => {
      await i18n.changeLanguage('zh-TW')
    })
    rerender(wrap(<DualPane session={{ ...session }} onClose={() => undefined} />))
    await act(async () => {
      await i18n.changeLanguage('en-US')
    })

    expect(home).toHaveBeenCalledTimes(1)
    // home 只被列一次；後續 rerender 不得再以 home 蓋回目前路徑
    expect(list.mock.calls.filter(([path]) => path === 'C:\\Users\\demo')).toHaveLength(1)
  })
})
