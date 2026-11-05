import { describe, expect, it, vi } from 'vitest'
import { crashCode, crashReport, formatCrashReport } from '../../src/shared/crash'
import { installCrashHandlers } from '../../src/main/crash'

describe('M4-06 可回報錯誤碼（RS-<scope>-XXXX）', () => {
  it('格式固定為 RS-MAIN/RS-UI 加 4 位十六進位', () => {
    expect(crashCode('UI', new Error('boom'))).toMatch(/^RS-UI-[0-9A-F]{4}$/)
    expect(crashCode('MAIN', new Error('boom'))).toMatch(/^RS-MAIN-[0-9A-F]{4}$/)
  })

  it('同一錯誤永遠同一碼（不吃 stack／時間），不同錯誤不同碼', () => {
    const a = new Error('render failed at App')
    const b = new Error('render failed at App')
    b.stack = 'at somewhere else'
    expect(crashCode('UI', a)).toBe(crashCode('UI', b))
    expect(crashCode('UI', a)).not.toBe(crashCode('UI', new Error('other failure')))
    // 不同 scope 不共用碼，log 才分得出來源
    expect(crashCode('UI', a)).not.toBe(crashCode('MAIN', a))
  })

  it('非 Error 的 rejection（字串／物件）也能產生碼與訊息', () => {
    expect(crashCode('UI', 'plain failure')).toMatch(/^RS-UI-[0-9A-F]{4}$/)
    const report = crashReport('UI', { code: 42 })
    expect(report.message).toContain('object')
    expect(report.stack).toBeNull()
  })

  it('formatCrashReport 含碼、時間、訊息與 stack（給「複製詳細資料」用）', () => {
    const report = crashReport('UI', new Error('kaput'), '2026-10-30T00:00:00.000Z')
    const text = formatCrashReport(report)
    expect(text).toContain(report.code)
    expect(text).toContain('2026-10-30T00:00:00.000Z')
    expect(text).toContain('kaput')
    expect(text).toContain('at ')
  })
})

describe('M4-06 main 例外邊界：不結束行程、會提示、會節流', () => {
  const makeDeps = () => ({
    logger: { error: vi.fn() },
    showError: vi.fn()
  })

  it('uncaughtException 被記錄、提示，且不會往外丟（行程繼續）', () => {
    const deps = makeDeps()
    const handlers = installCrashHandlers(deps)
    try {
      expect(() => handlers.handle('exception', new Error('main blew up'))).not.toThrow()
      expect(deps.logger.error).toHaveBeenCalledTimes(1)
      expect(deps.showError).toHaveBeenCalledTimes(1)
      const [title, content] = deps.showError.mock.calls[0] as [string, string]
      expect(title).toMatch(/^RemoteShell RS-MAIN-[0-9A-F]{4}$/)
      expect(content).toContain('still running')
      expect(content).toContain('main blew up')
    } finally {
      handlers.dispose()
    }
  })

  it('同一個錯誤碼最多提示 3 次（log 仍每次記錄）', () => {
    const deps = makeDeps()
    const handlers = installCrashHandlers({ ...deps, maxPromptsPerCode: 3 })
    try {
      for (let i = 0; i < 5; i++) handlers.handle('rejection', new Error('same failure'))
      expect(deps.logger.error).toHaveBeenCalledTimes(5)
      expect(deps.showError).toHaveBeenCalledTimes(3)
    } finally {
      handlers.dispose()
    }
  })

  it('dispose 之後不再攔截 process 事件', () => {
    const deps = makeDeps()
    const before = process.listenerCount('unhandledRejection')
    const handlers = installCrashHandlers(deps)
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)
    handlers.dispose()
    // 不用真的 emit（會變成 vitest 的 unhandled error），直接看 listener 是否移除
    expect(process.listenerCount('unhandledRejection')).toBe(before)
    expect(deps.logger.error).not.toHaveBeenCalled()
  })
})
