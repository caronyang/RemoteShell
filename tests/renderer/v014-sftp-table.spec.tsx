import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { SftpColumnWidths, SftpEntry } from '../../src/shared/ipc-contract'
import { initI18n } from '../../src/renderer/i18n'
import { FileTable, type SortState } from '../../src/renderer/features/sftp/FileTable'
import { formatMode } from '../../src/renderer/features/sftp/format'

afterEach(() => {
  cleanup()
  /* #8：每個測試自帶 settings mock；清掉避免殘留給同檔其他 describe */
  delete (window as { rs?: unknown }).rs
})

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>

const sort: SortState = { key: 'name', asc: true }
const baseProps = {
  selected: new Set<string>(),
  sort,
  dragKind: 'remote' as const,
  hiddenCount: 0,
  onSelectChange: () => undefined,
  onSelectRange: () => undefined,
  onOpen: () => undefined,
  onSort: () => undefined,
  onDropInto: () => undefined,
  onContextMenu: () => undefined
}

const entry = (over: Partial<SftpEntry>): SftpEntry => ({
  name: 'a.txt',
  path: '/home/u/a.txt',
  type: 'file',
  size: 10,
  mtimeMs: 1730000000000,
  isSymlink: false,
  ...over
})

const readRule = (file: string, selector: string): string => {
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles', file), 'utf8').replace(/\s+/g, ' ')
  const normalized = selector.replace(/\s+/g, ' ')
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (!match || match[1] === undefined) throw new Error(`rule not found: ${selector}`)
  return match[1]
}

const token = (name: string): string => {
  const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles', 'tokens.css'), 'utf8')
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))
  if (!match || match[1] === undefined) throw new Error(`token not found: ${name}`)
  return match[1]
}

const luminance = (hex: string): number => {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const contrast = (a: string, b: string): number => {
  const l1 = luminance(a)
  const l2 = luminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

describe('v0.1.4 #7 SFTP 表格欄序與權限欄', () => {
  it('欄序為 名稱 → 權限 → 修改日期 → 大小；權限欄不可排序（無按鈕、無 aria-sort）', () => {
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    const headers = [...document.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim())
    expect(headers).toEqual(['Name', 'Permissions', 'Modified', 'Size'])
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Permissions' }).hasAttribute('aria-sort')).toBe(false)
  })

  it('資料列順序為 檔名 / 權限 / 修改日期 / 大小', () => {
    render(
      wrap(
        <FileTable
          entries={[entry({ name: 'dir', type: 'dir', mode: 0o40755 })]}
          {...baseProps}
        />
      )
    )
    const cells = [...document.querySelectorAll('tbody tr td')].map((td) => (td.textContent ?? '').trim())
    expect(cells).toEqual(['dir', 'drwxr-xr-x', new Date(1730000000000).toLocaleString(), ''])
  })

  it('mode 缺省（本機面板）→ — 佔位＋title/aria-label 說明（主管裁定1：不硬造 POSIX mode）', () => {
    render(wrap(<FileTable entries={[entry({ name: 'local.txt' })]} {...baseProps} />))
    const cell = document.querySelectorAll('tbody tr td')[1]!
    expect(cell.textContent).toBe('—')
    const hint = 'POSIX permissions not available on local Windows files'
    expect(cell.getAttribute('title')).toBe(hint)
    expect(cell.getAttribute('aria-label')).toBe(hint)
  })

  it('formatMode：目錄／檔案／符號連結／setuid／無效值', () => {
    expect(formatMode(0o40755)).toBe('drwxr-xr-x')
    expect(formatMode(0o100644)).toBe('-rw-r--r--')
    expect(formatMode(0o120777)).toBe('lrwxrwxrwx')
    expect(formatMode(0o104755)).toBe('-rwsr-xr-x')
    expect(formatMode(0o100000)).toBe('----------')
    expect(formatMode(Number.NaN)).toBe('')
    expect(formatMode(-1)).toBe('')
  })
})

describe('v0.1.4 #6 SFTP 面板用色（終端前景色不得洩漏到白底面板）', () => {
  it('.rs-sftp__view 呼叫端宣告 color: var(--text)（根因：外層 .rs-terminal 是 --terminal-fg）', () => {
    const view = readRule('base.css', '.rs-sftp__view')
    expect(view).toContain('color: var(--text)')
    expect(readRule('base.css', '.rs-terminal')).toContain('color: var(--terminal-fg)')
  })

  it('.rs-sftp__name（檔名列）本身鎖定 --text', () => {
    expect(readRule('base.css', '.rs-sftp__name')).toContain('color: var(--text)')
  })

  it('面板背景與 hover／選取背景各 ≥4.5:1', () => {
    const text = token('--text')
    expect(contrast(text, token('--surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(text, token('--surface-subtle'))).toBeGreaterThanOrEqual(4.5)
    // 修復前的實際值（--terminal-fg 白底）＝ 1.54:1，留作回歸參照
    expect(contrast(token('--terminal-fg'), token('--surface'))).toBeLessThan(4.5)
  })
})

/* ---------- v0.1.4 #8：表頭欄寬拖曳、雙擊重設、持久化 ---------- */

/** 只帶 settings 的最小 window.rs mock（其他 API 測試不碰） */
function installSettings(initial?: Partial<SftpColumnWidths>) {
  const listeners: Array<(settings: unknown) => void> = []
  const get = vi.fn().mockResolvedValue({ ok: true, data: initial ? { ui: { sftpColumns: initial } } : {} })
  const patch = vi.fn().mockResolvedValue({ ok: true, data: {} })
  const onChange = vi.fn((cb: (settings: unknown) => void) => {
    listeners.push(cb)
    return () => undefined
  })
  Object.defineProperty(window, 'rs', {
    configurable: true,
    value: { settings: { get, patch, onChange } }
  })
  return { get, patch, onChange, emit: (settings: unknown) => listeners.forEach((cb) => cb(settings)) }
}

const colWidths = (): string[] =>
  [...document.querySelectorAll('col')].map((col) => col.style.width)

describe('v0.1.4 #8 SFTP 欄寬拖曳與持久化（settings.ui.sftpColumns）', () => {
  it('掛載讀回持久化欄寬：colgroup 套用設定值，表格 minWidth = 欄寬總和', async () => {
    installSettings({ name: 500, permissions: 90, mtime: 130, size: 80 })
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    await waitFor(() => expect(colWidths()).toEqual(['500px', '90px', '130px', '80px']))
    expect((document.querySelector('table') as HTMLTableElement).style.minWidth).toBe('800px')
  })

  it('滑鼠拖曳：拖動中即時預覽，放開才寫回（patch 單欄部分更新）', () => {
    const mock = installSettings()
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    const handle = screen.getByRole('button', { name: 'Resize Name column' })
    fireEvent.mouseDown(handle, { clientX: 300, clientY: 20 })
    fireEvent.mouseMove(document, { clientX: 360, clientY: 20 })
    expect(colWidths()[0]).toBe('240px') // 預設 180 + 60
    fireEvent.mouseUp(document, { clientX: 360, clientY: 20 })
    expect(mock.patch).toHaveBeenCalledWith({ ui: { sftpColumns: { name: 240 } } })
  })

  it('最小寬度（主管建議值）：name ≥120、其餘 ≥70，拖出下限即夾回', () => {
    const mock = installSettings()
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    /* 其餘欄：Permissions 預設 90 → 拖出 → 夾回 70（Size 預設已等於下限 70，用 Permissions 才有實際變化） */
    const permHandle = screen.getByRole('button', { name: 'Resize Permissions column' })
    fireEvent.mouseDown(permHandle, { clientX: 300, clientY: 20 })
    fireEvent.mouseMove(document, { clientX: 0, clientY: 20 })
    fireEvent.mouseUp(document, { clientX: 0, clientY: 20 })
    expect(colWidths()[1]).toBe('70px')
    expect(mock.patch).toHaveBeenLastCalledWith({ ui: { sftpColumns: { permissions: 70 } } })
    /* name：預設 180 → 拖出 → 夾回 120 */
    const nameHandle = screen.getByRole('button', { name: 'Resize Name column' })
    fireEvent.mouseDown(nameHandle, { clientX: 300, clientY: 20 })
    fireEvent.mouseMove(document, { clientX: 0, clientY: 20 })
    fireEvent.mouseUp(document, { clientX: 0, clientY: 20 })
    expect(colWidths()[0]).toBe('120px')
    expect(mock.patch).toHaveBeenLastCalledWith({ ui: { sftpColumns: { name: 120 } } })
  })

  it('雙擊把手：該欄回預設值並寫回', async () => {
    const mock = installSettings({ name: 500, permissions: 110, mtime: 150, size: 100 })
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    await waitFor(() => expect(colWidths()[0]).toBe('500px'))
    fireEvent.dblClick(screen.getByRole('button', { name: 'Resize Name column' }))
    expect(colWidths()[0]).toBe('180px')
    expect(mock.patch).toHaveBeenCalledWith({ ui: { sftpColumns: { name: 180 } } })
  })

  it('方向鍵微調：Right +10、Shift+Left -1、Home 錨到下限 70', () => {
    const mock = installSettings()
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    const handle = screen.getByRole('button', { name: 'Resize Modified column' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(mock.patch).toHaveBeenLastCalledWith({ ui: { sftpColumns: { mtime: 130 } } }) // 120 + 10
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(mock.patch).toHaveBeenLastCalledWith({ ui: { sftpColumns: { mtime: 129 } } })
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(mock.patch).toHaveBeenLastCalledWith({ ui: { sftpColumns: { mtime: 70 } } })
    expect(colWidths()[2]).toBe('70px')
  })

  it('settingsChanged 廣播（另一面板寫回）→ 本地欄寬同步', async () => {
    const mock = installSettings()
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    await waitFor(() => expect(mock.onChange).toHaveBeenCalled())
    act(() => mock.emit({ ui: { sftpColumns: { name: 420, permissions: 110, mtime: 150, size: 100 } } }))
    expect(colWidths()[0]).toBe('420px')
  })

  it('settings API 形狀不全（既有 mock 只有 reset）→ 用預設欄寬且不拋錯', () => {
    Object.defineProperty(window, 'rs', {
      configurable: true,
      value: { settings: { reset: vi.fn() } }
    })
    render(wrap(<FileTable entries={[entry({})]} {...baseProps} />))
    expect(colWidths()).toEqual(['180px', '90px', '120px', '70px'])
    expect((document.querySelector('table') as HTMLTableElement).style.minWidth).toBe('460px')
  })
})

/* ---------- UI-03 v1.2：SFTP 列表無框線（僅作用域） ---------- */

describe('UI-03 v1.2 SFTP 列表樣式（無框線、hover／選取／焦點／拖放）', () => {
  const rule = (selector: string): string => readRule('base.css', selector).replace(/\s+/g, ' ')

  it('垂直欄線／水平列線／表頭底線皆為 0（SFTP 作用域）', () => {
    expect(rule('.rs-sftp__table td')).toContain('border-bottom: 0')
    expect(rule('.rs-sftp__table th + th')).toContain('border-left: 0')
    expect(rule('.rs-sftp__table td + td')).toContain('border-left: 0')
    expect(rule('.rs-sftp__table thead th')).toContain('border-bottom: 0')
  })

  it('v0.1.9 #2：thead 不透明、sticky、有陰影且不加框線', () => {
    const css = rule('.rs-sftp__table thead th')
    expect(css).toContain('background: var(--surface)')
    expect(css).not.toContain('transparent')
    expect(css).toContain('position: sticky')
    expect(css).toContain('z-index: 1')
    expect(css).toContain('box-shadow')
    expect(css).toContain('border-bottom: 0')
  })

  it('列高 28px（density token）與欄距 8px，不改全域 token', () => {
    const cells = rule('.rs-sftp__table td')
    expect(cells).toContain('padding: 0 var(--space-2)')
    expect(cells).toContain('height: var(--density-table-row)')
    expect(rule('.rs-table td')).toContain('border-bottom: 1px solid var(--border)')
  })

  it('hover／選取／鍵盤焦點／拖放目標列都有底色或描邊', () => {
    expect(rule('.rs-sftp__table tbody tr:hover td')).toContain('background: var(--surface-subtle)')
    expect(rule('.rs-sftp__table tbody tr.is-selected td')).toContain('background: var(--row-selected)')
    expect(rule('.rs-sftp__table tbody tr:focus-visible')).toContain('outline: 2px solid var(--primary)')
    expect(rule('.rs-sftp__table tbody tr.is-drop-target td')).toContain('background: var(--row-selected)')
    expect(rule('.rs-sftp__table tbody tr.is-drop-target')).toContain('outline: 2px solid var(--primary)')
  })

  it('欄寬把手不常駐線：預設 transparent，hover/focus 才顯示 primary', () => {
    expect(rule('.rs-sftp__colresizer::after')).toContain('background: transparent')
    expect(rule('.rs-sftp__colresizer:hover::after, .rs-sftp__colresizer:focus-visible::after')).toContain(
      'background: var(--primary)'
    )
  })

  it('拖放進入資料夾列 → is-drop-target；離開即移除', () => {
    const dir: SftpEntry = { name: 'logs', path: 'C:\\logs', type: 'dir', size: 0, mtimeMs: 0, isSymlink: false }
    render(wrap(<FileTable entries={[dir]} {...baseProps} />))
    const row = screen.getByText('logs').closest('tr') as HTMLElement
    fireEvent.dragEnter(row)
    expect(row.className).toContain('is-drop-target')
    fireEvent.dragLeave(row)
    expect(row.className).not.toContain('is-drop-target')
  })
})
