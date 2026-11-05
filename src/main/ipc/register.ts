import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { Result } from '../../shared/ipc-contract'
import { fail } from '../../shared/errors'
import type { Logger } from '../logger'
import type { SettingsStore } from '../store/settings'
import type { ConnectionsStore } from '../store/connections'
import type { SessionManager } from './handlers/session'
import type { VaultService } from '../vault/dpapi'
import type { KnownHostsStore } from '../transport/hostkey'
import type { SftpRegistry } from '../sftp/registry'
import type { TransferScheduler } from '../queue/scheduler'
import { StoreValidationError } from '../store/schema'
import { ZodError } from 'zod'
import { isErrorCode } from '../../shared/errors'
import type { AppError } from '../../shared/ipc-contract'

/** handler 內以 throw appError(...) 表達的領域錯誤（要原樣回給 renderer） */
function isAppErrorLike(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    isErrorCode((value as { code: unknown }).code) &&
    'i18nKey' in value
  )
}

export interface AppContext {
  logger: Logger
  settings: SettingsStore
  connections: ConnectionsStore
  sessions: SessionManager
  vault: VaultService
  knownHosts: KnownHostsStore
  sftp: SftpRegistry
  transfers: TransferScheduler
  /** 「開啟資料夾」：由 main 決定（shell.showItemInFolder），不接受任意路徑 */
  revealPath(localPath: string): void
  broadcast(channel: string, payload: unknown): void
  resolveWindow(event: IpcMainInvokeEvent | null): BrowserWindow | null
}

export type Handler = (
  payload: unknown,
  ctx: AppContext,
  event: IpcMainInvokeEvent | null
) => Promise<Result<unknown>> | Result<unknown>

const registry = new Map<string, Handler>()

/**
 * 唯一註冊點（§3.4）：所有通道都必須經過這裡，重複註冊直接視為程式錯誤。
 */
export function registerChannel(channel: string, handler: Handler): void {
  if (registry.has(channel)) throw new Error(`duplicate channel registration: ${channel}`)
  registry.set(channel, handler)
}

/** M1 尚未實作的 M2／M3 通道：已註冊但回 E_INTERNAL（不得讓 renderer 收到例外） */
export function registerNotImplemented(channel: string, plannedCard: string): void {
  registerChannel(channel, () =>
    fail('E_INTERNAL', {
      message: 'Channel is registered but not implemented yet',
      detail: `planned: ${plannedCard}`
    })
  )
}

export function listChannels(): string[] {
  return [...registry.keys()].sort()
}

/**
 * 統一分派：未註冊 → E_NOT_FOUND；驗證失敗 → E_VALIDATION；其餘 → E_INTERNAL。
 * 對外（renderer）永遠拿到 Result，不會是 exception。
 */
export async function dispatch(
  channel: string,
  payload: unknown,
  ctx: AppContext,
  event: IpcMainInvokeEvent | null = null
): Promise<Result<unknown>> {
  const handler = registry.get(channel)
  if (!handler) return fail('E_NOT_FOUND', { detail: channel })
  try {
    return await handler(payload, ctx, event)
  } catch (cause) {
    if (isAppErrorLike(cause)) return { ok: false, error: cause }
    if (cause instanceof StoreValidationError) {
      return fail('E_VALIDATION', { message: cause.message, detail: cause.message })
    }
    if (cause instanceof ZodError) {
      const summary = cause.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      return fail('E_VALIDATION', { message: summary, detail: summary })
    }
    // 只記 channel 與錯誤訊息，payload 可能含秘密，絕不寫 log
    ctx.logger.error('ipc handler failed', {
      channel,
      error: cause instanceof Error ? cause.message : String(cause)
    })
    return fail('E_INTERNAL', { detail: channel })
  }
}

/** 把 registry 綁到 ipcMain（每個通道一個 handler，無通用 invoke） */
export function registerIpc(ctx: AppContext): void {
  for (const channel of registry.keys()) {
    ipcMain.handle(channel, (event, payload: unknown) => dispatch(channel, payload, ctx, event))
  }
  ctx.logger.info('ipc channels registered', { count: registry.size })
}
