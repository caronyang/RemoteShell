import type { AppError, TransferState, TransferTask } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'
import { TIMING } from '../../shared/constants'
import { isTerminal, transition } from './statemachine'

export interface TaskRunner {
  /** 執行單一任務；progress 由 runner 回報（呼叫端已做節流） */
  run(task: TransferTask, signal: AbortSignal, onProgress: (transferred: number, total: number) => void): Promise<void>
}

export interface SchedulerDeps {
  maxConcurrent: number
  broadcast: (batch: TransferTask[]) => void
  runner: TaskRunner
  throttleMs?: number
  now?: () => number
}

interface Runtime {
  controller: AbortController
  startedAt: number
  lastBytes: number
  lastAt: number
}

/**
 * 傳輸佇列排程（M3-02 / UI-04）
 * - 併發 1–10，動態調整
 * - 進度事件 200ms 節流批次（`rs:evt:transfer:update`）
 * - 取消／暫停用 AbortSignal；暫停後可續傳（offset 由 sftp/resume 決定）
 * - 斷線：該 session 的 running 任務轉 paused；重連後 resumeSession() 繼續
 * - 目錄任務（v1.11）：父列 `isDirectory=true` 只做彙總，實際傳輸是帶 `parentId` 的子任務；
 *   對父列的 pause/resume/cancel/remove 會串到所有子任務
 */
export class TransferScheduler {
  /** 所有任務（父列 + 子任務 + 單檔任務） */
  private readonly tasks = new Map<string, TransferTask>()
  /** 父列顯示順序（只有 parentId 為空的才會出現） */
  private readonly order: string[] = []
  private readonly runtimes = new Map<string, Runtime>()
  private readonly ready: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private readonly throttleMs: number
  private readonly now: () => number
  private maxConcurrent: number
  /** 已送出取消/暫停請求的任務，等 runner 收尾時決定最終狀態 */
  private readonly pending = new Map<string, 'cancel' | 'pause'>()

  constructor(private readonly deps: SchedulerDeps) {
    this.maxConcurrent = Math.min(10, Math.max(1, deps.maxConcurrent))
    this.throttleMs = deps.throttleMs ?? TIMING.transferThrottleMs
    this.now = deps.now ?? (() => Date.now())
  }

  /** 佇列列（父列 / 單檔）；目錄父列的 children 會即時彙總 */
  list(): TransferTask[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((task): task is TransferTask => Boolean(task))
      .map((task) => this.snapshot(task))
  }

  get(taskId: string): TransferTask {
    const task = this.tasks.get(taskId)
    if (!task) throw appError('E_NOT_FOUND', { detail: `task ${taskId}` })
    return this.snapshot(task)
  }

  get concurrency(): number {
    return this.maxConcurrent
  }

  setConcurrency(next: number): void {
    this.maxConcurrent = Math.min(10, Math.max(1, Math.trunc(next)))
    this.pump()
  }

  childrenOf(taskId: string): TransferTask[] {
    return [...this.tasks.values()].filter((task) => task.parentId === taskId)
  }

  /** 加入佇列：目錄父列（children 由 handler 先建好並帶 parentId）或單檔任務 */
  add(tasks: TransferTask[]): TransferTask[] {
    const added: TransferTask[] = []
    for (const task of tasks) {
      if (task.state !== 'queued') throw appError('E_VALIDATION', { detail: 'new task must be queued' })
      this.tasks.set(task.taskId, { ...task })
      added.push(task)
      if (!task.parentId) {
        this.order.push(task.taskId)
        if (!task.isDirectory) this.ready.push(task.taskId)
      } else if (!task.isDirectory) {
        this.ready.push(task.taskId)
      }
    }
    this.recomputeParents()
    this.markDirty()
    this.pump()
    return added
  }

  pause(taskId: string): void {
    const task = this.get(taskId)
    if (task.isDirectory) {
      for (const child of this.childrenOf(taskId)) this.pause(child.taskId)
      this.refreshParent(taskId)
      return
    }
    if (task.state === 'queued') {
      const index = this.ready.indexOf(taskId)
      if (index >= 0) this.ready.splice(index, 1)
      this.replace(taskId, transition(task, 'paused'))
      return
    }
    if (task.state !== 'running') throw appError('E_CONFLICT', { detail: `cannot pause ${task.state}` })
    this.pending.set(taskId, 'pause')
    this.runtimes.get(taskId)?.controller.abort()
  }

  resume(taskId: string): void {
    const task = this.get(taskId)
    if (task.isDirectory) {
      for (const child of this.childrenOf(taskId)) {
        if (child.state === 'paused') this.resume(child.taskId)
      }
      this.refreshParent(taskId)
      return
    }
    if (task.state !== 'paused') throw appError('E_CONFLICT', { detail: `cannot resume ${task.state}` })
    this.replace(taskId, { ...task, state: 'running' })
    this.ready.push(taskId)
    this.pump()
  }

  cancel(taskId: string): void {
    const task = this.get(taskId)
    if (task.isDirectory) {
      for (const child of this.childrenOf(taskId)) {
        if (!isTerminal(child.state)) this.cancel(child.taskId)
      }
      this.refreshParent(taskId)
      return
    }
    if (isTerminal(task.state)) return
    if (task.state === 'queued') {
      const index = this.ready.indexOf(taskId)
      if (index >= 0) this.ready.splice(index, 1)
      this.replace(taskId, { ...task, state: 'cancelled', bytesPerSec: 0, etaSec: null })
      return
    }
    this.pending.set(taskId, 'cancel')
    this.runtimes.get(taskId)?.controller.abort()
  }

  retry(taskId: string): void {
    const task = this.get(taskId)
    if (task.isDirectory) {
      const children = this.childrenOf(taskId)
      // QA v0.1.1 P2-01：空父列（例如 mkdir 失敗、根本沒有子任務）不能靜默 no-op
      if (children.length === 0) {
        throw appError('E_CONFLICT', {
          detail: `directory task ${taskId} has no child tasks to retry; restart the transfer`
        })
      }
      for (const child of children) {
        if (child.state === 'failed') this.retry(child.taskId)
      }
      this.refreshParent(taskId)
      return
    }
    if (task.state !== 'failed') throw appError('E_CONFLICT', { detail: `cannot retry ${task.state}` })
    this.replace(taskId, {
      ...task,
      state: 'queued',
      attempts: task.attempts + 1,
      error: undefined,
      bytesPerSec: 0,
      etaSec: null
    })
    this.ready.push(taskId)
    this.pump()
  }

  remove(taskId: string): void {
    const task = this.get(taskId)
    if (!isTerminal(task.state) && !task.isDirectory) {
      throw appError('E_CONFLICT', { detail: `cannot remove ${task.state}` })
    }
    if (task.isDirectory) {
      const children = this.childrenOf(taskId)
      if (children.some((child) => !isTerminal(child.state))) {
        throw appError('E_CONFLICT', { detail: 'directory task still has active children' })
      }
      for (const child of children) this.tasks.delete(child.taskId)
    }
    this.tasks.delete(taskId)
    const index = this.order.indexOf(taskId)
    if (index >= 0) this.order.splice(index, 1)
    this.markDirty()
  }

  /** completed + cancelled（failed 保留，讓使用者看到失敗原因） */
  clearCompleted(): void {
    for (const id of [...this.order]) {
      const task = this.tasks.get(id)
      if (!task) continue
      if (task.state === 'completed' || task.state === 'cancelled') {
        for (const child of this.childrenOf(id)) this.tasks.delete(child.taskId)
        this.tasks.delete(id)
        this.order.splice(this.order.indexOf(id), 1)
      }
    }
    this.markDirty()
  }

  /** UI-04 佇列優先權調整：只允許等待中的列（目錄列需全部子任務都還沒開始） */
  moveTask(taskId: string, direction: 'up' | 'down'): void {
    const task = this.get(taskId)
    const children = this.childrenOf(taskId)
    const reorderable = task.isDirectory
      ? children.length > 0 && children.every((child) => child.state === 'queued')
      : task.state === 'queued'
    if (!reorderable) {
      throw appError('E_CONFLICT', { detail: `only queued tasks can be reordered (${task.state})` })
    }

    const ids = [...this.order]
    const index = ids.indexOf(taskId)
    const target = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= ids.length) return
    const neighbourId = ids[target] as string

    // 1. 顯示順序：兩列互換
    const nextOrder = [...ids]
    nextOrder[index] = neighbourId
    nextOrder[target] = taskId
    this.order.splice(0, this.order.length, ...nextOrder)

    // 2. 執行順序：兩列（含目錄的子任務區塊）在 ready 佇列裡的位置互換
    const blockOf = (id: string): string[] => {
      const found = this.tasks.get(id)
      return found?.isDirectory ? this.childrenOf(id).map((child) => child.taskId) : [id]
    }
    const selfBlock = blockOf(taskId).filter((id) => this.ready.includes(id))
    const neighbourBlock = blockOf(neighbourId).filter((id) => this.ready.includes(id))
    if (selfBlock.length > 0 && neighbourBlock.length > 0) {
      const slots = [...new Set([...selfBlock, ...neighbourBlock].map((id) => this.ready.indexOf(id)))]
        .filter((position) => position >= 0)
        .sort((a, b) => a - b)
      const merged = direction === 'up' ? [...selfBlock, ...neighbourBlock] : [...neighbourBlock, ...selfBlock]
      slots.forEach((position, i) => {
        const value = merged[i]
        if (value) this.ready[position] = value
      })
    }
    this.markDirty()
  }

  /** 連線中斷：running → paused（可續傳），queued 保留 */
  pauseSession(sessionId: string): void {
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId || task.isDirectory) continue
      if (task.state === 'running') {
        this.pending.set(task.taskId, 'pause')
        this.runtimes.get(task.taskId)?.controller.abort()
      }
    }
  }

  reassignSession(fromSessionId: string, toSessionId: string): void {
    for (const [id, task] of this.tasks) {
      if (task.sessionId !== fromSessionId) continue
      this.tasks.set(id, { ...task, sessionId: toSessionId })
    }
    this.markDirty()
  }

  /** 重連後把 paused 的任務排回去 */
  resumeSession(sessionId: string): void {
    for (const task of [...this.tasks.values()]) {
      if (task.sessionId !== sessionId || task.isDirectory) continue
      if (task.state !== 'paused') continue
      this.resume(task.taskId)
    }
  }

  /** 立即送出目前批次（測試／關閉前用） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    this.deps.broadcast(this.list())
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.controller.abort()
    this.flush()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /* ---------------- 內部 ---------------- */

  /** 父列：children 投影 + 進度／狀態彙總 */
  private snapshot(task: TransferTask): TransferTask {
    if (!task.isDirectory) return { ...task }
    const children = this.childrenOf(task.taskId)
    const totalBytes = children.reduce((sum, child) => sum + (child.totalBytes ?? 0), 0)
    const transferredBytes = children.reduce((sum, child) => sum + child.transferredBytes, 0)
    return {
      ...task,
      totalBytes,
      transferredBytes,
      children: children.map((child) => ({
        taskId: child.taskId,
        source: child.source,
        target: child.target,
        size: child.totalBytes ?? 0,
        state: child.state
      }))
    }
  }

  private refreshParent(parentId: string): void {
    const parent = this.tasks.get(parentId)
    if (!parent) return
    const children = this.childrenOf(parentId)
    if (children.length === 0) return
    const states = children.map((child) => child.state)
    let state: TransferState = 'queued'
    if (states.some((s) => s === 'running')) state = 'running'
    else if (states.every((s) => s === 'completed')) state = 'completed'
    else if (states.some((s) => s === 'failed')) state = 'failed'
    else if (states.every((s) => s === 'cancelled')) state = 'cancelled'
    else if (states.every((s) => s === 'paused' || s === 'cancelled')) state = 'paused'
    else if (states.some((s) => s === 'paused')) state = 'paused'
    // P2-01：父列失敗時要帶得出原因（取第一個有 error 的子任務），否則 UI 只剩 "Failed"
    const failedChild =
      children.find((child) => child.state === 'failed' && child.error) ??
      children.find((child) => child.state === 'failed')
    const snapshot = this.snapshot(parent)
    this.tasks.set(parentId, {
      ...parent,
      state,
      totalBytes: snapshot.totalBytes,
      transferredBytes: snapshot.transferredBytes,
      bytesPerSec: children.reduce((sum, child) => sum + child.bytesPerSec, 0),
      etaSec: children.every((child) => child.etaSec === null || child.etaSec === 0)
        ? null
        : Math.max(...children.map((child) => child.etaSec ?? 0)),
      ...(state === 'failed'
        ? {
            error:
              failedChild?.error ??
              appError('E_INTERNAL', { detail: `directory task ${parentId} failed without a child error` })
          }
        : { error: undefined })
    })
  }

  private recomputeParents(): void {
    for (const task of this.tasks.values()) {
      if (task.isDirectory) this.refreshParent(task.taskId)
    }
  }

  private replace(taskId: string, next: TransferTask): void {
    this.tasks.set(taskId, next)
    if (next.parentId) this.refreshParent(next.parentId)
    this.markDirty()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.throttleMs)
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) this.timer.unref()
  }

  private pump(): void {
    while (this.runtimes.size < this.maxConcurrent) {
      const id = this.ready.shift()
      if (!id) return
      const task = this.tasks.get(id)
      if (!task || task.isDirectory) continue
      if (task.state === 'queued') {
        this.replace(id, transition(task, 'running'))
      } else if (task.state !== 'running') {
        continue
      }
      void this.start(id)
    }
  }

  private async start(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    const controller = new AbortController()
    const startedAt = this.now()
    this.runtimes.set(taskId, { controller, startedAt, lastBytes: task.transferredBytes, lastAt: startedAt })

    const onProgress = (transferred: number, total: number): void => {
      const current = this.tasks.get(taskId)
      const runtime = this.runtimes.get(taskId)
      if (!current || !runtime) return
      const elapsed = Math.max(1, this.now() - runtime.lastAt)
      const delta = transferred - runtime.lastBytes
      const instantRate = delta > 0 ? (delta * 1000) / elapsed : 0
      runtime.lastAt = this.now()
      runtime.lastBytes = transferred
      const bytesPerSec = instantRate > 0 ? instantRate : current.bytesPerSec
      const remaining = total - transferred
      const next: TransferTask = {
        ...current,
        transferredBytes: transferred,
        totalBytes: total > 0 ? total : current.totalBytes,
        bytesPerSec,
        etaSec: bytesPerSec > 0 ? Math.ceil(remaining / bytesPerSec) : null
      }
      this.tasks.set(taskId, next)
      if (next.parentId) this.refreshParent(next.parentId)
      this.markDirty()
    }

    try {
      await this.deps.runner.run(this.tasks.get(taskId) as TransferTask, controller.signal, onProgress)
      const finished = this.tasks.get(taskId)
      if (!finished) return
      this.replace(taskId, {
        ...finished,
        state: 'completed',
        transferredBytes: finished.totalBytes ?? finished.transferredBytes,
        bytesPerSec: 0,
        etaSec: 0,
        error: undefined
      })
    } catch (cause) {
      const current = this.tasks.get(taskId)
      if (!current) return
      const intent = this.pending.get(taskId)
      if (intent === 'cancel') {
        this.replace(taskId, { ...current, state: 'cancelled', bytesPerSec: 0, etaSec: null })
      } else if (intent === 'pause' || (cause as { name?: string }).name === 'AbortError') {
        this.replace(taskId, { ...current, state: 'paused', bytesPerSec: 0, etaSec: null })
      } else {
        const error = cause as AppError
        this.replace(taskId, {
          ...current,
          state: 'failed',
          bytesPerSec: 0,
          etaSec: null,
          error: error.code ? error : appError('E_INTERNAL', { message: String(cause) })
        })
      }
    } finally {
      this.pending.delete(taskId)
      this.runtimes.delete(taskId)
      this.markDirty()
      this.pump()
    }
  }
}
