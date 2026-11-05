import type { Client, ClientChannel } from 'ssh2'
import { appError } from '../../shared/errors'
import { TIMING } from '../../shared/constants'
import type { AppError } from '../../shared/ipc-contract'

export interface ForwardTarget {
  host: string
  port: number
}

/** 目的端連不上（拒絕／逾時／不可達）→ E_TARGET_TCP；其他（禁止轉發等）才是 E_TUNNEL */
const TARGET_UNREACHABLE = /connection refused|connection timed out|operation timed out|timed out|ehostunreach|enetunreach/i

/**
 * 跳板（C-4／PM 決策 3 單跳）：
 * 在跳板連線上開 direct-tcpip 通道，回傳的 socket 直接當第二個 Client 的 `sock` 使用。
 *
 * v0.1.8 P1-02：ssh2 對某些 forwardOut 失敗（例如跳板端 127.0.0.1:1）不會呼叫 callback，
 * 造成 session.open 永遠不 resolve、renderer 收不到任何錯誤。這裡加 TIMING.tcpTimeoutMs
 * 上限並保證 reject：
 * - 目的端拒絕／逾時／不可達 → E_TARGET_TCP（toast 顯示 target host:port）
 * - 其他通道錯誤（轉發被拒等）→ E_TUNNEL
 */
export function openForward(
  jumpClient: Client,
  target: ForwardTarget,
  timeoutMs: number = TIMING.tcpTimeoutMs
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const detail = `tunnel ${target.host}:${target.port}`

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          appError('E_TARGET_TCP', {
            phase: 'target-tcp',
            message: `forwardOut timed out after ${timeoutMs}ms`,
            detail
          }) satisfies AppError
        )
      )
    }, timeoutMs)

    try {
      jumpClient.forwardOut('127.0.0.1', 0, target.host, target.port, (error, stream) => {
        if (error) {
          const message = error.message ?? ''
          const code = TARGET_UNREACHABLE.test(message) ? 'E_TARGET_TCP' : 'E_TUNNEL'
          finish(() =>
            reject(
              appError(code, {
                phase: code === 'E_TARGET_TCP' ? 'target-tcp' : 'tunnel',
                message: `forwardOut failed: ${message}`,
                detail
              }) satisfies AppError
            )
          )
          return
        }
        finish(() => resolve(stream))
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish(() =>
        reject(
          appError('E_TUNNEL', {
            phase: 'tunnel',
            message: `forwardOut threw: ${message}`,
            detail
          }) satisfies AppError
        )
      )
    }
  })
}
