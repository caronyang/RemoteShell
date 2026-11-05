import { z } from 'zod'
import type { LocalListResult } from '../../../shared/ipc-contract'
import { CH } from '../../../shared/constants'
import { ok } from '../../../shared/errors'
import { registerChannel } from '../register'
import { homeDir, listLocal, mkdirLocal, removeLocal, renameLocal } from '../../local/fs'

const pathSchema = z.object({ path: z.string().min(1) })
const renameSchema = z.object({ from: z.string().min(1), to: z.string().min(1) })
const removeSchema = z.object({ path: z.string().min(1), recursive: z.boolean() })

/** 本地面板（F-1）：安全規則見 §3.9，全部在 main 以 Node fs 執行 */
export function register(): void {
  registerChannel(CH.localHome, () => ok<string>(homeDir()))

  registerChannel(CH.localList, (payload) => {
    const { path } = pathSchema.parse(payload)
    return ok<LocalListResult>(listLocal(path))
  })

  registerChannel(CH.localMkdir, (payload) => {
    const { path } = pathSchema.parse(payload)
    mkdirLocal(path)
    return ok(undefined)
  })

  registerChannel(CH.localRename, (payload) => {
    const { from, to } = renameSchema.parse(payload)
    renameLocal(from, to)
    return ok(undefined)
  })

  registerChannel(CH.localRemove, (payload) => {
    const { path, recursive } = removeSchema.parse(payload)
    removeLocal(path, recursive)
    return ok(undefined)
  })
}
