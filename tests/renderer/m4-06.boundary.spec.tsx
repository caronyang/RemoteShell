import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { I18nextProvider } from 'react-i18next'
import { ErrorBoundary } from '../../src/renderer/components/ErrorBoundary'
import { initI18n } from '../../src/renderer/i18n'

const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>

afterEach(() => cleanup())

function Boom(): JSX.Element {
  throw new Error('render exploded in M4-06 test')
}

describe('M4-06 renderer 例外邊界', () => {
  it('render 例外 → 顯示可回報錯誤碼，而不是白屏', () => {
    // React 會把錯誤印到 console.error；測試時靜音避免噪音
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(wrap(<ErrorBoundary>{<Boom />}</ErrorBoundary>))
    const screenEl = screen.getByRole('alert')
    expect(screenEl.getAttribute('data-crash-code')).toMatch(/^RS-UI-[0-9A-F]{4}$/)
    expect(screenEl.textContent).toContain('render exploded in M4-06 test')
    // render 失敗時只給「重新載入」，不給「關閉」（避免重試又炸）
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    spy.mockRestore()
  })

  it('正常的子樹不會被影響（沒有錯誤時直接渲染 children）', () => {
    render(wrap(<ErrorBoundary>{<div>content ok</div>}</ErrorBoundary>))
    expect(screen.getByText('content ok')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('未處理的 promise rejection 也會顯示同一組錯誤碼，且可以關閉繼續使用', () => {
    render(wrap(<ErrorBoundary>{<div>content ok</div>}</ErrorBoundary>))
    act(() => {
      const event = new Event('unhandledrejection') as Event & { reason?: unknown }
      event.reason = new Error('async failure')
      window.dispatchEvent(event)
    })
    const screenEl = screen.getByRole('alert')
    expect(screenEl.getAttribute('data-crash-code')).toMatch(/^RS-UI-[0-9A-F]{4}$/)
    expect(screenEl.textContent).toContain('async failure')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('content ok')).toBeTruthy()
  })

  it('「複製詳細資料」會把碼與 stack 放進剪貼簿', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(wrap(<ErrorBoundary>{<div>content ok</div>}</ErrorBoundary>))
    act(() => {
      const event = new Event('unhandledrejection') as Event & { reason?: unknown }
      event.reason = new Error('copy me')
      window.dispatchEvent(event)
    })
    const code = screen.getByRole('alert').getAttribute('data-crash-code')
    fireEvent.click(screen.getByRole('button', { name: 'Error details' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(String(writeText.mock.calls[0]?.[0])).toContain(code)
    expect(String(writeText.mock.calls[0]?.[0])).toContain('copy me')
  })
})
