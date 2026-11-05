import { useTranslation } from 'react-i18next'
import type { MouseEvent } from 'react'
import type { TransferState, TransferTask } from '../../../shared/ipc-contract'
import { formatEta, formatSize, formatSpeed } from '../sftp/format'

export type QueueAction =
  | 'cancel' | 'retry' | 'remove' | 'pause' | 'resume'
  | 'moveUp' | 'moveDown'
  | 'openFolder' | 'copySourcePath' | 'copyTargetPath' | 'errorDetails'

/** 目錄任務的子列型別 = contract 原生 children（v1.11，含 taskId） */
export type QueueChildEntry = NonNullable<TransferTask['children']>[number]

export interface QueueRowProps {
  task: TransferTask
  /** 目錄父列的 children 顯示狀態（由 QueuePanel 以 taskId 記憶） */
  expanded: boolean
  onToggleExpand: (taskId: string) => void
  onRequest: (action: QueueAction, task: TransferTask) => void
  onContextMenu: (event: MouseEvent, task: TransferTask) => void
}

/** 狀態 -> class（顏色+圖示+文字三重表達；顏色僅 tokens class） */
const STATE_META: Record<TransferState, { icon: 'info' | 'transfer' | 'check' | 'warning' | 'close'; className: string }> = {
  queued: { icon: 'info', className: 'is-queued' },
  running: { icon: 'transfer', className: 'is-running' },
  paused: { icon: 'warning', className: 'is-paused' },
  completed: { icon: 'check', className: 'is-completed' },
  failed: { icon: 'warning', className: 'is-failed' },
  cancelled: { icon: 'close', className: 'is-cancelled' }
}

const STATUS_KEY: Record<TransferState, string> = {
  queued: 'queue.statusQueued',
  running: 'queue.statusRunning',
  paused: 'queue.statusPaused',
  completed: 'queue.statusCompleted',
  failed: 'queue.statusFailed',
  cancelled: 'queue.statusCancelled'
}

/** Q4 依 UI-04：按鈕 = 依狀態顯示（取消/暫停/繼續/重試/移除）；其餘走右鍵選單 */
function rowActions(task: TransferTask): QueueAction[] {
  switch (task.state) {
    case 'queued':
      return ['cancel', 'remove']
    case 'running':
      return ['pause', 'cancel']
    case 'paused':
      return ['resume', 'cancel']
    case 'failed':
      return ['retry', 'openFolder', 'remove']
    case 'completed':
      return ['openFolder', 'remove']
    case 'cancelled':
      return ['retry', 'remove']
  }
}

/** 目錄任務的子列（契約 v1.11）：縮排顯示、無操作欄 */
export function QueueChildRow({ child }: { child: QueueChildEntry }): JSX.Element {
  const { t } = useTranslation()
  const meta = STATE_META[child.state]
  return (
    <tr className="rs-queue__child">
      <td className={`rs-queue__dir ${meta.className}`} />
      <td title={child.source}>{child.source}</td>
      <td title={child.target}>{child.target}</td>
      <td>{formatSize(child.size)}</td>
      <td className="rs-muted">{t('queue.speedNA')}</td>
      <td />
      <td className={meta.className}>{t(STATUS_KEY[child.state])}</td>
      <td />
      <td />
    </tr>
  )
}

/** UI-04 表格一列：七欄＋操作欄；目錄父列彙總進度＋展開 children */
export function QueueRow({ task, expanded, onToggleExpand, onRequest, onContextMenu }: QueueRowProps): JSX.Element {
  const { t } = useTranslation()
  const meta = STATE_META[task.state]
  const totalBytes = task.totalBytes
  const percent = totalBytes ? Math.min(100, Math.round((task.transferredBytes / totalBytes) * 100)) : null
  const unknownTotal = totalBytes === null || totalBytes === undefined
  const children = task.children ?? []
  const isDirectoryList = task.isDirectory && children.length > 0
  const doneChildren = children.filter((child) => child.state === 'completed').length

  return (
    <tr onContextMenu={(event) => onContextMenu(event, task)}>
      <td className={`rs-queue__dir ${task.direction === 'upload' ? 'is-upload' : 'is-download'}`}>
        <span aria-hidden="true">{task.direction === 'upload' ? '\u2191' : '\u2193'}</span>
        <span className="rs-queue__dirtext">{t(task.direction === 'upload' ? 'queue.directionUpload' : 'queue.directionDownload')}</span>
      </td>
      <td title={task.source}>
        {isDirectoryList ? (
          <button
            type="button"
            className="rs-queue__expand"
            aria-expanded={expanded}
            aria-label={task.source}
            onClick={() => onToggleExpand(task.taskId)}
          >
            {expanded ? '\u25BE' : '\u25B8'}
          </button>
        ) : null}
        {task.source}
      </td>
      <td title={task.target}>{task.target}</td>
      <td className="rs-queue__progress">
        <span className="rs-queue__bar" aria-hidden="true">
          <span className="rs-queue__barfill" style={{ width: `${percent ?? 0}%` }} />
        </span>
        <span className="rs-queue__barnum">
          {/* 目錄父列彙總：百分比 + 已完成檔數/總檔數（數字組合，無需 i18n key） */}
          {isDirectoryList
            ? `${percent ?? 0}% \u00B7 ${doneChildren}/${children.length}`
            : unknownTotal
              ? t('queue.progress.unknownTotal', { done: formatSize(task.transferredBytes) })
              : `${percent ?? 0}%`}
        </span>
      </td>
      <td>
        {task.state === 'running' ? formatSpeed(task.bytesPerSec) : <span className="rs-muted">{t('queue.speedNA')}</span>}
      </td>
      <td>
        {task.state === 'running' ? (formatEta(task.etaSec) ?? t('queue.etaCalculating')) : ''}
      </td>
      <td className={meta.className} title={task.state === 'failed' && task.error?.detail ? task.error.detail : undefined}>
        {t(STATUS_KEY[task.state])}
        {task.needsRetransfer ? <span className="rs-queue__retransfer">{t('queue.needRetry')}</span> : null}
        {task.state === 'failed' && task.error ? (
          <div className="rs-queue__err">
            <span className="rs-danger">{t(task.error.i18nKey)}</span>
            <button type="button" className="rs-link" onClick={() => onRequest('errorDetails', task)}>
              {t('queue.action.errorDetails')}
            </button>
          </div>
        ) : null}
      </td>
      <td className="rs-queue__actions">
        {rowActions(task).map((action) => (
          <button key={action} type="button" onClick={() => onRequest(action, task)}>
            {t(`queue.action.${action}`)}
          </button>
        ))}
      </td>
      <td className="rs-queue__conn">
        {task.connectionLabel}
      </td>
    </tr>
  )
}
