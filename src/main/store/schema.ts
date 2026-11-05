import { z } from 'zod'
import { SFTP_COLUMN_DEFAULTS } from '../../shared/constants'
import type { AppSettings } from '../../shared/ipc-contract'

/** store 層的驗證錯誤 → IPC 層轉 E_VALIDATION */
export class StoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreValidationError'
  }
}

export const localeSchema = z.enum(['en-US', 'zh-TW'])
export const themeIdSchema = z.enum(['dark', 'light', 'solarized', 'monokai'])
export const conflictPolicySchema = z.enum(['ask', 'overwrite', 'skip', 'rename'])

export const appSettingsSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  locale: localeSchema,
  general: z.object({
    restoreWorkspace: z.boolean(),
    onCloseWithActive: z.enum(['ask', 'disconnect']),
    minimizeToTray: z.boolean(),
    confirmDelete: z.boolean()
  }),
  terminal: z.object({
    fontFamily: z.string().min(1),
    fontSize: z.number().int().min(6).max(48),
    themeId: themeIdSchema,
    scrollback: z.number().int().min(100).max(100_000),
    cursorStyle: z.enum(['block', 'underline']),
    cursorBlink: z.boolean(),
    ambiguousWidth: z.enum(['narrow', 'wide'])
  }),
  transfer: z.object({
    maxConcurrent: z.number().int().min(1).max(10),
    downloadDir: z.string(),
    afterDownload: z.enum(['open', 'notify']),
    onConflict: conflictPolicySchema,
    retryCount: z.number().int().min(0).max(10)
  }),
  ui: z.object({
    sidebarWidth: z.number().int().min(200).max(480),
    queueHeight: z.number().int().min(28).max(500),
    queueCollapsed: z.boolean(),
    /* v0.1.4 #5：舊 settings.json 沒有這個欄位 → 補 false */
    sidebarCollapsed: z.boolean().default(false),
    /* v0.1.4 #8：舊檔沒有 → 補預設欄寬；UI 可拖曳後寫回 */
    sftpColumns: z
      .object({
        name: z.number().int().min(40).max(2000),
        permissions: z.number().int().min(40).max(2000),
        mtime: z.number().int().min(40).max(2000),
        size: z.number().int().min(40).max(2000)
      })
      .default({ ...SFTP_COLUMN_DEFAULTS })
  })
})

export const secretRefSchema = z.union([
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('dpapi'), cipher: z.string(), updatedAt: z.string() })
])

export const authConfigSchema = z.union([
  z.object({ method: z.literal('password'), username: z.string(), secret: secretRefSchema }),
  z.object({
    method: z.literal('passwordFile'),
    username: z.string(),
    secret: secretRefSchema,
    filePath: z.string()
  }),
  z.object({
    method: z.literal('publicKey'),
    username: z.string(),
    secret: secretRefSchema,
    keyPath: z.string()
  })
])

export const terminalOverrideSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().int().min(6).max(48).optional(),
  themeId: themeIdSchema.optional(),
  scrollback: z.number().int().min(100).max(100_000).optional(),
  cursorStyle: z.enum(['block', 'underline']).optional(),
  cursorBlink: z.boolean().optional()
})

export const connectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  groupId: z.string().nullable(),
  protocol: z.enum(['ssh', 'telnet']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  auth: authConfigSchema,
  jump: z.object({ enabled: z.boolean(), connectionIds: z.array(z.string()) }),
  terminal: terminalOverrideSchema,
  tags: z.array(z.string()),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const connectionGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().nullable(),
  collapsed: z.boolean(),
  order: z.number().int()
})

export const connectionsFileSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  profiles: z.array(connectionProfileSchema),
  groups: z.array(connectionGroupSchema)
})

/** ConnectionInput（§3.2 去掉 id/createdAt/updatedAt） */
export const connectionInputSchema = connectionProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true
})

export type ConnectionInputShape = z.infer<typeof connectionInputSchema>


export type ConnectionsFile = z.infer<typeof connectionsFileSchema>

export function parseSettings(value: unknown): AppSettings {
  const result = appSettingsSchema.safeParse(value)
  if (!result.success) throw new StoreValidationError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data as AppSettings
}

export function parseConnections(value: unknown): ConnectionsFile {
  const result = connectionsFileSchema.safeParse(value)
  if (!result.success) throw new StoreValidationError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data
}
