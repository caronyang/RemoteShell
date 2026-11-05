import { describe, expect, it } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { sshConnectConfig, type SshEndpoint } from '../../src/main/transport/ssh'

const endpoint: SshEndpoint = {
  host: '10.1.2.11',
  port: 22,
  username: 'tester',
  password: 'pw'
}

const hostVerifier = (): void => undefined
const base = { keepaliveIntervalMs: 15000, keepaliveCountMax: 1, readyTimeoutMs: 20000, hostVerifier }

describe('M2-01 sshConnectConfig（實際傳給 ssh2 的設定）', () => {
  it('直連：帶 host/port，並把 §6.1 定案的 keepalive／timeout 傳下去', () => {
    const config = sshConnectConfig(endpoint, base) as Record<string, unknown>
    expect(config['host']).toBe('10.1.2.11')
    expect(config['port']).toBe(22)
    expect(config['username']).toBe('tester')
    expect(config['password']).toBe('pw')
    expect(config['keepaliveInterval']).toBe(15000)
    expect(config['keepaliveCountMax']).toBe(1)
    expect(config['readyTimeout']).toBe(20000)
    expect(typeof config['hostVerifier']).toBe('function')
    expect(config['sock']).toBeUndefined()
  })

  it('跳板：改用 sock 時不得再帶 host/port（否則 ssh2 會直連目的主機）', () => {
    const sock = { destroyed: false } as unknown as ClientChannel
    const config = sshConnectConfig(endpoint, { ...base, sock }) as Record<string, unknown>
    expect(config['sock']).toBe(sock)
    expect(config['host']).toBeUndefined()
    expect(config['port']).toBeUndefined()
    expect(config['username']).toBe('tester')
  })

  it('呼叫端覆寫的值會原樣傳下去（不被硬寫死）', () => {
    const config = sshConnectConfig(endpoint, {
      ...base,
      keepaliveIntervalMs: 3000,
      keepaliveCountMax: 4,
      readyTimeoutMs: 5000
    }) as Record<string, unknown>
    expect(config['keepaliveInterval']).toBe(3000)
    expect(config['keepaliveCountMax']).toBe(4)
    expect(config['readyTimeout']).toBe(5000)
  })

  it('金鑰登入：privateKey／passphrase 原樣傳給 ssh2（不落 log）', () => {
    const key = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----')
    const config = sshConnectConfig(
      { host: '10.1.2.11', port: 22, username: 'tester', privateKey: key, passphrase: 'pp' },
      base
    ) as Record<string, unknown>
    expect(config['privateKey']).toBe(key)
    expect(config['passphrase']).toBe('pp')
    expect(config['password']).toBeUndefined()
  })
})
