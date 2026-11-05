import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import type { TransferTask } from '../../src/shared/ipc-contract'
import { createTransferRunner } from '../../src/main/ipc/handlers/transfer'
import type { SftpRegistry } from '../../src/main/sftp/registry'

// handlers/transfer 會 import ipc/register → electron；測試只用到 runner
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
  app: { getVersion: () => '0.1.0', getPath: () => os.tmpdir() }
}))

/** 極簡 SFTP 模擬：只實作 runner 需要的路徑（stat/mkdir/寫入串流） */
class FakeSftp {
  readonly files = new Map<string, Buffer>()
  readonly dirs = new Map<string, string[]>([['/', []]])
  readonly mkdirCalls: string[] = []
  readonly denyMkdir = new Set<string>()

  async stat(target: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean; isFile: boolean; isSymlink: boolean }> {
    const data = this.files.get(target)
    if (data) return { size: data.length, mtimeMs: 0, isDirectory: false, isFile: true, isSymlink: false }
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
    if (this.denyMkdir.has(target)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    this.mkdirCalls.push(target)
    if (!this.dirs.has(target)) this.dirs.set(target, [])
  }

  async openForAppend(): Promise<{ handle: Buffer; supported: boolean }> {
    return { handle: Buffer.alloc(0), supported: false }
  }

  async closeHandle(): Promise<void> {
    // no-op
  }

  createWriteStream(target: string): Writable {
    const chunks: Buffer[] = []
    return new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        chunks.push(Buffer.from(chunk))
        cb()
      },
      final: (cb) => {
        this.files.set(target, Buffer.concat(chunks))
        cb()
      }
    })
  }

  createReadStream(target: string): Readable {
    const data = this.files.get(target) ?? Buffer.alloc(0)
    let sent = false
    return new Readable({
      read() {
        if (sent) {
          this.push(null)
          return
        }
        sent = true
        this.push(data)
      }
    })
  }
}

const task = (over: Partial<TransferTask> = {}): TransferTask => ({
  taskId: over.taskId ?? 't1',
  sessionId: 's1',
  connectionLabel: 'prod-web-01',
  direction: 'upload',
  source: '',
  target: '/remote/a/b/c.txt',
  isDirectory: false,
  totalBytes: 0,
  transferredBytes: 0,
  bytesPerSec: 0,
  etaSec: null,
  state: 'running',
  attempts: 0,
  createdAt: new Date().toISOString(),
  ...over
})

let dir: string
let localFile: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-runner-'))
  localFile = path.join(dir, 'c.txt')
  fs.writeFileSync(localFile, 'hello remote parent')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const runnerFor = (fake: FakeSftp): ReturnType<typeof createTransferRunner> => {
  const registry = { tryBySession: () => fake } as unknown as SftpRegistry
  return createTransferRunner({
    sftp: registry,
    sessions: { sftpClient: () => null }
  })
}

describe('QA P1-04 目錄上傳自動建立遠端父目錄', () => {
  it('上傳 a/b/c.txt 到空目錄 → 自動建父目錄且內容（sha256）相符', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/remote', [])
    const runner = runnerFor(fake)

    await runner.run(task({ source: localFile, target: '/remote/a/b/c.txt' }), new AbortController().signal, vi.fn())

    expect(fake.mkdirCalls).toEqual(['/remote/a', '/remote/a/b'])
    const uploaded = fake.files.get('/remote/a/b/c.txt')
    expect(uploaded).toBeTruthy()
    const sha = (buffer: Buffer): string => crypto.createHash('sha256').update(buffer).digest('hex')
    expect(sha(uploaded as Buffer)).toBe(sha(fs.readFileSync(localFile)))
  })

  it('父目錄不可寫 → E_SFTP_PERMISSION（有可讀 i18nKey，不是 null）', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/remote', [])
    fake.denyMkdir.add('/remote/a')
    const runner = runnerFor(fake)

    const error = await runner
      .run(task({ source: localFile, target: '/remote/a/b/c.txt' }), new AbortController().signal, vi.fn())
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'E_SFTP_PERMISSION', i18nKey: 'error.E_SFTP_PERMISSION' })
    expect(fake.files.has('/remote/a/b/c.txt')).toBe(false)
  })
})
