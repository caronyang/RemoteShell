import { app, dialog } from 'electron'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type { AppInfo } from '../../../shared/ipc-contract'
import { CH } from '../../../shared/constants'
import { ok } from '../../../shared/errors'
import { registerChannel } from '../register'

/** ssh2 版本＝實際 SSH 引擎版本（§3.8：M2 起不得再回 pending） */
function sshEngineVersion(): string {
  try {
    // 只讀版本號；用 createRequire 避免把 ssh2 的 ESM/CJS 邊界問題帶進 main bundle
    const requireFn = createRequire(__filename)
    const pkg = requireFn('ssh2/package.json') as { version?: string }
    return `ssh2 ${pkg.version ?? 'unknown'}`
  } catch {
    return 'ssh2'
  }
}

const pickSchema = z.object({ defaultPath: z.string().optional() })

export function register(): void {
  registerChannel(CH.appInfo, () =>
    ok<AppInfo>({
      version: app.getVersion(),
      electron: process.versions['electron'] ?? 'unknown',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions['node'] ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      sshEngine: sshEngineVersion()
    })
  )

  /** v1.9：設定頁「下載資料夾」的系統選擇器；取消回 null（不是錯誤） */
  registerChannel(CH.appPickDirectory, async (payload, ctx, event) => {
    const parsed = pickSchema.safeParse(payload ?? {})
    const defaultPath = parsed.success ? parsed.data.defaultPath : undefined
    const win = ctx.resolveWindow(event)
    const options = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      ...(defaultPath ? { defaultPath } : {})
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return ok<string | null>(null)
    return ok<string | null>(result.filePaths[0] ?? null)
  })

  /** v0.1.4 #1：金鑰／password 檔等單檔選擇器；取消回 null（不是錯誤） */
  registerChannel(CH.appPickFile, async (payload, ctx, event) => {
    const parsed = pickSchema.safeParse(payload ?? {})
    const defaultPath = parsed.success ? parsed.data.defaultPath : undefined
    const win = ctx.resolveWindow(event)
    const options = {
      properties: ['openFile' as const],
      ...(defaultPath ? { defaultPath } : {})
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return ok<string | null>(null)
    return ok<string | null>(result.filePaths[0] ?? null)
  })
}
