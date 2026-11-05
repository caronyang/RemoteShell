import { describe, expect, it } from 'vitest'
import {
  PHASE_ORDER,
  classifyConnectError,
  classifyDisconnect,
  isRetryableCode
} from '../../src/main/transport/phases'

describe('M2-01 七階段錯誤碼（§6.1）', () => {
  it('階段順序與文件一致', () => {
    expect(PHASE_ORDER).toEqual([
      'jump-dns',
      'jump-tcp',
      'jump-auth',
      'tunnel',
      'target-tcp',
      'hostkey',
      'target-auth',
      'ready'
    ])
  })

  it('跳板 DNS 解析失敗 → E_JUMP_DNS，且 phase 落在 jump-dns', () => {
    expect(classifyConnectError('jump-dns', { code: 'ENOTFOUND' })).toEqual({
      phase: 'jump-dns',
      code: 'E_JUMP_DNS'
    })
    // 就算是在 jump-tcp 階段收到 DNS 錯誤，也要標成 jump-dns（斷點標示要準）
    expect(classifyConnectError('jump-tcp', { code: 'EAI_AGAIN' })).toEqual({
      phase: 'jump-dns',
      code: 'E_JUMP_DNS'
    })
  })

  it('跳板 TCP 失敗 → E_JUMP_TCP，且 phase 落在 jump-tcp', () => {
    expect(classifyConnectError('jump-tcp', { code: 'ECONNREFUSED' })).toEqual({
      phase: 'jump-tcp',
      code: 'E_JUMP_TCP'
    })
    // 階段還停在 jump-dns 時就收到 TCP 錯誤（DNS 已解析）→ phase 要升到 jump-tcp
    expect(classifyConnectError('jump-dns', { code: 'ECONNREFUSED' })).toEqual({
      phase: 'jump-tcp',
      code: 'E_JUMP_TCP'
    })
  })

  it('v0.1.8：跳板認證失敗（client-authentication）→ E_JUMP_AUTH，不是 E_JUMP_TCP', () => {
    const authError = {
      level: 'client-authentication',
      message: 'All configured authentication methods failed'
    }
    expect(classifyConnectError('jump-dns', authError)).toEqual({ phase: 'jump-auth', code: 'E_JUMP_AUTH' })
    expect(classifyConnectError('jump-tcp', authError)).toEqual({ phase: 'jump-auth', code: 'E_JUMP_AUTH' })
  })

  it('跳板驗證失敗 → E_JUMP_AUTH', () => {
    expect(classifyConnectError('jump-auth', { level: 'client-authentication' })).toEqual({
      phase: 'jump-auth',
      code: 'E_JUMP_AUTH'
    })
  })

  it('隧道失敗 → E_TUNNEL（不可落到 E_TARGET_TCP，R4）', () => {
    expect(classifyConnectError('tunnel', { message: 'forwardOut failed' })).toEqual({
      phase: 'tunnel',
      code: 'E_TUNNEL'
    })
  })

  it('目的主機不可達 → E_TARGET_TCP，逾時 → E_TIMEOUT', () => {
    expect(classifyConnectError('target-tcp', { code: 'ECONNREFUSED' })).toEqual({
      phase: 'target-tcp',
      code: 'E_TARGET_TCP'
    })
    expect(classifyConnectError('target-tcp', { level: 'client-timeout' })).toEqual({
      phase: 'target-tcp',
      code: 'E_TIMEOUT'
    })
  })

  it('v0.1.6：加密金鑰 passphrase 錯誤（connect 階段才解析）→ E_KEY_PASSPHRASE', () => {
    expect(
      classifyConnectError('target-tcp', { message: 'Cannot parse privateKey: OpenSSH key integrity check failed -- bad passphrase?' })
    ).toEqual({ phase: 'target-tcp', code: 'E_KEY_PASSPHRASE' })
    expect(classifyConnectError('target-tcp', { message: 'Cannot parse privateKey: no passphrase given' })).toEqual({
      phase: 'target-tcp',
      code: 'E_KEY_PASSPHRASE'
    })
  })

  it('主機金鑰未知／變更', () => {
    expect(classifyConnectError('hostkey', {})).toEqual({ phase: 'hostkey', code: 'E_HOSTKEY_UNKNOWN' })
    expect(classifyConnectError('hostkey', { code: 'E_HOSTKEY_MISMATCH' })).toEqual({
      phase: 'hostkey',
      code: 'E_HOSTKEY_MISMATCH'
    })
  })

  it('目的主機驗證失敗 → E_TARGET_AUTH', () => {
    expect(classifyConnectError('target-auth', { level: 'client-authentication' })).toEqual({
      phase: 'target-auth',
      code: 'E_TARGET_AUTH'
    })
  })

  it('可重試判定', () => {
    expect(isRetryableCode('E_TARGET_TCP')).toBe(true)
    expect(isRetryableCode('E_NETWORK')).toBe(true)
    expect(isRetryableCode('E_KEY_PARSE')).toBe(false)
    expect(isRetryableCode('E_VALIDATION')).toBe(false)
  })
})

describe('M2-01 斷線歸屬（§6.4）', () => {
  it('先斷跳板 → 隧道段 / E_TUNNEL', () => {
    expect(classifyDisconnect('jump')).toEqual({ phase: 'tunnel', code: 'E_TUNNEL' })
  })

  it('先斷目的主機 → 目的段 / E_NETWORK', () => {
    expect(classifyDisconnect('target')).toEqual({ phase: 'target-tcp', code: 'E_NETWORK' })
  })
})

describe('M2-01 keepalive 參數（行為驗證在 ssh-config.spec.ts：實際傳給 ssh2 的值）', () => {
  it('TIMING 是單一來源，transport 沒有另寫死數字', async () => {
    // 直接驗證「文件定案值」與「程式常數」一致；是否真的傳給 ssh2 由 ssh-config.spec 驗
    const { TIMING } = await import('../../src/shared/constants')
    expect(TIMING.keepaliveIntervalMs).toBe(15000)
    expect(TIMING.keepaliveCountMax).toBe(1)
  })
})
