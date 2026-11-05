import { describe, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import { openForward } from '../../src/main/transport/jump'
import type { AppError } from '../../src/shared/ipc-contract'

const fakeClient = (forwardOut: (...args: unknown[]) => void): Client =>
  ({ forwardOut }) as unknown as Client

const codeOf = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise
    throw new Error('expected rejection')
  } catch (error) {
    return error as AppError
  }
}

describe('v0.1.8 P1-02：forwardOut 不可無限等待，且目的端失敗要回 E_TARGET_TCP', () => {
  it('forwardOut 不回 callback（跳板端 127.0.0.1:1）→ 逾時回 E_TARGET_TCP，不卡住', async () => {
    const client = fakeClient(() => {
      /* 模擬 ssh2 不呼叫 callback 的情況 */
    })
    const started = Date.now()
    const error = await codeOf(openForward(client, { host: '127.0.0.1', port: 1 }, 30))
    expect(error.code).toBe('E_TARGET_TCP')
    expect(error.phase).toBe('target-tcp')
    expect(error.detail).toContain('127.0.0.1:1')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('forwardOut 回 Connection refused → E_TARGET_TCP', async () => {
    const client = fakeClient((_srcIp, _srcPort, _host, _port, cb) => {
      (cb as (error: Error) => void)(new Error('(SSH) Channel open failure: Connection refused'))
    })
    const error = await codeOf(openForward(client, { host: '10.1.2.11', port: 1 }, 1000))
    expect(error.code).toBe('E_TARGET_TCP')
    expect(error.phase).toBe('target-tcp')
  })

  it('forwardOut 回轉發被拒 → 維持 E_TUNNEL', async () => {
    const client = fakeClient((_srcIp, _srcPort, _host, _port, cb) => {
      (cb as (error: Error) => void)(new Error('(SSH) Channel open failure: Administratively prohibited'))
    })
    const error = await codeOf(openForward(client, { host: '10.1.2.11', port: 22 }, 1000))
    expect(error.code).toBe('E_TUNNEL')
    expect(error.phase).toBe('tunnel')
  })

  it('forwardOut 成功 → 回傳 stream', async () => {
    const stream = { close: vi.fn() }
    const client = fakeClient((_srcIp, _srcPort, _host, _port, cb) => {
      (cb as (error: null, stream: unknown) => void)(null, stream)
    })
    await expect(openForward(client, { host: '10.1.2.11', port: 22 }, 1000)).resolves.toBe(stream)
  })
})
