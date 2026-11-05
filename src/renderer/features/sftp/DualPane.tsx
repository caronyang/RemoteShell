import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { SftpEntry, SessionInfo, TransferPlanItem } from '../../../shared/ipc-contract'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import { ConflictDialog, type ConflictDecision, type ConflictItem } from './ConflictDialog'
import { DropZone } from './DropZone'
import { baseName, formatSize, formatMtime } from './format'
import { DRAG_MIME, FileTable, type DragPayload, type SortKey, type SortState } from './FileTable'
import { PathBar } from './PathBar'
import { SftpToolbar } from './Toolbar'

export interface DualPaneProps {
  session: SessionInfo
  /** close the SFTP tab (also called when opening the channel fails) */
  onClose: () => void
}

interface PaneState {
  path: string
  history: string[]
  entries: SftpEntry[]
  sort: SortState
}

/** folders first, then localeCompare on names (CJK safe, TID T-1) */
function sortEntries(entries: SftpEntry[], sort: SortState): SftpEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
    if (sort.key === 'size') {
      return sort.asc ? a.size - b.size : b.size - a.size
    }
    if (sort.key === 'mtime') {
      return sort.asc ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs
    }
    const cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return sort.asc ? cmp : -cmp
  })
}

const joinRemote = (dir: string, name: string): string => `${dir.endsWith('/') ? dir : `${dir}/`}${name}`
const joinLocal = (dir: string, name: string): string =>
  /\\$|\/$/.test(dir) ? `${dir}${name}` : `${dir}\\${name}`
const isHiddenRemote = (name: string): boolean => name.startsWith('.')

/** P1-03：衝突決策的 key —— 與 main 的 decideConflict 查表對齊
 *  （src/main/queue/conflict.ts：`decisions[target] ?? decisions[source→target]`）。
 *  送 source 單鍵後端查不到 → ask → 全部 skip（QA T05d-1/2 的根因）。 */
const decisionKey = (item: { source: string; target: string }): string => `${item.source}→${item.target}`

/** M3-05 SFTP dual pane (UI-03): symmetric panels, resizable, drag-and-drop transfer */
export function DualPane({ session, onClose }: DualPaneProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  const [local, setLocal] = useState<PaneState>({ path: '', history: [], entries: [], sort: { key: 'name', asc: true } })
  const [drives, setDrives] = useState<string[]>([])
  const [remote, setRemote] = useState<PaneState>({ path: '/', history: [], entries: [], sort: { key: 'name', asc: true } })
  const [sftpId, setSftpId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [localSelected, setLocalSelected] = useState<ReadonlySet<string>>(new Set())
  const [remoteSelected, setRemoteSelected] = useState<ReadonlySet<string>>(new Set())
  /* v0.1.4：刪除確認（App 內 ConfirmDialog，取代 window.confirm） */
  const [pendingDelete, setPendingDelete] = useState<{ pane: 'local' | 'remote'; names: string[] } | null>(null)
  const [localLast, setLocalLast] = useState<string | null>(null)
  const [remoteLast, setRemoteLast] = useState<string | null>(null)
  const [focusedPane, setFocusedPane] = useState<'local' | 'remote'>('remote')
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const [conflicts, setConflicts] = useState<{ direction: 'upload' | 'download'; items: ConflictItem[]; plan: TransferPlanItem[] } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ pane: 'local' | 'remote'; entry: SftpEntry } | null>(null)
  const [mkdirPane, setMkdirPane] = useState<'local' | 'remote' | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; pane: 'local' | 'remote'; entry: SftpEntry | null } | null>(null)
  const [properties, setProperties] = useState<{ entry: SftpEntry } | null>(null)
  const [errorPath, setErrorPath] = useState<string | null>(null)

  const sftpIdRef = useRef<string | null>(null)
  sftpIdRef.current = sftpId
  /* v0.1.4 #9：本地面板首頁只初始化一次。listLocal 依賴 t／toast，identity 會隨 render 變；
     沒有這個 guard 的話，開收佇列／切換語系造成 rerender 會把使用者導覽到的路徑重設回 home。
     分頁重掛載（key 變）才會重設。 */
  const localInitialisedRef = useRef(false)

  /* open/close the real SFTP channel (M2 sftp.open/close) */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const opened = await window.rs.sftp.open(session.sessionId)
      if (cancelled) return
      if (!opened.ok) {
        toast.show(t(opened.error.i18nKey), 'error')
        onClose()
        return
      }
      setSftpId(opened.data.sftpId)
      setRemote((prev) => ({ ...prev, path: opened.data.home || '/' }))
    })()
    return () => {
      cancelled = true
      if (sftpIdRef.current) void window.rs.sftp.close(sftpIdRef.current).catch(() => undefined)
      setSftpId(null)
    }
  }, [session.sessionId])

  const listRemote = useCallback(
    async (sftpHandle: string, path: string, pushHistory: boolean): Promise<void> => {
      setLoading(true)
      const result = await window.rs.sftp.list(sftpHandle, path)
      setLoading(false)
      if (!result.ok) {
        setErrorPath(path)
        toast.show(t(result.error.i18nKey), 'error')
        return
      }
      setErrorPath(null)
      setRemote((prev) => ({
        path: result.data.path,
        entries: result.data.entries,
        history:
          pushHistory && prev.path !== result.data.path ? [prev.path, ...prev.history].slice(0, 10) : prev.history,
        sort: prev.sort
      }))
      setRemoteSelected(new Set())
      setRemoteLast(null)
    },
    [t, toast]
  )

  useEffect(() => {
    if (!sftpId) return
    void listRemote(sftpId, remote.path, false)
  }, [sftpId])

  /* local pane: real localFs backend (v1.8 contract §3.5b) */
  const listLocal = useCallback(
    async (path: string, pushHistory: boolean): Promise<void> => {
      const result = await window.rs.localFs.list(path)
      if (!result.ok) {
        setErrorPath(path)
        toast.show(t(result.error.i18nKey), 'error')
        return
      }
      setDrives(result.data.drives)
      setLocal((prev) => ({
        path: result.data.path,
        entries: result.data.entries,
        history:
          pushHistory && prev.path !== result.data.path ? [prev.path, ...prev.history].slice(0, 10) : prev.history,
        sort: prev.sort
      }))
      setLocalSelected(new Set())
      setLocalLast(null)
    },
    [t, toast]
  )

  useEffect(() => {
    if (localInitialisedRef.current) return
    localInitialisedRef.current = true
    void (async () => {
      const home = await window.rs.localFs.home()
      if (home.ok) void listLocal(home.data, false)
    })()
  }, [listLocal])

  const canTransfer = sftpId !== null && session.protocol === 'ssh' && session.state === 'connected'

  const visibleLocal = useMemo(
    () =>
      sortEntries(
        showHidden ? local.entries : local.entries.filter((entry) => !entry.name.startsWith('.')),
        local.sort
      ),
    [local.entries, local.sort, showHidden]
  )
  const visibleRemote = useMemo(
    () =>
      sortEntries(
        showHidden ? remote.entries : remote.entries.filter((entry) => !isHiddenRemote(entry.name)),
        remote.sort
      ),
    [remote.entries, remote.sort, showHidden]
  )

  /* selection */
  const selectLocal = useCallback((selected: string[], last: string): void => {
    setLocalSelected(new Set(selected))
    setLocalLast(last)
  }, [])
  const selectRemote = useCallback((selected: string[], last: string): void => {
    setRemoteSelected(new Set(selected))
    setRemoteLast(last)
  }, [])

  const range = (anchor: string | null, to: string, names: string[]): [number, number] | null => {
    if (!anchor) return null
    const a = names.indexOf(anchor)
    const b = names.indexOf(to)
    if (a < 0 || b < 0) return null
    return [Math.min(a, b), Math.max(a, b)]
  }
  const selectRangeLocal = (toName: string, additive: boolean): void => {
    const bounds = range(localLast ?? localSelected.values().next().value ?? null, toName, visibleLocal.map((entry) => entry.name))
    if (!bounds) return
    const picked = visibleLocal.slice(bounds[0], bounds[1] + 1).map((entry) => entry.name)
    selectLocal(additive ? [...new Set([...localSelected, ...picked])] : picked, localLast ?? picked[0] ?? toName)
  }
  const selectRangeRemote = (toName: string, additive: boolean): void => {
    const bounds = range(remoteLast ?? remoteSelected.values().next().value ?? null, toName, visibleRemote.map((entry) => entry.name))
    if (!bounds) return
    const picked = visibleRemote.slice(bounds[0], bounds[1] + 1).map((entry) => entry.name)
    selectRemote(additive ? [...new Set([...remoteSelected, ...picked])] : picked, remoteLast ?? picked[0] ?? toName)
  }

  /* transfer (F-2/F-3): real backend via window.rs.transfer */
  const launchTransfer = useCallback(
    async (direction: 'upload' | 'download', items: TransferPlanItem[], decisions?: Record<string, ConflictDecision>): Promise<void> => {
      const result = await window.rs.transfer.start({
        sessionId: session.sessionId,
        direction,
        items: items.map((item) => ({ source: item.source, target: item.target })),
        onConflict: 'ask',
        ...(decisions ? { decisions } : {})
      })
      if (!result.ok) {
        toast.show(t(result.error.i18nKey), 'error')
        return
      }
      /* 空目錄上傳（資深新行為）：start 成功但回 []（目錄已在 main 建立、不落佇列）→ 不顯示「0 items」。
         無既有 key 表達「資料夾已建立」，依主管裁示取「不顯示」；有任務時維持原計數 toast。 */
      if (result.data.length > 0) {
        toast.show(t('sftp.selection.count', { count: result.data.length }), 'success')
      }
    },
    [session.sessionId, t, toast]
  )

  const beginTransfer = useCallback(
    async (direction: 'upload' | 'download', names: string[], targetDir: string): Promise<void> => {
      if (!canTransfer || names.length === 0) return
      const request: TransferPlanItem[] = names.map((name) =>
        direction === 'upload'
          ? { source: joinLocal(local.path, name), target: joinRemote(targetDir, name), conflict: false }
          : { source: joinRemote(remote.path, name), target: joinLocal(targetDir, name), conflict: false }
      )
      /* conflict detection is authoritative from the backend (transfer.plan) */
      const planned = await window.rs.transfer.plan(session.sessionId, direction, request)
      if (!planned.ok) {
        toast.show(t(planned.error.i18nKey), 'error')
        return
      }
      const localSizes = new Map(local.entries.map((entry) => [entry.name, entry.size]))
      const conflictItems: ConflictItem[] = planned.data.items
        .filter((item) => item.conflict)
        .map((item) => ({
          /* P1-03：main 的 decideConflict 以 `decisions[target] ?? decisions[source→target]` 查表
             （src/main/queue/conflict.ts L35）。原本用 source 為 key → 查不到 → ask → 全部 skip。
             改送 `source→target`（main 文件明列的第二種 key 格式）。 */
          baseKey: decisionKey(item),
          displayName: baseName(item.target),
          existingSize: item.existingSize ?? localSizes.get(baseName(item.target)) ?? null
        }))
      if (planned.data.skipped.length > 0) {
        for (const skipped of planned.data.skipped) toast.show(t(skipped.reason.i18nKey), 'warning')
      }
      if (conflictItems.length > 0) {
        setConflicts({ direction, items: conflictItems, plan: planned.data.items })
        return
      }
      void launchTransfer(direction, planned.data.items)
    },
    [canTransfer, local.entries, local.path, remote.path, launchTransfer, session.sessionId, t, toast]
  )

  const resolveConflicts = (entries: Array<{ baseKey: string; decision: ConflictDecision }>): void => {
    if (!conflicts) return
    const decisions: Record<string, ConflictDecision> = {}
    for (const entry of entries) decisions[entry.baseKey] = entry.decision
    /* 契約 v1.11：skip 不建立任務 —— UI 端先從 items 過濾（後端 plan.skipped 亦會帶回）。
       TODO: Toast「略過 N 個」需要新 key（現有 key 無略過計數），已回報主管補規格。 */
    const toStart = conflicts.plan.filter((item) => decisions[decisionKey(item)] !== 'skip')
    void launchTransfer(conflicts.direction, toStart, decisions)
    setConflicts(null)
  }

  /* panel actions */
  const navigateLocal = useCallback(
    (next: string): void => {
      void listLocal(next, true)
    },
    [listLocal]
  )

  const navigateRemote = useCallback(
    (next: string): void => {
      if (sftpId) void listRemote(sftpId, next, true)
    },
    [sftpId, listRemote]
  )

  const toggleSort = (pane: 'local' | 'remote'): ((key: SortKey) => void) => {
    const setter = pane === 'local' ? setLocal : setRemote
    return (key: SortKey) => {
      setter((prev) => ({
        ...prev,
        sort: { key, asc: prev.sort.key === key ? !prev.sort.asc : true }
      }))
    }
  }

  const closeNameModal = useCallback((): void => {
    setRenameTarget(null)
    setMkdirPane(null)
    setNameDraft('')
  }, [])

  const applyRename = useCallback((): void => {
    const target = renameTarget
    const mkdir = mkdirPane
    const clean = nameDraft.trim()
    if (mkdir) {
      closeNameModal()
      if (!clean) return
      if (mkdir === 'remote' && sftpId) {
        void window.rs.sftp
          .mkdir(sftpId, joinRemote(remote.path, clean))
          .then(() => {
            if (sftpId) {
              void listRemote(sftpId, remote.path, false)
            }
          })
          .catch(() => toast.show(t('error.E_INTERNAL'), 'error'))
      }
      if (mkdir === 'local') {
        void window.rs.localFs
          .mkdir(joinLocal(local.path, clean))
          .then(() => void listLocal(local.path, false))
          .catch(() => toast.show(t('error.E_INTERNAL'), 'error'))
      }
      return
    }
    if (!target) return
    closeNameModal()
    if (!clean || clean === target.entry.name) return
    if (target.pane === 'remote' && sftpId) {
      void window.rs.sftp
        .rename(sftpId, target.entry.path, joinRemote(remote.path, clean))
        .then(() => void (sftpId ? listRemote(sftpId, remote.path, false) : undefined))
        .catch(() => toast.show(t('error.E_INTERNAL'), 'error'))
      return
    }
    void window.rs.localFs
      .rename(target.entry.path, joinLocal(local.path, clean))
      .then(() => void listLocal(local.path, false))
      .catch(() => toast.show(t('error.E_INTERNAL'), 'error'))
    setLocalSelected(new Set())
  }, [closeNameModal, listLocal, listRemote, local.path, mkdirPane, nameDraft, renameTarget, remote.path, sftpId, t, toast])

  const performDelete = (pane: 'local' | 'remote', names: string[]): void => {
    if (pane === 'remote' && sftpId) {
      for (const name of names) {
        const entry = remote.entries.find((candidate) => candidate.name === name)
        if (entry) void window.rs.sftp.remove(sftpId, entry.path, entry.type === 'dir')
      }
      void listRemote(sftpId, remote.path, false)
      return
    }
    /* local delete: real localFs backend */
    const localTargets = names
      .map((name) => local.entries.find((entry) => entry.name === name))
      .filter((entry): entry is SftpEntry => entry !== undefined)
    void (async () => {
      for (const entry of localTargets) {
        await window.rs.localFs.remove(entry.path, entry.type === 'dir')
      }
      await listLocal(local.path, false)
    })().catch(() => toast.show(t('error.E_LOCAL_IO'), 'error'))
    setLocalSelected(new Set())
    setLocalLast(null)
  }

  /* v0.1.4：刪除改用 App 內 ConfirmDialog（不再用 window.confirm 阻塞 renderer） */
  const deleteSelection = (pane: 'local' | 'remote'): void => {
    const selected = pane === 'local' ? localSelected : remoteSelected
    const names = [...selected]
    if (names.length === 0) return
    setPendingDelete({ pane, names })
  }

  /* context menu (UI-03, both panes) */
  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenu = (event: MouseEvent, pane: 'local' | 'remote', entry: SftpEntry | null): void => {
    event.preventDefault()
    setFocusedPane(pane)
    setMenu({ x: event.clientX, y: event.clientY, pane, entry })
    if (entry) (pane === 'local' ? selectLocal : selectRemote)([entry.name], entry.name)
  }

  /* drag and drop */
  const dragHint = (target: 'local' | 'remote'): string | null => {
    if (!dragging || dragging.names.length === 0) return null
    if (dragging.kind === target) return null
    const direction: 'upload' | 'download' = target === 'remote' ? 'upload' : 'download'
    return t(direction === 'upload' ? 'sftp.drop.hintUpload' : 'sftp.drop.hintDownload', {
      count: dragging.names.length,
      target: target === 'remote' ? remote.path : local.path
    })
  }

  const readPayload = (event: DragEvent<HTMLDivElement>): DragPayload | null => {
    const raw = event.dataTransfer.getData(DRAG_MIME)
    if (raw) {
      try {
        return JSON.parse(raw) as DragPayload
      } catch {
        return dragging && dragging.names.length > 0 ? dragging : null
      }
    }
    return dragging && dragging.names.length > 0 ? dragging : null
  }

  const handleDrop = (target: 'local' | 'remote', event: DragEvent<HTMLDivElement>): void => {
    const payload = readPayload(event)
    setDragging(null)
    if (!payload || payload.kind === target || payload.names.length === 0) return
    void beginTransfer(target === 'remote' ? 'upload' : 'download', payload.names, target === 'remote' ? remote.path : local.path)
  }

  const upOneLocal = (): string => (local.path.length > 3 ? local.path.replace(/[^\\]+\\?$/u, '') : local.path)

  return (
    <div
      className="rs-sftp"
      role="tabpanel"
      aria-label={t('toolbar.sftp')}
      onMouseDown={(event) => {
        const pane = (event.target as HTMLElement).closest('[data-pane]')
        if (pane instanceof HTMLElement && (pane.dataset.pane === 'local' || pane.dataset.pane === 'remote')) setFocusedPane(pane.dataset.pane)
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault()
          const names = (focusedPane === 'local' ? visibleLocal : visibleRemote).map((entry) => entry.name)
          ;(focusedPane === 'local' ? selectLocal : selectRemote)(names, names[names.length - 1] ?? '')
        }
      }}
    >
      <SftpToolbar
        hasLocalSelection={localSelected.size > 0}
        hasRemoteSelection={remoteSelected.size > 0}
        canTransfer={canTransfer}
        showHidden={showHidden}
        onUpload={() => void beginTransfer('upload', [...localSelected], remote.path)}
        onDownload={() => void beginTransfer('download', [...remoteSelected], local.path)}
        onNewFolder={() => {
          setMkdirPane(focusedPane)
          setNameDraft('')
        }}
        onRename={() => {
          const name = focusedPane === 'remote' ? remoteSelected.values().next().value : localSelected.values().next().value
          if (!name) return
          const entry = (focusedPane === 'remote' ? remote.entries : local.entries).find((candidate) => candidate.name === name)
          if (entry) {
            setRenameTarget({ pane: focusedPane, entry })
            setNameDraft(entry.name)
          }
        }}
        onDelete={() => deleteSelection(remoteSelected.size > 0 ? 'remote' : 'local')}
        onRefresh={() => (sftpId ? void listRemote(sftpId, remote.path, false) : undefined)}
        onToggleHidden={() => setShowHidden(!showHidden)}
      />
      <div className="rs-sftp__panes">
        <section className="rs-sftp__pane" data-pane="local">
          <header className="rs-sftp__panehead">
            <Icon name="folder" size={14} />
            <h3>{t('sftp.pane.local')}</h3>
            <Button variant="ghost" icon="chevron-right" title={t('sftp.path.up')} aria-label={t('sftp.path.up')} onClick={() => navigateLocal(upOneLocal())} />
          </header>
          <PathBar kind="local" path={local.path} history={local.history} drives={drives} onNavigate={navigateLocal} />
          <DropZone kind="local" dropHint={dragHint('local')} onDrop={(event) => handleDrop('local', event)}>
            {visibleLocal.length === 0 ? (
              <p className="rs-empty">{t('sftp.empty.folder')}</p>
            ) : (
              <FileTable
                entries={visibleLocal}
                selected={localSelected}
                sort={local.sort}
                dragKind="local"
                hiddenCount={local.entries.length - visibleLocal.length}
                onDragStarted={setDragging}
                onSelectChange={selectLocal}
                onSelectRange={selectRangeLocal}
                onOpen={(entry) => entry.type === 'dir' && navigateLocal(joinLocal(local.path, entry.name))}
                onSort={toggleSort('local')}
                onDropInto={(entry) => void beginTransfer('download', [...remoteSelected], joinLocal(local.path, entry.name))}
                onContextMenu={(event, entry) => openMenu(event, 'local', entry)}
              />
            )}
          </DropZone>
        </section>
        <aside className="rs-resizer rs-sftp__resizer" role="separator" aria-orientation="vertical" aria-label={t('sftp.pane.remote')} />
        <section className="rs-sftp__pane" data-pane="remote">
          <header className="rs-sftp__panehead">
            <Icon name="server" size={14} />
            <h3>{t('sftp.pane.remote')}</h3>
            <Button
              variant="ghost"
              icon="chevron-right"
              title={t('sftp.path.up')}
              aria-label={t('sftp.path.up')}
              disabled={!sftpId}
              onClick={() => navigateRemote(remote.path === '/' ? '/' : `${remote.path.replace(/\/[^/]*\/$/, '')}/`)}
            />
          </header>
          <PathBar kind="remote" path={remote.path} history={remote.history} onNavigate={navigateRemote} />
          <DropZone kind="remote" dropHint={dragHint('remote')} onDrop={(event) => handleDrop('remote', event)}>
            {loading ? <p className="rs-empty">{t('common.loading')}</p> : null}
            {!loading && visibleRemote.length === 0 ? <p className="rs-empty">{t('sftp.empty.folder')}</p> : null}
            {!loading && visibleRemote.length > 0 ? (
              <FileTable
                entries={visibleRemote}
                selected={remoteSelected}
                sort={remote.sort}
                dragKind="remote"
                hiddenCount={remote.entries.length - visibleRemote.length}
                onDragStarted={setDragging}
                onSelectChange={selectRemote}
                onSelectRange={selectRangeRemote}
                onOpen={(entry) => entry.type === 'dir' && navigateRemote(joinRemote(remote.path, entry.name))}
                onSort={toggleSort('remote')}
                onDropInto={(entry) => void beginTransfer('download', [...remoteSelected], joinRemote(remote.path, entry.name))}
                onContextMenu={(event, entry) => openMenu(event, 'remote', entry)}
              />
            ) : null}
          </DropZone>
        </section>
      </div>
      <footer className="rs-sftp__status">
        <span>{t('sftp.selection.count', { count: localSelected.size + remoteSelected.size })}</span>
        <span className="rs-sftp__status-spacer" />
        {errorPath !== null ? <span className="rs-danger">{errorPath}</span> : null}
      </footer>

      {menu !== null ? <div className="rs-sftp__mask" onMouseDown={closeMenu} /> : null}
      {menu !== null ? (
        <div className="rs-menu__list rs-sftp__ctxmenu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('sftp.context.properties')}>
          <button type="button" role="menuitem" className="rs-menu__item" disabled={menu.pane !== 'local' || localSelected.size === 0} onClick={() => { closeMenu(); void beginTransfer('upload', [...localSelected], remote.path) }}>
            {t('sftp.context.upload')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" disabled={menu.pane !== 'remote' || remoteSelected.size === 0} onClick={() => { closeMenu(); void beginTransfer('download', [...remoteSelected], local.path) }}>
            {t('sftp.context.download')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" onClick={() => { const pane = menu.pane; closeMenu(); setMkdirPane(pane); setNameDraft('') }}>
            {t('sftp.context.newFolder')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" disabled={!menu.entry} onClick={() => { const entry = menu.entry; const pane = menu.pane; closeMenu(); if (entry) { setRenameTarget({ pane, entry }); setNameDraft(entry.name) } }}>
            {t('sftp.toolbar.rename')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" disabled={!menu.entry} onClick={() => { const entry = menu.entry; closeMenu(); if (entry) void navigator.clipboard.writeText(entry.path) }}>
            {t('sftp.context.copyPath')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" onClick={() => { const pane = menu.pane; closeMenu(); deleteSelection(pane) }}>
            {t('sftp.toolbar.delete')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" onClick={() => { closeMenu(); if (sftpId) void listRemote(sftpId, remote.path, false) }}>
            {t('sftp.toolbar.refresh')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" disabled={!menu.entry} onClick={() => { const entry = menu.entry; closeMenu(); if (entry) setProperties({ entry }) }}>
            {t('sftp.context.properties')}
          </button>
        </div>
      ) : null}

      <Modal
        open={renameTarget !== null || mkdirPane !== null}
        title={mkdirPane !== null ? t('sftp.context.newFolder') : t('sftp.toolbar.rename')}
        onClose={closeNameModal}
        footer={
          <>
            <Button variant="secondary" onClick={closeNameModal}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={applyRename}>
              {t('common.ok')}
            </Button>
          </>
        }
      >
        {mkdirPane !== null ? <p className="rs-muted">{mkdirPane === 'remote' ? t('sftp.pane.remote') : t('sftp.pane.local')}</p> : null}
        <input
          className="rs-input"
          value={nameDraft}
          aria-label={mkdirPane !== null ? t('sftp.context.newFolder') : t('sftp.toolbar.rename')}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyRename()
          }}
        />
      </Modal>

      <Modal open={properties !== null} title={t('sftp.context.properties')} onClose={() => setProperties(null)}>
        {properties ? (
          <dl className="rs-kv">
            <dt>{t('sftp.column.name')}</dt>
            <dd>{properties.entry.name}</dd>
            <dt>{t('sftp.property.size')}</dt>
            <dd>{properties.entry.type === 'dir' ? t('common.none') : formatSize(properties.entry.size)}</dd>
            <dt>{t('sftp.property.mtime')}</dt>
            <dd>{formatMtime(properties.entry.mtimeMs)}</dd>
            <dt>{t('sftp.property.owner')}</dt>
            <dd>{[properties.entry.owner, properties.entry.group].filter(Boolean).join(' ') || t('common.unknown')}</dd>
            <dt>{t('sftp.property.permission')}</dt>
            <dd className="rs-mono">{properties.entry.mode !== undefined ? properties.entry.mode.toString(8) : t('common.unknown')}</dd>
          </dl>
        ) : null}
      </Modal>

      <ConflictDialog
        open={conflicts !== null}
        items={conflicts?.items ?? []}
        onResolve={resolveConflicts}
        onCancel={() => setConflicts(null)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('sftp.toolbar.delete')}
        message={t('sftp.delete.confirm', { count: pendingDelete?.names.length ?? 0 })}
        confirmLabel={t('common.delete')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) performDelete(target.pane, target.names)
        }}
      />
    </div>
  )
}
