import type { ReactNode } from 'react'

export interface TableColumn<Row> {
  key: string
  header: string
  width?: number | string
  align?: 'left' | 'right' | 'center'
  /** 提供 onSortChange 時，此欄可點擊排序 */
  sortable?: boolean
  render: (row: Row) => ReactNode
}

export interface TableSort {
  key: string
  direction: 'asc' | 'desc'
}

export interface TableProps<Row> {
  columns: Array<TableColumn<Row>>
  rows: Row[]
  rowKey: (row: Row) => string
  emptyLabel?: string
  selectedKey?: string | null
  onSelect?: (row: Row) => void
  /** 排序狀態由呼叫端持有（元件本身不排序，保持 dumb） */
  sort?: TableSort | null
  onSortChange?: (sort: TableSort) => void
}

/** 表格列高固定 --density-table-row（28px）；欄寬以 <colgroup> 控制 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  emptyLabel,
  selectedKey,
  onSelect,
  sort,
  onSortChange
}: TableProps<Row>): JSX.Element {
  const toggleSort = (key: string): void => {
    if (!onSortChange) return
    const nextDirection = sort && sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc'
    onSortChange({ key, direction: nextDirection })
  }

  if (rows.length === 0) {
    return <p className="rs-empty">{emptyLabel}</p>
  }
  return (
    <div className="rs-table__wrap">
      <table className="rs-table">
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key
              const ariaSort = active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none'
              return (
                <th
                  key={column.key}
                  scope="col"
                  style={{ textAlign: column.align ?? 'left' }}
                  aria-sort={column.sortable ? ariaSort : undefined}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      className={`rs-table__sort${active ? ' is-active' : ''}`}
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.header}
                      <span aria-hidden="true">{active ? (sort?.direction === 'asc' ? '▲' : '▼') : '↕'}</span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            return (
              <tr
                key={key}
                aria-selected={selectedKey === key}
                className={selectedKey === key ? 'is-selected' : undefined}
                onClick={() => onSelect?.(row)}
              >
                {columns.map((column) => (
                  <td key={column.key} style={{ textAlign: column.align ?? 'left' }}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
