import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AppInfo,
  AppSettings,
  ConnectionGroup,
  ConnectionProfile,
  DeepPartial,
  Result,
  SessionState,
  TransferTask
} from '../../../shared/ipc-contract'
import type { TreeNode } from '../../components/Tree'
import { ConnectionDialog } from '../connections/ConnectionDialog'
import { DeleteConnectionDialog } from '../connections/DeleteConnectionDialog'
import { CredentialDialog } from '../../components/CredentialDialog'
import { useToast } from '../../components/Toast'
import { SettingsDialog, type SettingsPaneId } from '../settings/SettingsDialog'
import type { QueueAction } from '../queue/QueueRow'
import { QueuePanel } from '../queue/QueuePanel'
import { useSessions, type SessionOpenError } from '../terminal/useSessions'
import { neighborAfterClose } from '../terminal/tabNeighbor'
import { resolveTerminalSettings } from '../terminal/resolveTerminalSettings'
import { NewGroupDialog } from './NewGroupDialog'
import { TitleBar } from './TitleBar'
import { MenuBar } from './MenuBar'
import { Toolbar } from './Toolbar'
import { Sidebar } from './Sidebar'
import { TerminalArea } from './TerminalArea'
import { StatusBar } from './StatusBar'

export interface MainWindowProps {
  settings: AppSettings
  info: AppInfo | null
  onPatch: (patch: DeepPartial<AppSettings>) => void
}

/* UI-01 §4 三重表達：狀態點（色）+ 圖示 + 名稱/小字；dot 色走既有 rs-dot token classes */
const DOT_CLASS: Record<SessionState, string> = {
  connected: 'rs-dot rs-dot--connected',
  connecting: 'rs-dot rs-dot--connecting',
  disconnected: 'rs-dot rs-dot--idle',
  failed: 'rs-dot rs-dot--failed'
}
const STATE_LABEL_KEY: Record<SessionState, string> = {
  connected: 'tree.legendConnected',
  connecting: 'tree.legendConnecting',
  disconnected: 'tree.legendDisconnected',
  failed: 'tree.legendFailed'
}

type Translate = (key: string, options?: Record<string, string>) => string

function buildTree(
  profiles: ConnectionProfile[],
  groups: ConnectionGroup[],
  statusByProfile: Map<string, SessionState>,
  jumpNameOf: (profile: ConnectionProfile) => string | null,
  t: Translate
): TreeNode[] {
  const byGroup = new Map<string, ConnectionProfile[]>()
  for (const profile of profiles) {
    const key = profile.groupId ?? ''
    const list = byGroup.get(key) ?? []
    list.push(profile)
    byGroup.set(key, list)
  }
  /* v0.1.9 #4：被其他 profile 當跳板參照的主機縮排一層（12px）；直連維持最左 */
  const jumpHostIds = new Set<string>()
  for (const profile of profiles) {
    if (profile.jump.enabled) for (const id of profile.jump.connectionIds) jumpHostIds.add(id)
  }
  /* N-1：狀態點（無 session 的連線視為未連線）；N-2：跳板標示 ⛓（色用 --jump token） */
  const profileNode = (profile: ConnectionProfile): TreeNode => {
    const state = statusByProfile.get(profile.id) ?? 'disconnected'
    const jumpName = jumpNameOf(profile)
    return {
      id: `profile:${profile.id}`,
      label: profile.name,
      icon: 'server',
      ...(jumpHostIds.has(profile.id) ? { indentPx: 12 } : {}),
      lead: (
        <span className={DOT_CLASS[state]} role="img" aria-label={t(STATE_LABEL_KEY[state])} data-state={state} />
      ),
      secondary: `${profile.host} · ${profile.protocol.toUpperCase()}`,
      ...(jumpName
        ? {
            /* v1.4 裁決：字元 ⛓ 無内嵌字型會壞 → inline SVG 小箭頭（同 UI-01 線框 M108 353 l8 0 M112 349 l4 4 -4 4）；
               完整「經跳板 {name}」放 title/aria-label */
            trail: (
              <svg
                className="rs-tree__jump"
                viewBox="0 0 12 12"
                width={12}
                height={12}
                role="img"
                aria-label={t('tree.jumpAria', { name: jumpName })}
              >
                <title>{t('tree.jumpAria', { name: jumpName })}</title>
                <path
                  d="M1 6 h8 M6 3 l3 3 -3 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )
          }
        : {})
    }
  }
  const groupNodes = groups.map<TreeNode>((group) => ({
    id: `group:${group.id}`,
    label: group.name,
    icon: 'folder',
    expanded: !group.collapsed,
    children: (byGroup.get(group.id) ?? []).map<TreeNode>(profileNode)
  }))
  const ungrouped = (byGroup.get('') ?? []).map<TreeNode>(profileNode)
  return [...groupNodes, ...ungrouped]
}

/* 佇列高度：拖曳範圍 120–500（設定檔舊值如 queueHeight=160 載入時同範圍 clamp） */
const clampQueue = (height: number): number => Math.max(120, Math.min(500, height))
/** UI-01 三區佈局 + 連線生命週期（M2）；SFTP 分頁與佇列接真實後端（M3-05/07） */
export function MainWindow({ settings, info, onPatch }: MainWindowProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [sidebarWidth, setSidebarWidth] = useState(settings.ui.sidebarWidth)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [groups, setGroups] = useState<ConnectionGroup[]>([])
  const [credentialFor, setCredentialFor] = useState<ConnectionProfile | null>(null)
  /* SFTP 分頁：requireSessionIds = 有開 SFTP 分頁的連線；sftpViewId = 目前顯示 */
  const [sftpSessionIds, setSftpSessionIds] = useState<string[]>([])
  const [sftpViewId, setSftpViewId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<TransferTask[]>([])
  const [settingsPane, setSettingsPane] = useState<SettingsPaneId | null>(null)
  /* FAIL-3：新增/編輯連線對話框；groupId = 分組右鍵預填 */
  const [connectionDialog, setConnectionDialog] = useState<{ connection: ConnectionProfile | null; groupId: string | null } | null>(null)
  /* P1-02：刪除確認（confirmDelete=false 時不進此狀態） */
  const [deleteFor, setDeleteFor] = useState<ConnectionProfile | null>(null)
  /* FAIL-3：新增分組小對話框 */
  const [groupDialog, setGroupDialog] = useState<{ open: boolean; parentId: string | null }>({ open: false, parentId: null })

  const { sessions, activeId, setActiveId, open, close, reconnect, active, pendingCredential, submitCredential, cancelCredential, lastError, clearError } = useSessions()

  /* v0.1.8：open 失敗沒有分頁可承載錯誤，狀態列也要留一份（PM 門檻：toast＋狀態列都要有回饋） */
  const [statusError, setStatusError] = useState<SessionOpenError | null>(null)

  /* v0.1.5 #4：open／reconnect 非憑證類失敗要 toast（憑證類走 CredentialDialog，二選一） */
  useEffect(() => {
    if (!lastError) return
    /* v0.1.7：E_JUMP_TCP 的 {host}:{port} 是跳板，不是目標；openProfile 會帶 jumpHost／jumpPort。
       沒有跳板資訊時退回原 params（例如 reconnect 的舊路徑），至少不顯示空白。 */
    const { jumpHost, jumpPort } = lastError.params
    const toastParams =
      lastError.error.code === 'E_JUMP_TCP' && jumpHost !== undefined && jumpPort !== undefined
        ? { host: jumpHost, port: jumpPort }
        : lastError.params
    setStatusError(lastError)
    toast.show(t(lastError.error.i18nKey, toastParams), 'error')
    clearError()
  }, [lastError, clearError, t, toast])

  /* 憑證類錯誤（例如 target-auth）沒有 toast，但狀態列仍要顯示失敗原因 */
  useEffect(() => {
    if (!pendingCredential) return
    setStatusError({ error: pendingCredential.error, params: {} })
  }, [pendingCredential])

  useEffect(() => {
    setSidebarWidth(settings.ui.sidebarWidth)
  }, [settings.ui.sidebarWidth])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.rs.connections.list()
      if (!cancelled && result.ok) {
        setProfiles(result.data.profiles)
        setGroups(result.data.groups)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* M3-07 佇列資料：初始 list() + onUpdate 批次更新（渲染端不節流） */
  useEffect(() => {
    const off = window.rs.transfer.onUpdate((batch) => {
      setTasks((prev) => {
        const index = new Map(prev.map((task) => [task.taskId, task]))
        for (const task of batch) index.set(task.taskId, task)
        return [...index.values()]
      })
    })
    void (async () => {
      const result = await window.rs.transfer.list()
      if (result.ok) setTasks(result.data)
    })()
    return off
  }, [])

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles])
  const profileName = useCallback(
    (profileId: string) => profileById.get(profileId)?.name ?? profileId.slice(0, 8),
    [profileById]
  )

  const reloadProfiles = useCallback(async (): Promise<void> => {
    const result = await window.rs.connections.list()
    if (result.ok) {
      setProfiles(result.data.profiles)
      setGroups(result.data.groups)
    }
  }, [])

  /* FAIL-3：新增連線（groupId 供分組右鍵預填）；快速連線入口暫共用（契約無 profile-less connect） */
  const openNewConnection = useCallback((groupId: string | null): void => {
    setConnectionDialog({ connection: null, groupId })
  }, [])

  const openNewGroup = useCallback((parentId: string | null): void => {
    setGroupDialog({ open: true, parentId })
  }, [])

  /* P1-02：編輯/刪除入口（右鍵與 F2） */
  const editConnection = useCallback((profileId: string): void => {
    const profile = profileById.get(profileId)
    if (profile) setConnectionDialog({ connection: profile, groupId: profile.groupId ?? null })
  }, [profileById])

  const doDelete = useCallback(
    async (profile: ConnectionProfile): Promise<void> => {
      const removed = await window.rs.connections.remove(profile.id)
      if (!removed.ok) {
        /* #9：main 回 E_CONFLICT（detail = `jump dependents (N): a, b…`）→ 擋刪除並顯示依賴清單 */
        if (removed.error.code === 'E_CONFLICT') {
          const matched = /^jump dependents \((\d+)\): *(.*)$/.exec(removed.error.detail ?? '')
          if (matched) {
            const count = Number(matched[1])
            const names = matched[2] ? ` ${matched[2]}` : ''
            toast.show(`${t('dialog.connection.delete.jumpInUse', { count })}${names}`, 'error', 8000)
          } else {
            toast.show(`${t(removed.error.i18nKey)}${removed.error.detail ? ` — ${removed.error.detail}` : ''}`, 'error', 8000)
          }
        } else {
          toast.show(t(removed.error.i18nKey), 'error')
        }
        return
      }
      /* #10＋P3：刪除成功 → 先等該 profile 的 session 全部關閉（分頁/SFTP 收掉）再 reload 清單，
         避免「清單已無此連線、分頁還在」的一幀 */
      const doomed = sessions.filter((session) => session.profileId === profile.id)
      const doomedIds = new Set(doomed.map((session) => session.sessionId))
      if (doomedIds.size > 0) {
        setSftpSessionIds((prev) => prev.filter((id) => !doomedIds.has(id)))
        setSftpViewId((current) => (current !== null && doomedIds.has(current) ? null : current))
        await Promise.allSettled(doomed.map((session) => close(session.sessionId)))
      }
      setSelectedId((prev) => (prev === `profile:${profile.id}` ? null : prev))
      await reloadProfiles()
    },
    [close, reloadProfiles, sessions, t, toast]
  )

  const requestDelete = useCallback(
    (profileId: string): void => {
      const profile = profileById.get(profileId)
      if (!profile) return
      /* 設定「刪除前確認」= false 時直接刪 */
      if (!settings.general.confirmDelete) {
        void doDelete(profile)
        return
      }
      setDeleteFor(profile)
    },
    [doDelete, profileById, settings.general.confirmDelete]
  )

  const createGroup = useCallback(
    async (name: string, parentId: string | null): Promise<void> => {
      const result = await window.rs.groups.create({ name, parentId })
      setGroupDialog((prev) => ({ ...prev, open: false }))
      if (result.ok) await reloadProfiles()
      else toast.show(t(result.error.i18nKey), 'error')
    },
    [reloadProfiles, t, toast]
  )

  /* N-1：profileId → 最新 session 狀態（同一 profile 重連後新 session 會覆蓋舊的） */
  const statusByProfile = useMemo(() => {
    const map = new Map<string, SessionState>()
    for (const session of sessions) map.set(session.profileId, session.state)
    return map
  }, [sessions])

  /* N-2：跳板名稱由 jump.connectionIds[0] 解析 */
  const jumpNameOf = useCallback(
    (profile: ConnectionProfile): string | null => {
      if (!profile.jump?.enabled) return null
      const jumpId = profile.jump.connectionIds[0]
      return jumpId ? profileById.get(jumpId)?.name ?? null : null
    },
    [profileById]
  )

  /* #13 讀取端：依 profileId 合併 profile.terminal（六欄逐欄 fallback 全域） */
  const terminalSettingsFor = useCallback(
    (profileId: string): AppSettings['terminal'] =>
      resolveTerminalSettings(settings.terminal, profileById.get(profileId)?.terminal),
    [profileById, settings.terminal]
  )

  /* P2-02：E_JUMP_TCP 的 {host}:{port} 佔位符用跳板主機（否則用目標主機） */
  const activeJump = useMemo(() => {
    if (!active) return null
    const profile = profileById.get(active.profileId)
    const jumpId = profile?.jump?.enabled ? profile.jump.connectionIds[0] : undefined
    const jumpProfile = jumpId ? profileById.get(jumpId) : undefined
    return jumpProfile ? { host: jumpProfile.host, port: jumpProfile.port } : null
  }, [active, profileById])

  const nodes = useMemo(() => {
    const tree = buildTree(profiles, groups, statusByProfile, jumpNameOf, (key, options) => t(key, options))
    if (!search.trim()) return tree
    const needle = search.trim().toLowerCase()
    return tree.filter((node) => {
      const selfHit = node.label.toLowerCase().includes(needle)
      const childHit = (node.children ?? []).some(
        (child) =>
          child.label.toLowerCase().includes(needle) || (child.secondary ?? '').toLowerCase().includes(needle)
      )
      return selfHit || childHit
    })
  }, [profiles, groups, statusByProfile, jumpNameOf, search, t])

  const openProfile = useCallback(
    async (profile: ConnectionProfile, secret?: string) => {
      /* v0.1.6：passwordFile 的 secret 依設計永遠是 none（密碼在檔案裡），不能因此跳憑證框。
         只有 password 需要「沒有記住密碼 → 先問」。publicKey 缺 passphrase 由 main 回 E_KEY_PASSPHRASE。 */
      if (!secret && profile.auth.method === 'password' && profile.auth.secret.kind === 'none') {
        setCredentialFor(profile)
        return
      }
      /* v0.1.7：E_JUMP_TCP toast 需要跳板 host/port；沒有跳板就不帶這兩個 key */
      const jumpId = profile.jump.enabled ? profile.jump.connectionIds[0] : undefined
      const jumpProfile = jumpId ? profileById.get(jumpId) : undefined
      setStatusError(null)
      await open(profile.id, {
        ...(secret ? { secret } : {}),
        params: {
          host: profile.host,
          port: profile.port,
          ...(jumpProfile ? { jumpHost: jumpProfile.host, jumpPort: jumpProfile.port } : {})
        }
      })
    },
    [open, profileById]
  )

  const handleActivate = useCallback(
    (node: TreeNode) => {
      if (!node.id.startsWith('profile:')) return
      const profile = profileById.get(node.id.slice('profile:'.length))
      if (profile) void openProfile(profile)
    },
    [openProfile, profileById]
  )

  const handleWidth = useCallback(
    (width: number, commit: boolean) => {
      setSidebarWidth(width)
      if (commit) onPatch({ ui: { sidebarWidth: width } })
    },
    [onPatch]
  )

  const toggleQueue = useCallback(() => {
    onPatch({ ui: { queueCollapsed: !settings.ui.queueCollapsed } })
  }, [onPatch, settings.ui.queueCollapsed])

  /* #5：側欄整體收合（settings.ui.sidebarCollapsed 持久化；Ctrl+Shift+B／雙擊邊界／收合鈕） */
  const toggleSidebar = useCallback(() => {
    onPatch({ ui: { sidebarCollapsed: !settings.ui.sidebarCollapsed } })
  }, [onPatch, settings.ui.sidebarCollapsed])

  /* ---------- SFTP 分頁（UI-03 開啟方式；Ctrl+Shift+S） ---------- */
  const openSftp = useCallback(
    (sessionId: string): void => {
      setSftpSessionIds((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]))
      setSftpViewId(sessionId)
      setActiveId(null)
    },
    [setActiveId]
  )

  const switchToTerminal = useCallback(
    (sessionId: string): void => {
      setSftpViewId(null)
      setActiveId(sessionId)
    },
    [setActiveId]
  )

  const closeSftpTab = useCallback((sessionId: string): void => {
    const sftpIds = sftpSessionIds
    setSftpSessionIds((prev) => prev.filter((id) => id !== sessionId))
    if (sftpViewId !== sessionId) return
    /* v0.1.10 #3：同類型（SFTP）相鄰優先，沒有才回終端相鄰；最後一個才回空狀態 */
    const sftpNext = neighborAfterClose(sftpIds, sessionId, sessionId)
    if (sftpNext) {
      setSftpViewId(sftpNext)
      return
    }
    const terminalIds = sessions.map((session) => session.sessionId)
    setSftpViewId(null)
    setActiveId(neighborAfterClose(terminalIds, sessionId, sessionId))
  }, [sftpSessionIds, sftpViewId, sessions, setActiveId])

  const canOpenSftp = active !== null && active.protocol === 'ssh' && active.state === 'connected'
  const toggleSftp = useCallback((): void => {
    if (sftpViewId === activeId && sftpViewId !== null) {
      setSftpViewId(null)
      setActiveId(activeId ?? null)
      return
    }
    if (activeId) openSftp(activeId)
  }, [activeId, openSftp, setActiveId, sftpViewId])

  /* 快速鍵：Ctrl+Shift+S（SFTP）、Ctrl+Shift+Q（佇列）、Ctrl+Shift+N（新增連線）、Ctrl+Shift+B（側欄收合）、Ctrl+Q（快速連線）、Ctrl+,（設定） */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'S' || event.key === 's' || event.key === 'q' || event.key === 'Q' || event.key === 'N' || event.key === 'n' || event.key === 'B' || event.key === 'b')) {
        event.preventDefault()
        if (event.key === 'S' || event.key === 's') toggleSftp()
        else if (event.key === 'N' || event.key === 'n') openNewConnection(null)
        else if (event.key === 'B' || event.key === 'b') toggleSidebar()
        else toggleQueue()
        return
      }
      if (event.ctrlKey && !event.shiftKey && (event.key === 'q' || event.key === 'Q')) {
        event.preventDefault()
        openNewConnection(null)
        return
      }
      if (event.ctrlKey && event.key === ',') {
        event.preventDefault()
        setSettingsPane((prev) => (prev === null ? 'general' : prev))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleQueue, toggleSftp, toggleSidebar, openNewConnection])

  /* 佇列動作（M3-07 UI → transfer.*）；moveUp/moveDown 合約暫無 reorder，先 toast 回報 */
  const queueTaskRequest = useCallback(
    async (action: QueueAction, taskId: string): Promise<void> => {
      if (action === 'moveUp' || action === 'moveDown') {
        toast.show(t(`queue.action.${action}`), 'info')
        return
      }
      if (action === 'openFolder') {
        // TODO(M3): contract 暫無「開啟 local folder」IPC，暫不動作
        return
      }
      const handlers: Partial<Record<QueueAction, (id: string) => Promise<Result<unknown>>>> = {
        cancel: window.rs.transfer.cancel,
        retry: window.rs.transfer.retry,
        remove: window.rs.transfer.remove,
        pause: window.rs.transfer.pause,
        resume: window.rs.transfer.resume
      }
      const handler = handlers[action]
      try {
        if (handler) {
          const result = await handler(taskId)
          /* P2-01v2-2 §1：後端失敗（如 E_CONFLICT 父列無子任務）必須顯示 —— 原本完全靜默 */
          if (!result.ok) {
            toast.show(result.error.detail ? `${t(result.error.i18nKey)} — ${result.error.detail}` : t(result.error.i18nKey), 'error')
          }
        }
      } catch {
        /* §2：IPC 例外也不可靜默（原本 unhandled → 使用者按了沒反應） */
        toast.show(t('error.E_INTERNAL'), 'error')
      } finally {
        /* §3：失敗與成功都要刷新佇列 —— 畫面狀態回到真實值 */
        try {
          const refreshed = await window.rs.transfer.list()
          if (refreshed.ok) setTasks(refreshed.data)
        } catch {
          /* 刷新失敗不覆蓋既有畫面 */
        }
      }
    },
    [t, toast]
  )

  const handleQueueAction = useCallback(
    (action: QueueAction, task: { taskId: string }) => {
      void queueTaskRequest(action, task.taskId)
    },
    [queueTaskRequest]
  )

  return (    <div className="rs-app">
      <TitleBar />
      <MenuBar
        locale={settings.locale}
        onLocaleChange={(locale) => onPatch({ locale })}
        onOpenSettings={(pane) => setSettingsPane(pane)}
        onNewConnection={() => openNewConnection(null)}
      />
      <Toolbar
        queueOpen={!settings.ui.queueCollapsed}
        onToggleQueue={toggleQueue}
        activeTaskCount={tasks.filter((task) => task.state === 'running' || task.state === 'queued').length}
        hasSession={active !== null}
        canReconnect={active?.state === 'disconnected' || active?.state === 'failed'}
        canSftp={canOpenSftp}
        onSftp={toggleSftp}
        onDisconnect={() => (active ? void close(active.sessionId) : undefined)}
        onReconnect={() => (active ? void reconnect(active.sessionId) : undefined)}
        onQuickConnect={() => openNewConnection(null)}
        onNewConnection={() => openNewConnection(null)}
      />
      <div className="rs-body">
        <Sidebar
          width={sidebarWidth}
          onWidthChange={handleWidth}
          search={search}
          onSearch={setSearch}
          nodes={nodes}
          selectedId={selectedId}
          onSelect={(node) => setSelectedId(node.id)}
          onActivate={handleActivate}
          onNewConnection={openNewConnection}
          onNewGroup={openNewGroup}
          onEditConnection={editConnection}
          onDeleteConnection={requestDelete}
          collapsed={settings.ui.sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
        />
        <main className="rs-main">
          <TerminalArea
            sessions={sessions}
            activeId={activeId}
            settings={settings}
            sftpSessionIds={sftpSessionIds.filter((sessionId) => sessions.some((session) => session.sessionId === sessionId))}
            sftpViewId={sftpViewId}
            profileName={profileName}
            terminalSettingsFor={terminalSettingsFor}
            onSelect={switchToTerminal}
            onClose={(sessionId) => {
              closeSftpTab(sessionId)
              void close(sessionId)
            }}
            onSelectSftp={openSftp}
            onCloseSftp={closeSftpTab}
            closeSftpTab={() => (sftpViewId ? closeSftpTab(sftpViewId) : undefined)}
            onQuickConnect={() => openNewConnection(null)}
          />
          <QueuePanel
            collapsed={settings.ui.queueCollapsed}
            height={clampQueue(settings.ui.queueHeight)}
            onToggle={toggleQueue}
            onHeightChange={(height, commit) => {
              if (commit) onPatch({ ui: { queueHeight: clampQueue(height) } })
            }}
            tasks={tasks}
            onRequest={handleQueueAction}
            onClearCompleted={() => {
              void (async () => {
                await window.rs.transfer.clearCompleted()
                const refreshed = await window.rs.transfer.list()
                if (refreshed.ok) setTasks(refreshed.data)
              })()
            }}
          />
        </main>
      </div>
      <StatusBar
        locale={settings.locale}
        info={info}
        session={active}
        profileName={active ? profileName(active.profileId) : ''}
        jumpHost={activeJump?.host}
        jumpPort={activeJump?.port}
        openError={statusError}
        onReconnect={(sessionId) => void reconnect(sessionId)}
      />
      <CredentialDialog
        open={credentialFor !== null}
        title={credentialFor ? `${credentialFor.name}` : ''}
        host={credentialFor?.host ?? ''}
        username={credentialFor?.auth.username ?? ''}
        onCancel={() => setCredentialFor(null)}
        onSubmit={(secret) => {
          const profile = credentialFor
          setCredentialFor(null)
          if (profile) void openProfile(profile, secret)
        }}
      />
      {/* M4-07：重連因 vault/auth 失敗的憑證補輸入（取消維持斷線） */}
      <CredentialDialog
        open={pendingCredential !== null}
        title={pendingCredential ? t('statusBar.reconnectNow') : ''}
        host={pendingCredential ? profileById.get(pendingCredential.profileId)?.host ?? '' : ''}
        username={pendingCredential ? profileById.get(pendingCredential.profileId)?.auth.username ?? '' : ''}
        onCancel={cancelCredential}
        onSubmit={(secret) => void submitCredential(secret)}
      />
      <SettingsDialog
        open={settingsPane !== null}
        settings={settings}
        info={info}
        initialPane={settingsPane ?? 'general'}
        onPatch={onPatch}
        onClose={() => setSettingsPane(null)}
      />
      {/* FAIL-3：新增/編輯連線（UI-02）；分組右鍵預填 initialGroupId。
          key 依開啟目標重掛：避免 useState 初值在首次 mount（對話框未開時）固化造成預填/編輯值殘留 */}
      <ConnectionDialog
        key={
          connectionDialog === null
            ? 'conn-dialog-closed'
            : `conn-${connectionDialog.connection?.id ?? 'new'}-${connectionDialog.groupId ?? 'root'}`
        }
        open={connectionDialog !== null}
        connection={connectionDialog?.connection ?? null}
        initialGroupId={connectionDialog?.groupId ?? null}
        settings={settings}
        onConnect={(profile) => void openProfile(profile)}
        groups={groups}
        profiles={profiles}
        onClose={() => setConnectionDialog(null)}
        onSaved={() => {
          setConnectionDialog(null)
          void reloadProfiles()
        }}
      />
      {/* FAIL-3：新增分組（空白/分組右鍵、側欄資料夾+鈕） */}
      <NewGroupDialog
        open={groupDialog.open}
        parentId={groupDialog.parentId}
        onClose={() => setGroupDialog((prev) => ({ ...prev, open: false }))}
        onCreate={(name, parentId) => void createGroup(name, parentId)}
      />
      {/* P1-02：刪除連線二次確認（輸入名稱；confirmDelete=false 不會進來） */}
      <DeleteConnectionDialog
        open={deleteFor !== null}
        name={deleteFor?.name ?? ''}
        onCancel={() => setDeleteFor(null)}
        onConfirm={() => {
          const profile = deleteFor
          setDeleteFor(null)
          if (profile) void doDelete(profile)
        }}
      />
    </div>
  )
}
