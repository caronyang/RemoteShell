import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KnownHostsStore, fingerprintSha256, keyAlgorithm, verifyHostKey } from '../../src/main/transport/hostkey'
import { ByteBatcher, ByteRingBuffer, createStreamDecoder } from '../../src/main/transport/decoder'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-hostkey-'))
})

const keyA = Buffer.from('key-a')
const keyB = Buffer.from('key-b')

describe('M2-01 host key TOFU', () => {
  it('指紋格式與 OpenSSH 一致（SHA256:base64 無 padding）', () => {
    const fp = fingerprintSha256(keyA)
    expect(fp.startsWith('SHA256:')).toBe(true)
    expect(fp.endsWith('=')).toBe(false)
  })

  it('首次連線 always → 寫入 known_hosts，下一次不再詢問', async () => {
    const store = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
    let asked = 0
    const prompt = async (): Promise<'always'> => {
      asked += 1
      return 'always'
    }

    const first = await verifyHostKey({ store, prompt, host: '10.1.2.11', port: 22, keyType: 'target', key: keyA })
    expect(first).toEqual({ accepted: true, saved: true })
    expect(asked).toBe(1)
    expect(store.find('10.1.2.11', 22, 'target')?.fingerprintSha256).toBe(fingerprintSha256(keyA))

    const second = await verifyHostKey({ store, prompt, host: '10.1.2.11', port: 22, keyType: 'target', key: keyA })
    expect(second).toEqual({ accepted: true, saved: false })
    expect(asked).toBe(1)
  })

  it('once 只放行當次，不寫檔', async () => {
    const store = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
    const outcome = await verifyHostKey({
      store,
      prompt: async () => 'once',
      host: 'h',
      port: 22,
      keyType: 'target',
      key: keyA
    })
    expect(outcome).toEqual({ accepted: true, saved: false })
    expect(store.list()).toHaveLength(0)
  })

  it('reject 拒絕連線', async () => {
    const store = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
    const outcome = await verifyHostKey({
      store,
      prompt: async () => 'reject',
      host: 'h',
      port: 22,
      keyType: 'target',
      key: keyA
    })
    expect(outcome).toEqual({ accepted: false, reason: 'reject' })
  })

  it('金鑰變更 → 詢問時帶 knownPrevious；非 always 一律拒絕（mismatch）', async () => {
    const store = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
    store.save({ host: 'h', port: 22, keyType: 'target', fingerprintSha256: fingerprintSha256(keyA), addedAt: 'x' })

    let seenPrevious: string | undefined
    const outcome = await verifyHostKey({
      store,
      prompt: async (req) => {
        seenPrevious = req.knownPrevious
        return 'reject'
      },
      host: 'h',
      port: 22,
      keyType: 'target',
      key: keyB
    })
    expect(seenPrevious).toBe(fingerprintSha256(keyA))
    expect(outcome).toEqual({ accepted: false, reason: 'mismatch' })
    // 原紀錄不得被覆蓋
    expect(store.find('h', 22, 'target')?.fingerprintSha256).toBe(fingerprintSha256(keyA))
  })

  it('使用者接受新指紋（always）會覆蓋舊紀錄', async () => {
    const store = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
    store.save({ host: 'h', port: 22, keyType: 'target', fingerprintSha256: fingerprintSha256(keyA), addedAt: 'x' })
    const outcome = await verifyHostKey({
      store,
      prompt: async () => 'always',
      host: 'h',
      port: 22,
      keyType: 'target',
      key: keyB
    })
    expect(outcome).toEqual({ accepted: true, saved: true })
    expect(store.find('h', 22, 'target')?.fingerprintSha256).toBe(fingerprintSha256(keyB))
  })
})

describe('M2-04 環形緩衝（256KB）', () => {
  it('未滿時 snapshot 等於全部內容', () => {
    const ring = new ByteRingBuffer(8)
    ring.push(Buffer.from([1, 2, 3]))
    expect([...ring.snapshot()]).toEqual([1, 2, 3])
    expect(ring.size).toBe(3)
  })

  it('超過容量時只保留最後 N bytes（含跨環繞）', () => {
    const ring = new ByteRingBuffer(8)
    ring.push(Buffer.from([1, 2, 3, 4, 5, 6]))
    ring.push(Buffer.from([7, 8, 9, 10]))
    expect([...ring.snapshot()]).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('單次寫入大於容量時只留尾端', () => {
    const ring = new ByteRingBuffer(4)
    ring.push(Buffer.from([1, 2, 3, 4, 5, 6]))
    expect([...ring.snapshot()]).toEqual([3, 4, 5, 6])
  })

  it('可用 256KB 容量建立（§6.6）', () => {
    const ring = new ByteRingBuffer(256 * 1024)
    ring.push(Buffer.alloc(300 * 1024, 7))
    expect(ring.size).toBe(256 * 1024)
  })
})

describe('M2-04 8ms / 16KB 批次（§6.6 強制項）', () => {
  it('累積到 16KB 立即 flush', () => {
    const batches: number[] = []
    const batcher = new ByteBatcher({ maxDelayMs: 8, maxBytes: 1024 }, (bytes) => batches.push(bytes.length))
    batcher.push(Buffer.alloc(600, 1))
    expect(batches).toHaveLength(0)
    batcher.push(Buffer.alloc(600, 2))
    expect(batches).toEqual([1200])
    batcher.dispose()
  })

  it('未達 16KB 時 8ms 後 flush（計時器）', async () => {
    const batches: Buffer[] = []
    const batcher = new ByteBatcher({ maxDelayMs: 8, maxBytes: 16 * 1024 }, (bytes) => batches.push(Buffer.from(bytes)))
    batcher.push(Buffer.from('hi'))
    expect(batches).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.toString()).toBe('hi')
    batcher.dispose()
  })

  it('seq 每次 flush 遞增（renderer 可偵測漏批）', async () => {
    const seqs: number[] = []
    const batcher = new ByteBatcher({ maxDelayMs: 8, maxBytes: 4 }, (_bytes, seq) => seqs.push(seq))
    batcher.push(Buffer.alloc(4))
    batcher.push(Buffer.alloc(4))
    expect(seqs).toEqual([1, 2])
    batcher.dispose()
  })

  it('3-byte 中文被批次切在邊界時不得產生 U+FFFD（TextDecoder stream）', () => {
    // 「中」= E4 B8 AD，故意切成兩個批次
    const first = Buffer.from([0xe4])
    const second = Buffer.from([0xb8, 0xad])
    const batches: Buffer[] = []
    const batcher = new ByteBatcher({ maxDelayMs: 1000, maxBytes: 16 * 1024 }, (bytes) => batches.push(Buffer.from(bytes)))
    batcher.push(first)
    batcher.flush()
    batcher.push(second)
    batcher.flush()
    batcher.dispose()

    const decoder = createStreamDecoder()
    const text = batches.map((b) => decoder.decode(b)).join('')
    expect(text).toBe('中')
    expect(text).not.toContain('\uFFFD')
  })
})

describe('M2-01 host key 演算法名稱', () => {
  it('keyAlgorithm 從 raw blob 取出 ssh-ed25519（HostKeyPrompt.keyType 用）', () => {
    const algorithm = Buffer.from('ssh-ed25519', 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(algorithm.length, 0)
    const blob = Buffer.concat([length, algorithm, Buffer.alloc(32, 1)])
    expect(keyAlgorithm(blob)).toBe('ssh-ed25519')
    expect(keyAlgorithm(Buffer.alloc(2))).toBe('unknown')
  })
})
