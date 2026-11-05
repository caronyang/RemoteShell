import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../../src/main/store/settings'
import { ConnectionsStore } from '../../src/main/store/connections'
import { defaultSettings } from '../../src/shared/constants'
import { writeJsonAtomic } from '../../src/main/store/atomic'
import { migrateSettings } from '../../src/main/store/migrate'
import { StoreValidationError } from '../../src/main/store/schema'
import type { ConnectionInput } from '../../src/shared/ipc-contract'

let dir: string

const connectionInput = (name: string): ConnectionInput => ({
  name,
  groupId: null,
  protocol: 'ssh',
  host: '10.0.0.1',
  port: 22,
  auth: { method: 'password', username: 'root', secret: { kind: 'none' } },
  jump: { enabled: false, connectionIds: [] },
  terminal: {},
  tags: [],
  description: ''
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-store-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('M1-04 settings store', () => {
  it('首次啟動建立預設 settings.json', () => {
    const file = path.join(dir, 'settings.json')
    const store = new SettingsStore(file, path.join(dir, 'downloads'))
    expect(fs.existsSync(file)).toBe(false)

    const settings = store.load()

    expect(fs.existsSync(file)).toBe(true)
    expect(settings.schemaVersion).toBe(1)
    expect(settings.locale).toBe('en-US')
    expect(settings.ui.sidebarWidth).toBe(260)
    expect(settings.ui.sidebarCollapsed).toBe(false)
    expect(settings.ui.queueCollapsed).toBe(true)
    expect(settings.ui.sftpColumns).toEqual({ name: 180, permissions: 90, mtime: 120, size: 70 })
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { schemaVersion: number }
    expect(onDisk.schemaVersion).toBe(1)
  })

  it('v0.1.4：sftpColumns 可 patch 並持久化（具名 map）', () => {
    const file = path.join(dir, 'settings.json')
    const store = new SettingsStore(file, path.join(dir, 'downloads'))
    store.load()

    const next = store.patch({ ui: { sftpColumns: { name: 300, permissions: 90, mtime: 160, size: 80 } } })
    expect(next.ui.sftpColumns).toMatchObject({ name: 300, permissions: 90 })

    const reloaded = new SettingsStore(file, path.join(dir, 'downloads'))
    expect(reloaded.load().ui.sftpColumns).toEqual({ name: 300, permissions: 90, mtime: 160, size: 80 })
  })

  it('patch 會 deep merge 並持久化', () => {
    const file = path.join(dir, 'settings.json')
    const store = new SettingsStore(file, path.join(dir, 'downloads'))
    store.load()

    const next = store.patch({ ui: { sidebarWidth: 320 }, terminal: { fontSize: 14 } })

    expect(next.ui.sidebarWidth).toBe(320)
    expect(next.ui.queueCollapsed).toBe(true)
    expect(next.terminal.fontSize).toBe(14)
    const reloaded = new SettingsStore(file, path.join(dir, 'downloads'))
    expect(reloaded.load().ui.sidebarWidth).toBe(320)
  })

  it('非法值回 E_VALIDATION 對應的 StoreValidationError，且不覆寫原檔', () => {
    const file = path.join(dir, 'settings.json')
    const store = new SettingsStore(file, path.join(dir, 'downloads'))
    store.load()
    const before = fs.readFileSync(file, 'utf8')

    expect(() => store.patch({ terminal: { fontSize: 999 } })).toThrow(StoreValidationError)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('reset 回到預設值', () => {
    const store = new SettingsStore(path.join(dir, 'settings.json'), path.join(dir, 'downloads'))
    store.patch({ locale: 'zh-TW' })
    expect(store.load().locale).toBe('zh-TW')
    const reset = store.reset()
    expect(reset.locale).toBe('en-US')
  })
})

describe('M1-04 原子寫入', () => {
  it('rename 失敗時原檔完整、暫存檔清掉、保留 .bak', () => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{"schemaVersion":1,"keep":"me"}\n', 'utf8')

    expect(() =>
      writeJsonAtomic(file, { schemaVersion: 1, keep: 'no' }, {
        renameSync: () => {
          throw new Error('EPERM simulated')
        }
      })
    ).toThrow('EPERM simulated')

    expect(fs.readFileSync(file, 'utf8')).toBe('{"schemaVersion":1,"keep":"me"}\n')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(fs.existsSync(`${file}.bak`)).toBe(true)
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ schemaVersion: 1, keep: 'me' })
  })

  it('正常寫入會產生 .bak 上一版', () => {
    const file = path.join(dir, 'settings.json')
    writeJsonAtomic(file, { v: 1 })
    writeJsonAtomic(file, { v: 2 })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 2 })
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ v: 1 })
  })
})

describe('M1-04 schema 遷移', () => {
  it('舊版 schemaVersion 會被升級並標記 migrated', () => {
    const raw = {
      schemaVersion: 0,
      locale: 'zh-TW',
      general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete: true },
      terminal: {
        fontFamily: 'Cascadia Mono',
        fontSize: 11,
        themeId: 'dark',
        scrollback: 10000,
        cursorStyle: 'block',
        cursorBlink: true,
        ambiguousWidth: 'narrow'
      },
      transfer: {
        maxConcurrent: 3,
        downloadDir: 'C:\\tmp',
        afterDownload: 'notify',
        onConflict: 'ask',
        retryCount: 0
      },
      ui: { sidebarWidth: 260, queueHeight: 160, queueCollapsed: true }
    }
    const result = migrateSettings(raw)
    expect(result.migrated).toBe(true)
    expect(result.fromVersion).toBe(0)
    expect(result.data.schemaVersion).toBe(1)
    expect(result.data.locale).toBe('zh-TW')
  })

  it('v0.1.4：舊檔缺 ui.sidebarCollapsed／ui.sftpColumns → 補預設並落地（不升 schemaVersion）', () => {
    const file = path.join(dir, 'settings.json')
    const raw = {
      schemaVersion: 1,
      locale: 'zh-TW',
      general: { restoreWorkspace: false, onCloseWithActive: 'disconnect', minimizeToTray: true, confirmDelete: false },
      terminal: {
        fontFamily: 'Consolas',
        fontSize: 16,
        themeId: 'dark',
        scrollback: 5000,
        cursorStyle: 'underline',
        cursorBlink: false,
        ambiguousWidth: 'wide'
      },
      transfer: {
        maxConcurrent: 5,
        downloadDir: 'D:\\dl',
        afterDownload: 'open',
        onConflict: 'rename',
        retryCount: 2
      },
      ui: { sidebarWidth: 300, queueHeight: 160, queueCollapsed: false }
    }
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8')

    const store = new SettingsStore(file, path.join(dir, 'downloads'))
    const loaded = store.load()

    expect(loaded.ui.sidebarWidth).toBe(300)
    expect(loaded.ui.sidebarCollapsed).toBe(false)
    expect(loaded.ui.queueCollapsed).toBe(false)
    expect(loaded.ui.sftpColumns).toEqual({ name: 180, permissions: 90, mtime: 120, size: 70 })
    expect(loaded.locale).toBe('zh-TW')

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      schemaVersion: number
      ui: Record<string, unknown>
    }
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.ui.sidebarCollapsed).toBe(false)
    expect(onDisk.ui.sftpColumns).toEqual({ name: 180, permissions: 90, mtime: 120, size: 70 })
  })

  it('factory default: queueCollapsed 為 true', () => {
    expect(defaultSettings(path.join(dir, 'downloads')).ui.queueCollapsed).toBe(true)
  })

  it('migration: legacy settings with queueCollapsed:false stays false', () => {
    const raw = {
      schemaVersion: 1,
      locale: 'en-US',
      general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete: true },
      terminal: {
        fontFamily: 'Cascadia Mono',
        fontSize: 11,
        themeId: 'dark',
        scrollback: 10000,
        cursorStyle: 'block',
        cursorBlink: true,
        ambiguousWidth: 'narrow'
      },
      transfer: {
        maxConcurrent: 3,
        downloadDir: 'C:\\\\tmp',
        afterDownload: 'notify',
        onConflict: 'ask',
        retryCount: 0
      },
      ui: { sidebarWidth: 260, queueHeight: 200, queueCollapsed: false, sidebarCollapsed: true, sftpColumns: { name: 180, permissions: 90, mtime: 120, size: 70 } }
    }
    const result = migrateSettings(raw)
    expect(result.data.ui.queueCollapsed).toBe(false)
  })

  it('已有新欄位的檔案不會被標成 migrated', () => {
    const raw = {
      schemaVersion: 1,
      locale: 'en-US',
      general: { restoreWorkspace: true, onCloseWithActive: 'ask', minimizeToTray: false, confirmDelete: true },
      terminal: {
        fontFamily: 'Cascadia Mono',
        fontSize: 11,
        themeId: 'dark',
        scrollback: 10000,
        cursorStyle: 'block',
        cursorBlink: true,
        ambiguousWidth: 'narrow'
      },
      transfer: {
        maxConcurrent: 3,
        downloadDir: 'C:\\tmp',
        afterDownload: 'notify',
        onConflict: 'ask',
        retryCount: 0
      },
      ui: {
        sidebarWidth: 260,
        queueHeight: 200,
        queueCollapsed: true,
        sidebarCollapsed: true,
        sftpColumns: { name: 200, permissions: 100, mtime: 140, size: 90 }
      }
    }
    const result = migrateSettings(raw)
    expect(result.migrated).toBe(false)
    expect(result.data.ui.sidebarCollapsed).toBe(true)
  })

  it('未來版本（比支援的新）要拒絕', () => {
    expect(() => migrateSettings({ schemaVersion: 99 })).toThrow(StoreValidationError)
  })

  it('缺 schemaVersion 要拒絕', () => {
    expect(() => migrateSettings({ locale: 'en-US' })).toThrow(StoreValidationError)
  })
})

describe('M1-04 connections store', () => {
  it('CRUD + reorder', () => {
    const store = new ConnectionsStore(path.join(dir, 'connections.json'))
    const a = store.create(connectionInput('alpha'))
    const b = store.create(connectionInput('beta'))
    expect(store.list().profiles.map((p) => p.name)).toEqual(['alpha', 'beta'])

    const updated = store.update(a.id, { host: '10.0.0.9' })
    expect(updated.host).toBe('10.0.0.9')
    expect(updated.createdAt).toBe(a.createdAt)

    store.reorder([b.id, a.id])
    expect(store.list().profiles.map((p) => p.name)).toEqual(['beta', 'alpha'])

    store.remove(b.id)
    expect(store.list().profiles.map((p) => p.name)).toEqual(['alpha'])
    expect(() => store.remove('missing')).toThrow(StoreValidationError)
  })

  it('同名連線要拒絕', () => {
    const store = new ConnectionsStore(path.join(dir, 'connections.json'))
    store.create(connectionInput('alpha'))
    expect(() => store.create(connectionInput('ALPHA'))).toThrow(StoreValidationError)
  })

  it('分組：建立／改名／刪除（刪除時解除連線歸屬）', () => {
    const store = new ConnectionsStore(path.join(dir, 'connections.json'))
    const group = store.createGroup({ name: 'Prod', parentId: null })
    const child = store.createGroup({ name: 'Prod/DB', parentId: group.id })
    const profile = store.create({ ...connectionInput('db-01'), groupId: group.id })

    expect(store.list().groups.map((g) => g.name)).toEqual(['Prod', 'Prod/DB'])
    expect(() => store.removeGroup(group.id)).toThrow(StoreValidationError) // 有子分組

    store.updateGroup(child.id, { name: 'Prod/DB2', collapsed: true })
    expect(store.list().groups.find((g) => g.id === child.id)?.collapsed).toBe(true)

    store.removeGroup(child.id)
    store.removeGroup(group.id)
    expect(store.list().profiles.find((p) => p.id === profile.id)?.groupId).toBeNull()
  })

  it('reorder 只接受已知 id', () => {
    const store = new ConnectionsStore(path.join(dir, 'connections.json'))
    expect(() => store.reorder(['nope'])).toThrow(StoreValidationError)
  })
})
