import { SCHEMA_VERSION, defaultSettings } from '../../shared/constants'
import type { AppSettings, DeepPartial } from '../../shared/ipc-contract'
import { readJson, writeJsonAtomic, type AtomicDeps } from './atomic'
import { migrateSettings } from './migrate'
import { StoreValidationError, parseSettings } from './schema'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : (patch as T))
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return out as T
}

/**
 * settings.json 存取（§5）。
 * - 首次啟動：建立預設檔
 * - patch：deep merge → zod 驗證 → 原子寫入
 * - reset：回到預設值並覆寫檔案
 */
export class SettingsStore {
  private cache: AppSettings | null = null

  constructor(
    private readonly file: string,
    private readonly downloadDir: string,
    private readonly deps: Partial<AtomicDeps> = {}
  ) {}

  load(): AppSettings {
    if (this.cache) return this.cache
    const raw = readJson<unknown>(this.file, this.deps)
    if (raw === null) {
      const created = defaultSettings(this.downloadDir)
      writeJsonAtomic(this.file, created, this.deps)
      this.cache = created
      return created
    }
    const migrated = migrateSettings(raw)
    if (migrated.migrated) writeJsonAtomic(this.file, migrated.data, this.deps)
    this.cache = migrated.data
    return migrated.data
  }

  /** 未指定時使用「目前載入的值 + 預設值」的合併結果 */
  patch(partial: DeepPartial<AppSettings>): AppSettings {
    const current = this.load()
    const merged = deepMerge(current, partial)
    merged.schemaVersion = SCHEMA_VERSION
    const validated = parseSettings(merged)
    writeJsonAtomic(this.file, validated, this.deps)
    this.cache = validated
    return validated
  }

  replace(next: AppSettings): AppSettings {
    const validated = parseSettings({ ...next, schemaVersion: SCHEMA_VERSION })
    writeJsonAtomic(this.file, validated, this.deps)
    this.cache = validated
    return validated
  }

  reset(): AppSettings {
    const defaults = defaultSettings(this.downloadDir)
    writeJsonAtomic(this.file, defaults, this.deps)
    this.cache = defaults
    return defaults
  }

  /** 只給測試用：清掉記憶體快取 */
  invalidate(): void {
    this.cache = null
  }
}

export function assertSettings(value: unknown): asserts value is AppSettings {
  if (!isPlainObject(value)) throw new StoreValidationError('settings must be an object')
  parseSettings(value)
}
