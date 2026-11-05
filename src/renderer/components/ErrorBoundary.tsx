import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { crashReport, formatCrashReport, type CrashReport } from '../../shared/crash'

/**
 * M4-06：renderer 的例外邊界。
 *
 * 兩種來源都會被接住，並顯示同一組「可回報錯誤碼」（RS-UI-XXXX）：
 *   1. React 在 render / lifecycle 丟出的例外（getDerivedStateFromError）
 *   2. 沒人處理的 window error / unhandledrejection（事件監聽）
 *
 * 畫面刻意保持極簡：不載入任何 feature 元件，避免錯誤本身又被同一個錯誤打斷。
 * 錯誤碼由 shared/crash 產生，與 main 的 RS-MAIN-XXXX 同一套規則。
 */

interface Props {
  children: ReactNode
}

interface State {
  report: CrashReport | null
  /** true = React render 失敗（重試無用，只能重新載入） */
  renderFailed: boolean
}

function errorOf(value: unknown): unknown {
  return value ?? new Error('unknown renderer error')
}

interface CrashScreenProps {
  report: CrashReport
  renderFailed: boolean
  onReload: () => void
  onDismiss: () => void
}

function CrashScreen({ report, renderFailed, onReload, onDismiss }: CrashScreenProps): JSX.Element {
  const { t } = useTranslation()
  const details = formatCrashReport(report)

  return (
    <div className="rs-crash" role="alert" data-crash-code={report.code}>
      <h1 className="rs-crash__title">{t('error.E_INTERNAL')}</h1>
      <p className="rs-crash__code" aria-label="error code">
        {report.code}
      </p>
      <p className="rs-crash__message">{report.message}</p>
      <pre className="rs-crash__stack" aria-label="stack">
        {details}
      </pre>
      <div className="rs-crash__actions">
        <button
          type="button"
          className="rs-btn rs-btn--primary"
          onClick={() => {
            void navigator.clipboard?.writeText(details)
          }}
        >
          {t('queue.action.errorDetails')}
        </button>
        {renderFailed ? null : (
          <button type="button" className="rs-btn rs-btn--secondary" onClick={onDismiss}>
            {t('common.close')}
          </button>
        )}
        <button type="button" className="rs-btn rs-btn--secondary" onClick={onReload}>
          {t('common.retry')}
        </button>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { report: null, renderFailed: false }

  static getDerivedStateFromError(error: Error): State {
    return { report: crashReport('UI', error), renderFailed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只留在 console（logger 在 main），讓開發者能直接看到元件堆疊
    console.error('[renderer] render error', error, info.componentStack)
  }

  override componentDidMount(): void {
    window.addEventListener('error', this.onWindowError)
    window.addEventListener('unhandledrejection', this.onUnhandledRejection)
  }

  override componentWillUnmount(): void {
    window.removeEventListener('error', this.onWindowError)
    window.removeEventListener('unhandledrejection', this.onUnhandledRejection)
  }

  private onWindowError = (event: ErrorEvent): void => {
    // 資源載入失敗（img/script）沒有 event.error，且不該擋掉整個 UI
    if (!event.error) return
    this.setState({ report: crashReport('UI', errorOf(event.error)), renderFailed: false })
  }

  private onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.setState({ report: crashReport('UI', errorOf(event.reason)), renderFailed: false })
  }

  private reload = (): void => {
    window.location.reload()
  }

  private dismiss = (): void => {
    this.setState({ report: null, renderFailed: false })
  }

  override render(): ReactNode {
    const { report, renderFailed } = this.state
    if (report) {
      return (
        <CrashScreen report={report} renderFailed={renderFailed} onReload={this.reload} onDismiss={this.dismiss} />
      )
    }
    return this.props.children
  }
}
