import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  ConnectionProfile,
  TransferPlan,
  TransferPlanItem,
  TransferTask
} from '../../../shared/ipc-contract'
import { CH, EVT, TIMING } from '../../../shared/constants'
import { appError, ok } from '../../../shared/errors'
import { registerChannel } from '../register'
import type { AppContext } from '../register'
import type { SftpRegistry } from '../../sftp/registry'
import { downloadFile, ensureRemoteDir, uploadFile } from '../../sftp/transfer'
import { buildTransferTasks, type ExpandedItem } from '../../queue/plan-start'
import { SftpSession, mapSftpError } from '../../sftp/session'
import type { Client } from 'ssh2'
import { walkRemote } from '../../sftp/walk'
import type { TaskRunner } from '../../queue/scheduler'

const planSchema = z.object({
  sessionId: z.string().min(1),
  direction: z.enum(['upload', 'download']).optional(),
  items: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).min(1)
})
const startSchema = z.object({
  sessionId: z.string().min(1),
  direction: z.enum(['upload', 'download']),
  items: z.array(z.object({ source: z.string().min(1), target: z.string().min(1) })).min(1),
  onConflict: z.enum(['ask', 'overwrite', 'skip', 'rename']),
  decisions: z.record(z.enum(['overwrite', 'skip', 'rename'])).optional()
})
const taskIdSchema = z.object({ taskId: z.string().min(1) })
const reorderSchema = z.object({
  taskId: z.string().min(1),
  direction: z.enum(['up', 'down'])
})

/** 上傳用：本地路徑展開（目錄 → 逐檔；另外收集空目錄，讓遠端也能建出來） */
interface LocalExpansion {
  files: Array<{ source: string; target: string; size: number }>
  /** 沒有任何項目的子目錄（遠端路徑） */
  emptyDirs: string[]
}

function expandLocal(source: string, target: string): LocalExpansion {
  const stat = fs.statSync(source)
  if (!stat.isDirectory()) return { files: [{ source, target, size: stat.size }], emptyDirs: [] }
  const files: Array<{ source: string; target: string; size: number }> = []
  const emptyDirs: string[] = []
  const root = target.replace(/\/$/, '')
  const stack: Array<{ dir: string; rel: string }> = [{ dir: source, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop() as { dir: string; rel: string }
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      const abs = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        stack.push({ dir: abs, rel })
        if (fs.readdirSync(abs).length === 0) emptyDirs.push(`${root}/${rel}`)
      } else {
        files.push({ source: abs, target: `${root}/${rel}`, size: fs.statSync(abs).size })
      }
    }
  }
  return { files, emptyDirs }
}

/** 下載用：遠端路徑展開（目錄 → 逐檔；目錄本身先建好） */
async function expandRemote(
  ctx: AppContext,
  sessionId: string,
  source: string,
  target: string
): Promise<Array<{ source: string; target: string; size: number }>> {
  const sftp = ctx.sftp.bySession(sessionId)
  const stat = await sftp.stat(source)
  if (!stat.isDirectory) return [{ source, target, size: stat.size }]
  const walked = await walkRemote(sftp, source)
  const out: Array<{ source: string; target: string; size: number }> = []
  for (const item of walked) {
    if (item.isDirectory) {
      fs.mkdirSync(path.join(target, item.relative), { recursive: true })
      continue
    }
    out.push({ source: item.path, target: path.join(target, item.relative), size: item.size })
  }
  return out
}

function connectionLabel(profile: ConnectionProfile | undefined, via?: string): string {
  const name = profile?.name ?? 'unknown'
  return via ? `${name} (經 ${via})` : name
}

/**
 * 傳輸 runner：由 TransferScheduler 呼叫。
 * 未帶 allowResume 的第二段（暫停後續傳）用 forceResume 只比大小，
 * 避免「傳輸中 mtime 變了」被誤判成需要重傳。
 *
 * SFTP 通道若不存在（例如重連後 session 換了），這裡會自動重開——
 * 「重連＝整條隧道重建」之後，傳輸要能自己接回去。
 */
export function createTransferRunner(deps: {
  sftp: SftpRegistry
  sessions: { sftpClient(sessionId: string): Client | null }
}): TaskRunner {
  const sessionFor = async (sessionId: string): Promise<SftpSession> => {
    const existing = deps.sftp.tryBySession(sessionId)
    if (existing) return existing
    const client = deps.sessions.sftpClient(sessionId)
    if (!client) {
      throw appError('E_SFTP_UNAVAILABLE', {
        detail: `session ${sessionId} has no SSH channel (telnet or closed)`,
        message: 'SFTP requires an open SSH session'
      })
    }
    const opened = await SftpSession.open(client)
    deps.sftp.add(`auto:${sessionId}`, sessionId, opened)
    return opened
  }

  return {
    async run(task, signal, onProgress) {
      const sftp = await sessionFor(task.sessionId)
      const forceResume = task.transferredBytes > 0 || task.attempts > 0
      try {
        if (task.direction === 'upload') {
          // P1-04：遠端父目錄不存在時先遞迴建立（mkdir -p），否則每個子檔都會 E_SFTP_NOT_FOUND
          await ensureRemoteDir(sftp, path.posix.dirname(task.target))
          await uploadFile(sftp, task.source, task.target, {
            signal,
            onProgress,
            forceResume
          })
          return
        }
        await downloadFile(sftp, task.source, task.target, { signal, onProgress, forceResume })
      } catch (error) {
        // 暫停／取消用 AbortError 控制流程，不能當成失敗訊息
        if ((error as { name?: string } | null)?.name === 'AbortError') throw error
        // 已經是產品錯誤（有 E_* 碼與 i18nKey）就原樣往上丟
        const code = (error as { code?: unknown } | null)?.code
        if (typeof code === 'string' && code.startsWith('E_')) throw error
        // ssh2 的 SFTP 錯誤是數字碼（3 = permission denied…）——沒有映射的話 UI 只會顯示
        // 「Failed」，錯誤詳情是空的（M4-06 demo 實際撞到）。這裡統一轉成可顯示文案的碼。
        throw mapSftpError(error, `${task.direction} ${task.source} -> ${task.target}`)
      }
    }
  }
}

export function register(): void {
  registerChannel(CH.transferPlan, async (payload, ctx) => {
    const { sessionId, direction, items } = planSchema.parse(payload)
    const planned: TransferPlanItem[] = []
    const skipped: TransferPlan['skipped'] = []
    const sftp = ctx.sftp.bySession(sessionId)
    const isUpload = (direction ?? 'upload') === 'upload'

    for (const item of items) {
      try {
        if (isUpload) {
          const existing = await sftp.tryStat(item.target)
          planned.push({
            source: item.source,
            target: item.target,
            conflict: existing !== null,
            ...(existing ? { existingSize: existing.size } : {})
          })
        } else {
          const remote = await sftp.stat(item.source)
          const existing = fs.existsSync(item.target)
          planned.push({
            source: item.source,
            target: item.target,
            conflict: existing || remote.isDirectory,
            ...(existing ? { existingSize: fs.statSync(item.target).size } : {})
          })
        }
      } catch (error) {
        skipped.push({ source: item.source, reason: error as TransferPlan['skipped'][number]['reason'] })
      }
    }
    return ok<TransferPlan>({ items: planned, skipped })
  })

  registerChannel(CH.transferStart, async (payload, ctx) => {
    const request = startSchema.parse(payload)
    const profile = ctx.connections.list().profiles.find((p) => p.id === ctx.sessions.profileIdOf(request.sessionId))
    const label = connectionLabel(profile, ctx.sessions.viaNameOf(request.sessionId))
    const sftp = ctx.sftp.bySession(request.sessionId)
    const isUpload = request.direction === 'upload'
    const now = new Date().toISOString()

    // 先把每個選取項目展開成實際檔案（目錄 → 逐檔），再交給純函式建立任務
    const expanded: ExpandedItem[] = []
    for (const item of request.items) {
      let files: Array<{ source: string; target: string; size: number }>
      let emptyDirs: string[] = []
      if (isUpload) {
        const expansion = expandLocal(item.source, item.target)
        files = expansion.files
        emptyDirs = expansion.emptyDirs
      } else {
        files = await expandRemote(ctx, request.sessionId, item.source, item.target)
      }
      let isDirectory = false
      try {
        isDirectory = isUpload ? fs.statSync(item.source).isDirectory() : (await sftp.stat(item.source)).isDirectory
      } catch {
        isDirectory = false
      }
      /* 樹狀目錄內的空子目錄也要在遠端建出來（非空目錄的父層由 ensureRemoteDir(file) 自動建立） */
      for (const emptyDir of emptyDirs) await ensureRemoteDir(sftp, emptyDir)
      /* QA P2-01v2-1：空目錄（children=0）不落佇列——父列沒有子任務可跑，會永遠卡 queued。
         方案 a：直接把目錄建好（上傳＝遠端 mkdir -p；下載＝本地 mkdir），失敗就讓本次 start 回錯誤（UI toast）。 */
      if (isDirectory && files.length === 0) {
        if (isUpload) {
          await ensureRemoteDir(sftp, item.target)
        } else {
          try {
            fs.mkdirSync(item.target, { recursive: true })
          } catch (error) {
            throw appError('E_LOCAL_IO', {
              detail: `mkdir ${item.target}: ${error instanceof Error ? error.message : String(error)}`
            })
          }
        }
        continue
      }
      expanded.push({ source: item.source, target: item.target, isDirectory, files })
    }

    const built = await buildTransferTasks({
      sessionId: request.sessionId,
      connectionLabel: label,
      direction: request.direction,
      now,
      items: expanded,
      policy: request.onConflict,
      ...(request.decisions ? { decisions: request.decisions } : {}),
      isRemoteTarget: isUpload,
      targetExists: async (candidate) =>
        isUpload ? (await sftp.tryStat(candidate)) !== null : fs.existsSync(candidate),
      newId: randomUUID
    })

    ctx.transfers.add(built.tasks)
    ctx.logger.info('transfer started', {
      rows: built.tasks.filter((t) => !t.parentId).length,
      files: built.tasks.filter((t) => !t.isDirectory).length,
      skipped: built.skipped.length,
      direction: request.direction
    })
    return ok<TransferTask[]>(built.tasks.filter((t) => !t.parentId))
  })

  registerChannel(CH.transferPause, (payload, ctx) => {
    ctx.transfers.pause(taskIdSchema.parse(payload).taskId)
    return ok(undefined)
  })

  registerChannel(CH.transferResume, (payload, ctx) => {
    ctx.transfers.resume(taskIdSchema.parse(payload).taskId)
    return ok(undefined)
  })

  registerChannel(CH.transferCancel, (payload, ctx) => {
    ctx.transfers.cancel(taskIdSchema.parse(payload).taskId)
    return ok(undefined)
  })

  registerChannel(CH.transferRetry, (payload, ctx) => {
    ctx.transfers.retry(taskIdSchema.parse(payload).taskId)
    return ok(undefined)
  })

  registerChannel(CH.transferRemove, (payload, ctx) => {
    ctx.transfers.remove(taskIdSchema.parse(payload).taskId)
    return ok(undefined)
  })

  registerChannel(CH.transferReorder, (payload, ctx) => {
    const { taskId, direction } = reorderSchema.parse(payload)
    ctx.transfers.moveTask(taskId, direction)
    return ok(undefined)
  })

  registerChannel(CH.transferReveal, (payload, ctx) => {
    const { taskId } = taskIdSchema.parse(payload)
    const task = ctx.transfers.get(taskId)
    // §3.9-6：只接受既有任務的本地目標，不接受 renderer 傳來的任意路徑
    const localPath = task.direction === 'upload' ? task.source : task.target
    ctx.revealPath(localPath)
    return ok(undefined)
  })

  registerChannel(CH.transferClearCompleted, (_payload, ctx) => {
    ctx.transfers.clearCompleted()
    return ok(undefined)
  })

  registerChannel(CH.transferList, (_payload, ctx) => ok<TransferTask[]>(ctx.transfers.list()))
}

export { EVT, TIMING }
