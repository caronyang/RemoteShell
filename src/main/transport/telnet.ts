import net from 'node:net'
import type { AppError } from '../../shared/ipc-contract'
import { appError } from '../../shared/errors'
import { TIMING } from '../../shared/constants'
import { IacDecoder, OPT, escapeData, naws, optionCommand, terminalTypeIs, type IacEvent } from './iac'

export interface TelnetOptions {
  host: string
  port: number
  cols?: number
  rows?: number
  timeoutMs?: number
  onData?: (bytes: Buffer) => void
  onNegotiate?: (event: IacEvent) => void
  onDisconnect?: (error: AppError) => void
}

const TERM_NAME = 'XTERM-256COLOR'

/**
 * Telnet（S5）：IAC 協商在 main 完成，renderer 只收到乾淨位元組。
 * - 接受 WILL ECHO / WILL SGA / WILL TTYPE，並對 DO NAWS 回 WILL NAWS + 視窗大小
 * - resize 立即送 NAWS
 */
export class TelnetTransport {
  private closed = false
  private cols: number
  private rows: number
  private readonly decoder = new IacDecoder()

  private constructor(
    private readonly socket: net.Socket,
    private readonly options: TelnetOptions
  ) {
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 30
  }

  static connect(options: TelnetOptions): Promise<TelnetTransport> {
    const timeoutMs = options.timeoutMs ?? TIMING.tcpTimeoutMs

    return new Promise<TelnetTransport>((resolve, reject) => {
      const socket = net.connect({ host: options.host, port: options.port })
      let settled = false

      const failWith = (code: 'E_TARGET_TCP' | 'E_TIMEOUT', detail: string): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(appError(code, { phase: 'target-tcp', detail, message: detail }))
      }

      const timer = setTimeout(
        () => failWith('E_TIMEOUT', `telnet connect timeout ${options.host}:${options.port}`),
        timeoutMs
      )

      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const transport = new TelnetTransport(socket, options)
        // 主動要求終端型別 / 視窗大小 / ECHO（對齊 S5 驗收）
        socket.write(optionCommand('will', OPT.TTYPE))
        socket.write(optionCommand('do', OPT.NAWS))
        socket.write(optionCommand('will', OPT.SGA))
        socket.write(optionCommand('do', OPT.ECHO))
        socket.write(naws(transport.cols, transport.rows))
        socket.on('data', (chunk: Buffer) => transport.ingest(chunk))
        resolve(transport)
      })

      socket.once('error', (error: Error) => {
        if (!settled) {
          failWith('E_TARGET_TCP', error.message)
          return
        }
        options.onDisconnect?.(
          appError('E_NETWORK', { phase: 'target-tcp', message: error.message, detail: error.message })
        )
      })

      socket.once('close', () => {
        clearTimeout(timer)
        if (!settled) {
          failWith('E_TARGET_TCP', 'connection closed before ready')
          return
        }
        options.onDisconnect?.(
          appError('E_NETWORK', { phase: 'target-tcp', message: 'telnet socket closed', detail: 'closed' })
        )
      })
    })
  }

  /** 解析一段位元組：先回報協商事件（必要時回覆），乾淨資料才往上送 */
  private ingest(chunk: Buffer): void {
    const { data, events } = this.decoder.push(chunk)
    for (const event of events) {
      this.options.onNegotiate?.(event)
      this.handleNegotiation(event)
    }
    if (data.length > 0) this.options.onData?.(data)
  }

  /** 由 socket data 事件呼叫（在 connect 內註冊） */
  private handleNegotiation(event: IacEvent): void {
    if (event.type === 'sub') {
      if (event.option === OPT.TTYPE && event.payload[0] === 1) {
        this.socket.write(terminalTypeIs(TERM_NAME))
      }
      return
    }
    const reply = (verb: 'will' | 'wont' | 'do' | 'dont', option: number): void => {
      this.socket.write(optionCommand(verb, option))
    }
    switch (event.type) {
      case 'will':
        if (event.option === OPT.ECHO || event.option === OPT.SGA) reply('do', event.option)
        else if (event.option === OPT.TTYPE) reply('do', event.option)
        else reply('dont', event.option)
        break
      case 'do':
        if (event.option === OPT.NAWS) {
          reply('will', event.option)
          this.socket.write(naws(this.cols, this.rows))
        } else if (event.option === OPT.TTYPE) reply('will', event.option)
        else reply('wont', event.option)
        break
      case 'wont':
      case 'dont':
        break
    }
  }

  write(data: string): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(escapeData(Buffer.from(data, 'utf8')))
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (this.closed || this.socket.destroyed) return
    this.socket.write(naws(cols, rows))
  }

  close(): void {
    this.closed = true
    this.socket.end()
    this.socket.destroy()
  }

  isClosed(): boolean {
    return this.closed || this.socket.destroyed
  }
}
