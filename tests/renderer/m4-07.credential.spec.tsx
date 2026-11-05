import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, cleanup } from '@testing-library/react'
import type { AppError, SessionInfo } from '../../src/shared/ipc-contract'
import { useSessions } from '../../src/renderer/features/terminal/useSessions'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const session = (sessionId: string, state: SessionInfo['state']): SessionInfo => ({
  sessionId,
  profileId: 'p1',
  protocol: 'ssh',
  state,
  phase: state === 'connected' ? 'ready' : 'target-auth',
  host: '10.0.0.1',
  port: 22,
  cols: 120,
  rows: 30
})

const authError: AppError = {
  code: 'E_TARGET_AUTH',
  message: 'auth failed',
  i18nKey: 'error.E_TARGET_AUTH',
  retryable: true
}

const stubSession = (reconnectResult: unknown) => {
  const open = vi.fn().mockResolvedValue({ ok: true, data: session('s2', 'connected') })
  let onStateCb: ((info: SessionInfo) => void) | null = null
  const rs = {
    session: {
      // main 的 open/reconnect 成功會 broadcast rs:evt:session:state；stub 收下 cb 以便測試模擬
      onState: vi.fn().mockImplementation((cb: (info: SessionInfo) => void) => {
        onStateCb = cb
        return () => undefined
      }),
      open,
      close: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      reconnect: vi.fn().mockResolvedValue(reconnectResult),
      write: vi.fn(),
      resize: vi.fn(),
      snapshot: vi.fn()
    }
  }
  Object.defineProperty(window, 'rs', { value: rs, configurable: true })
  return { open, reconnect: rs.session.reconnect, emitState: (info: SessionInfo) => onStateCb?.(info) }
}

describe('M4-07 重連憑證補輸入', () => {
  it('E_TARGET_AUTH 辨識 → 跳憑證框；送出後以 ephemeral.secret 重開成功', async () => {
    const { open, emitState } = stubSession({ ok: false, error: authError })
    const { result } = renderHook(() => useSessions())

    // 先開一個 session 建立鏡像（profileId p1, sessionId s1）
    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      await result.current.open('p1')
      emitState(session('s1', 'connected'))
    })
    expect(result.current.sessions).toHaveLength(1)

    // 重連失敗 E_TARGET_AUTH → pendingCredential 出現
    await act(async () => {
      await result.current.reconnect('s1')
    })
    expect(result.current.pendingCredential).toEqual({ sessionId: 's1', profileId: 'p1', error: authError })

    // 送出暫時憑證 → 以 ephemeral.secret 重開同 profile，成功後清除提示
    await act(async () => {
      await result.current.submitCredential('pw-123')
      emitState(session('s2', 'connected'))
    })
    expect(open).toHaveBeenLastCalledWith({
      profileId: 'p1',
      cols: 120,
      rows: 30,
      ephemeral: { secret: 'pw-123' }
    })
    expect(result.current.pendingCredential).toBeNull()
    expect(result.current.active?.sessionId).toBe('s2')
    // 舊 s1 已被換掉
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s2'])
  })

  it('取消補輸入：維持斷線、不再呼叫 reconnect/open', async () => {
    const { open, reconnect, emitState } = stubSession({ ok: false, error: authError })
    const { result } = renderHook(() => useSessions())

    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      await result.current.open('p1')
      emitState(session('s1', 'connected'))
    })
    await act(async () => {
      await result.current.reconnect('s1')
    })
    expect(result.current.pendingCredential).not.toBeNull()

    const reconnectCalls = reconnect.mock.calls.length
    const openCalls = open.mock.calls.length

    await act(async () => {
      result.current.cancelCredential()
    })
    expect(result.current.pendingCredential).toBeNull()
    // 取消後不再有任何自動重試
    expect(reconnect.mock.calls.length).toBe(reconnectCalls)
    expect(open.mock.calls.length).toBe(openCalls)
    // 舊 session 維持斷線（reconnect 失敗時 main 廣播的狀態；renderer 鏡像未被換掉）
    expect(result.current.sessions[0]?.sessionId).toBe('s1')
  })

  /* P1-05：main 的 reconnect 是 close 舊 + open —— open 失敗後舊 session 已不存在，
     第二次 reconnect 會拿到 E_NOT_FOUND（不在憑證碼清單 → 曾靜默卡死）。 */
  it('取消憑證後再按 Reconnect Now：E_NOT_FOUND 改走 open，憑證框再次出現（可重試）', async () => {
    const { open, reconnect, emitState } = stubSession({ ok: false, error: authError })
    const notFoundError: AppError = { code: 'E_NOT_FOUND', message: 'gone', i18nKey: 'error.E_NOT_FOUND', retryable: false }
    const vaultError: AppError = { code: 'E_VAULT_UNAVAILABLE', message: 'no secret', i18nKey: 'error.E_VAULT_UNAVAILABLE', retryable: true }
    const { result } = renderHook(() => useSessions())

    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      await result.current.open('p1')
      emitState(session('s1', 'failed'))
    })

    // 第一次：憑證碼 → 憑證框
    reconnect.mockResolvedValueOnce({ ok: false, error: authError })
    await act(async () => {
      await result.current.reconnect('s1')
    })
    expect(result.current.pendingCredential).not.toBeNull()

    // 取消（維持斷線，不自動重試 —— 與既有 case 相同）
    await act(async () => {
      result.current.cancelCredential()
    })
    expect(result.current.pendingCredential).toBeNull()

    // 第二次：main 已 close 舊 session → E_NOT_FOUND → 以 profileId 重新 open → 憑證碼 → 憑證框再現
    reconnect.mockResolvedValueOnce({ ok: false, error: notFoundError })
    open.mockResolvedValue({ ok: false, error: vaultError })
    await act(async () => {
      await result.current.reconnect('s1')
    })
    expect(reconnect).toHaveBeenCalledTimes(2)
    // fallback open：用 profileId 重開（不帶 ephemeral）
    expect(open).toHaveBeenLastCalledWith({ profileId: 'p1', cols: 120, rows: 30 })
    expect(result.current.pendingCredential).toEqual({ sessionId: 's1', profileId: 'p1', error: vaultError })
  })

  it('連按兩次 Reconnect 不產生重複 session（in-flight guard）', async () => {
    const { open, reconnect, emitState } = stubSession({ ok: false, error: authError })
    const { result } = renderHook(() => useSessions())

    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      await result.current.open('p1')
      emitState(session('s1', 'failed'))
    })

    let resolveFirst: ((value: unknown) => void) | null = null
    reconnect.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    await act(async () => {
      void result.current.reconnect('s1')
      void result.current.reconnect('s1') // 第二次在 in-flight 期間 → 直接忽略
    })
    expect(reconnect).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst?.({ ok: true, data: session('s2', 'connected') })
      emitState(session('s2', 'connected'))
    })
    // 唯一新分頁取代舊分頁
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s2'])
  })

  /* P1-01 分頁殭屍：onState 只更新已存在 id（第 1 層）＋ connected 清同 profile failed（第 2 層） */
  it('P1-01：未知 sessionId 的 onState 不會新增分頁', async () => {
    const { open, emitState } = stubSession({ ok: false, error: authError })
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      await result.current.open('p1')
    })
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s1'])

    // main close 舊 session 時的殘餘 broadcast（舊 id 已不在清單）→ 忽略
    await act(async () => {
      emitState(session('s-zombie', 'failed'))
    })
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s1'])
  })

  it('P1-01：同 profile 新 session 進入 connected → 舊 failed 分頁被清（第 2 層）', async () => {
    const { open, emitState } = stubSession({ ok: false, error: authError })
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      await result.current.open('p1')
    })
    await act(async () => {
      emitState(session('s1', 'failed'))
    })
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s1'])

    // 使用者再次連線同 profile：新 connected 進來時，舊 failed 要被清掉
    await act(async () => {
      open.mockResolvedValueOnce({ ok: true, data: session('s2', 'connected') })
      await result.current.open('p1')
    })
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s2'])
  })

  it('P1-01：連續 3 輪「斷線→憑證重連」→ 最後 1 個分頁、無 failed 殭屍', async () => {
    const { open, emitState } = stubSession({ ok: false, error: authError })
    const { result } = renderHook(() => useSessions())
    open
      .mockResolvedValueOnce({ ok: true, data: session('s1', 'connected') })
      .mockResolvedValueOnce({ ok: true, data: session('s2', 'connected') })
      .mockResolvedValueOnce({ ok: true, data: session('s3', 'connected') })
      .mockResolvedValueOnce({ ok: true, data: session('s4', 'connected') })
    await act(async () => {
      await result.current.open('p1')
    })

    let current = 's1'
    for (const next of ['s2', 's3', 's4']) {
      await act(async () => {
        emitState(session(current, 'failed')) // 斷線
      })
      await act(async () => {
        await result.current.reconnect(current) // 憑證碼 → 憑證框
      })
      expect(result.current.pendingCredential).not.toBeNull()
      await act(async () => {
        await result.current.submitCredential('pw') // 補密碼重連 → 新分頁
      })
      expect(result.current.pendingCredential).toBeNull()
      await act(async () => {
        emitState(session(current, 'failed')) // main close 舊 id 的殘餘 broadcast → 必須被忽略
      })
      current = next
    }

    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(['s4'])
    expect(result.current.sessions.every((item) => item.state !== 'failed')).toBe(true)
  })
})
