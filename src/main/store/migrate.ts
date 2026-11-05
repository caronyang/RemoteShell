import { SCHEMA_VERSION } from '../../shared/constants'
import { StoreValidationError, parseConnections, parseSettings, type ConnectionsFile } from './schema'
import type { AppSettings } from '../../shared/ipc-contract'

/**
 * schema 遷移（§5）：以 schemaVersion 逐級升版。
 * v1 為初版，沒有任何歷史版本，因此只驗證版號與結構；
 * 未來版本在此加 migration step（v1 → v2 → …），失敗時由呼叫端保留原檔並回 E_VALIDATION。
 */
export const SUPPORTED_VERSION = SCHEMA_VERSION

export interface MigrationResult<T> {
  data: T
  /** 是否實際升級過（false = 已經是最新版） */
  migrated: boolean
  fromVersion: number
}

function readVersion(raw: unknown, label: string): number {
  if (typeof raw !== 'object' || raw === null) throw new StoreValidationError(`${label}: root must be an object`)
  const version = (raw as { schemaVersion?: unknown }).schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new StoreValidationError(`${label}: missing or invalid schemaVersion`)
  }
  if (version > SUPPORTED_VERSION) {
    throw new StoreValidationError(
      `${label}: schemaVersion ${version} is newer than supported ${SUPPORTED_VERSION}`
    )
  }
  return version
}

export function migrateSettings(raw: unknown): MigrationResult<AppSettings> {
  const fromVersion = readVersion(raw, 'settings.json')
  const data = parseSettings({ ...(raw as object), schemaVersion: SUPPORTED_VERSION })
  /* v0.1.4：舊檔缺 ui.sidebarCollapsed／ui.sftpColumns 時 parse 會補預設，
     這裡把「補過欄位」也視為 migrated，讓檔案實際落地成新結構（不用升 schemaVersion）。 */
  const rawUi = (raw as { ui?: unknown } | null)?.ui
  const backfilled =
    typeof rawUi !== 'object' ||
    rawUi === null ||
    !('sidebarCollapsed' in rawUi) ||
    !('sftpColumns' in rawUi)
  return { data, migrated: fromVersion < SUPPORTED_VERSION || backfilled, fromVersion }
}

export function migrateConnections(raw: unknown): MigrationResult<ConnectionsFile> {
  const fromVersion = readVersion(raw, 'connections.json')
  const data = parseConnections({ ...(raw as object), schemaVersion: SUPPORTED_VERSION })
  return { data, migrated: fromVersion < SUPPORTED_VERSION, fromVersion }
}
