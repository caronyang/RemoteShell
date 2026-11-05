import { beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Result } from '../../src/shared/ipc-contract'
import { dispatch, listChannels, type AppContext } from '../../src/main/ipc/register'
import { SettingsStore } from '../../src/main/store/settings'
import { ConnectionsStore } from '../../src/main/store/connections'
import { SessionManager } from '../../src/main/ipc/handlers/session'
import { VaultService } from '../../src/main/vault/dpapi'
import { KnownHostsStore } from '../../src/main/transport/hostkey'
import { SftpRegistry } from '../../src/main/sftp/registry'
import { TransferScheduler } from '../../src/main/queue/scheduler'
import { CH, EVT } from '../../src/shared/constants'
import { ERROR_CODES, appError } from '../../src/shared/errors'
import * as appHandlers from '../../src/main/ipc/handlers/app'
import * as windowHandlers from '../../src/main/ipc/handlers/window'
import * as settingsHandlers from '../../src/main/ipc/handlers/settings'
import * as connectionsHandlers from '../../src/main/ipc/handlers/connections'
import * as vaultHandlers from '../../src/main/ipc/handlers/vault'
import * as sessionHandlers from '../../src/main/ipc/handlers/session'
import * as sftpHandlers from '../../src/main/ipc/handlers/sftp'
import * as transferHandlers from '../../src/main/ipc/handlers/transfer'
import * as hostkeyHandlers from '../../src/main/ipc/handlers/hostkey'
import * as localHandlers from '../../src/main/ipc/handlers/local'

// vitest 會把 vi.mock 提升到檔案最上方，因此上面的靜態 import 拿到的就是 mock 後的 electron
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
  app: { getVersion: () => '0.1.0', getPath: () => os.tmpdir() },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['C:\\picked-dir'] }))
  },
  shell: { openExternal: vi.fn() }
}))

const handlers = {
  app: appHandlers,
  window: windowHandlers,
  settings: settingsHandlers,
  connections: connectionsHandlers,
  vault: vaultHandlers,
  session: sessionHandlers,
  sftp: sftpHandlers,
  transfer: transferHandlers,
  hostkey: hostkeyHandlers,
  local: localHandlers
}

let dir: string
let ctx: AppContext

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ipc-'))
  const loggerStub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), filePath: path.join(dir, 'log') }
  const settings = new SettingsStore(path.join(dir, 'settings.json'), path.join(dir, 'downloads'))
  const connections = new ConnectionsStore(path.join(dir, 'connections.json'))
  const vault = new VaultService({
    isAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  })
  const knownHosts = new KnownHostsStore(path.join(dir, 'known_hosts.json'))
  const sessions = new SessionManager({ connections, vault, knownHosts, logger: loggerStub, broadcast: vi.fn() })
  const sftp = new SftpRegistry()
  const transfers = new TransferScheduler({
    maxConcurrent: 2,
    broadcast: vi.fn(),
    runner: { run: async () => undefined }
  })
  ctx = {
    logger: loggerStub,
    settings,
    connections,
    sessions,
    sftp,
    transfers,
    vault,
    knownHosts,
    revealPath: vi.fn(),
    broadcast: vi.fn(),
    resolveWindow: () => null
  }
  for (const group of Object.values(handlers)) group.register()
})

/** 取出 Ok 的 data（型別由呼叫端指定） */
function data<T>(result: Result<unknown>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.data as T
}

describe('M1-02 IPC 契約', () => {
  it('所有 §3.4 通道都註冊了（49 invoke）', () => {
    const channels = listChannels()
    const declared = Object.values(CH)
    // 契約數字（§3.4）：若常數增減，下面的 declared 長度會先報錯，指向「契約與常數不同步」
    expect(declared).toHaveLength(50)
    expect(channels).toHaveLength(50)
    const missing = declared.filter((channel) => !channels.includes(channel))
    expect(missing).toEqual([])
    const unregistered = channels.filter((channel) => !(declared as string[]).includes(channel))
    expect(unregistered).toEqual([])
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('事件名稱 6 個且都以 rs:evt: 開頭', () => {
    const events = Object.values(EVT)
    expect(events).toHaveLength(6)
    expect(events.every((e) => e.startsWith('rs:evt:'))).toBe(true)
  })

  it('未註冊通道回 E_NOT_FOUND（不是例外）', async () => {
    const result = await dispatch('rs:does:not:exist', null, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_NOT_FOUND')
      expect(result.error.i18nKey).toBe('error.E_NOT_FOUND')
    }
  })

  it('settings get / patch 走完整 Result 流程，並廣播 settings:changed', async () => {
    const initial = data<{ schemaVersion: number; locale: string }>(await dispatch(CH.settingsGet, null, ctx))
    expect(initial.schemaVersion).toBe(1)
    expect(initial.locale).toBe('en-US')

    const patched = data<{ locale: string }>(await dispatch(CH.settingsPatch, { locale: 'zh-TW' }, ctx))
    expect(patched.locale).toBe('zh-TW')
    expect(ctx.broadcast).toHaveBeenCalledWith(
      EVT.settingsChanged,
      expect.objectContaining({ locale: 'zh-TW' })
    )
  })

  it('非法 patch 回 E_VALIDATION', async () => {
    const result = await dispatch(CH.settingsPatch, { terminal: { fontSize: 999 } }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_VALIDATION')
  })

  it('非物件 payload 回 E_VALIDATION', async () => {
    const result = await dispatch(CH.settingsPatch, 'nope', ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_VALIDATION')
  })

  it('connections create → list → update → reorder → remove', async () => {
    const input = {
      name: 'prod-web-01',
      groupId: null,
      protocol: 'ssh' as const,
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password' as const, username: 'tester', secret: { kind: 'none' as const } },
      jump: { enabled: false, connectionIds: [] },
      terminal: {},
      tags: [],
      description: ''
    }
    const created = data<{ id: string }>(await dispatch(CH.connectionsCreate, input, ctx))
    const listed = data<{ profiles: Array<{ id: string }> }>(await dispatch(CH.connectionsList, null, ctx))
    expect(listed.profiles.map((p) => p.id)).toContain(created.id)

    const renamed = data<{ name: string }>(
      await dispatch(CH.connectionsUpdate, { id: created.id, patch: { name: 'prod-web-01b' } }, ctx)
    )
    expect(renamed.name).toBe('prod-web-01b')

    data<undefined>(await dispatch(CH.connectionsReorder, { ids: [created.id] }, ctx))
    data<undefined>(await dispatch(CH.connectionsRemove, { id: created.id }, ctx))
    const after = data<{ profiles: unknown[] }>(await dispatch(CH.connectionsList, null, ctx))
    expect(after.profiles).toHaveLength(0)
  })

  it('P0-01-2：建立時跳板啟用但沒選 id → E_VALIDATION（detail 指出 jump）', async () => {
    const result = await dispatch(
      CH.connectionsCreate,
      {
        name: `jump-empty-${Date.now()}`,
        groupId: null,
        protocol: 'ssh',
        host: '10.1.2.11',
        port: 22,
        auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
        jump: { enabled: true, connectionIds: [] },
        terminal: {},
        tags: [],
        description: ''
      },
      ctx
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_VALIDATION')
      expect(result.error.detail ?? '').toContain('jump')
    }
  })

  it('P0-01-2：Telnet 連線不能當跳板 → E_VALIDATION', async () => {
    const telnet = data<{ id: string }>(
      await dispatch(
        CH.connectionsCreate,
        {
          name: `telnet-gw-${Date.now()}`,
          groupId: null,
          protocol: 'telnet',
          host: '10.0.0.9',
          port: 23,
          auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
          jump: { enabled: false, connectionIds: [] },
          terminal: {},
          tags: [],
          description: ''
        },
        ctx
      )
    )
    const result = await dispatch(
      CH.connectionsCreate,
      {
        name: `via-telnet-${Date.now()}`,
        groupId: null,
        protocol: 'ssh',
        host: '10.1.2.11',
        port: 22,
        auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
        jump: { enabled: true, connectionIds: [telnet.id] },
        terminal: {},
        tags: [],
        description: ''
      },
      ctx
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_VALIDATION')
      expect(result.error.detail ?? '').toContain('jump')
    }
  })

  it('P1-02-1：被其他連線當跳板時刪除 → E_CONFLICT（帶 dependent 名稱與總數）', async () => {
    const suffix = Date.now()
    const gw = data<{ id: string }>(
      await dispatch(
        CH.connectionsCreate,
        {
          name: `gw-ref-${suffix}`,
          groupId: null,
          protocol: 'ssh',
          host: '127.0.0.1',
          port: 2201,
          auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
          jump: { enabled: false, connectionIds: [] },
          terminal: {},
          tags: [],
          description: ''
        },
        ctx
      )
    )
    data<{ id: string }>(
      await dispatch(
        CH.connectionsCreate,
        {
          name: `dep-a-${suffix}`,
          groupId: null,
          protocol: 'ssh',
          host: '10.1.2.11',
          port: 22,
          auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
          jump: { enabled: true, connectionIds: [gw.id] },
          terminal: {},
          tags: [],
          description: ''
        },
        ctx
      )
    )
    const result = await dispatch(CH.connectionsRemove, { id: gw.id }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_CONFLICT')
      expect(result.error.detail ?? '').toContain(`dep-a-${suffix}`)
      expect(result.error.detail ?? '').toContain('jump dependents (1)')
    }
  })

  it('P1-02-1：沒被引用的連線可以刪除', async () => {
    const created = data<{ id: string }>(
      await dispatch(
        CH.connectionsCreate,
        {
          name: `solo-${Date.now()}`,
          groupId: null,
          protocol: 'ssh',
          host: '10.0.0.50',
          port: 22,
          auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
          jump: { enabled: false, connectionIds: [] },
          terminal: {},
          tags: [],
          description: ''
        },
        ctx
      )
    )
    data<undefined>(await dispatch(CH.connectionsRemove, { id: created.id }, ctx))
    const listed = data<{ profiles: Array<{ id: string }> }>(await dispatch(CH.connectionsList, null, ctx))
    expect(listed.profiles.map((p) => p.id)).not.toContain(created.id)
  })

  it('P0-01-2：session.open 遇到跳板未選／非 SSH 一律 E_VALIDATION', async () => {
    const suffix = Date.now()
    const telnet = ctx.connections.create({
      name: `telnet-jump-${suffix}`,
      groupId: null,
      protocol: 'telnet',
      host: '10.9.9.9',
      port: 23,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: false, connectionIds: [] },
      terminal: {},
      tags: [],
      description: ''
    })
    // 直接寫入 store（繞過 handler 驗證），模擬舊版／手改檔案留下的資料
    const noJump = ctx.connections.create({
      name: `no-jump-${suffix}`,
      groupId: null,
      protocol: 'ssh',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: true, connectionIds: [] },
      terminal: {},
      tags: [],
      description: ''
    })
    const viaTelnet = ctx.connections.create({
      name: `via-telnet-${suffix}`,
      groupId: null,
      protocol: 'ssh',
      host: '10.1.2.11',
      port: 22,
      auth: { method: 'password', username: 'tester', secret: { kind: 'none' } },
      jump: { enabled: true, connectionIds: [telnet.id] },
      terminal: {},
      tags: [],
      description: ''
    })

    const empty = await dispatch(CH.sessionOpen, { profileId: noJump.id, cols: 120, rows: 30 }, ctx)
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.error.code).toBe('E_VALIDATION')
      expect(empty.error.detail ?? '').toContain('jump')
    }

    const nonSsh = await dispatch(CH.sessionOpen, { profileId: viaTelnet.id, cols: 120, rows: 30 }, ctx)
    expect(nonSsh.ok).toBe(false)
    if (!nonSsh.ok) {
      expect(nonSsh.error.code).toBe('E_VALIDATION')
      expect(nonSsh.error.detail ?? '').toContain('jump')
    }
  })

  it('沒有視窗時 window 通道回 E_NOT_FOUND', async () => {    const result = await dispatch(CH.windowMinimize, null, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_NOT_FOUND')
  })

  it('M3 通道已實作：必填欄位缺漏一律 E_VALIDATION（不再是 E_INTERNAL 佔位）', async () => {
    const requiresPayload = [
      CH.vaultSetSecret,
      CH.vaultClearSecret,
      CH.vaultInspectKeyFile,
      CH.sessionOpen,
      CH.sessionWrite,
      CH.sessionResize,
      CH.sessionClose,
      CH.sessionReconnect,
      CH.sessionSnapshot,
      CH.hostkeyAnswer,
      CH.sftpOpen,
      CH.sftpClose,
      CH.sftpList,
      CH.sftpMkdir,
      CH.sftpRename,
      CH.sftpRemove,
      CH.sftpRealpath,
      CH.transferPlan,
      CH.transferStart,
      CH.transferPause,
      CH.transferResume,
      CH.transferCancel,
      CH.transferRetry,
      CH.transferRemove,
      CH.transferReorder,
      CH.transferReveal,
      CH.localList,
      CH.localMkdir,
      CH.localRename,
      CH.localRemove
    ]
    for (const channel of requiresPayload) {
      const result = await dispatch(channel, {}, ctx)
      expect(result.ok, `${channel} 應驗證失敗`).toBe(false)
      if (!result.ok) expect(result.error.code, channel).toBe('E_VALIDATION')
    }
  })

  it('QA v0.1.1 P2-01：空目錄父列 retry 回 E_CONFLICT（不是靜默 Ok）', async () => {
    const now = new Date().toISOString()
    ctx.transfers.add([
      {
        taskId: 'qa-empty-dir',
        sessionId: 's-none',
        connectionLabel: 'qa',
        direction: 'upload',
        source: 'C:/tmp/empty',
        target: '/remote/empty',
        isDirectory: true,
        totalBytes: 0,
        transferredBytes: 0,
        bytesPerSec: 0,
        etaSec: null,
        children: [],
        state: 'queued',
        attempts: 0,
        createdAt: now
      }
    ])
    const result = await dispatch(CH.transferRetry, { taskId: 'qa-empty-dir' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_CONFLICT')
      expect(result.error.detail ?? '').toContain('no child tasks')
    }
    ctx.transfers.remove('qa-empty-dir')
  })

  it('無參數通道回 Ok（不是例外、也不是錯誤碼）', async () => {
    for (const channel of [CH.appInfo, CH.appPickDirectory, CH.appPickFile, CH.connectionsList, CH.transferList, CH.transferClearCompleted, CH.localHome]) {
      const result = await dispatch(channel, undefined, ctx)
      expect(result.ok, `${channel} 應成功`).toBe(true)
    }
  })

  it('hostkey.answer 對未知 requestId 回 E_NOT_FOUND', async () => {
    const result = await dispatch(CH.hostkeyAnswer, { requestId: 'nope', decision: 'once' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_NOT_FOUND')
  })

  it('app.pickDirectory：取消回 null、選取回路徑（走 dialog.showOpenDialog）', async () => {
    const picked = data<string | null>(await dispatch(CH.appPickDirectory, {}, ctx))
    expect(picked).toBe('C:\\picked-dir')

    const { dialog } = (await import('electron')) as unknown as {
      dialog: { showOpenDialog: ReturnType<typeof vi.fn> }
    }
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const cancelled = data<string | null>(await dispatch(CH.appPickDirectory, { defaultPath: 'C:\\tmp' }, ctx))
    expect(cancelled).toBeNull()
    expect(dialog.showOpenDialog).toHaveBeenCalled()
  })

  it('app.pickFile：單檔選擇回路徑、取消回 null（v0.1.4 #1）', async () => {
    const picked = data<string | null>(await dispatch(CH.appPickFile, {}, ctx))
    expect(picked).toBe('C:\\picked-dir')

    const { dialog } = (await import('electron')) as unknown as {
      dialog: { showOpenDialog: ReturnType<typeof vi.fn> }
    }
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const cancelled = data<string | null>(await dispatch(CH.appPickFile, { defaultPath: 'C:\\keys' }, ctx))
    expect(cancelled).toBeNull()
  })

  it('transfer.reveal 只接受既有任務的本地目標（不接收任意路徑）', async () => {
    ctx.transfers.add([
      {
        taskId: 'reveal-me',
        sessionId: 's1',
        connectionLabel: 'prod-web-01',
        direction: 'download',
        source: '/remote/a.bin',
        target: 'C:\\downloads\\a.bin',
        isDirectory: false,
        totalBytes: 10,
        transferredBytes: 0,
        bytesPerSec: 0,
        etaSec: null,
        state: 'queued',
        attempts: 0,
        createdAt: new Date().toISOString()
      }
    ])
    const okResult = await dispatch(CH.transferReveal, { taskId: 'reveal-me' }, ctx)
    expect(okResult.ok).toBe(true)
    expect(ctx.revealPath).toHaveBeenCalledWith('C:\\downloads\\a.bin')

    const missing = await dispatch(CH.transferReveal, { taskId: 'nope' }, ctx)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('E_NOT_FOUND')
  })

  it('transfer.reorder 對已完成的任務回 E_CONFLICT（只有等待中可調）', async () => {
    const listed = data<Array<{ taskId: string; state: string }>>(await dispatch(CH.transferList, undefined, ctx))
    expect(listed.length).toBeGreaterThan(0)
    const task = listed[0] as { taskId: string; state: string }
    // ipc.spec 的 runner 會立刻完成任務
    expect(task.state).toBe('completed')
    const result = await dispatch(CH.transferReorder, { taskId: task.taskId, direction: 'up' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_CONFLICT')
  })
})

describe('M1-02 errors', () => {
  it('28 個 ErrorCode，i18nKey 一律 error.<code>', () => {
    expect(ERROR_CODES).toHaveLength(28)
    expect(new Set(ERROR_CODES).size).toBe(28)
    for (const code of ERROR_CODES) {
      expect(appError(code).i18nKey).toBe(`error.${code}`)
    }
  })
})
