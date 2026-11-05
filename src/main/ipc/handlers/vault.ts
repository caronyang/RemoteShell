import { z } from 'zod'
import type { KeyFileInfo, SecretRef } from '../../../shared/ipc-contract'
import { CH } from '../../../shared/constants'
import { ok } from '../../../shared/errors'
import { inspectKeyFile } from '../../vault/keyfile'
import { registerChannel } from '../register'

const setSecretSchema = z.object({ scopeId: z.string().min(1), secret: z.string().min(1) })
const clearSecretSchema = z.object({ scopeId: z.string().min(1) })
const inspectSchema = z.object({ path: z.string().min(1) })

/**
 * 秘密只寫不回讀（§2 鐵則 2）：setSecret 回 SecretRef（密文），任何通道都不回明文。
 * scopeId 只用於 log 與稽核，不使用其內容。
 */
export function register(): void {
  registerChannel(CH.vaultSetSecret, (payload, ctx) => {
    const { scopeId, secret } = setSecretSchema.parse(payload)
    const ref = ctx.vault.encrypt(secret)
    ctx.logger.info('secret stored', { scopeId, kind: ref.kind })
    return ok<SecretRef>(ref)
  })

  registerChannel(CH.vaultClearSecret, (payload, ctx) => {
    const { scopeId } = clearSecretSchema.parse(payload)
    ctx.logger.info('secret cleared', { scopeId })
    return ok(undefined)
  })

  registerChannel(CH.vaultInspectKeyFile, (payload) => {
    const { path } = inspectSchema.parse(payload)
    return ok<KeyFileInfo>(inspectKeyFile(path))
  })
}
