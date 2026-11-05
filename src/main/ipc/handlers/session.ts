import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { AppError, ConnectionProfile, HostKeyDecision, OpenSessionRequest, SessionInfo } from '../../../shared/ipc-contract'
import { CH, EVT, TIMING } from '../../../shared/constants'
import { appError, ok } from '../../../shared/errors'
import { registerChannel } from '../register'
import { ByteBatcher, ByteRingBuffer } from '../../transport/decoder'
import { openSshSession, type SshEndpoint, type SshSession } from '../../transport/ssh'
import type { Client as SshClient } from 'ssh2'
import { TelnetTransport } from '../../transport/telnet'
import type { HostKeyPromptRequest } from '../../transport/hostkey'
import type { KnownHostsStore } from '../../transport/hostkey'
import type { VaultService } from '../../vault/dpapi'
import type { ConnectionsStore } from '../../store/connections'
import type { Logger } from '../../logger'
import { loadPrivateKey, readPasswordFile } from '../../vault/keyfile'

/** SessionManager 只需要這幾樣，不依賴整個 AppContext（避免循環依賴） */
export interface SessionDeps {
  connections: ConnectionsStore
  vault: VaultService
  knownHosts: KnownHostsStore
  logger: Logger
  broadcast: (channel: string, payload: unknown) => void
}

interface TransportHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  isClosed(): boolean
}

interface ActiveSession {
  info: SessionInfo
  profile: ConnectionProfile
  transport: TransportHandle | null
  /** 只有 SSH session 才有（SFTP 用） */
  client: SshClient | null
  batcher: ByteBatcher | null
  ring: ByteRingBuffer
  closed: boolean
}

const HOSTKEY_TIMEOUT_MS = 120_000

/**
 * v0.1.5 P1：本次輸入的臨時憑證優先於已存 dpapi secret。
 * 舊行為在「已記住密碼」的 profile 上永遠用舊密碼重試，憑證重送不可能成功。
 */
export function preferredSecret(
  auth: ConnectionProfile['auth'],
  ephemeralSecret: string | undefined,
  decrypt: (ref: Extract<ConnectionProfile['auth']['secret'], { kind: 'dpapi' }>) => string
): string | undefined {
  if (ephemeralSecret !== undefined) return ephemeralSecret
  return auth.secret.kind === 'dpapi' ? decrypt(auth.secret) : undefined
}

/**
 * 連線工作階段管理（§6.6）：
 * - 權威狀態在 main，renderer 只收 `rs:evt:session:state`
 * - 資料以 8ms/16KB 批次送 `rs:evt:session:data`，同時寫入 256KB 環形緩衝（snapshot 用）
 * - 秘密只存在這個行程的記憶體，任何事件都不夾帶
 */
export class SessionManager {
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly pendingHostKeys = new Map<string, (decision: HostKeyDecision) => void>()
  /** 已關閉 session → profileId（P1-06：憑證重連走 session.open，仍要認得舊 session 屬於哪個 profile） */
  private readonly closedProfiles = new Map<string, string>()

  constructor(private readonly ctx: SessionDeps) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  get(sessionId: string): SessionInfo {
    return this.require(sessionId).info
  }

  private require(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw appError('E_NOT_FOUND', { detail: `session ${sessionId}` })
    return session
  }

  /** 狀態變更通知（main 用它把傳輸佇列暫停／續傳；保持 SessionManager 不依賴 queue） */
  onStateChange: ((info: SessionInfo) => void) | null = null

  private updateState(session: ActiveSession, patch: Partial<SessionInfo>): void {
    session.info = { ...session.info, ...patch }
    this.ctx.broadcast(EVT.sessionState, session.info)
    this.onStateChange?.(session.info)
  }

  /** 把 profile.auth + 本次臨時輸入轉成 ssh2 端點（秘密只留在 main 記憶體） */
  private resolveEndpoint(profile: ConnectionProfile, ephemeralSecret?: string, passwordFileOverride?: string): SshEndpoint {
    const auth = profile.auth
    /* v0.1.5 P1：本次臨時輸入優先於已存的 dpapi secret —— 否則「憑證重送」永遠拿舊密碼重試，
       第二次 open 必再失敗（QA 看到的「按 OK 沒反應」就是這個）。 */
    const secretValue = (): string | undefined =>
      preferredSecret(auth, ephemeralSecret, (ref) => this.ctx.vault.decrypt(ref))

    switch (auth.method) {
      case 'password': {
        const password = secretValue()
        if (!password) {
          // 沒記住密碼：回可辨識的碼讓 UI 跳 CredentialDialog（不是「輸入格式錯誤」）
          throw appError('E_VAULT_UNAVAILABLE', {
            message: 'credential required',
            detail: 'no stored password for this profile; UI should prompt for one'
          })
        }
        return { host: profile.host, port: profile.port, username: auth.username, password }
      }
      case 'passwordFile': {
        const filePath = passwordFileOverride ?? auth.filePath
        return { host: profile.host, port: profile.port, username: auth.username, password: readPasswordFile(filePath) }
      }
      case 'publicKey': {
        const passphrase = secretValue()
        return {
          host: profile.host,
          port: profile.port,
          username: auth.username,
          privateKey: loadPrivateKey(auth.keyPath, passphrase),
          /* v0.1.6：加密金鑰的 passphrase 不只要用來檢查金鑰，還要傳給 ssh2；
             否則 connect 重新解析同一個加密緩衝時會失敗（之前被歸類成 E_TARGET_TCP）。
             loadPrivateKey 已先用同一 passphrase 驗證，錯字會在此之前回 E_KEY_PASSPHRASE。 */
          ...(passphrase ? { passphrase } : {})
        }
      }
      default:
        throw appError('E_VALIDATION', { detail: 'unknown auth method' })
    }
  }

  private promptHostKey(sessionId: string): (req: HostKeyPromptRequest) => Promise<HostKeyDecision> {
    return (request) =>
      new Promise<HostKeyDecision>((resolve) => {
        const requestId = randomUUID()
        const timer = setTimeout(() => {
          this.pendingHostKeys.delete(requestId)
          resolve('reject')
        }, HOSTKEY_TIMEOUT_MS)
        this.pendingHostKeys.set(requestId, (decision) => {
          clearTimeout(timer)
          this.pendingHostKeys.delete(requestId)
          resolve(decision)
        })
        this.ctx.broadcast(EVT.hostkeyPrompt, {
          requestId,
          host: request.host,
          port: request.port,
          keyType: request.keyType,
          fingerprintSha256: request.fingerprintSha256,
          ...(request.knownPrevious ? { knownPrevious: request.knownPrevious } : {})
        })
        void sessionId
      })
  }

  answerHostKey(requestId: string, decision: HostKeyDecision): void {
    const pending = this.pendingHostKeys.get(requestId)
    if (!pending) throw appError('E_NOT_FOUND', { detail: `hostkey request ${requestId}` })
    pending(decision)
  }

  async open(request: OpenSessionRequest): Promise<SessionInfo> {
    const { profiles } = this.ctx.connections.list()
    const profile = profiles.find((p) => p.id === request.profileId)
    if (!profile) throw appError('E_NOT_FOUND', { detail: `profile ${request.profileId}` })

    const jumpProfile =
      profile.jump.enabled && profile.jump.connectionIds.length > 0
        ? profiles.find((p) => p.id === profile.jump.connectionIds[0])
        : undefined
    // P0-01-2：main 不信任 UI —— 跳板必須已選、存在、且是 SSH
    if (profile.jump.enabled && profile.jump.connectionIds.length === 0) {
      throw appError('E_VALIDATION', { detail: 'jump: enabled but no jump connection selected' })
    }
    if (profile.jump.enabled && !jumpProfile) {
      throw appError('E_VALIDATION', { detail: 'jump: jump profile not found' })
    }
    if (jumpProfile && jumpProfile.protocol !== 'ssh') {
      throw appError('E_VALIDATION', {
        detail: `jump: "${jumpProfile.name}" is ${jumpProfile.protocol}; jump host must be SSH`
      })
    }

    const sessionId = randomUUID()
    const info: SessionInfo = {
      sessionId,
      profileId: profile.id,
      protocol: profile.protocol,
      state: 'connecting',
      phase: jumpProfile ? 'jump-dns' : 'target-tcp',
      host: profile.host,
      port: profile.port,
      ...(jumpProfile ? { viaProfileName: jumpProfile.name } : {}),
      cols: request.cols,
      rows: request.rows
    }

    const session: ActiveSession = {
      info,
      profile,
      transport: null,
      client: null,
      batcher: null,
      ring: new ByteRingBuffer(TIMING.ringBufferBytes),
      closed: false
    }
    this.sessions.set(sessionId, session)
    this.ctx.broadcast(EVT.sessionState, session.info)

    try {
      if (profile.protocol === 'telnet') {
        await this.openTelnet(session, request)
      } else {
        await this.openSsh(session, request, jumpProfile)
      }
    } catch (error) {
      const appErr = isAppError(error)
        ? error
        : appError('E_INTERNAL', { message: error instanceof Error ? error.message : 'connect failed' })
      this.updateState(session, { state: 'failed', error: appErr, phase: appErr.phase ?? session.info.phase })
      this.ctx.logger.warn('session open failed', { sessionId, code: appErr.code, phase: appErr.phase })
      throw appErr
    }

    return session.info
  }

  private startDataPlane(session: ActiveSession): void {
    const sessionId = session.info.sessionId
    session.batcher = new ByteBatcher(
      { maxDelayMs: TIMING.dataBatchMs, maxBytes: TIMING.dataBatchBytes },
      (bytes, seq) => {
        session.ring.push(bytes)
        this.ctx.broadcast(EVT.sessionData, { sessionId, seq, bytes })
      }
    )
  }

  private async openSsh(
    session: ActiveSession,
    request: OpenSessionRequest,
    jumpProfile: ConnectionProfile | undefined
  ): Promise<void> {
    const profile = session.profile
    const target = this.resolveEndpoint(profile, request.ephemeral?.secret, request.ephemeral?.passwordFileOverride)
    const jump = jumpProfile
      ? this.resolveEndpoint(jumpProfile, request.ephemeral?.secret, request.ephemeral?.passwordFileOverride)
      : undefined

    const handle: SshSession = await openSshSession({
      target,
      ...(jump ? { jump } : {}),
      knownHosts: this.ctx.knownHosts,
      hostKeyPrompt: this.promptHostKey(session.info.sessionId),
      cols: request.cols,
      rows: request.rows,
      onPhase: (phase) => this.updateState(session, { phase }),
      onDisconnect: (failure) => this.markDisconnected(session, failure.phase, failure.code)
    })

    session.transport = handle
    session.client = handle.client
    this.startDataPlane(session)
    handle.stream.on('data', (chunk: Buffer) => session.batcher?.push(chunk))
    handle.stream.stderr.on('data', (chunk: Buffer) => session.batcher?.push(chunk))
    handle.stream.on('close', () => this.markDisconnected(session, 'target-tcp', 'E_CHANNEL_CLOSED'))

    this.updateState(session, {
      state: 'connected',
      phase: 'ready',
      openedAt: new Date().toISOString()
    })
    this.ctx.logger.info('ssh session opened', {
      sessionId: session.info.sessionId,
      via: jumpProfile?.name ?? null,
      fingerprint: handle.fingerprint
    })
  }

  private async openTelnet(session: ActiveSession, request: OpenSessionRequest): Promise<void> {
    const profile = session.profile
    const transport = await TelnetTransport.connect({
      host: profile.host,
      port: profile.port,
      cols: request.cols,
      rows: request.rows,
      onData: (bytes) => session.batcher?.push(bytes),
      onDisconnect: (error) => this.markDisconnected(session, error.phase ?? 'target-tcp', error.code)
    })
    session.transport = transport
    this.startDataPlane(session)
    this.updateState(session, { state: 'connected', phase: 'ready', openedAt: new Date().toISOString() })
    this.ctx.logger.info('telnet session opened', { sessionId: session.info.sessionId })
  }

  private markDisconnected(session: ActiveSession, phase: SessionInfo['phase'], code: AppError['code']): void {
    if (session.closed || session.info.state !== 'connected') return
    session.batcher?.flush()
    this.updateState(session, {
      state: 'disconnected',
      phase,
      error: appError(code, { phase })
    })
    this.ctx.logger.warn('session disconnected', { sessionId: session.info.sessionId, phase, code })
  }

  /** SFTP 用：只有 SSH session 才有 client（Telnet 回 null → E_SFTP_UNAVAILABLE） */
  sftpClient(sessionId: string): SshClient | null {
    return this.require(sessionId).client
  }

  profileIdOf(sessionId: string): string {
    return this.require(sessionId).info.profileId
  }

  viaNameOf(sessionId: string): string | undefined {
    return this.require(sessionId).info.viaProfileName
  }

  write(sessionId: string, data: string): void {
    const session = this.require(sessionId)
    if (!session.transport) throw appError('E_CHANNEL_CLOSED', { phase: session.info.phase })
    session.transport.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId)
    session.info = { ...session.info, cols, rows }
    session.transport?.resize(cols, rows)
  }

  snapshot(sessionId: string): Uint8Array {
    return this.require(sessionId).ring.snapshot()
  }

  close(sessionId: string): void {
    const session = this.require(sessionId)
    session.closed = true
    this.rememberClosed(session)
    session.batcher?.flush()
    session.batcher?.dispose()
    session.transport?.close()
    this.updateState(session, { state: 'disconnected', phase: 'ready' })
    this.sessions.delete(sessionId)
  }

  /** 舊 session 的 profile 只留最近 200 筆，避免長期累積 */
  private rememberClosed(session: ActiveSession): void {
    this.closedProfiles.delete(session.info.sessionId)
    this.closedProfiles.set(session.info.sessionId, session.info.profileId)
    while (this.closedProfiles.size > 200) {
      const oldest = this.closedProfiles.keys().next().value
      if (oldest === undefined) break
      this.closedProfiles.delete(oldest)
    }
  }

  /** P1-06：同一個 profile 最近關閉的 sessionId（憑證重連後要把任務改綁回新 session） */
  closedSessionIdsForProfile(profileId: string): string[] {
    return [...this.closedProfiles.entries()]
      .filter(([, id]) => id === profileId)
      .map(([sessionId]) => sessionId)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      try {
        this.close(id)
      } catch {
        // 已關閉
      }
    }
  }
}

function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && 'code' in value && 'i18nKey' in value
}

/* ---------------- IPC 註冊 ---------------- */

/** 傳輸佇列中需要改綁的最小介面（方便單元測試） */
export interface TransferBinding {
  reassignSession(fromSessionId: string, toSessionId: string): void
  resumeSession(sessionId: string): void
}

/**
 * P1-06：任何成功建立的新 session 取代舊 session 時，把舊 session 的任務改綁並續傳。
 * 舊 session 可能是「已斷線但仍在清單」或「已被 close（憑證重連路徑）」，
 * 兩者都要算；仍在 connecting／connected 的其他 session 不動（那是另一個分頁）。
 */
export function adoptTransfersToSession(
  liveSessions: SessionInfo[],
  closedSessionIds: string[],
  transfers: TransferBinding,
  opened: SessionInfo
): string[] {
  const stale = new Set(closedSessionIds)
  for (const info of liveSessions) {
    if (info.sessionId === opened.sessionId) continue
    if (info.profileId !== opened.profileId) continue
    if (info.state === 'connecting' || info.state === 'connected') continue
    stale.add(info.sessionId)
  }
  stale.delete(opened.sessionId)
  for (const sessionId of stale) transfers.reassignSession(sessionId, opened.sessionId)
  if (stale.size > 0) transfers.resumeSession(opened.sessionId)
  return [...stale]
}

const openSchema = z.object({
  profileId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
  ephemeral: z.object({ secret: z.string().optional(), passwordFileOverride: z.string().optional() }).optional()
})
const writeSchema = z.object({ sessionId: z.string().min(1), data: z.string() })
const resizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500)
})
const idSchema = z.object({ sessionId: z.string().min(1) })

export function register(): void {
  registerChannel(CH.sessionOpen, async (payload, ctx) => {
    const request = openSchema.parse(payload) as OpenSessionRequest
    const opened = await ctx.sessions.open(request)
    // P1-06：憑證重連走的就是這條（open + ephemeral），新 session 要接手舊 session 的暫停任務
    adoptTransfersToSession(
      ctx.sessions.list(),
      ctx.sessions.closedSessionIdsForProfile(opened.profileId),
      ctx.transfers,
      opened
    )
    return ok<SessionInfo>(opened)
  })

  registerChannel(CH.sessionWrite, (payload, ctx) => {
    const { sessionId, data } = writeSchema.parse(payload)
    ctx.sessions.write(sessionId, data)
    return ok(undefined)
  })

  registerChannel(CH.sessionResize, (payload, ctx) => {
    const { sessionId, cols, rows } = resizeSchema.parse(payload)
    ctx.sessions.resize(sessionId, cols, rows)
    return ok(undefined)
  })

  registerChannel(CH.sessionClose, (payload, ctx) => {
    const { sessionId } = idSchema.parse(payload)
    ctx.sessions.close(sessionId)
    return ok(undefined)
  })

  registerChannel(CH.sessionReconnect, async (payload, ctx) => {
    const { sessionId } = idSchema.parse(payload)
    const existing = ctx.sessions.get(sessionId)
    ctx.sessions.close(sessionId)
    const reopened = await ctx.sessions.open({
      profileId: existing.profileId,
      cols: existing.cols,
      rows: existing.rows
    })
    // 斷線期間被暫停的傳輸：改綁到新 session 後自動續傳（UI-07 B「重連＝整條重建」）
    // 舊 session 已在 close() 記進 closedProfiles；同時接手其他同 profile 的殘留 session
    adoptTransfersToSession(
      ctx.sessions.list(),
      ctx.sessions.closedSessionIdsForProfile(reopened.profileId),
      ctx.transfers,
      reopened
    )
    return ok<SessionInfo>(reopened)
  })

  registerChannel(CH.sessionSnapshot, (payload, ctx) => {
    const { sessionId } = idSchema.parse(payload)
    return ok<{ bytes: Uint8Array }>({ bytes: ctx.sessions.snapshot(sessionId) })
  })
}

/** 給 main 建構 context 用（deps 是 AppContext 的子集） */
export function createSessionManager(deps: SessionDeps): SessionManager {
  return new SessionManager(deps)
}
