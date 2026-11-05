import { Client, type ClientChannel } from 'ssh2'
import type { AppError, ConnectPhase } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'
import { TIMING } from '../../shared/constants'
import { classifyConnectError, classifyDisconnect, type PhaseFailure, type SshErrorLike } from './phases'
import { openForward } from './jump'
import { fingerprintSha256, keyAlgorithm, verifyHostKey, type HostKeyPrompt, type KnownHostsStore } from './hostkey'

export interface SshAuth {
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
}

export interface SshEndpoint extends SshAuth {
  host: string
  port: number
}

export interface SshConnectOptions {
  target: SshEndpoint
  jump?: SshEndpoint
  /** §6.1 定案：15000 / 1（不得用 ssh2 預設值） */
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  readyTimeoutMs?: number
  knownHosts?: KnownHostsStore
  /** TOFU 詢問；未提供時一律拒絕（安全預設） */
  hostKeyPrompt?: HostKeyPrompt
  onPhase?: (phase: ConnectPhase) => void
  onDisconnect?: (failure: PhaseFailure) => void
  cols?: number
  rows?: number
  term?: string
}

export interface SshSession {
  /** 目的主機的 Client（SFTP 直接用它，天然走同一條隧道） */
  client: Client
  stream: ClientChannel
  /** 目的主機金鑰指紋（known_hosts 用） */
  fingerprint: string
  phase: ConnectPhase
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  isClosed(): boolean
}

/** 傳給 ssh2 Client.connect 的設定（抽成純函式，供單元測試驗證 §6.1 定案參數） */
export function sshConnectConfig(
  endpoint: SshEndpoint,
  options: {
    keepaliveIntervalMs: number
    keepaliveCountMax: number
    readyTimeoutMs: number
    hostVerifier: (key: Buffer, callback: (ok: boolean) => void) => void
    sock?: ClientChannel
  }
): Parameters<Client['connect']>[0] {
  return {
    ...(options.sock
      ? { sock: options.sock }
      : { host: endpoint.host, port: endpoint.port }),
    username: endpoint.username,
    password: endpoint.password,
    privateKey: endpoint.privateKey,
    passphrase: endpoint.passphrase,
    readyTimeout: options.readyTimeoutMs,
    keepaliveInterval: options.keepaliveIntervalMs,
    keepaliveCountMax: options.keepaliveCountMax,
    hostVerifier: options.hostVerifier
  }
}

function toAppError(phase: ConnectPhase, error: unknown): AppError {
  const failure = classifyConnectError(phase, (error ?? {}) as SshErrorLike)
  const message = error instanceof Error ? error.message : String((error as SshErrorLike | undefined)?.message ?? error)
  return appError(failure.code, { phase: failure.phase, message, detail: message })
}

/**
 * SSH 連線（含單跳跳板）。七階段任一失敗都以 AppError（帶 phase）拒絕。
 * 已連線後斷線：`error` / `close` / `end` 取最先觸發者，且只回報一次（§6.4）。
 */
export async function openSshSession(options: SshConnectOptions): Promise<SshSession> {
  const keepaliveInterval = options.keepaliveIntervalMs ?? TIMING.keepaliveIntervalMs
  const keepaliveCountMax = options.keepaliveCountMax ?? TIMING.keepaliveCountMax
  const readyTimeout = options.readyTimeoutMs ?? TIMING.authTimeoutMs
  const cols = options.cols ?? 120
  const rows = options.rows ?? 30
  const term = options.term ?? 'xterm-256color'
  const rejectPrompt: HostKeyPrompt = async () => 'reject'
  const prompt = options.hostKeyPrompt ?? rejectPrompt

  let phase: ConnectPhase = options.jump ? 'jump-dns' : 'target-tcp'
  const report = (next: ConnectPhase): void => {
    phase = next
    options.onPhase?.(next)
  }

  const jumpClient = options.jump ? new Client() : null
  const targetClient = new Client()
  const fingerprints = new Map<string, string>()
  let destroyed = false
  let disconnecting = false

  const hostVerifierFor =
    (host: string, port: number, kind: 'jump' | 'target') =>
    (key: Buffer, callback: (ok: boolean) => void): void => {
      fingerprints.set(kind, fingerprintSha256(key))
      const keyType = keyAlgorithm(key)
      if (!options.knownHosts) {
        callback(true)
        return
      }
      if (kind === 'target') report('hostkey')
      verifyHostKey({ store: options.knownHosts, prompt, host, port, keyType, key })
        .then((outcome) => {
          if (!outcome.accepted) {
            callback(false)
            return
          }
          if (kind === 'target') report('target-auth')
          callback(true)
        })
        .catch(() => callback(false))
    }

  const connectClient = (
    client: Client,
    config: Parameters<Client['connect']>[0],
    errorPhase: () => ConnectPhase
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        client.removeListener('ready', onReady)
        reject(toAppError(errorPhase(), error))
      }
      const onReady = (): void => {
        client.removeListener('error', onError)
        resolve()
      }
      client.once('error', onError)
      client.once('ready', onReady)
      try {
        client.connect(config)
      } catch (error) {
        client.removeListener('error', onError)
        client.removeListener('ready', onReady)
        reject(toAppError(errorPhase(), error))
      }
    })

  // ---- 1~3：跳板 ----
  if (jumpClient && options.jump) {
    const jump = options.jump
    report('jump-dns')
    await connectClient(
      jumpClient,
      sshConnectConfig(jump, {
        keepaliveIntervalMs: keepaliveInterval,
        keepaliveCountMax,
        readyTimeoutMs: readyTimeout,
        hostVerifier: hostVerifierFor(jump.host, jump.port, 'jump')
      }),
      () => phase
    ).catch((error: unknown) => {
      jumpClient.end()
      throw error
    })
    report('jump-auth')
  }

  // ---- 4：隧道 ----
  let sock: ClientChannel | undefined
  if (jumpClient) {
    report('tunnel')
    try {
      sock = await openForward(jumpClient, { host: options.target.host, port: options.target.port })
    } catch (error) {
      jumpClient.end()
      throw error
    }
    report('target-tcp')
  }

  // ---- 5~7：目的主機 ----
  try {
    await connectClient(
      targetClient,
      sshConnectConfig(options.target, {
        keepaliveIntervalMs: keepaliveInterval,
        keepaliveCountMax,
        readyTimeoutMs: readyTimeout,
        hostVerifier: hostVerifierFor(options.target.host, options.target.port, 'target'),
        ...(sock ? { sock } : {})
      }),
      () => phase
    )
  } catch (error) {
    jumpClient?.end()
    targetClient.end()
    throw error
  }

  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    targetClient.shell({ term, cols, rows }, (error, channel) => {
      if (error) {
        reject(toAppError('target-auth', error))
        return
      }
      resolve(channel)
    })
  })
  report('ready')

  // ---- §6.4：斷線偵測（error / close / end 取最先，去重）----
  const notifyDisconnect = (who: 'jump' | 'target'): void => {
    if (destroyed || disconnecting) return
    disconnecting = true
    options.onDisconnect?.(classifyDisconnect(who))
  }
  const bind = (client: Client, who: 'jump' | 'target'): void => {
    client.on('error', () => notifyDisconnect(who))
    client.on('close', () => notifyDisconnect(who))
    client.on('end', () => notifyDisconnect(who))
  }
  bind(targetClient, 'target')
  if (jumpClient) bind(jumpClient, 'jump')

  return {
    client: targetClient,
    stream,
    fingerprint: fingerprints.get('target') ?? '',
    phase,
    write(data: string): void {
      if (!stream.destroyed) stream.write(data)
    },
    resize(nextCols: number, nextRows: number): void {
      if (!stream.destroyed) stream.setWindow(nextRows, nextCols, 0, 0)
    },
    close(): void {
      destroyed = true
      try {
        stream.close()
      } catch {
        // 已關閉
      }
      targetClient.end()
      jumpClient?.end()
    },
    isClosed(): boolean {
      return destroyed || stream.destroyed
    }
  }
}
