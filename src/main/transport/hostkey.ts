import crypto from 'node:crypto'
import { readJson, writeJsonAtomic, type AtomicDeps } from '../store/atomic'
import type { HostKeyDecision } from '../../shared/ipc-contract'

export interface KnownHostEntry {
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
  addedAt: string
}

export interface KnownHostsFile {
  schemaVersion: number
  hosts: KnownHostEntry[]
}

/** ssh2 hostVerifier 收到的是 raw key blob；指紋格式與 OpenSSH 一致 */
export function fingerprintSha256(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/**
 * 從 raw key blob 取出演算法名稱（ssh-ed25519 / ssh-rsa / ecdsa-sha2-* …）。
 * HostKeyPrompt.keyType 要顯示這個，而不是連線角色。
 */
export function keyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const length = key.readUInt32BE(0)
  if (length <= 0 || length > 64 || 4 + length > key.length) return 'unknown'
  return key.subarray(4, 4 + length).toString('ascii')
}

/** known_hosts.json（§5）：{ host, port, keyType, fingerprintSha256, addedAt } */
export class KnownHostsStore {
  private cache: KnownHostsFile | null = null

  constructor(
    private readonly file: string,
    private readonly deps: Partial<AtomicDeps> = {},
    private readonly now: () => Date = () => new Date()
  ) {}

  load(): KnownHostsFile {
    if (this.cache) return this.cache
    const raw = readJson<KnownHostsFile>(this.file, this.deps)
    if (!raw || !Array.isArray(raw.hosts)) {
      this.cache = { schemaVersion: 1, hosts: [] }
      return this.cache
    }
    this.cache = { schemaVersion: 1, hosts: raw.hosts.filter((h) => typeof h?.fingerprintSha256 === 'string') }
    return this.cache
  }

  list(): KnownHostEntry[] {
    return [...this.load().hosts]
  }

  find(host: string, port: number, keyType?: string): KnownHostEntry | undefined {
    return this.load().hosts.find(
      (entry) => entry.host === host && entry.port === port && (!keyType || entry.keyType === keyType)
    )
  }

  /** 同一 host:port 只保留最新指紋（金鑰變更時覆蓋） */
  save(entry: KnownHostEntry): void {
    const file = this.load()
    const hosts = file.hosts.filter(
      (existing) => !(existing.host === entry.host && existing.port === entry.port && existing.keyType === entry.keyType)
    )
    hosts.push({ ...entry, addedAt: entry.addedAt || this.now().toISOString() })
    this.cache = { schemaVersion: 1, hosts }
    writeJsonAtomic(this.file, this.cache, this.deps)
  }

  remove(host: string, port: number): void {
    const file = this.load()
    this.cache = { schemaVersion: 1, hosts: file.hosts.filter((h) => !(h.host === host && h.port === port)) }
    writeJsonAtomic(this.file, this.cache, this.deps)
  }

  invalidate(): void {
    this.cache = null
  }
}

export interface HostKeyPromptRequest {
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
  knownPrevious?: string
}

export type HostKeyPrompt = (req: HostKeyPromptRequest) => Promise<HostKeyDecision>

export type HostKeyOutcome =
  | { accepted: true; saved: boolean }
  | { accepted: false; reason: 'reject' | 'mismatch' | 'no-decision' }

/**
 * TOFU（§6.1 第 6 階段）：
 * - 沒紀錄 → 問使用者；always 才寫入 known_hosts
 * - 有紀錄且相符 → 直接放行
 * - 有紀錄但不同 → 問使用者（帶 knownPrevious）；non-always 一律拒絕（E_HOSTKEY_MISMATCH）
 */
export async function verifyHostKey(options: {
  store: KnownHostsStore
  prompt: HostKeyPrompt
  host: string
  port: number
  keyType: string
  key: Buffer
}): Promise<HostKeyOutcome> {
  const { store, prompt, host, port, keyType, key } = options
  const fingerprint = fingerprintSha256(key)
  const known = store.find(host, port, keyType)

  if (known && known.fingerprintSha256 === fingerprint) {
    return { accepted: true, saved: false }
  }

  const decision = await prompt({
    host,
    port,
    keyType,
    fingerprintSha256: fingerprint,
    ...(known ? { knownPrevious: known.fingerprintSha256 } : {})
  })

  if (decision === 'reject') return { accepted: false, reason: known ? 'mismatch' : 'reject' }
  if (decision === 'once') return { accepted: true, saved: false }

  store.save({ host, port, keyType, fingerprintSha256: fingerprint, addedAt: new Date().toISOString() })
  return { accepted: true, saved: true }
}
