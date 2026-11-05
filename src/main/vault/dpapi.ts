import type { SecretRef } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'

/** 只依賴這個介面，單元測試可注入假實作（不載入 electron） */
export interface SecureStorage {
  isAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

export const CIPHER_PREFIX = 'dpapi:v1:'

export interface VaultOptions {
  now?: () => Date
}

/**
 * 秘密儲存（§5）：safeStorage(DPAPI) 加密後只留 `dpapi:v1:<base64>`。
 * - 不可用時**拒絕儲存**並回 E_VAULT_UNAVAILABLE（不得降級明碼）
 * - 解密失敗（換使用者／換機器／壞檔）回 E_VAULT_DECRYPT
 */
export class VaultService {
  private readonly now: () => Date

  constructor(
    private readonly storage: SecureStorage,
    options: VaultOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  isAvailable(): boolean {
    try {
      return this.storage.isAvailable()
    } catch {
      return false
    }
  }

  encrypt(plain: string): SecretRef {
    if (!plain) throw appError('E_VALIDATION', { detail: 'empty secret' })
    if (!this.isAvailable()) {
      throw appError('E_VAULT_UNAVAILABLE', { detail: 'safeStorage.isEncryptionAvailable() === false' })
    }
    const cipher = this.storage.encryptString(plain)
    return { kind: 'dpapi', cipher: CIPHER_PREFIX + cipher.toString('base64'), updatedAt: this.now().toISOString() }
  }

  decrypt(ref: SecretRef): string {
    if (ref.kind === 'none') return ''
    if (!ref.cipher.startsWith(CIPHER_PREFIX)) {
      throw appError('E_VAULT_DECRYPT', { detail: 'unknown cipher format' })
    }
    if (!this.isAvailable()) {
      throw appError('E_VAULT_UNAVAILABLE', { detail: 'safeStorage unavailable' })
    }
    try {
      return this.storage.decryptString(Buffer.from(ref.cipher.slice(CIPHER_PREFIX.length), 'base64'))
    } catch (error) {
      throw appError('E_VAULT_DECRYPT', {
        detail: error instanceof Error ? error.message : 'decrypt failed',
        message: 'stored secret could not be decrypted'
      })
    }
  }

  clear(): SecretRef {
    return { kind: 'none' }
  }
}
