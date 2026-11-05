import type { AppError, TransferState, TransferTask } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'

/** UI-04 狀態機（M3-02）：所有合法轉移；非法轉移一律回 E_CONFLICT */
export const TRANSITIONS: Record<TransferState, readonly TransferState[]> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'paused', 'cancelled'],
  paused: ['running', 'cancelled'],
  failed: ['queued', 'cancelled'],
  completed: [],
  cancelled: []
}

export function canTransition(from: TransferState, to: TransferState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: TransferState, to: TransferState): void {
  if (!canTransition(from, to)) {
    throw appError('E_CONFLICT', {
      message: `illegal transfer transition ${from} → ${to}`,
      detail: `${from} → ${to}`
    }) as AppError
  }
}

export function transition(task: TransferTask, to: TransferState, patch: Partial<TransferTask> = {}): TransferTask {
  assertTransition(task.state, to)
  return { ...task, ...patch, state: to }
}

/** 終態（不會再有任何事件） */
export function isTerminal(state: TransferState): boolean {
  return state === 'completed' || state === 'cancelled'
}

/** 進行中（會佔用併發名額） */
export function isActive(state: TransferState): boolean {
  return state === 'running' || state === 'paused'
}

/**
 * 斷線 → 進行中的任務一律轉 paused（可續傳）。
 * 回傳新陣列，呼叫端負責廣播。
 */
export function pauseRunningForSession(tasks: TransferTask[], sessionId: string): TransferTask[] {
  return tasks.map((task) =>
    task.sessionId === sessionId && task.state === 'running'
      ? { ...task, state: 'paused' as TransferState }
      : task
  )
}
