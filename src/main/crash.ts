/**
 * M4-06：main 行程的例外邊界。
 *
 * 沒有這個檔案時，任何沒被 catch 的例外／rejection 都會讓 Electron main 直接結束，
 * 使用者看到的是「視窗不見了」或「白屏」——而且沒有任何線索可以回報。
 *
 * 現在的行為：
 *   1. 記錄到 log（含可回報碼 RS-MAIN-XXXX、stack）
 *   2. 原生對話框告知使用者碼與「程式仍在執行」
 *   3. 不結束行程（main 活著，renderer 照常運作）
 *   4. 同一個碼最多彈 3 次，避免連環錯誤把使用者淹沒（log 仍全部記錄）
 */
import { crashReport, type CrashReport } from '../shared/crash'

export interface CrashLogger {
  error: (message: string, meta?: Record<string, unknown>) => void
}

export interface CrashDialogs {
  showError: (title: string, content: string) => void
}

export interface CrashHandlerOptions extends CrashDialogs {
  logger: CrashLogger
  /** 預設 false：錯誤發生時不結束行程（白屏比閃退容易回報） */
  exitOnFatal?: boolean
  /** 每個錯誤碼最多提示幾次 */
  maxPromptsPerCode?: number
}

export interface InstalledCrashHandlers {
  /** 測試用：直接餵一個例外進同一條處理管線 */
  handle: (kind: 'exception' | 'rejection', error: unknown) => CrashReport
  /** 移除監聽器 */
  dispose: () => void
}

const MAX_PROMPTS = 3

export function installCrashHandlers(options: CrashHandlerOptions): InstalledCrashHandlers {
  const prompts = new Map<string, number>()
  const maxPrompts = options.maxPromptsPerCode ?? MAX_PROMPTS

  const handle = (kind: 'exception' | 'rejection', error: unknown): CrashReport => {
    const report = crashReport('MAIN', error)
    options.logger.error(kind === 'exception' ? 'uncaught exception' : 'unhandled rejection', {
      code: report.code,
      message: report.message,
      stack: report.stack
    })

    const seen = (prompts.get(report.code) ?? 0) + 1
    prompts.set(report.code, seen)
    if (seen <= maxPrompts) {
      options.showError(
        `RemoteShell ${report.code}`,
        [
          `Unexpected ${kind === 'exception' ? 'error' : 'promise rejection'} in the main process.`,
          'RemoteShell is still running. Please report this code together with the log file.',
          '',
          report.message
        ].join('\n')
      )
    }

    if (options.exitOnFatal) process.exit(1)
    return report
  }

  const onException = (error: unknown): void => {
    handle('exception', error)
  }
  const onRejection = (reason: unknown): void => {
    handle('rejection', reason)
  }

  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)

  return {
    handle,
    dispose: () => {
      process.off('uncaughtException', onException)
      process.off('unhandledRejection', onRejection)
    }
  }
}
