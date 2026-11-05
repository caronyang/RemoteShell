import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TransferTask } from '../../../shared/ipc-contract'
import { useToast } from '../../components/Toast'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { formatSpeed } from '../sftp/format'
import { Badge } from './Badge'
import { QueueChildRow, QueueRow, type QueueAction } from './QueueRow'

export interface QueuePanelProps {
  collapsed: boolean
  /** 展開高度（200–500px），來自 settings.ui.queueHeight */
  height: number
  onToggle: () => void
  /** 拖曳調整高度（commit=true 時持久化） */
  onHeightChange: (height: number, commit: boolean) => void
  tasks: TransferTask[]
  onRequest: (action: QueueAction, task: TransferTask) => void
  onClearCompleted: () => void
}

const COLUMNS = ['queue.column.direction', 'queue.column.source', 'queue.column.target', 'queue.column.progress', 'queue.column.speed', 'queue.column.eta', 'queue.column.status', 'queue.column.actions', 'queue.column.connection']

/** M3-07 傳輸佇列面板（UI-04）：收合 28px 主列＋徽章＋整體速度；展開 200px 可拖至 500px */
export function QueuePanel({ collapsed, height, onToggle, onHeightChange, tasks, onRequest, onClearCompleted }: QueuePanelProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number; task: TransferTask } | null>(null)  /* 目錄父列的 children 顯示狀態：以 taskId 記憶，重繪/更新不會收起 */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  /* v0.1.4：Clear all 是破壞性操作，改用 App 內 ConfirmDialog（不再用 window.confirm 阻塞 renderer） */
  const [confirmClear, setConfirmClear] = useState(false)
  /* P1-07：拖曳期間的本地預覽高度（prop 只在 commit 後才更新，用它做視覺回饋） */
  const [dragPreview, setDragPreview] = useState<number | null>(null)
  const dragRef = useRef<{ startY: number; startHeight: number; preview: number } | null>(null)
  const effectiveHeight = dragPreview ?? height
  /* commit 後 settings prop 追上預覽值 → 交回 prop（避免放開瞬間彈回舊高度） */
  useEffect(() => {
    setDragPreview(null)
  }, [height])

  const running = useMemo(() => tasks.filter((task) => task.state === 'running'), [tasks])
  const activeCount = useMemo(
    () => tasks.filter((task) => task.state === 'running' || task.state === 'queued').length,
    [tasks]
  )
  /* 契約 v1.11：斷線橫幅的 N = 暫停中的任務數（不含 completed/cancelled） */
  const pausedCount = useMemo(() => tasks.filter((task) => task.state === 'paused').length, [tasks])
  const totalSpeed = running.reduce((sum, task) => sum + (Number.isFinite(task.bytesPerSec) ? task.bytesPerSec : 0), 0)

  const toggleExpand = useCallback((taskId: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])
  const openMenu = (event: MouseEvent, task: TransferTask): void => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, task })
  }

  useEffect(() => {
    if (!menu) return undefined
    return undefined
  }, [menu])

  const menuItems: Array<{ action: QueueAction; label: string; disabled?: boolean }> = menu
    ? [
        ...(menu.task.state === 'running' ? [{ action: 'pause' as QueueAction, label: t('queue.action.pause') }] : []),
        ...(menu.task.state === 'paused' ? [{ action: 'resume' as QueueAction, label: t('queue.action.resume') }] : []),
        ...(menu.task.state === 'running' || menu.task.state === 'queued' ? [{ action: 'cancel' as QueueAction, label: t('queue.action.cancel') }] : []),
        ...(menu.task.state === 'failed' || menu.task.state === 'cancelled' ? [{ action: 'retry' as QueueAction, label: t('queue.action.retry') }] : []),
        { action: 'openFolder', label: t('queue.action.openFolder'), disabled: menu.task.state !== 'completed' && menu.task.state !== 'failed' },
        { action: 'moveUp', label: t('queue.action.moveUp') },
        { action: 'moveDown', label: t('queue.action.moveDown') },
        { action: 'copySourcePath', label: t('queue.action.copySourcePath') },
        { action: 'copyTargetPath', label: t('queue.action.copyTargetPath') },
        { action: 'errorDetails', label: t('queue.action.errorDetails'), disabled: menu.task.state !== 'failed' },
        { action: 'remove', label: t('queue.action.remove') }
      ]
    : []

  const clearAll = (): void => {
    for (const task of tasks) {
      if (task.state === 'running' || task.state === 'queued') onRequest('cancel', task)
      onRequest('remove', task)
    }
    setConfirmClear(false)
  }

  return (
    <>
    <section className={`rs-queue${collapsed ? ' is-collapsed' : ''}`} aria-label={t('queue.title')}>
      <div className="rs-queue__head">
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="rs-queue__toggle">
          <span aria-hidden="true" className={`rs-queue__twisty${collapsed ? ' is-collapsed' : ''}`}>{'\u25B8'}</span>
          <span>{t('queue.title')}</span>
          <Badge count={activeCount} />
          {running.length > 0 ? <span className="rs-queue__speed">{formatSpeed(totalSpeed)}</span> : null}
        </button>
        {!collapsed ? (
          <div className="rs-queue__head-actions">
            <button type="button" className="rs-link" onClick={onClearCompleted}>
              {t('queue.clearFinished')}
            </button>
            <button
              type="button"
              className="rs-link"
              onClick={() => {
                if (tasks.length === 0) return
                if (running.length === 0) {
                  clearAll()
                  return
                }
                setConfirmClear(true)
              }}
            >
              {t('queue.clearAll')}
            </button>
          </div>
        ) : null}
      </div>
      {collapsed ? null : (
        <>
          {/* 契約 v1.11：斷線橫幅 N = 暫停中任務數（paused，不含 completed/cancelled） */}
          {pausedCount > 0 ? (
            <p className="rs-queue__interrupted" role="status">
              {t('queue.interrupted', { count: pausedCount })}
              <button type="button" className="rs-link" onClick={() => tasks.filter((task) => task.state === 'paused').forEach((task) => onRequest('retry', task))}>
                {t('queue.interrupted.reconnect')}
              </button>
            </p>
          ) : null}
          <div
            className="rs-queue__resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('queue.title')}
            onMouseDown={(event) => {
              /* P1-07：拖曳期間以 local state 預覽（即時視覺回饋），pointerup 才 commit 最後位置 */
              dragRef.current = { startY: event.clientY, startHeight: effectiveHeight, preview: effectiveHeight }
              const move = (moveEvent: globalThis.MouseEvent): void => {
                const drag = dragRef.current
                if (!drag) return
                /* 拖曳範圍 120–500（主管裁示；載入端同範圍 clamp） */
                drag.preview = Math.max(120, Math.min(500, drag.startHeight + (moveEvent.clientY - drag.startY)))
                setDragPreview(drag.preview)
              }
              const up = (): void => {
                window.removeEventListener('mousemove', move)
                window.removeEventListener('mouseup', up)
                const final = dragRef.current?.preview ?? dragRef.current?.startHeight ?? null
                dragRef.current = null
                /* 保留預覽值：等 settings prop 追上（useEffect [height]）再交回，避免瞬間彈回 */
                if (final !== null) setDragPreview(final)
                if (final !== null && final !== height) onHeightChange(final, true)
              }
              window.addEventListener('mousemove', move)
              window.addEventListener('mouseup', up)
              event.preventDefault()
            }}
          />
          <div className="rs-queue__body" style={{ height: effectiveHeight }}>
            {tasks.length === 0 ? (
              <p className="rs-empty">{t('queue.empty')}</p>
            ) : (
              <div className="rs-table__wrap">
                <table className="rs-table rs-queue__table">
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => (
                        <th key={column}>{t(column)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.flatMap((task) => [
                      <QueueRow
                        key={task.taskId}
                        task={task}
                        expanded={expandedIds.has(task.taskId)}
                        onToggleExpand={toggleExpand}
                        onRequest={onRequest}
                        onContextMenu={openMenu}
                      />,
                      ...(task.isDirectory && (task.children?.length ?? 0) > 0 && expandedIds.has(task.taskId)
                        ? task.children?.map((child, i) => (
                            <QueueChildRow key={`${task.taskId}:${child.source}:${i}`} child={child} />
                          )) ?? []
                        : [])
                    ])}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {menu !== null ? <div className="rs-sftp__mask" onMouseDown={closeMenu} /> : null}
      {menu !== null ? (
        <div className="rs-menu__list rs-sftp__ctxmenu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('queue.title')}>
          {menuItems
            .filter((item) => !item.disabled)
            .map((item) => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                className="rs-menu__item"
                onClick={() => {
                  const task = menu.task
                  closeMenu()
                  if (item.action === 'copySourcePath' || item.action === 'copyTargetPath') {
                    void navigator.clipboard.writeText(item.action === 'copySourcePath' ? task.source : task.target)
                  } else if (item.action === 'errorDetails') {
                    toast.show(task.error ? t(task.error.i18nKey) + (task.error.detail ? ` ${task.error.detail}` : '') : '', 'error', 8000)
                  } else {
                    onRequest(item.action, task)
                  }
                }}
              >
                {item.label}
              </button>
            ))}
        </div>
      ) : null}
    </section>
    <ConfirmDialog
      open={confirmClear}
      title={t('queue.clearAllConfirm.title')}
      message={t('queue.clearAllConfirm.message', { count: running.length })}
      confirmLabel={t('common.ok')}
      onCancel={() => setConfirmClear(false)}
      onConfirm={clearAll}
    />
    </>
  )
}
