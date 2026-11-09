import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { RsApi, TransferTask } from '../../src/shared/ipc-contract'
import { useTransferRefresh, type TransferRefreshOptions } from '../../src/renderer/features/sftp/useTransferRefresh'

type Listener = (batch: TransferTask[]) => void

let listener: Listener | null = null
const unsubscribe = vi.fn()
const onUpdate = vi.fn((cb: Listener) => {
  listener = cb
  return unsubscribe
})

function makeTask(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    taskId: 'task-1',
    sessionId: 'sess-1',
    connectionLabel: 'dev@localhost',
    direction: 'upload',
    source: 'C:\\Users\\dev\\Downloads\\report.pdf',
    target: '/home/dev/project/report.pdf',
    isDirectory: false,
    totalBytes: 1024,
    transferredBytes: 1024,
    bytesPerSec: 0,
    state: 'completed',
    attempts: 1,
    createdAt: '2026-11-09T00:00:00.000Z',
    ...overrides
  }
}

function emit(batch: TransferTask[]): void {
  act(() => {
    listener?.(batch)
  })
}

function options(overrides: Partial<TransferRefreshOptions> = {}): TransferRefreshOptions {
  return {
    localPath: 'C:\\Users\\dev\\Downloads',
    remotePath: '/home/dev/project',
    onRefreshLocal: vi.fn(),
    onRefreshRemote: vi.fn(),
    ...overrides
  }
}

function mount(sessionId: string, opts: TransferRefreshOptions, props?: { sessionId: string; options: TransferRefreshOptions }) {
  return renderHook(
    (p: { sessionId: string; options: TransferRefreshOptions }) => useTransferRefresh(p.sessionId, p.options),
    { initialProps: props ?? { sessionId, options: opts } }
  )
}

beforeEach(() => {
  listener = null
  onUpdate.mockClear()
  unsubscribe.mockClear()
  unsubscribe.mockImplementation(() => {
    listener = null
  })
  ;(window as unknown as { rs: Partial<RsApi> }).rs = {
    transfer: { onUpdate } as unknown as RsApi['transfer']
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { rs?: Partial<RsApi> }).rs
})

describe('v0.1.11 #3/#4 useTransferRefresh', () => {
  it('訂閱一次，upload 完成只刷新遠端，重複事件不再觸發', () => {
    const opts = options()
    mount('sess-1', opts)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    emit([makeTask()])
    expect(opts.onRefreshRemote).toHaveBeenCalledTimes(1)
    expect(opts.onRefreshLocal).not.toHaveBeenCalled()

    emit([makeTask()])
    expect(opts.onRefreshRemote).toHaveBeenCalledTimes(1)
  })

  it('download 完成只刷新本機，且同一批多筆只各觸發一次', () => {
    const opts = options()
    mount('sess-1', opts)

    emit([
      makeTask({ taskId: 'task-2', direction: 'download', target: 'C:\\Users\\dev\\Downloads\\a.txt' }),
      makeTask({ taskId: 'task-3', direction: 'download', target: 'C:\\Users\\dev\\Downloads\\b.txt' })
    ])
    expect(opts.onRefreshLocal).toHaveBeenCalledTimes(2)
    expect(opts.onRefreshRemote).not.toHaveBeenCalled()
  })

  it('別 session／未完成／路徑不符都不刷新', () => {
    const opts = options()
    mount('sess-1', opts)

    emit([
      makeTask({ taskId: 't-other', sessionId: 'sess-2' }),
      makeTask({ taskId: 't-running', state: 'running' }),
      makeTask({ taskId: 't-failed', state: 'failed' }),
      makeTask({ taskId: 't-away', target: '/home/dev/other/report.pdf' })
    ])
    expect(opts.onRefreshLocal).not.toHaveBeenCalled()
    expect(opts.onRefreshRemote).not.toHaveBeenCalled()
  })

  it('路徑或 callback 更新後使用新值', () => {
    const first = options()
    const second = options({
      remotePath: '/srv/www/',
      onRefreshLocal: vi.fn(),
      onRefreshRemote: vi.fn()
    })
    const { rerender } = mount('sess-1', first)

    rerender({ sessionId: 'sess-1', options: second })
    expect(onUpdate).toHaveBeenCalledTimes(1)

    emit([makeTask({ target: '/srv/www/index.html' })])
    expect(second.onRefreshRemote).toHaveBeenCalledTimes(1)
    expect(first.onRefreshRemote).not.toHaveBeenCalled()
  })

  it('卸載時解除訂閱，之後的事件不再觸發', () => {
    const opts = options()
    const { unmount } = mount('sess-1', opts)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    emit([makeTask()])
    expect(opts.onRefreshRemote).not.toHaveBeenCalled()
  })
})
