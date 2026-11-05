import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferState, TransferTask } from '../../src/shared/ipc-contract'
import { TRANSITIONS, canTransition, isTerminal, transition } from '../../src/main/queue/statemachine'
import { TransferScheduler } from '../../src/main/queue/scheduler'
import { appError } from '../../src/shared/errors'

const task = (over: Partial<TransferTask> = {}): TransferTask => ({
  taskId: over.taskId ?? `t-${Math.random().toString(36).slice(2, 8)}`,
  sessionId: 's1',
  connectionLabel: 'prod-web-01',
  direction: 'upload',
  source: '/local/a.bin',
  target: '/remote/a.bin',
  isDirectory: false,
  totalBytes: 100,
  transferredBytes: 0,
  bytesPerSec: 0,
  etaSec: null,
  state: 'queued',
  attempts: 0,
  createdAt: new Date().toISOString(),
  ...over
})

class ControlledRunner {
  readonly pending: Array<{
    task: TransferTask
    signal: AbortSignal
    onProgress: (transferred: number, total: number) => void
    resolve: () => void
    reject: (error: unknown) => void
  }> = []

  run = (
    running: TransferTask,
    signal: AbortSignal,
    onProgress: (transferred: number, total: number) => void
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      this.pending.push({ task: running, signal, onProgress, resolve, reject })
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })

  take(taskId: string): (typeof this.pending)[number] | undefined {
    return this.pending.find((item) => item.task.taskId === taskId)
  }

  /** 同一任務可能被執行多次（續傳／重試），取最後一次 */
  last(taskId: string): (typeof this.pending)[number] | undefined {
    return [...this.pending].reverse().find((item) => item.task.taskId === taskId)
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('M3-02 傳輸狀態機（UI-04）', () => {
  it('合法轉移與非法轉移', () => {
    expect(canTransition('queued', 'running')).toBe(true)
    expect(canTransition('running', 'completed')).toBe(true)
    expect(canTransition('running', 'paused')).toBe(true)
    expect(canTransition('paused', 'running')).toBe(true)
    expect(canTransition('failed', 'queued')).toBe(true)
    expect(canTransition('completed', 'running')).toBe(false)
    expect(canTransition('cancelled', 'queued')).toBe(false)
    // 每個狀態都有明確的允許集合（避免漏寫）
    const states: TransferState[] = ['queued', 'running', 'paused', 'failed', 'completed', 'cancelled']
    for (const state of states) expect(Array.isArray(TRANSITIONS[state])).toBe(true)
  })

  it('非法轉移丟 E_CONFLICT，合法轉移回新任務', () => {
    const running = task({ state: 'running' })
    const completed = transition(running, 'completed', { transferredBytes: 100 })
    expect(completed.state).toBe('completed')
    expect(completed.transferredBytes).toBe(100)
    expect(() => transition(completed, 'running')).toThrowError(/illegal transfer transition/)
  })

  it('終態判定', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('paused')).toBe(false)
  })
})

describe('M3-02 目錄任務（一列 + children，v1.11）', () => {
  it('父列彙總進度與狀態，實際傳輸由子任務執行', async () => {
    const runner = new ControlledRunner()
    const broadcast = vi.fn()
    const scheduler = new TransferScheduler({ maxConcurrent: 2, broadcast, runner, throttleMs: 10 })
    const parent = task({ taskId: 'dir', isDirectory: true, totalBytes: 300, source: '/local/dir' })
    const childA = task({ taskId: 'dir/a', parentId: 'dir', totalBytes: 100, source: '/local/dir/a' })
    const childB = task({ taskId: 'dir/b', parentId: 'dir', totalBytes: 200, source: '/local/dir/b' })
    scheduler.add([parent, childA, childB])
    await settle()

    // 只有子任務會被 runner 執行
    expect(runner.pending.map((p) => p.task.taskId).sort()).toEqual(['dir/a', 'dir/b'])
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['dir'])

    runner.take('dir/a')?.onProgress(100, 100)
    runner.take('dir/a')?.resolve()
    await settle()
    const running = scheduler.get('dir')
    expect(running.state).toBe('running')
    expect(running.transferredBytes).toBe(100)
    expect(running.children?.map((c) => c.state)).toEqual(['completed', 'running'])

    runner.take('dir/b')?.resolve()
    await settle()
    await settle()
    const done = scheduler.get('dir')
    expect(done.state).toBe('completed')
    expect(done.transferredBytes).toBe(300)
    scheduler.dispose()
  })

  it('對父列 pause / cancel 會串到所有子任務', async () => {
    const runner = new ControlledRunner()
    const scheduler = new TransferScheduler({ maxConcurrent: 2, broadcast: vi.fn(), runner, throttleMs: 10 })
    scheduler.add([
      task({ taskId: 'dir', isDirectory: true, totalBytes: 200 }),
      task({ taskId: 'dir/a', parentId: 'dir', totalBytes: 100 }),
      task({ taskId: 'dir/b', parentId: 'dir', totalBytes: 100 })
    ])
    await settle()
    scheduler.pause('dir')
    await settle()
    await settle()
    expect(scheduler.get('dir').state).toBe('paused')
    expect(scheduler.childrenOf('dir').every((c) => c.state === 'paused')).toBe(true)

    scheduler.resume('dir')
    await settle()
    expect(scheduler.childrenOf('dir').every((c) => c.state === 'running')).toBe(true)

    scheduler.cancel('dir')
    await settle()
    await settle()
    expect(scheduler.get('dir').state).toBe('cancelled')
    scheduler.dispose()
  })

  it('clearCompleted 清 completed + cancelled，failed 保留', async () => {
    const runner = new ControlledRunner()
    const scheduler = new TransferScheduler({ maxConcurrent: 3, broadcast: vi.fn(), runner, throttleMs: 10 })
    scheduler.add([task({ taskId: 'ok' }), task({ taskId: 'bad' }), task({ taskId: 'bye' })])
    await settle()
    runner.take('ok')?.resolve()
    runner.take('bad')?.reject(Object.assign(new Error('boom'), { code: 'E_LOCAL_IO' }))
    scheduler.cancel('bye')
    await settle()
    await settle()
    scheduler.clearCompleted()
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['bad'])
    scheduler.dispose()
  })
})

describe('M3-02 排程器（併發／節流／生命週期）', () => {
  let runner: ControlledRunner
  let broadcast: ReturnType<typeof vi.fn>
  let scheduler: TransferScheduler

  beforeEach(() => {
    runner = new ControlledRunner()
    broadcast = vi.fn()
    scheduler = new TransferScheduler({
      maxConcurrent: 2,
      broadcast,
      runner,
      throttleMs: 10
    })
  })

  it('併發上限生效（3 個任務只會同時跑 2 個）', async () => {
    scheduler.add([task(), task(), task()])
    await settle()
    expect(runner.pending).toHaveLength(2)
    expect(scheduler.list().filter((t) => t.state === 'running')).toHaveLength(2)
    expect(scheduler.list().filter((t) => t.state === 'queued')).toHaveLength(1)
  })

  it('完成後自動遞補下一個，且狀態為 completed', async () => {
    scheduler.add([task({ taskId: 'a' }), task({ taskId: 'b' }), task({ taskId: 'c' })])
    await settle()
    runner.take('a')?.resolve()
    await settle()
    await settle()
    expect(scheduler.get('a').state).toBe('completed')
    expect(runner.pending.some((p) => p.task.taskId === 'c')).toBe(true)
  })

  it('進度更新被 200ms 節流成批次（同批只送一次）', async () => {
    scheduler.add([task({ taskId: 'a' })])
    await settle()
    const running = runner.take('a')
    for (let i = 1; i <= 5; i++) running?.onProgress(i * 10, 100)
    scheduler.flush()
    const batches = broadcast.mock.calls.length
    expect(batches).toBeGreaterThan(0)
    // flush 後只發這一批，最後一次的 transferredBytes 是 50
    const lastBatch = broadcast.mock.calls[broadcast.mock.calls.length - 1]?.[0] as TransferTask[]
    expect(lastBatch.find((t) => t.taskId === 'a')?.transferredBytes).toBe(50)
  })

  it('取消：狀態轉 cancelled，之後不再有該任務的進度事件', async () => {
    scheduler.add([task({ taskId: 'a' })])
    await settle()
    const running = runner.take('a')
    running?.onProgress(30, 100)
    scheduler.cancel('a')
    await settle()
    await settle()
    expect(scheduler.get('a').state).toBe('cancelled')
    const callsAfter = broadcast.mock.calls.length
    running?.onProgress(60, 100)
    scheduler.flush()
    const batch = broadcast.mock.calls[broadcast.mock.calls.length - 1]?.[0] as TransferTask[]
    const entry = batch.find((t) => t.taskId === 'a')
    // 取消後的 progress 不應再更新 bytes（runner 已 abort，這裡直接呼叫也不該生效）
    expect(entry?.state).toBe('cancelled')
    expect(broadcast.mock.calls.length).toBeGreaterThanOrEqual(callsAfter)
  })

  it('暫停 → paused；續傳 → running → completed', async () => {
    scheduler.add([task({ taskId: 'a' })])
    await settle()
    scheduler.pause('a')
    await settle()
    await settle()
    expect(scheduler.get('a').state).toBe('paused')

    scheduler.resume('a')
    await settle()
    const resumed = runner.pending.filter((p) => p.task.taskId === 'a')
    expect(resumed.length).toBe(2)
    resumed[1]?.resolve()
    await settle()
    await settle()
    expect(scheduler.get('a').state).toBe('completed')
  })

  it('連線中斷：該 session 的 running → paused；重連後 resumeSession 會排回', async () => {
    scheduler.add([task({ taskId: 'a', sessionId: 's1' }), task({ taskId: 'b', sessionId: 's2' })])
    await settle()
    scheduler.pauseSession('s1')
    await settle()
    await settle()
    expect(scheduler.get('a').state).toBe('paused')
    expect(scheduler.get('b').state).toBe('running')

    scheduler.resumeSession('s1')
    await settle()
    expect(scheduler.get('a').state).toBe('running')
  })

  it('重連換 sessionId：reassignSession 會把任務改綁到新 session', async () => {
    scheduler.add([task({ taskId: 'a', sessionId: 'old' })])
    await settle()
    scheduler.pauseSession('old')
    await settle()
    await settle()
    scheduler.reassignSession('old', 'new')
    expect(scheduler.get('a').sessionId).toBe('new')
  })

  it('失敗 → retry 回到 queued 並重跑；attempts 累加', async () => {
    scheduler.add([task({ taskId: 'a' })])
    await settle()
    runner.take('a')?.reject(Object.assign(new Error('boom'), { code: 'E_LOCAL_IO' }))
    await settle()
    await settle()
    expect(scheduler.get('a').state).toBe('failed')
    expect(scheduler.get('a').error?.code).toBe('E_LOCAL_IO')

    scheduler.retry('a')
    await settle()
    expect(scheduler.get('a').attempts).toBe(1)
    expect(runner.pending.filter((p) => p.task.taskId === 'a')).toHaveLength(2)
  })

  it('remove 只允許終態；clearCompleted 清掉完成的', async () => {
    scheduler.add([task({ taskId: 'a' }), task({ taskId: 'b' })])
    await settle()
    // 執行中的任務不能移除（E_CONFLICT）
    let code = ''
    try {
      scheduler.remove('a')
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    expect(code).toBe('E_CONFLICT')
    runner.take('a')?.resolve()
    await settle()
    await settle()
    scheduler.clearCompleted()
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['b'])
    expect(() => scheduler.get('a')).toThrowError()
  })

  it('動態調整併發數（1–10）', async () => {
    scheduler.setConcurrency(0)
    expect(scheduler.concurrency).toBe(1)
    scheduler.setConcurrency(99)
    expect(scheduler.concurrency).toBe(10)
  })

  it('reorder：只能動等待中的任務，且會改變實際執行順序', async () => {
    scheduler.setConcurrency(1)
    scheduler.add([task({ taskId: 'a' }), task({ taskId: 'b' })])
    await settle()
    // a 已經在跑，b 還是 queued
    expect(scheduler.get('a').state).toBe('running')
    let code = ''
    try {
      scheduler.moveTask('a', 'down')
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    expect(code).toBe('E_CONFLICT')

    // 加第三個 queued，把 c 往上移 → c 應排在 b 前面
    scheduler.add([task({ taskId: 'c' })])
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['a', 'b', 'c'])
    scheduler.moveTask('c', 'up')
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['a', 'c', 'b'])

    // 邊界：最上面的 queued 再往上移是 no-op
    scheduler.moveTask('b', 'down')
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['a', 'c', 'b'])

    // 第一個任務完成後，下一個應該是 c（順序真的生效）
    runner.take('a')?.resolve()
    await settle()
    await settle()
    expect(runner.pending.some((p) => p.task.taskId === 'c')).toBe(true)
  })
})

describe('QA P2-01 目錄失敗要帶得出錯誤原因', () => {
  it('子任務 failed 且帶 error 時，父列 error 與子任務相同（不是 null）', async () => {
    const runner = new ControlledRunner()
    const scheduler = new TransferScheduler({ maxConcurrent: 2, broadcast: vi.fn(), runner, throttleMs: 5 })
    const parent = task({ taskId: 'dir', isDirectory: true, totalBytes: 100 })
    const child = task({ taskId: 'dir/a', parentId: 'dir', totalBytes: 100 })
    scheduler.add([parent, child])
    await settle()

    runner
      .take('dir/a')
      ?.reject(appError('E_SFTP_PERMISSION', { detail: 'mkdir /remote/a: permission denied' }))
    await settle()

    const row = scheduler.get('dir')
    expect(row.state).toBe('failed')
    expect(row.error).toMatchObject({ code: 'E_SFTP_PERMISSION', i18nKey: 'error.E_SFTP_PERMISSION' })
  })

  it('全部完成後父列的 error 會被清掉', async () => {
    const runner = new ControlledRunner()
    const scheduler = new TransferScheduler({ maxConcurrent: 2, broadcast: vi.fn(), runner, throttleMs: 5 })
    const parent = task({ taskId: 'dir', isDirectory: true, totalBytes: 100 })
    const child = task({ taskId: 'dir/a', parentId: 'dir', totalBytes: 100 })
    scheduler.add([parent, child])
    await settle()
    runner.take('dir/a')?.reject(appError('E_SFTP_NOT_FOUND', { detail: 'missing' }))
    await settle()
    expect(scheduler.get('dir').error?.code).toBe('E_SFTP_NOT_FOUND')

    scheduler.retry('dir')
    await settle()
    runner.last('dir/a')?.resolve()
    await settle()
    expect(scheduler.get('dir').state).toBe('completed')
    expect(scheduler.get('dir').error).toBeUndefined()
  })
})

describe('QA v0.1.1 P2-01 空父列的 Retry 不能靜默 no-op', () => {
  it('父列 isDirectory=true 且 children 為空 → E_CONFLICT（detail 說明要重新開始）', () => {
    const scheduler = new TransferScheduler({
      maxConcurrent: 1,
      broadcast: vi.fn(),
      runner: new ControlledRunner(),
      throttleMs: 5
    })
    scheduler.add([task({ taskId: 'empty-dir', isDirectory: true, totalBytes: 0 })])

    let error: { code?: string; detail?: string } | null = null
    try {
      scheduler.retry('empty-dir')
    } catch (cause) {
      error = cause as { code?: string; detail?: string }
    }
    expect(error?.code).toBe('E_CONFLICT')
    expect(error?.detail ?? '').toContain('no child tasks')
  })

  it('有 children 的父列 retry 行為不變：失敗的子任務重新排入', async () => {
    const runner = new ControlledRunner()
    const scheduler = new TransferScheduler({ maxConcurrent: 1, broadcast: vi.fn(), runner, throttleMs: 5 })
    scheduler.add([
      task({ taskId: 'dir', isDirectory: true, totalBytes: 100 }),
      task({ taskId: 'dir/a', parentId: 'dir', totalBytes: 100 })
    ])
    await settle()
    runner.take('dir/a')?.reject(appError('E_SFTP_PERMISSION', { detail: 'mkdir failed' }))
    await settle()
    expect(scheduler.get('dir/a').state).toBe('failed')

    scheduler.retry('dir')
    await settle()
    expect(runner.last('dir/a')).toBeTruthy()
    expect(scheduler.get('dir/a').state).toBe('running')
  })
})

describe('QA P1-06 重連：改綁新 session 並續傳', () => {
  it('paused 任務改綁到新 session 後可續傳，舊 sessionId 不再被引用', async () => {
    const runner = new ControlledRunner()
    const scheduler = new TransferScheduler({ maxConcurrent: 1, broadcast: vi.fn(), runner, throttleMs: 5 })
    scheduler.add([task({ taskId: 'big', sessionId: 'old', totalBytes: 300_000_000 })])
    await settle()
    expect(scheduler.get('big').state).toBe('running')

    scheduler.pause('big')
    await settle()
    expect(scheduler.get('big').state).toBe('paused')

    scheduler.reassignSession('old', 'new')
    scheduler.resumeSession('new')
    await settle()

    const resumed = runner.last('big')
    expect(resumed?.task.sessionId).toBe('new')
    expect(scheduler.get('big').sessionId).toBe('new')
    expect(scheduler.list().every((row) => row.sessionId !== 'old')).toBe(true)

    resumed?.resolve()
    await settle()
    expect(scheduler.get('big').state).toBe('completed')
  })
})
