import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { SftpListResult } from '../../../shared/ipc-contract'
import { CH } from '../../../shared/constants'
import { appError, ok } from '../../../shared/errors'
import { registerChannel } from '../register'
import { SftpSession } from '../../sftp/session'

const sessionIdSchema = z.object({ sessionId: z.string().min(1) })
const sftpIdSchema = z.object({ sftpId: z.string().min(1) })
const pathSchema = z.object({ sftpId: z.string().min(1), path: z.string().min(1) })
const renameSchema = z.object({ sftpId: z.string().min(1), from: z.string().min(1), to: z.string().min(1) })
const removeSchema = z.object({
  sftpId: z.string().min(1),
  path: z.string().min(1),
  isDir: z.boolean()
})

/**
 * SFTP 一律掛在既有 SSH session 上（§6 鐵則 6／F-4）：
 * Telnet session 沒有 ssh client → E_SFTP_UNAVAILABLE。
 */
export function register(): void {
  registerChannel(CH.sftpOpen, async (payload, ctx) => {
    const { sessionId } = sessionIdSchema.parse(payload)
    const client = ctx.sessions.sftpClient(sessionId)
    if (!client) {
      throw appError('E_SFTP_UNAVAILABLE', {
        detail: `session ${sessionId} is not an SSH session`,
        message: 'SFTP requires an SSH session'
      })
    }
    const session = await SftpSession.open(client)
    const sftpId = randomUUID()
    ctx.sftp.add(sftpId, sessionId, session)
    ctx.logger.info('sftp opened', { sessionId, sftpId, home: session.home })
    return ok({ sftpId, home: session.home })
  })

  registerChannel(CH.sftpClose, (payload, ctx) => {
    const { sftpId } = sftpIdSchema.parse(payload)
    ctx.sftp.remove(sftpId)
    return ok(undefined)
  })

  registerChannel(CH.sftpList, async (payload, ctx) => {
    const { sftpId, path } = pathSchema.parse(payload)
    return ok<SftpListResult>(await ctx.sftp.get(sftpId).list(path))
  })

  registerChannel(CH.sftpMkdir, async (payload, ctx) => {
    const { sftpId, path } = pathSchema.parse(payload)
    await ctx.sftp.get(sftpId).mkdir(path)
    return ok(undefined)
  })

  registerChannel(CH.sftpRename, async (payload, ctx) => {
    const { sftpId, from, to } = renameSchema.parse(payload)
    await ctx.sftp.get(sftpId).rename(from, to)
    return ok(undefined)
  })

  registerChannel(CH.sftpRemove, async (payload, ctx) => {
    const { sftpId, path, isDir } = removeSchema.parse(payload)
    await ctx.sftp.get(sftpId).remove(path, isDir)
    return ok(undefined)
  })

  registerChannel(CH.sftpRealpath, async (payload, ctx) => {
    const { sftpId, path } = pathSchema.parse(payload)
    return ok<string>(await ctx.sftp.get(sftpId).realpath(path))
  })
}
