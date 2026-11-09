import { describe, expect, it } from 'vitest'
import type { TransferTask } from '../../src/shared/ipc-contract'
import { panesToRefresh, type TransferRefreshContext } from '../../src/renderer/features/sftp/transferRefresh'

type TaskLike = Pick<TransferTask, 'state' | 'sessionId' | 'direction' | 'target'>

function task(overrides: Partial<TaskLike> = {}): TaskLike {
  return {
    state: 'completed',
    sessionId: 'sess-1',
    direction: 'upload',
    target: '/home/dev/project/report.pdf',
    ...overrides
  }
}

function ctx(overrides: Partial<TransferRefreshContext> = {}): TransferRefreshContext {
  return {
    sessionId: 'sess-1',
    localPath: 'C:\\Users\\dev\\Downloads',
    remotePath: '/home/dev/project',
    ...overrides
  }
}

describe('v0.1.11 #3/#4 panesToRefresh', () => {
  it('upload 完成 → 只刷新遠端目標目錄', () => {
    expect(panesToRefresh(task(), ctx())).toEqual({ local: false, remote: true })
  })

  it('download 完成 → 只刷新本機目標目錄', () => {
    const download = task({
      direction: 'download',
      target: 'C:\\Users\\dev\\Downloads\\report.pdf'
    })
    expect(panesToRefresh(download, ctx())).toEqual({ local: true, remote: false })
  })

  it('其他 session 的任務不刷新', () => {
    expect(panesToRefresh(task({ sessionId: 'sess-2' }), ctx())).toEqual({ local: false, remote: false })
  })

  it('未完成的任務（running／queued／failed）不刷新', () => {
    for (const state of ['queued', 'running', 'paused', 'failed', 'cancelled'] as const) {
      expect(panesToRefresh(task({ state }), ctx())).toEqual({ local: false, remote: false })
    }
  })

  it('目標目錄與目前路徑不符時不刷新', () => {
    expect(panesToRefresh(task({ target: '/home/dev/other/report.pdf' }), ctx())).toEqual({
      local: false,
      remote: false
    })
    expect(
      panesToRefresh(task({ direction: 'download', target: 'C:\\Temp\\report.pdf' }), ctx())
    ).toEqual({ local: false, remote: false })
  })

  it('本機路徑容忍 \\ 與 / 混用且大小寫不敏感', () => {
    const download = task({ direction: 'download', target: 'c:/users/DEV/downloads/REPORT.pdf' })
    expect(panesToRefresh(download, ctx({ localPath: 'C:\\Users\\dev\\Downloads\\' }))).toEqual({
      local: true,
      remote: false
    })
  })

  it('遠端路徑容忍結尾斜線，但不忽略大小寫', () => {
    expect(panesToRefresh(task(), ctx({ remotePath: '/home/dev/project/' }))).toEqual({
      local: false,
      remote: true
    })
    expect(panesToRefresh(task(), ctx({ remotePath: '/home/dev/Project' }))).toEqual({
      local: false,
      remote: false
    })
  })

  it('遠端根目錄的任務可刷新根目錄', () => {
    expect(panesToRefresh(task({ target: '/README.md' }), ctx({ remotePath: '/' }))).toEqual({
      local: false,
      remote: true
    })
  })

  it('目錄任務本身以其父目錄比對（於父目錄顯示新資料夾）', () => {
    const directoryTask = task({ target: '/home/dev/project/new-folder' })
    expect(panesToRefresh(directoryTask, ctx({ remotePath: '/home/dev/project/' }))).toEqual({
      local: false,
      remote: true
    })
  })
})
