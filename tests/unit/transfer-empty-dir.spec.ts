import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CH } from '../../src/shared/constants'
import { dispatch } from '../../src/main/ipc/register'
import type { AppContext } from '../../src/main/ipc/register'
import * as transferHandlers from '../../src/main/ipc/handlers/transfer'

// handlers/transfer 會 import ipc/register → electron；本測試只需要 dispatch
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
  app: { getVersion: () => '0.1.2', getPath: () => os.tmpdir() }
}))

transferHandlers.register()

class FakeSftp {
  readonly dirs = new Set<string>(['/srv'])
  readonly files = new Map<string, Buffer>()
  readonly mkdirCalls: string[] = []
  readonly denyMkdir = new Set<string>()

  async stat(target: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean }> {
    if (this.files.has(target)) return { size: (this.files.get(target) as Buffer).length, mtimeMs: 0, isDirectory: false, isFile: true, isSymlink: false }
    if (this.dirs.has(target)) return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, isSymlink: false }
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
  }

  async tryStat(target: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const stat = await this.stat(target)
      return stat.isDirectory ? null : { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  async mkdir(target: string): Promise<void> {
    if (this.denyMkdir.has(target)) throw Object.assign(new Error('permission denied'), { code: 3 })
    this.mkdirCalls.push(target)
    this.dirs.add(target)
  }
}

const makeCtx = (fake: FakeSftp): AppContext => {
  const added: unknown[] = []
  return {
    sftp: { bySession: () => fake },
    sessions: { profileIdOf: () => 'p1', viaNameOf: () => undefined },
    connections: {
      list: () => ({ profiles: [{ id: 'p1', name: 'demo', groupId: null }], groups: [] })
    },
    transfers: {
      add: (tasks: unknown[]) => {
        added.push(...tasks)
        return tasks
      }
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), filePath: '' },
    broadcast: vi.fn(),
    resolveWindow: () => null
  } as unknown as AppContext
}

let dir: string
let emptyDir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-empty-'))
  emptyDir = path.join(dir, 'empty')
  fs.mkdirSync(emptyDir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('QA P2-01v2-1 空目錄上傳不落佇列（方案 a）', () => {
  it('空目錄 → 直接建立遠端目錄、回 0 任務（不會卡 queued）', async () => {
    const fake = new FakeSftp()
    const ctx = makeCtx(fake)
    const result = await dispatch(
      CH.transferStart,
      {
        sessionId: 's1',
        direction: 'upload',
        items: [{ source: emptyDir, target: '/srv/empty-upload' }],
        onConflict: 'overwrite'
      },
      ctx
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
    expect(fake.mkdirCalls).toContain('/srv/empty-upload')
    expect(fake.dirs.has('/srv/empty-upload')).toBe(true)
  })

  it('遠端父目錄不可寫 → start 回 E_SFTP_PERMISSION（UI toast 可顯示，不是靜默排入 queued）', async () => {    const fake = new FakeSftp()
    fake.dirs.add('/srv/ro')
    fake.denyMkdir.add('/srv/ro/empty-upload')
    const ctx = makeCtx(fake)
    const result = await dispatch(
      CH.transferStart,
      {
        sessionId: 's1',
        direction: 'upload',
        items: [{ source: emptyDir, target: '/srv/ro/empty-upload' }],
        onConflict: 'overwrite'
      },
      ctx
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_SFTP_PERMISSION')
      expect(result.error.i18nKey).toBe('error.E_SFTP_PERMISSION')
    }
  })

  it('非空目錄內的空子目錄也會在遠端建立（送 1 個父列任務）', async () => {
    const tree = path.join(dir, 'tree')
    const emptySub = path.join(tree, 'empty-sub')
    fs.mkdirSync(emptySub, { recursive: true })
    fs.writeFileSync(path.join(tree, 'a.txt'), 'hello')

    const fake = new FakeSftp()
    const ctx = makeCtx(fake)
    const result = await dispatch(
      CH.transferStart,
      {
        sessionId: 's1',
        direction: 'upload',
        items: [{ source: tree, target: '/srv/tree' }],
        onConflict: 'overwrite'
      },
      ctx
    )

    expect(result.ok).toBe(true)
    expect(fake.mkdirCalls).toContain('/srv/tree/empty-sub')
    if (result.ok) {
      const rows = result.data as Array<{ isDirectory?: boolean }>
      expect(rows).toHaveLength(1)
      expect(rows[0]?.isDirectory).toBe(true)
    }
  })
})
