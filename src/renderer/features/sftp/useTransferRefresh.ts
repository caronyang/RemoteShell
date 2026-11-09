import { useEffect, useRef } from 'react'
import type { TransferTask } from '../../../shared/ipc-contract'
import { panesToRefresh } from './transferRefresh'

export interface TransferRefreshOptions {
  localPath: string
  remotePath: string
  onRefreshLocal: () => void
  onRefreshRemote: () => void
}

/**
 * 訂閱傳輸完成事件並依任務方向刷新對應面板（v0.1.11 #3／#4）。
 * 只訂閱一次；路徑與 callback 走 ref，永遠使用最新值；
 * 同一 taskId 的 completed 事件只處理一次；卸載時解除訂閱。
 */
export function useTransferRefresh(sessionId: string, options: TransferRefreshOptions): void {
  const latestRef = useRef({ sessionId, ...options })
  latestRef.current = { sessionId, ...options }

  const handledRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const transfer = window.rs?.transfer
    if (!transfer) return undefined

    const off = transfer.onUpdate((batch: TransferTask[]) => {
      for (const task of batch) {
        if (task.state !== 'completed') continue
        if (handledRef.current.has(task.taskId)) continue
        handledRef.current.add(task.taskId)

        const latest = latestRef.current
        const panes = panesToRefresh(task, {
          sessionId: latest.sessionId,
          localPath: latest.localPath,
          remotePath: latest.remotePath
        })
        if (panes.local) latest.onRefreshLocal()
        if (panes.remote) latest.onRefreshRemote()
      }
    })

    return off
  }, [])
}
