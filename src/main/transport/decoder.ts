/** 環形緩衝（§6.6：每 session 保留 256KB，供 rs:session:snapshot 補畫面） */
export class ByteRingBuffer {
  private readonly buffer: Buffer
  private start = 0
  private length = 0

  constructor(readonly capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be positive')
    this.buffer = Buffer.allocUnsafe(capacity)
  }

  get size(): number {
    return this.length
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    if (chunk.length >= this.capacity) {
      // 單次寫入就超過容量：只留最後 capacity bytes
      this.buffer.set(chunk.subarray(chunk.length - this.capacity), 0)
      this.start = 0
      this.length = this.capacity
      return
    }
    const overflow = this.length + chunk.length - this.capacity
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity
      this.length -= overflow
    }
    const end = (this.start + this.length) % this.capacity
    const first = Math.min(chunk.length, this.capacity - end)
    this.buffer.set(chunk.subarray(0, first), end)
    if (first < chunk.length) this.buffer.set(chunk.subarray(first), 0)
    this.length += chunk.length
  }

  snapshot(): Uint8Array {
    const out = Buffer.allocUnsafe(this.length)
    const first = Math.min(this.length, this.capacity - this.start)
    this.buffer.copy(out, 0, this.start, this.start + first)
    if (first < this.length) this.buffer.copy(out, first, 0, this.length - first)
    return out
  }

  clear(): void {
    this.start = 0
    this.length = 0
  }
}

export interface BatcherOptions {
  /** 先到者觸發：8ms（§6.6） */
  maxDelayMs: number
  /** 或累積 16KB（§6.6） */
  maxBytes: number
}

export type BatchSink = (bytes: Uint8Array, seq: number) => void

/**
 * 8ms / 16KB 批次（§6.6 強制項）：避免大量輸出（yes、長 log）把 IPC 灌爆。
 * seq 每次 flush 遞增，renderer 可用來偵測漏批。
 */
export class ByteBatcher {
  private chunks: Uint8Array[] = []
  private bytes = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: BatcherOptions,
    private readonly sink: BatchSink
  ) {}

  get pendingBytes(): number {
    return this.bytes
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    if (this.bytes >= this.options.maxBytes) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.options.maxDelayMs)
      if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
        this.timer.unref()
      }
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) return
    const bytes = Buffer.concat(
      this.chunks.map((chunk) => Buffer.from(chunk)),
      this.bytes
    )
    this.chunks = []
    this.bytes = 0
    this.seq += 1
    this.sink(bytes, this.seq)
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.chunks = []
    this.bytes = 0
  }
}

/** renderer 端契約用：每 session 一個 TextDecoder({stream:true})，重連必須重建 */
export function createStreamDecoder(): { decode(chunk: Uint8Array): string; reset(): void } {
  let decoder = new TextDecoder('utf-8')
  return {
    decode: (chunk) => decoder.decode(chunk, { stream: true }),
    reset: () => {
      decoder = new TextDecoder('utf-8')
    }
  }
}
