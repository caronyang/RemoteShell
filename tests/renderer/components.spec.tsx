import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import { Modal } from '../../src/renderer/components/Modal'
import { Table } from '../../src/renderer/components/Table'
import { initI18n } from '../../src/renderer/i18n'

// Modal 關閉鈕 aria-label 走 t('common.close')（M4 i18n 修正），測試需提供 i18n
const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>

// RTL 的自動清理需要 globals:true；本專案不開 globals，因此手動 cleanup
afterEach(() => cleanup())

describe('M2-05 Modal（焦點陷阱 + ESC）', () => {
  it('開啟時焦點落在第一個可聚焦元素', () => {
    render(
      wrap(
        <Modal open title="Confirm" onClose={() => undefined}>
          <input aria-label="first" />
          <button type="button">second</button>
        </Modal>
      )
    )
    expect(document.activeElement).toBe(screen.getByLabelText('first'))
  })

  it('Tab 在最後一個元素時回到第一個、Shift+Tab 反向（焦點不會跑到對話框外）', () => {
    render(
      wrap(
        <Modal open title="Confirm" onClose={() => undefined}>
          <input aria-label="first" />
          <button type="button">second</button>
        </Modal>
      )
    )
    // DOM 順序：Close（標題列）→ first → second
    const closeButton = screen.getByLabelText('Close')
    const first = screen.getByLabelText('first')
    const second = screen.getByText('second')

    second.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton)

    closeButton.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(second)

    // 中間的元素不受攔截
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('ESC 會呼叫 onClose，且不渲染時回 null', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      wrap(
        <Modal open title="Confirm" onClose={onClose}>
          <input aria-label="first" />
        </Modal>
      )
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      wrap(
        <Modal open={false} title="Confirm" onClose={onClose}>
          <input aria-label="first" />
        </Modal>
      )
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /* v0.1.9 #3：onClose inline arrow 每次 re-render 都換 identity，不可因此重設焦點 */
  it('v0.1.9 #3：輸入連續打字時 focus 不會被搶回第一個元素（頁籤）', () => {
    function TypingHost(): JSX.Element {
      const [value, setValue] = useState('')
      return (
        <Modal open title="Edit" onClose={() => undefined}>
          <button type="button">General</button>
          <input aria-label="host" value={value} onChange={(event) => setValue(event.target.value)} />
        </Modal>
      )
    }

    render(wrap(<TypingHost />))
    const input = screen.getByLabelText('host') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'a' } })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'ab' } })
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('ab')
  })

  it('v0.1.9 #3：Modal 父層 re-render／onClose 換 identity 不重設焦點', () => {
    const { rerender } = render(
      wrap(
        <Modal open title="Edit" onClose={() => undefined}>
          <button type="button">General</button>
          <input aria-label="host" />
        </Modal>
      )
    )
    const input = screen.getByLabelText('host')
    input.focus()

    rerender(
      wrap(
        <Modal open title="Edit (rerender)" onClose={() => undefined}>
          <button type="button">General</button>
          <input aria-label="host" />
        </Modal>
      )
    )
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Edit (rerender)')
    expect(document.activeElement).toBe(screen.getByLabelText('host'))
  })

  it('v0.1.9 #3：Modal 首次 mount 就是 open → 關閉後焦點回觸發元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'launcher'
    document.body.appendChild(trigger)
    trigger.focus()

    const { rerender } = render(
      wrap(
        <Modal open title="Edit" onClose={() => undefined}>
          <input aria-label="host" />
        </Modal>
      )
    )
    expect(document.activeElement).toBe(screen.getByLabelText('host'))

    rerender(
      wrap(
        <Modal open={false} title="Edit" onClose={() => undefined}>
          <input aria-label="host" />
        </Modal>
      )
    )
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})

describe('M2-05 Table（排序委派 + 選取 + 空狀態）', () => {
  interface Row {
    id: string
    name: string
    size: number
  }
  const rows: Row[] = [
    { id: 'a', name: 'alpha', size: 10 },
    { id: 'b', name: 'beta', size: 20 }
  ]
  const columns = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (row: Row) => row.name
    },
    { key: 'size', header: 'Size', align: 'right' as const, render: (row: Row) => row.size }
  ]

  it('點同一欄位會 asc → desc 切換（排序狀態由呼叫端持有）', () => {
    const onSortChange = vi.fn()
    const { rerender } = render(
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} onSortChange={onSortChange} />
    )
    fireEvent.click(screen.getByText('Name'))
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', direction: 'asc' })

    rerender(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={onSortChange}
      />
    )
    fireEvent.click(screen.getByText('Name'))
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', direction: 'desc' })
  })

  it('aria-sort 會反映目前排序', () => {
    render(
      <Table
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ key: 'name', direction: 'desc' }}
        onSortChange={() => undefined}
      />
    )
    const header = screen.getByRole('columnheader', { name: /Name/ })
    expect(header.getAttribute('aria-sort')).toBe('descending')
  })

  it('列可選取（回傳整個 row）與空狀態文字', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <Table columns={columns} rows={rows} rowKey={(r) => r.id} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByText('beta'))
    expect(onSelect).toHaveBeenCalledWith(rows[1])

    rerender(<Table columns={columns} rows={[]} rowKey={(r) => r.id} emptyLabel="No files" />)
    expect(screen.getByText('No files')).toBeTruthy()
  })
})
