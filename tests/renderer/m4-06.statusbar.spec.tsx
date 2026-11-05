import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { StatusBar } from '../../src/renderer/features/layout/StatusBar'
import { initI18n } from '../../src/renderer/i18n'
import type { AppError, SessionInfo } from '../../src/shared/ipc-contract'

// 狀態列近年改為走 i18n（M4 錯誤文案），測試需提供 instance
const i18n = initI18n('en-US')
const wrap = (ui: ReactNode): JSX.Element => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>

afterEach(() => cleanup())

const baseSession: SessionInfo = {
  sessionId: 's1',
  profileId: 'p1',
  protocol: 'ssh',
  state: 'failed',
  phase: 'target-auth',
  host: '10.1.2.11',
  port: 22,
  cols: 80,
  rows: 24
}

const renderBar = (error: AppError): void => {
  render(
    wrap(
      <StatusBar
        locale="en-US"
        info={null}
        session={{ ...baseSession, error }}
        profileName="prod-web-01"
        onReconnect={vi.fn()}
      />
    )
  )
}

describe('M4-06 狀態列錯誤顯示', () => {
  it('有 phase 時顯示「Failed phase: <phase>」', () => {
    renderBar({
      code: 'E_TARGET_AUTH',
      phase: 'target-auth',
      message: 'Authentication failed',
      i18nKey: 'error.E_TARGET_AUTH',
      retryable: false
    })
    expect(screen.getByText(/Failed phase: target-auth/)).toBeTruthy()
    expect(screen.getByText(/Target host authentication failed/)).toBeTruthy()
  })

  it('phase 未知（如 E_KEY_PASSPHRASE）不顯示階段段，也不出現 "-" 佔位符', () => {
    const { container } = render(      wrap(
        <StatusBar
          locale="en-US"
          info={null}
          session={{
            ...baseSession,
            error: {
              code: 'E_KEY_PASSPHRASE',
              message: 'Incorrect key passphrase',
              i18nKey: 'error.E_KEY_PASSPHRASE',
              retryable: false
            }
          }}
          profileName="prod-web-01"
          onReconnect={vi.fn()}
        />
      )
    )
    expect(screen.queryByText(/Failed phase/)).toBeNull()
    const errorText = screen.getByText(/Incorrect key passphrase/)
    expect(errorText.textContent).toContain('Incorrect key passphrase')
    expect(container.textContent).not.toContain('Failed phase: -')
  })
})
