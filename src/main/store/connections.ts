import { randomUUID } from 'node:crypto'
import { SCHEMA_VERSION } from '../../shared/constants'
import type { ConnectionGroup, ConnectionInput, ConnectionProfile } from '../../shared/ipc-contract'
import { readJson, writeJsonAtomic, type AtomicDeps } from './atomic'
import { migrateConnections } from './migrate'
import { StoreValidationError, connectionGroupSchema, connectionProfileSchema, type ConnectionsFile } from './schema'

/** 刪除被其他連線當跳板時丟出；handler 轉成 E_CONFLICT 並帶 dependent 名稱 */
export class ConnectionInUseError extends Error {
  constructor(readonly dependents: string[]) {
    super(`connection is used as a jump host by: ${dependents.join(', ')}`)
    this.name = 'ConnectionInUseError'
  }
}

export class ConnectionsStore {
  private cache: ConnectionsFile | null = null

  constructor(
    private readonly file: string,
    private readonly deps: Partial<AtomicDeps> = {},
    private readonly now: () => Date = () => new Date()
  ) {}

  private empty(): ConnectionsFile {
    return { schemaVersion: SCHEMA_VERSION, profiles: [], groups: [] }
  }

  load(): ConnectionsFile {
    if (this.cache) return this.cache
    const raw = readJson<unknown>(this.file, this.deps)
    if (raw === null) {
      const created = this.empty()
      writeJsonAtomic(this.file, created, this.deps)
      this.cache = created
      return created
    }
    const migrated = migrateConnections(raw)
    if (migrated.migrated) writeJsonAtomic(this.file, migrated.data, this.deps)
    this.cache = migrated.data
    return migrated.data
  }

  private persist(next: ConnectionsFile): ConnectionsFile {
    const validated = { ...next, schemaVersion: SCHEMA_VERSION }
    writeJsonAtomic(this.file, validated, this.deps)
    this.cache = validated
    return validated
  }

  list(): { profiles: ConnectionProfile[]; groups: ConnectionGroup[] } {
    const file = this.load()
    return {
      profiles: [...file.profiles],
      groups: [...file.groups].sort((a, b) => a.order - b.order)
    }
  }

  create(input: ConnectionInput): ConnectionProfile {
    const file = this.load()
    if (file.profiles.some((p) => p.name.trim().toLowerCase() === input.name.trim().toLowerCase())) {
      throw new StoreValidationError(`connection name already exists: ${input.name}`)
    }
    const stamp = this.now().toISOString()
    const profile = connectionProfileSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: stamp,
      updatedAt: stamp
    }) as ConnectionProfile
    this.persist({ ...file, profiles: [...file.profiles, profile] })
    return profile
  }

  update(id: string, patch: Partial<ConnectionInput>): ConnectionProfile {
    const file = this.load()
    const index = file.profiles.findIndex((p) => p.id === id)
    if (index < 0) throw new StoreValidationError(`connection not found: ${id}`)
    const current = file.profiles[index] as ConnectionProfile
    const merged = connectionProfileSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString()
    }) as ConnectionProfile
    const profiles = [...file.profiles]
    profiles[index] = merged
    this.persist({ ...file, profiles })
    return merged
  }

  /** 哪些連線把 id 當跳板（刪除／改協定前檢查） */
  dependentsOf(id: string): string[] {
    return this.load()
      .profiles.filter((p) => p.id !== id && p.jump.connectionIds.includes(id))
      .map((p) => p.name)
  }

  remove(id: string): void {
    const file = this.load()
    const found = file.profiles.some((p) => p.id === id)
    if (!found) throw new StoreValidationError(`connection not found: ${id}`)
    const dependents = this.dependentsOf(id)
    if (dependents.length > 0) throw new ConnectionInUseError(dependents)
    this.persist({ ...file, profiles: file.profiles.filter((p) => p.id !== id) })
  }

  reorder(ids: string[]): void {
    const file = this.load()
    const known = new Set(file.profiles.map((p) => p.id))
    for (const id of ids) if (!known.has(id)) throw new StoreValidationError(`unknown connection id: ${id}`)
    const ordered = [
      ...ids.map((id) => file.profiles.find((p) => p.id === id)).filter((p): p is ConnectionProfile => !!p),
      ...file.profiles.filter((p) => !ids.includes(p.id))
    ]
    this.persist({ ...file, profiles: ordered })
  }

  createGroup(input: { name: string; parentId: string | null }): ConnectionGroup {
    const file = this.load()
    if (input.parentId && !file.groups.some((g) => g.id === input.parentId)) {
      throw new StoreValidationError(`parent group not found: ${input.parentId}`)
    }
    const group = connectionGroupSchema.parse({
      id: randomUUID(),
      name: input.name,
      parentId: input.parentId,
      collapsed: false,
      order: file.groups.length
    }) as ConnectionGroup
    this.persist({ ...file, groups: [...file.groups, group] })
    return group
  }

  updateGroup(
    id: string,
    patch: { name?: string; parentId?: string | null; collapsed?: boolean }
  ): ConnectionGroup {
    const file = this.load()
    const index = file.groups.findIndex((g) => g.id === id)
    if (index < 0) throw new StoreValidationError(`group not found: ${id}`)
    const current = file.groups[index] as ConnectionGroup
    if (patch.parentId === id) throw new StoreValidationError('group cannot be its own parent')
    const merged = connectionGroupSchema.parse({ ...current, ...patch }) as ConnectionGroup
    const groups = [...file.groups]
    groups[index] = merged
    this.persist({ ...file, groups })
    return merged
  }

  removeGroup(id: string): void {
    const file = this.load()
    if (file.groups.some((g) => g.parentId === id)) {
      throw new StoreValidationError(`group has children: ${id}`)
    }
    const groups = file.groups.filter((g) => g.id !== id)
    if (groups.length === file.groups.length) throw new StoreValidationError(`group not found: ${id}`)
    const profiles = file.profiles.map((p) => (p.groupId === id ? { ...p, groupId: null } : p))
    this.persist({ ...file, groups, profiles })
  }

  invalidate(): void {
    this.cache = null
  }
}
