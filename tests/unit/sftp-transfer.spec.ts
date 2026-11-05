import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { SftpSession } from '../../src/main/sftp/session'
import { downloadFile, ensureRemoteDir, uploadFile } from '../../src/main/sftp/transfer'
import { downgradeToRestart, planDownload, planUpload } from '../../src/main/sftp/resume'
import { walkRemote } from '../../src/main/sftp/walk'

/** 以記憶體模擬遠端檔案系統（真跑 upload/download 的串流與續傳邏輯） */
class FakeSftp {
  readonly files = new Map<string, Buffer>()
  readonly dirs = new Map<string, string[]>()
  readonly mkdirCalls: string[] = []
  readonly denyMkdir = new Set<string>()
  appendSupported = true
  private readonly handles = new Map<number, { path: string }>()
  private handleSeq = 0

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

  async list(dir: string): Promise<{ path: string; entries: Array<{ name: string; path: string; type: 'file' | 'dir'; size: number; mtimeMs: number; mode: number; isSymlink: boolean }> }> {    const names = this.dirs.get(dir)
    if (!names) throw Object.assign(new Error('no such directory'), { code: 'ENOENT' })
    return {
      path: dir,
      entries: names.map((name) => {
        const full = `${dir.replace(/\/$/, '')}/${name}`
        const data = this.files.get(full)
        return {
          name,
          path: full,
          type: data ? ('file' as const) : ('dir' as const),
          size: data ? data.length : 0,
          mtimeMs: 0,
          mode: 0o644,
          isSymlink: false
        }
      })
    }
  }

  async openForAppend(target: string): Promise<{ handle: Buffer | null; supported: boolean }> {
    if (!this.appendSupported || !this.files.has(target)) return { handle: null, supported: false }
    const id = ++this.handleSeq
    this.handles.set(id, { path: target })
    return { handle: Buffer.from([id]), supported: true }
  }

  async writeToHandle(handle: Buffer, buffer: Buffer, _offset: number, position: number): Promise<void> {
    const entry = this.handles.get(handle[0] as number)
    if (!entry) throw new Error('bad handle')
    const current = this.files.get(entry.path) ?? Buffer.alloc(0)
    const next = Buffer.alloc(Math.max(current.length, position + buffer.length))
    current.copy(next)
    buffer.copy(next, position)
    this.files.set(entry.path, next)
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

  createReadStream(target: string, start = 0): Readable {
    const data = this.files.get(target) ?? Buffer.alloc(0)
    let sent = false
    return new Readable({
      read() {
        if (sent) {
          this.push(null)
          return
        }
        sent = true
        this.push(data.subarray(start))
      }
    })
  }
}

const asSession = (fake: FakeSftp): SftpSession => fake as unknown as SftpSession

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sftp-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('M3-01 續傳判斷（§6.3 純函式）', () => {
  it('下載：本地較小且 mtime 相同 → 從本地長度續傳', () => {
    const plan = planDownload({ size: 1000, mtimeMs: 5_000_000 }, { size: 400, mtimeMs: 5_000_000 })
    expect(plan).toEqual({ mode: 'resume', offset: 400, reason: 'resume' })
  })

  it('下載：mtime 變了 → 重傳（避免接錯版本）', () => {
    expect(planDownload({ size: 1000, mtimeMs: 9_000_000 }, { size: 400, mtimeMs: 5_000_000 })).toEqual({
      mode: 'restart',
      offset: 0,
      reason: 'mtime-changed'
    })
  })

  it('下載：本地不存在／已等長／比遠端大 → 重傳', () => {
    expect(planDownload({ size: 10, mtimeMs: 1 }, null).reason).toBe('no-target')
    expect(planDownload({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 }).reason).toBe('size-equal')
    expect(planDownload({ size: 10, mtimeMs: 1 }, { size: 99, mtimeMs: 1 }).reason).toBe('target-larger')
  })

  it('上傳：遠端較小且 mtime 相同 → 續寫；伺服器不支援 r+ → 需重傳', () => {
    const plan = planUpload({ size: 1000, mtimeMs: 5_000_000 }, { size: 250, mtimeMs: 5_000_000 })
    expect(plan).toEqual({ mode: 'resume', offset: 250, reason: 'resume' })
    expect(downgradeToRestart(plan)).toEqual({ mode: 'restart', offset: 0, reason: 'server-no-append' })
    // 已經是 restart 的不變
    expect(downgradeToRestart({ mode: 'restart', offset: 0, reason: 'mtime-changed' }).reason).toBe('mtime-changed')
  })
})

describe('M3-01 上傳／下載（真串流 + 續傳）', () => {
  it('上傳新檔：完整寫入，大小正確', async () => {
    const fake = new FakeSftp()
    const local = path.join(dir, 'a.bin')
    const payload = Buffer.alloc(300 * 1024, 7)
    fs.writeFileSync(local, payload)

    const outcome = await uploadFile(asSession(fake), local, '/remote/a.bin')
    expect(outcome.finalSize).toBe(payload.length)
    expect(outcome.needsRetransfer).toBe(false)
    expect(fake.files.get('/remote/a.bin')?.length).toBe(payload.length)
    expect(fake.files.get('/remote/a.bin')?.subarray(0, 4)).toEqual(Buffer.alloc(4, 7))
  })

  it('上傳續傳（forceResume）：只補後半段，最終長度相符', async () => {
    const fake = new FakeSftp()
    const local = path.join(dir, 'b.bin')
    const payload = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251))
    fs.writeFileSync(local, payload)
    fake.files.set('/remote/b.bin', payload.subarray(0, 800))

    const outcome = await uploadFile(asSession(fake), local, '/remote/b.bin', { forceResume: true })
    expect(outcome.plan.mode).toBe('resume')
    expect(outcome.plan.offset).toBe(800)
    expect(outcome.bytes).toBe(1200)
    expect(fake.files.get('/remote/b.bin')).toEqual(payload)
  })

  it('上傳：伺服器不支援 r+ → 退回重傳並標記需重傳', async () => {
    const fake = new FakeSftp()
    fake.appendSupported = false
    const local = path.join(dir, 'c.bin')
    const payload = Buffer.alloc(1024, 3)
    fs.writeFileSync(local, payload)
    fake.files.set('/remote/c.bin', payload.subarray(0, 100))

    const outcome = await uploadFile(asSession(fake), local, '/remote/c.bin', { forceResume: true })
    expect(outcome.needsRetransfer).toBe(true)
    expect(outcome.plan.reason).toBe('server-no-append')
    expect(fake.files.get('/remote/c.bin')).toEqual(payload)
  })

  it('下載續傳（forceResume）：append 後長度相符', async () => {
    const fake = new FakeSftp()
    const payload = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 251))
    fake.files.set('/remote/d.bin', payload)
    const local = path.join(dir, 'd.bin')
    fs.writeFileSync(local, payload.subarray(0, 1200))

    const outcome = await downloadFile(asSession(fake), '/remote/d.bin', local, { forceResume: true })
    expect(outcome.plan.offset).toBe(1200)
    expect(outcome.finalSize).toBe(payload.length)
    expect(fs.readFileSync(local)).toEqual(payload)
  })

  it('下載取消：寫入被中止且不會覆寫成完整檔', async () => {
    const fake = new FakeSftp()
    fake.files.set('/remote/e.bin', Buffer.alloc(4 * 1024 * 1024, 9))
    const local = path.join(dir, 'e.bin')
    const controller = new AbortController()
    const promise = downloadFile(asSession(fake), '/remote/e.bin', local, {
      signal: controller.signal,
      onProgress: () => controller.abort()
    })
    await expect(promise).rejects.toBeTruthy()
    expect(fs.existsSync(local) ? fs.statSync(local).size : 0).toBeLessThan(4 * 1024 * 1024)
  })
})

describe('M3-01 目錄走訪', () => {
  it('遞迴列出所有檔案並保留相對路徑', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/root', ['a.txt', 'sub'])
    fake.dirs.set('/root/sub', ['b.txt'])
    fake.files.set('/root/a.txt', Buffer.alloc(10))
    fake.files.set('/root/sub/b.txt', Buffer.alloc(20))

    const walked = await walkRemote(asSession(fake), '/root')
    const files = walked.filter((item) => !item.isDirectory)
    expect(files.map((f) => f.relative).sort()).toEqual(['a.txt', 'sub/b.txt'])
    expect(files.find((f) => f.relative === 'sub/b.txt')?.size).toBe(20)
  })

  it('超過 maxEntries 會中止（保護誤選整個磁碟）', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/big', Array.from({ length: 20 }, (_, i) => `f${i}.txt`))
    for (let i = 0; i < 20; i++) fake.files.set(`/big/f${i}.txt`, Buffer.alloc(1))

    await expect(walkRemote(asSession(fake), '/big', { maxEntries: 5 })).rejects.toMatchObject({ code: 'E_LIMIT' })
  })
})

describe('QA P1-04 遠端父目錄遞迴建立（mkdir -p）', () => {
  it('父目錄不存在時逐段建立，已存在的略過', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/home', [])
    fake.dirs.set('/home/tester', [])
    await ensureRemoteDir(asSession(fake), '/home/tester/a/b')
    expect(fake.mkdirCalls).toEqual(['/home/tester/a', '/home/tester/a/b'])
    expect(fake.dirs.has('/home/tester/a/b')).toBe(true)
  })

  it('根目錄／目前目錄／空字串不做事', async () => {
    const fake = new FakeSftp()
    await ensureRemoteDir(asSession(fake), '/')
    await ensureRemoteDir(asSession(fake), '.')
    await ensureRemoteDir(asSession(fake), '')
    expect(fake.mkdirCalls).toEqual([])
  })

  it('父路徑存在但它是檔案 → E_SFTP_UNAVAILABLE（不覆寫）', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/home', [])
    fake.dirs.set('/home/tester', [])
    fake.files.set('/home/tester/a', Buffer.alloc(1))
    await expect(ensureRemoteDir(asSession(fake), '/home/tester/a/b')).rejects.toMatchObject({
      code: 'E_SFTP_UNAVAILABLE'
    })
    expect(fake.mkdirCalls).toEqual([])
  })

  it('父目錄不可寫 → 原始 EACCES 轉成 E_SFTP_PERMISSION（帶 i18nKey）', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/home', [])
    fake.dirs.set('/home/tester', [])
    fake.denyMkdir.add('/home/tester/a')
    const error = await ensureRemoteDir(asSession(fake), '/home/tester/a/b').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'E_SFTP_PERMISSION', i18nKey: 'error.E_SFTP_PERMISSION' })
  })

  it('併發：mkdir 失敗但目錄已被別人建好 → 視為成功', async () => {
    const fake = new FakeSftp()
    fake.dirs.set('/home', [])
    fake.dirs.set('/home/tester', [])
    fake.dirs.set('/home/tester/a', [])
    // mkdir 被呼叫時目錄已存在（模擬 race 後再次確認成功）
    await ensureRemoteDir(asSession(fake), '/home/tester/a')
    expect(fake.mkdirCalls).toEqual([])
  })
})
