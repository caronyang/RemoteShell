import { describe, expect, it } from 'vitest'
import { IAC, IacDecoder, OPT, escapeData, naws, optionCommand, terminalTypeIs } from '../../src/main/transport/iac'

const dec = (chunks: Buffer[]): { data: Buffer; events: ReturnType<IacDecoder['push']>['events'] } => {
  const decoder = new IacDecoder()
  let data = Buffer.alloc(0)
  const events: ReturnType<IacDecoder['push']>['events'] = []
  for (const chunk of chunks) {
    const result = decoder.push(chunk)
    data = Buffer.concat([data, result.data])
    events.push(...result.events)
  }
  return { data, events }
}

describe('M2-02 IAC 解析（S5）', () => {
  it('剝離 IAC 序列，資料不會出現 0xFF', () => {
    const input = Buffer.concat([
      Buffer.from([IAC, 251, OPT.ECHO]), // WILL ECHO
      Buffer.from('hello '),
      Buffer.from([IAC, 253, OPT.NAWS]), // DO NAWS
      Buffer.from('中文')
    ])
    const { data, events } = dec([input])
    expect(data.includes(IAC)).toBe(false)
    expect(data.toString('utf8')).toBe('hello 中文')
    expect(events).toEqual([
      { type: 'will', option: OPT.ECHO },
      { type: 'do', option: OPT.NAWS }
    ])
  })

  it('跨 chunk 的半個 IAC 序列會保留狀態', () => {
    const { data, events } = dec([Buffer.from([IAC]), Buffer.from([251]), Buffer.from([OPT.TTYPE])])
    expect(data).toHaveLength(0)
    expect(events).toEqual([{ type: 'will', option: OPT.TTYPE }])
  })

  it('子協商（TTYPE SEND / NAWS）解析', () => {
    const ttype = Buffer.from([IAC, 250, OPT.TTYPE, 1, IAC, 240])
    const size = naws(132, 43)
    const { events } = dec([Buffer.concat([ttype, size])])
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'sub', option: OPT.TTYPE, payload: Buffer.from([1]) })
    const sub = events[1]
    if (!sub || sub.type !== 'sub') throw new Error('expected sub negotiation')
    expect(sub.option).toBe(OPT.NAWS)
    expect(((sub.payload[0] ?? 0) << 8) | (sub.payload[1] ?? 0)).toBe(132)
    expect(((sub.payload[2] ?? 0) << 8) | (sub.payload[3] ?? 0)).toBe(43)
  })

  it('IAC IAC 代表資料中的 0xFF', () => {
    const { data } = dec([Buffer.from([IAC, IAC, 65])])
    expect([...data]).toEqual([IAC, 65])
  })

  it('NAWS 編碼為 9 bytes 且可回解', () => {
    const encoded = naws(120, 30)
    expect(encoded).toHaveLength(9)
    expect(encoded[0]).toBe(IAC)
    expect(encoded[1]).toBe(250)
    expect(encoded[2]).toBe(OPT.NAWS)
    expect(((encoded[3] ?? 0) << 8) | (encoded[4] ?? 0)).toBe(120)
    expect(((encoded[5] ?? 0) << 8) | (encoded[6] ?? 0)).toBe(30)
    expect(encoded[7]).toBe(IAC)
    expect(encoded[8]).toBe(240)
  })

  it('使用者資料中的 0xFF 會被轉義（不得變成指令）', () => {
    const escaped = escapeData(Buffer.from([0x41, IAC, 0x42]))
    expect([...escaped]).toEqual([0x41, IAC, IAC, 0x42])
  })

  it('指令與 TTYPE IS 編碼', () => {
    expect([...optionCommand('will', OPT.TTYPE)]).toEqual([IAC, 251, OPT.TTYPE])
    expect([...optionCommand('dont', OPT.ECHO)]).toEqual([IAC, 254, OPT.ECHO])
    const is = terminalTypeIs('XTERM-256COLOR')
    expect([...is.slice(0, 4)]).toEqual([IAC, 250, OPT.TTYPE, 0])
    expect(is.slice(4, -2).toString('ascii')).toBe('XTERM-256COLOR')
  })
})
