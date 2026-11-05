import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager, preferredSecret } from '../../src/main/ipc/handlers/session'
import { ConnectionsStore } from '../../src/main/store/connections'
import { KnownHostsStore } from '../../src/main/transport/hostkey'
import { VaultService } from '../../src/main/vault/dpapi'
import type { AppError, ConnectionInput } from '../../src/shared/ipc-contract'

const input = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
  name: 'need-credential',
  groupId: null,
  protocol: 'ssh',
  host: '10.1.2.11',
  port: 22,
  auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: '',
  ...over
})

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-auth-'))
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
  return { dir, connections, sessions }
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'NO_THROW'
  } catch (error) {
    return (error as AppError).code ?? 'NO_CODE'
  }
}

describe('M4 待辦：reconnect 需要憑證時要回可辨識的碼', () => {
  it('profile 沒有記住密碼（secret.kind=none）→ E_VAULT_UNAVAILABLE，不是 E_VALIDATION', async () => {
    const { connections, sessions } = makeManager()
    const profile = connections.create(input())
    expect(await codeOf(sessions.open({ profileId: profile.id, cols: 80, rows: 24 }))).toBe('E_VAULT_UNAVAILABLE')
  })

  it('有 DPAPI 密文但 vault 不可用 → 同樣是 E_VAULT_UNAVAILABLE（UI 一律跳輸入框）', async () => {
    const { connections, sessions } = makeManager()
    const profile = connections.create(
      input({ auth: { method: 'password', username: 'tester', secret: { kind: 'dpapi', cipher: 'dpapi:v1:AAAA', updatedAt: '' } } })
    )
    expect(await codeOf(sessions.open({ profileId: profile.id, cols: 80, rows: 24 }))).toBe('E_VAULT_UNAVAILABLE')
  })

  it('本次臨時輸入的密碼會走正常路徑（不會被當成缺憑證）', async () => {
    const { connections, sessions } = makeManager()
    const profile = connections.create(input({ host: '127.0.0.1', port: 1 }))
    // 連到關閉的埠：會失敗，但錯誤必須是連線類（E_JUMP_TCP/E_TARGET_TCP/E_TIMEOUT），不是缺憑證
    const code = await codeOf(
      sessions.open({ profileId: profile.id, cols: 80, rows: 24, ephemeral: { secret: 'pw' } })
    )
    expect(code).not.toBe('E_VAULT_UNAVAILABLE')
    expect(['E_TARGET_TCP', 'E_TIMEOUT', 'E_NETWORK', 'E_INTERNAL']).toContain(code)
  })
})

describe('v0.1.5 P1：憑證重送（ephemeral 優先於已存 dpapi）', () => {
  const dpapiSecret = { kind: 'dpapi' as const, cipher: 'dpapi:v1:AAAA', updatedAt: '' }

  it('有 ephemeral 時使用本次輸入，不讀舊 dpapi', () => {
    const decrypt = vi.fn(() => 'stored-password')
    const value = preferredSecret(
      { method: 'password', username: 'tester', secret: dpapiSecret },
      'typed-password',
      decrypt
    )
    expect(value).toBe('typed-password')
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('沒有 ephemeral 時才解密 dpapi；secret none 回 undefined', () => {
    const decrypt = vi.fn(() => 'stored-password')
    expect(preferredSecret({ method: 'password', username: 'tester', secret: dpapiSecret }, undefined, decrypt)).toBe(
      'stored-password'
    )
    expect(
      preferredSecret({ method: 'password', username: 'tester', secret: { kind: 'none' } }, undefined, decrypt)
    ).toBeUndefined()
  })
})
