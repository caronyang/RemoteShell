/** Telnet IAC（RFC 854/857/1073/1091）：位元組解析與編碼 */

export const IAC = 255
export const DONT = 254
export const DO = 253
export const WONT = 252
export const WILL = 251
export const SB = 250
export const SE = 240

export const OPT = {
  ECHO: 1,
  SGA: 3,
  STATUS: 5,
  TTYPE: 24,
  NAWS: 31
} as const

export type IacVerb = 'will' | 'wont' | 'do' | 'dont'

export interface IacOptionEvent {
  type: IacVerb
  option: number
}

export interface IacSubEvent {
  type: 'sub'
  option: number
  payload: Buffer
}

export type IacEvent = IacOptionEvent | IacSubEvent

const VERB_BY_BYTE: Record<number, IacVerb> = {
  [WILL]: 'will',
  [WONT]: 'wont',
  [DO]: 'do',
  [DONT]: 'dont'
}

/**
 * 剝離 IAC 序列（不得有任何 0xFF 洩漏到畫面），並回報協商事件。
 * 跨 chunk 的半個序列會保留狀態，下次 push 繼續。
 */
export class IacDecoder {
  private state: 'data' | 'iac' | 'verb' | 'sb' | 'sb-iac' = 'data'
  private verb: number | null = null
  private subOption: number | null = null
  private subPayload: number[] = []

  push(chunk: Buffer): { data: Buffer; events: IacEvent[] } {
    const out: number[] = []
    const events: IacEvent[] = []
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) this.state = 'iac'
          else out.push(byte)
          break
        case 'iac':
          if (byte === IAC) {
            out.push(IAC)
            this.state = 'data'
          } else if (byte === SB) {
            this.state = 'sb'
            this.subOption = null
            this.subPayload = []
          } else if (VERB_BY_BYTE[byte]) {
            this.verb = byte
            this.state = 'verb'
          } else {
            this.state = 'data'
          }
          break
        case 'verb': {
          const type = VERB_BY_BYTE[this.verb ?? -1]
          if (type) events.push({ type, option: byte })
          this.verb = null
          this.state = 'data'
          break
        }
        case 'sb':
          if (byte === IAC) this.state = 'sb-iac'
          else if (this.subOption === null) this.subOption = byte
          else this.subPayload.push(byte)
          break
        case 'sb-iac':
          if (byte === SE) {
            if (this.subOption !== null) {
              events.push({
                type: 'sub',
                option: this.subOption,
                payload: Buffer.from(this.subPayload)
              })
            }
            this.subOption = null
            this.subPayload = []
            this.state = 'data'
          } else {
            this.subPayload.push(byte)
            this.state = 'sb'
          }
          break
      }
    }
    return { data: Buffer.from(out), events }
  }
}

export function optionCommand(verb: IacVerb, option: number): Buffer {
  const byte = verb === 'will' ? WILL : verb === 'wont' ? WONT : verb === 'do' ? DO : DONT
  return Buffer.from([IAC, byte, option])
}

/** NAWS 子協商（視窗縮放） */
export function naws(cols: number, rows: number): Buffer {
  const c = Math.max(1, Math.min(0xffff, Math.trunc(cols)))
  const r = Math.max(1, Math.min(0xffff, Math.trunc(rows)))
  return Buffer.from([IAC, SB, OPT.NAWS, (c >> 8) & 0xff, c & 0xff, (r >> 8) & 0xff, r & 0xff, IAC, SE])
}

export function terminalTypeIs(name: string): Buffer {
  return Buffer.concat([Buffer.from([IAC, SB, OPT.TTYPE, 0]), Buffer.from(name, 'ascii'), Buffer.from([IAC, SE])])
}

/** 使用者資料中的 0xFF 必須連寫兩次（否則會被當成 IAC） */
export function escapeData(data: Uint8Array): Buffer {
  const out: number[] = []
  for (const byte of data) {
    out.push(byte)
    if (byte === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}
