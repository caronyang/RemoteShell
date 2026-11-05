import { z } from 'zod'
import { CH } from '../../../shared/constants'
import { ok } from '../../../shared/errors'
import { registerChannel } from '../register'

const answerSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['once', 'always', 'reject'])
})

/** TOFU 三選項（§6.1 第 6 階段）：把使用者的決定交回等待中的連線 */
export function register(): void {
  registerChannel(CH.hostkeyAnswer, (payload, ctx) => {
    const { requestId, decision } = answerSchema.parse(payload)
    ctx.sessions.answerHostKey(requestId, decision)
    ctx.logger.info('host key decision', { requestId, decision })
    return ok(undefined)
  })
}
