import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { utils } from 'ssh2'
import { VaultService, type SecureStorage } from '../../src/main/vault/dpapi'
import { inspectKeyContent, loadPrivateKey, mapKeyError, readPasswordFile } from '../../src/main/vault/keyfile'
import { findSecrets, formatLogLine, redactText, redactValue } from '../../src/main/vault/redact'
import type { AppError } from '../../src/shared/ipc-contract'

let dir: string
let keys: { ed25519: string; encrypted: string; passphrase: string; ppk: string }

function fakeStorage(available = true): SecureStorage {
  return {
    isAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad blob')
      return text.slice(4)
    }
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-vault-'))
  const passphrase = 'M0pass!2026'
  const pair = utils.generateKeyPairSync('ed25519')
  const ed25519 = path.join(dir, 'id_ed25519')
  fs.writeFileSync(ed25519, pair.private)
  fs.writeFileSync(path.join(dir, 'id_ed25519.pub'), pair.public + '\n')

  const encryptedPair = utils.generateKeyPairSync('ed25519', {
    passphrase,
    cipher: 'aes256-ctr',
    rounds: 16
  })
  const encrypted = path.join(dir, 'id_ed25519_enc')
  fs.writeFileSync(encrypted, encryptedPair.private)

  const ppk = path.join(dir, 'id_ed25519.ppk')
  fs.writeFileSync(
    ppk,
    [
      'PuTTY-User-Key-File-3: ssh-ed25519',
      'Encryption: none',
      'Comment: sample',
      'Public-Lines: 1',
      'AAAAC3NzaC1lZDI1NTE5AAAAIAAA',
      'Private-Lines: 1',
      'AAAAIGZha2U=',
      'Private-MAC: 00',
      ''
    ].join('\n')
  )
  keys = { ed25519, encrypted, passphrase, ppk }
})

describe('M2-03 VaultService（DPAPI 包裝）', () => {
  it('可用時加密成 dpapi:v1:<base64>，可解回原文', () => {
    const vault = new VaultService(fakeStorage())
    const ref = vault.encrypt('s3cret')
    expect(ref.kind).toBe('dpapi')
    if (ref.kind !== 'dpapi') throw new Error('unexpected')
    expect(ref.cipher.startsWith('dpapi:v1:')).toBe(true)
    expect(vault.decrypt(ref)).toBe('s3cret')
    // 檔案內容（base64 字串本身）不得直接看到明文
    expect(ref.cipher).not.toContain('s3cret')
  })

  it('不可用時拒絕儲存（E_VAULT_UNAVAILABLE，不得降級明碼）', () => {
    const vault = new VaultService(fakeStorage(false))
    try {
      vault.encrypt('x')
      throw new Error('should throw')
    } catch (error) {
      expect((error as AppError).code).toBe('E_VAULT_UNAVAILABLE')
    }
  })

  it('壞掉的 blob → E_VAULT_DECRYPT（不 crash、不誤報檔案損毀）', () => {
    const vault = new VaultService(fakeStorage())
    try {
      vault.decrypt({ kind: 'dpapi', cipher: 'dpapi:v1:' + Buffer.from('garbage').toString('base64'), updatedAt: '' })
      throw new Error('should throw')
    } catch (error) {
      expect((error as AppError).code).toBe('E_VAULT_DECRYPT')
    }
    expect(() => vault.decrypt({ kind: 'dpapi', cipher: 'plaintext', updatedAt: '' })).toThrow()
  })
})

describe('M2-03 金鑰檔（§6.5）', () => {
  it('未加密 ed25519：encrypted=false 且有 algorithm', () => {
    const info = inspectKeyContent(fs.readFileSync(keys.ed25519))
    expect(info.format).toBe('openssh')
    expect(info.encrypted).toBe(false)
    expect(info.algorithm).toBe('ssh-ed25519')
  })

  it('加密金鑰：parseKey 回傳 Error 也要判定為 encrypted=true（M0 踩過的坑）', () => {
    const info = inspectKeyContent(fs.readFileSync(keys.encrypted))
    expect(info.format).toBe('openssh')
    expect(info.encrypted).toBe(true)
  })

  it('.ppk 一律 E_KEY_PARSE，且訊息含 PuTTYgen 指引', () => {
    try {
      loadPrivateKey(keys.ppk)
      throw new Error('should throw')
    } catch (error) {
      const appErr = error as AppError
      expect(appErr.code).toBe('E_KEY_PARSE')
      expect(appErr.detail).toContain('PuTTYgen')
    }
    expect(inspectKeyContent(fs.readFileSync(keys.ppk)).format).toBe('ppk')
  })

  it('passphrase 正確可載入、錯誤回 E_KEY_PASSPHRASE', () => {
    expect(loadPrivateKey(keys.encrypted, keys.passphrase)).toBeInstanceOf(Buffer)
    try {
      loadPrivateKey(keys.encrypted, 'wrong')
      throw new Error('should throw')
    } catch (error) {
      expect((error as AppError).code).toBe('E_KEY_PASSPHRASE')
    }
    try {
      loadPrivateKey(keys.encrypted)
      throw new Error('should throw')
    } catch (error) {
      expect((error as AppError).code).toBe('E_KEY_PASSPHRASE')
    }
  })

  it('mapKeyError 對未知格式回 E_KEY_PARSE', () => {
    const info = mapKeyError(new Error('Cannot parse privateKey: no key found'), keys.ed25519)
    expect(info.code).toBe('E_KEY_PARSE')
  })

  it('password file 會去掉結尾換行（G1）', () => {
    const file = path.join(dir, 'pass.txt')
    fs.writeFileSync(file, 'P@ssw0rd\r\n')
    expect(readPasswordFile(file)).toBe('P@ssw0rd')
    try {
      readPasswordFile(path.join(dir, 'missing.txt'))
      throw new Error('should throw')
    } catch (error) {
      expect((error as AppError).code).toBe('E_PASSWORD_FILE')
    }
  })
})

describe('M2-03 redaction', () => {
  it('巢狀物件中的秘密欄位一律 ***', () => {
    const redacted = redactValue({
      user: 'tester',
      password: 'hunter2',
      nested: { passphrase: 'pp', publicKey: 'public-ok', privateKey: 'secret-key' },
      list: [{ token: 'abc' }]
    }) as Record<string, unknown>
    expect(redacted.user).toBe('tester')
    expect(redacted.password).toBe('***')
    expect(redacted.nested).toEqual({ passphrase: '***', publicKey: 'public-ok', privateKey: '***' })
    expect(redacted.list).toEqual([{ token: '***' }])
  })

  it('字串內的 password=... / "passphrase":"..." 會遮蔽', () => {
    const text = 'connect password=hunter2 and "passphrase":"abcd" ok'
    const masked = redactText(text)
    expect(masked).not.toContain('hunter2')
    expect(masked).not.toContain('abcd')
    expect(masked).toContain('***')
  })

  it('log 行掃描：不得出現密碼或 passphrase', () => {
    const line = formatLogLine(
      'INFO',
      'connecting with password=hunter2',
      { username: 'tester', password: 'hunter2', passphrase: 'abcd', nested: { secret: 'topsecret' } },
      new Date('2026-10-30T00:00:00Z')
    )
    expect(findSecrets(line, ['hunter2', 'abcd', 'topsecret'])).toEqual([])
    expect(line).toContain('"password":"***"')
  })
})

describe('M2-03 秘密不落 log（整合）', () => {
  it('logger 寫出的檔案掃不到密碼', async () => {
    const { createLogger } = await import('../../src/main/logger')
    const logger = createLogger(dir, false)
    logger.info('login', { username: 'tester', password: 'hunter2', auth: { passphrase: 'abcd' } })
    const content = fs.readFileSync(logger.filePath, 'utf8')
    expect(findSecrets(content, ['hunter2', 'abcd'])).toEqual([])
    expect(content).toContain('username')
    void vi
  })
})
