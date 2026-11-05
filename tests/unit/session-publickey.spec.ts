import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import type { AppError, ConnectionInput } from '../../src/shared/ipc-contract'
import { openSshSession, type SshSession } from '../../src/main/transport/ssh'
import { SessionManager } from '../../src/main/ipc/handlers/session'
import { ConnectionsStore } from '../../src/main/store/connections'
import { KnownHostsStore } from '../../src/main/transport/hostkey'
import { VaultService } from '../../src/main/vault/dpapi'

vi.mock('../../src/main/transport/ssh', () => ({ openSshSession: vi.fn() }))
const openSshMock = vi.mocked(openSshSession)

const PASSPHRASE = 'M0pass!2026'

const input = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
  name: 'pk-profile',
  groupId: null,
  protocol: 'ssh',
  host: '127.0.0.1',
  port: 22,
  auth: { method: 'publicKey', username: 'tester', secret: { kind: 'none' }, keyPath: '' },
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  ...over
})

function makeKey(dir: string, encrypted: boolean): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = encrypted
    ? privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE })
    : privateKey.export({ type: 'pkcs1', format: 'pem' })
  const file = path.join(dir, encrypted ? 'encrypted.pem' : 'plain.pem')
  fs.writeFileSync(file, pem)
  return file
}

function fakeSession(): SshSession {
  const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
  return {
    client: {} as SshSession['client'],
    stream: stream as unknown as SshSession['stream'],
    fingerprint: 'SHA256:test',
    phase: 'ready',
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    isClosed: () => false
  }
}

function makeManager(keyPath: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-pk-'))
  const connections = new ConnectionsStore(path.join(dir, 'connections.json'))
  const knownHosts = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
  const vault = new VaultService({
    isAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => {
      throw new Error('vault unavailable in test')
    }
  })
  const sessions = new SessionManager({
    connections,
    vault,
    knownHosts,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), filePath: path.join(dir, 'log') },
    broadcast: vi.fn()
  })
  const profile = connections.create(input({ auth: { method: 'publicKey', username: 'tester', secret: { kind: 'none' }, keyPath } }))
  return { dir, sessions, profile }
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'NO_THROW'
  } catch (error) {
    return (error as AppError).code ?? 'NO_CODE'
  }
}

afterEach(() => {
  openSshMock.mockReset()
})

describe('v0.1.6：publicKey 加密金鑰的 passphrase 要傳進 ssh2', () => {
  it('正確 passphrase：endpoint 同時帶 privateKey 與 passphrase，連線成功', async () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-key-'))
    const keyPath = makeKey(keyDir, true)
    const { sessions, profile } = makeManager(keyPath)
    openSshMock.mockResolvedValue(fakeSession())

    const info = await sessions.open({ profileId: profile.id, cols: 80, rows: 24, ephemeral: { secret: PASSPHRASE } })

    expect(info.state).toBe('connected')
    expect(openSshMock).toHaveBeenCalledTimes(1)
    const target = openSshMock.mock.calls[0]?.[0].target
    expect(target?.privateKey).toEqual(fs.readFileSync(keyPath))
    expect(target?.passphrase).toBe(PASSPHRASE)
    sessions.closeAll()
  })

  it('錯誤 passphrase：回 E_KEY_PASSPHRASE，且不會進到 ssh2 連線', async () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-key-'))
    const keyPath = makeKey(keyDir, true)
    const { sessions, profile } = makeManager(keyPath)

    expect(await codeOf(sessions.open({ profileId: profile.id, cols: 80, rows: 24, ephemeral: { secret: 'wrong' } }))).toBe(
      'E_KEY_PASSPHRASE'
    )
    expect(openSshMock).not.toHaveBeenCalled()
    sessions.closeAll()
  })

  it('未加密金鑰且沒有 passphrase：走原路徑，endpoint 不帶 passphrase', async () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-key-'))
    const keyPath = makeKey(keyDir, false)
    const { sessions, profile } = makeManager(keyPath)
    openSshMock.mockResolvedValue(fakeSession())

    await sessions.open({ profileId: profile.id, cols: 80, rows: 24 })

    const target = openSshMock.mock.calls[0]?.[0].target
    expect(target?.privateKey).toEqual(fs.readFileSync(keyPath))
    expect(target && 'passphrase' in target).toBe(false)
    sessions.closeAll()
  })

  it('加密金鑰但沒給 passphrase：回 E_KEY_PASSPHRASE，不進 ssh2 連線', async () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-key-'))
    const keyPath = makeKey(keyDir, true)
    const { sessions, profile } = makeManager(keyPath)

    expect(await codeOf(sessions.open({ profileId: profile.id, cols: 80, rows: 24 }))).toBe('E_KEY_PASSPHRASE')
    expect(openSshMock).not.toHaveBeenCalled()
    sessions.closeAll()
  })
})
