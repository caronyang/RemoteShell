import type { KeyboardEvent, MouseEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SftpEntry } from '../../../shared/ipc-contract'
import { Icon } from '../../components/Icon'
import { formatMode, formatMtime, formatSize } from './format'
import { COLUMN_MIN_WIDTHS, COLUMN_WIDTH_MAX, useSftpColumnWidths, type SftpColumnKey } from './useSftpColumnWidths'

export type SortKey = 'name' | 'size' | 'mtime'
export interface SortState {
  key: SortKey
  asc: boolean
}

export interface FileTableProps {
  entries: SftpEntry[]
  selected: ReadonlySet<string>
  sort: SortState
  /* 拖放（F-2）：本面板作為來源時提供項目；作為目的地由 DropZone 處理 */
  dragKind: 'local' | 'remote'
  hiddenCount: number
  onDragStarted?: (payload: DragPayload | null) => void
  onSelectChange: (selected: string[], last: string) => void
  onSelectRange: (toName: string, additive: boolean) => void
  onOpen: (entry: SftpEntry) => void
  onSort: (key: SortKey) => void
  onDropInto: (entry: SftpEntry) => void
  onContextMenu: (event: MouseEvent, entry: SftpEntry | null) => void
}

export const DRAG_MIME = 'application/x-remoteshell-transfer'

export interface DragPayload {
  kind: 'local' | 'remote'
  names: string[]
}

interface HeaderColumn {
  key: SftpColumnKey
  label: string
  /** 缺設 = 不可排序欄（權限）；定義了就掛排序按鈕與 aria-sort */
  sortKey?: SortKey
}

interface ColumnResizerProps {
  columnKey: SftpColumnKey
  label: string
  width: number
  onPreview: (key: SftpColumnKey, width: number) => void
  onCommit: (key: SftpColumnKey, width: number) => void
  onReset: (key: SftpColumnKey) => void
}

/**
 * v0.1.4 #8：表頭欄寬拖曳把手。
 * 滑鼠拖曳（document 監聽，拖出面板外放開也收尾）／方向鍵 ±10px（Shift ±1、Home/End 錨到上下限）／
 * 雙擊回預設；落盤（settings.ui.sftpColumns）由 useSftpColumnWidths 統一處理。
 */
function ColumnResizer({ columnKey, label, width, onPreview, onCommit, onReset }: ColumnResizerProps): JSX.Element {
  const { t } = useTranslation()

  const startDrag = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    let moved = false
    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      moved = true
      onPreview(columnKey, startWidth + (moveEvent.clientX - startX))
    }
    const onUp = (upEvent: globalThis.MouseEvent): void => {
      if (moved) onCommit(columnKey, startWidth + (upEvent.clientX - startX))
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const step = event.shiftKey ? 1 : 10
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onCommit(columnKey, width - step)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onCommit(columnKey, width + step)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onCommit(columnKey, COLUMN_MIN_WIDTHS[columnKey])
    } else if (event.key === 'End') {
      event.preventDefault()
      onCommit(columnKey, COLUMN_WIDTH_MAX)
    }
  }

  return (
    <button
      type="button"
      className="rs-sftp__colresizer"
      aria-label={t('sftp.column.resize', { column: label })}
      title={t('sftp.column.resizeHint')}
      onMouseDown={startDrag}
      onDoubleClick={() => onReset(columnKey)}
      onKeyDown={onKeyDown}
    />
  )
}

/**
 * 檔案列表（UI-03 §面板規格）：名稱 / 大小 / 修改日期可排序；單選、多選 Ctrl、
 * 連續選取 Shift（連續 = 目前列表可見順序，含隱藏檔與否以 entries 為準）。
 * 資料夾優先排序在 DualPane 統一處理。
 */
export function FileTable({
  entries,
  selected,
  sort,
  dragKind,
  hiddenCount,
  onDragStarted,
  onSelectChange,
  onSelectRange,
  onOpen,
  onSort,
  onDropInto,
  onContextMenu
}: FileTableProps): JSX.Element {
  const { t } = useTranslation()
  const { widths, previewWidth, commitWidth, resetWidth } = useSftpColumnWidths()
  /* UI-03 v1.2：拖放目標資料夾列要高亮（class 給 CSS；不影響拖放 payload 邏輯） */
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const cell = (event: MouseEvent, entry: SftpEntry): void => {
    if (event.shiftKey) {
      onSelectRange(entry.name, event.ctrlKey || event.metaKey)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected)
      if (next.has(entry.name)) next.delete(entry.name)
      else next.add(entry.name)
      onSelectChange([...next], entry.name)
      return
    }
    onSelectChange([entry.name], entry.name)
  }

  const sortIcon = (key: SortKey): 'chevron-down' | 'chevron-right' | undefined =>
    sort.key === key ? (sort.asc ? 'chevron-down' : 'chevron-right') : undefined

  /* v0.1.4 #7＋主管裁定1：權限欄——遠端顯示 POSIX mode；本機（Windows）無 mode 資料
     不硬造數字，用 — 佔位並附 title/aria-label 說明，欄位對齊但不假造資料 */
  const modeCell = (entry: SftpEntry): JSX.Element => {
    if (entry.mode === undefined) {
      const hint = t('sftp.property.permissionUnavailable')
      return (
        <td className="rs-sftp__mode" title={hint} aria-label={hint}>
          —
        </td>
      )
    }
    return <td className="rs-sftp__mode">{formatMode(entry.mode)}</td>
  }

  /* v0.1.4 #7：欄序固定 名稱 → 權限 → 修改日期 → 大小（權限非排序欄）；
     #8：四欄皆可拖曳調寬，寬度套用 settings.ui.sftpColumns（useSftpColumnWidths） */
  const headers: HeaderColumn[] = [
    { key: 'name', label: t('sftp.column.name'), sortKey: 'name' },
    { key: 'permissions', label: t('sftp.property.permission') },
    { key: 'mtime', label: t('sftp.column.mtime'), sortKey: 'mtime' },
    { key: 'size', label: t('sftp.column.size'), sortKey: 'size' }
  ]

  /* 欄寬總和：大於面板時水平捲動（dropzone overflow: auto），小於面板時表格仍 100% */
  const columnsWidth = headers.reduce((total, column) => total + widths[column.key], 0)

  const headerCell = (column: HeaderColumn): JSX.Element => {
    const { key, label, sortKey } = column
    return (
      <th
        key={key}
        /* 表頭含互動子項（排序鈕／拖曳把手）→ 明示 aria-label 保持可及名稱＝欄名 */
        aria-label={label}
        aria-sort={
          sortKey === undefined
            ? undefined
            : sort.key === sortKey
              ? (sort.asc ? 'ascending' : 'descending')
              : 'none'
        }
      >
        {sortKey === undefined ? (
          label
        ) : (
          <button type="button" className="rs-sftp__sort" onClick={() => onSort(sortKey)}>
            {label}
            {sortIcon(sortKey) ? <Icon name={sortIcon(sortKey)!} size={10} /> : null}
          </button>
        )}
        <ColumnResizer
          columnKey={key}
          label={label}
          width={widths[key]}
          onPreview={previewWidth}
          onCommit={commitWidth}
          onReset={resetWidth}
        />
      </th>
    )
  }

  return (
    <table
      className="rs-table rs-sftp__table"
      aria-rowcount={entries.length + hiddenCount}
      /* 340 = .rs-sftp__table 既有 min-width 下限；欄寬總和較大時以總和為準 */
      style={{ minWidth: Math.max(340, columnsWidth) }}
    >
      <colgroup>
        {headers.map((column) => (
          <col key={column.key} style={{ width: `${widths[column.key]}px` }} />
        ))}
      </colgroup>
      <thead>
        <tr>{headers.map((column) => headerCell(column))}</tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr
            key={entry.name}
            className={
              [selected.has(entry.name) ? 'is-selected' : null, dropTarget === entry.name ? 'is-drop-target' : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            tabIndex={0}
            aria-selected={selected.has(entry.name)}
            onClick={(event) => cell(event, entry)}
            onDoubleClick={() => onOpen(entry)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onOpen(entry)
            }}
            onContextMenu={(event) => onContextMenu(event, entry)}
            draggable
            onDragStart={(event) => {
              const names = selected.has(entry.name) ? [...selected] : [entry.name]
              const payload: DragPayload = { kind: dragKind, names }
              event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
              event.dataTransfer.effectAllowed = 'copy'
              onDragStarted?.(payload)
            }}
            onDragEnd={() => {
              setDropTarget(null)
              onDragStarted?.(null)
            }}
            onDragEnter={entry.type === 'dir' ? () => setDropTarget(entry.name) : undefined}
            onDragLeave={
              entry.type === 'dir'
                ? () => setDropTarget((current) => (current === entry.name ? null : current))
                : undefined
            }
            onDragOver={entry.type === 'dir' ? (event) => event.preventDefault() : undefined}
            onDrop={
              entry.type === 'dir'
                ? (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setDropTarget(null)
                    onDropInto(entry)
                  }
                : undefined
            }
          >
            <td className="rs-sftp__name">
              <span className="rs-sftp__icon">
                {entry.type === 'dir' ? <Icon name="folder" size={14} /> : null}
              </span>
              <span className="rs-tree__label" title={entry.name}>{entry.name}</span>
            </td>
            {modeCell(entry)}
            <td>{formatMtime(entry.mtimeMs)}</td>
            <td>{entry.type === 'dir' ? '' : formatSize(entry.size)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
