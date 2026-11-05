import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Result, RsApi } from '../shared/ipc-contract'
import { CH, EVT } from '../shared/constants'

/**
 * §2 鐵則 1：preload 是唯一暴露點，只暴露白名單方法。
 * 不得暴露 ipcRenderer、不得提供 invoke(channel, ...) 這類通用轉發。
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * 統一回傳 Result：即使 main 端漏註冊通道（invoke 會 reject），
 * 也絕不讓例外穿到 renderer（§3.4 契約規則）。
 */
const invoke = async <T>(channel: string, payload?: unknown): Promise<Result<T>> => {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as Result<T>
  } catch {
    return {
      ok: false,
      error: {
        code: 'E_INTERNAL',
        message: 'IPC invocation failed',
        i18nKey: 'error.E_INTERNAL',
        retryable: false,
        detail: channel
      }
    }
  }
}

const api: RsApi = {
  app: {
    info: () => invoke('rs:app:info'),
    pickDirectory: (defaultPath) => invoke(CH.appPickDirectory, defaultPath ? { defaultPath } : {}),
    pickFile: (defaultPath) => invoke(CH.appPickFile, defaultPath ? { defaultPath } : {})
  },
  window: {
    minimize: () => invoke<void>(CH.windowMinimize),
    toggleMaximize: () => invoke<boolean>(CH.windowToggleMaximize),
    close: () => invoke<void>(CH.windowClose),
    onState: (cb) => subscribe<{ maximized: boolean }>(EVT.windowState, cb)
  },
  settings: {
    get: () => invoke(CH.settingsGet),
    patch: (patch) => invoke(CH.settingsPatch, patch),
    reset: () => invoke(CH.settingsReset),
    onChange: (cb) => subscribe(EVT.settingsChanged, cb)
  },
  connections: {
    list: () => invoke(CH.connectionsList),
    create: (input) => invoke(CH.connectionsCreate, input),
    update: (id, patch) => invoke(CH.connectionsUpdate, { id, patch }),
    remove: (id) => invoke(CH.connectionsRemove, { id }),
    reorder: (ids) => invoke(CH.connectionsReorder, { ids })
  },
  groups: {
    create: (input) => invoke(CH.groupsCreate, input),
    update: (id, patch) => invoke(CH.groupsUpdate, { id, patch }),
    remove: (id) => invoke(CH.groupsRemove, { id })
  },
  vault: {
    setSecret: (scopeId, secret) => invoke(CH.vaultSetSecret, { scopeId, secret }),
    clearSecret: (scopeId) => invoke(CH.vaultClearSecret, { scopeId }),
    inspectKeyFile: (keyPath) => invoke(CH.vaultInspectKeyFile, { path: keyPath })
  },
  session: {
    open: (req) => invoke(CH.sessionOpen, req),
    write: (sessionId, data) => invoke(CH.sessionWrite, { sessionId, data }),
    resize: (sessionId, cols, rows) => invoke(CH.sessionResize, { sessionId, cols, rows }),
    close: (sessionId) => invoke(CH.sessionClose, { sessionId }),
    reconnect: (sessionId) => invoke(CH.sessionReconnect, { sessionId }),
    snapshot: (sessionId) => invoke(CH.sessionSnapshot, { sessionId }),
    onState: (cb) => subscribe(EVT.sessionState, cb),
    onData: (cb) => subscribe(EVT.sessionData, cb)
  },
  hostkey: {
    answer: (requestId, decision) => invoke(CH.hostkeyAnswer, { requestId, decision }),
    onPrompt: (cb) => subscribe(EVT.hostkeyPrompt, cb)
  },
  sftp: {
    open: (sessionId) => invoke(CH.sftpOpen, { sessionId }),
    close: (sftpId) => invoke(CH.sftpClose, { sftpId }),
    list: (sftpId, sftpPath) => invoke(CH.sftpList, { sftpId, path: sftpPath }),
    mkdir: (sftpId, sftpPath) => invoke(CH.sftpMkdir, { sftpId, path: sftpPath }),
    rename: (sftpId, from, to) => invoke(CH.sftpRename, { sftpId, from, to }),
    remove: (sftpId, sftpPath, isDir) => invoke(CH.sftpRemove, { sftpId, path: sftpPath, isDir }),
    realpath: (sftpId, sftpPath) => invoke(CH.sftpRealpath, { sftpId, path: sftpPath })
  },
  transfer: {
    plan: (sessionId, direction, items) => invoke(CH.transferPlan, { sessionId, direction, items }),
    start: (req) => invoke(CH.transferStart, req),
    pause: (taskId) => invoke(CH.transferPause, { taskId }),
    resume: (taskId) => invoke(CH.transferResume, { taskId }),
    cancel: (taskId) => invoke(CH.transferCancel, { taskId }),
    retry: (taskId) => invoke(CH.transferRetry, { taskId }),
    remove: (taskId) => invoke(CH.transferRemove, { taskId }),
    reorder: (taskId, direction) => invoke(CH.transferReorder, { taskId, direction }),
    reveal: (taskId) => invoke(CH.transferReveal, { taskId }),
    clearCompleted: () => invoke(CH.transferClearCompleted),
    list: () => invoke(CH.transferList),
    onUpdate: (cb) => subscribe(EVT.transferUpdate, cb)
  },
  localFs: {
    home: () => invoke(CH.localHome),
    list: (path) => invoke(CH.localList, { path }),
    mkdir: (path) => invoke(CH.localMkdir, { path }),
    rename: (from, to) => invoke(CH.localRename, { from, to }),
    remove: (path, recursive) => invoke(CH.localRemove, { path, recursive })
  }
}

contextBridge.exposeInMainWorld('rs', api)
