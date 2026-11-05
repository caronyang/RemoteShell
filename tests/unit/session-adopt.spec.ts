import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../../src/shared/ipc-contract'
import { adoptTransfersToSession } from '../../src/main/ipc/handlers/session'

// 這個 helper 從 handlers/session 匯出，該模組 import 了 ipc/register → electron
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: 's1',
  profileId: 'p1',
  protocol: 'ssh',
  state: 'disconnected',
  phase: 'ready',
  host: '10.1.2.11',
  port: 22,
  cols: 120,
  rows: 30,
  ...over
})

describe('QA P1-06 新 session 接手舊 session 的暫停任務', () => {
  it('斷線中的舊 session 與已 close 的舊 session 都改綁，並觸發續傳', () => {
    const reassign = vi.fn()
    const resume = vi.fn()
    const opened = session({ sessionId: 'new', state: 'connected' })

    const adopted = adoptTransfersToSession(
      [
        session({ sessionId: 'old-disconnected', state: 'disconnected' }),
        session({ sessionId: 'old-failed', state: 'failed' }),
        session({ sessionId: 'still-connected', state: 'connected' }),
        session({ sessionId: 'new', state: 'connected' })
      ],
      ['old-closed'],
      { reassignSession: reassign, resumeSession: resume },
      opened
    )

    expect(adopted.sort()).toEqual(['old-closed', 'old-disconnected', 'old-failed'])
    expect(reassign.mock.calls).toEqual(
      expect.arrayContaining([
        ['old-closed', 'new'],
        ['old-disconnected', 'new'],
        ['old-failed', 'new']
      ])
    )
    expect(reassign).toHaveBeenCalledTimes(3)
    expect(resume).toHaveBeenCalledWith('new')
  })

  it('不同 profile 的舊 session 不動（避免把任務綁到錯的主機）', () => {
    const reassign = vi.fn()
    const resume = vi.fn()
    const opened = session({ sessionId: 'new', state: 'connected' })

    const adopted = adoptTransfersToSession(
      [session({ sessionId: 'other-profile', profileId: 'p2', state: 'disconnected' })],
      [],
      { reassignSession: reassign, resumeSession: resume },
      opened
    )

    expect(adopted).toEqual([])
    expect(reassign).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('沒有舊 session 時不呼叫 reassign／resume', () => {
    const reassign = vi.fn()
    const resume = vi.fn()
    const opened = session({ sessionId: 'new', state: 'connected' })

    expect(adoptTransfersToSession([opened], [], { reassignSession: reassign, resumeSession: resume }, opened)).toEqual([])
    expect(reassign).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })
})
