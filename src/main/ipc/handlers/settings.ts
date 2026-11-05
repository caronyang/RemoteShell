import { z } from 'zod'
import type { AppSettings } from '../../../shared/ipc-contract'
import { CH, EVT } from '../../../shared/constants'
import { ok } from '../../../shared/errors'
import { registerChannel } from '../register'

/** patch 只驗形狀，欄位合法性交由 store 的 zod schema 判斷（單一真相） */
const patchSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  { message: 'patch must be an object' }
)

export function register(): void {
  registerChannel(CH.settingsGet, (_payload, ctx) => ok<AppSettings>(ctx.settings.load()))

  registerChannel(CH.settingsPatch, (payload, ctx) => {
    const patch = patchSchema.parse(payload)
    const next = ctx.settings.patch(patch as Partial<AppSettings>)
    ctx.broadcast(EVT.settingsChanged, next)
    ctx.logger.info('settings patched', { keys: Object.keys(patch) })
    return ok<AppSettings>(next)
  })

  registerChannel(CH.settingsReset, (_payload, ctx) => {
    const next = ctx.settings.reset()
    ctx.broadcast(EVT.settingsChanged, next)
    ctx.logger.info('settings reset')
    return ok<AppSettings>(next)
  })
}
