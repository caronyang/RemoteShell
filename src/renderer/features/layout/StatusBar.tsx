import { useTranslation } from 'react-i18next'
import type { AppError, AppInfo, Locale, SessionInfo } from '../../../shared/ipc-contract'

export interface StatusBarProps {
  locale: Locale
  info: AppInfo | null
  session: SessionInfo | null
  profileName: string
  onReconnect: (sessionId: string) => void
  /** P2-02：E_JUMP_TCP 的 {host}:{port} 要用跳板主機（由 MainWindow 依 active profile 解析） */
  jumpHost?: string
  jumpPort?: number
  /** v0.1.8：open 失敗沒有分頁，錯誤也要顯示在狀態列（toast＋狀態列雙回饋） */
  openError?: { error: AppError; params: Record<string, unknown> } | null
}

const DOT: Record<SessionInfo['state'], string> = {
  connecting: 'rs-dot rs-dot--connecting',
  connected: 'rs-dot rs-dot--connected',
  disconnected: 'rs-dot rs-dot--idle',
  failed: 'rs-dot rs-dot--failed'
}

/**
 * 狀態列（UI-01 §7／UI-07 FLOW-B）：
 * - 已連線：`● 已連線: prod-web-01 (SSH2) · 經 gw-edge → 10.1.2.11`
 * - 斷線轉紅字 + [立即重連]；失敗顯示失敗階段
 */
export function StatusBar({ locale, info, session, profileName, onReconnect, jumpHost, jumpPort, openError }: StatusBarProps): JSX.Element {
  const { t } = useTranslation()

  let connectionText = t('statusBar.disconnected')
  let tone = ''
  let openErrorText: string | null = null
  if (session) {
    const protocol = session.protocol === 'ssh' ? 'SSH2' : 'Telnet'
    if (session.state === 'connected') {
      connectionText = session.viaProfileName
        ? t('statusBar.format.connectedVia', {
            name: profileName,
            protocol,
            jump: session.viaProfileName,
            host: session.host
          })
        : `${profileName} (${protocol}) · ${session.host}:${session.port}`
    } else if (session.state === 'connecting') {
      connectionText = `${t('statusBar.connecting')}: ${profileName} · ${session.phase}`
    } else {
      tone = 'is-error'
      connectionText = `${t('statusBar.interrupted')}: ${profileName}`
    }
  }
  if (!session?.error && openError) {
    const error = openError.error
    const params =
      error.code === 'E_JUMP_TCP'
        ? {
            host: openError.params['jumpHost'] ?? openError.params['host'],
            port: openError.params['jumpPort'] ?? openError.params['port']
          }
        : openError.params
    const phase = error.phase ? `${t('statusBar.errorPhase', { phase: error.phase })} · ` : ''
    openErrorText = `${phase}${t(error.i18nKey, params)}`
  }

  return (
    <footer className="rs-statusbar">
      <span className={`rs-status ${tone}`}>
        <span className={session ? DOT[session.state] : 'rs-dot rs-dot--idle'} /> {connectionText}
      </span>
      {session?.error ? (
        <span className="rs-status is-error">
          {session.error.phase
            ? `${t('statusBar.errorPhase', { phase: session.error.phase })} · `
            : ''}
          {/* P2-02：error 文案含 {host}:{port} 佔位符 —— E_JUMP_TCP 用跳板主機，否則用目標主機 */}
          {t(session.error.i18nKey, {
            host: session.error.code === 'E_JUMP_TCP' && jumpHost ? jumpHost : session.host,
            port: session.error.code === 'E_JUMP_TCP' && jumpPort ? jumpPort : session.port
          })}
        </span>
      ) : null}
      {openErrorText ? <span className="rs-status is-error">{openErrorText}</span> : null}
      {session && (session.state === 'disconnected' || session.state === 'failed') ? (
        <button type="button" className="rs-link" onClick={() => onReconnect(session.sessionId)}>
          {t('statusBar.reconnectNow')}
        </button>
      ) : null}
      <span>{t('statusBar.sftpChannel')}: —</span>
      <span className="rs-statusbar__spacer" />
      <span>{t('statusBar.format.encoding', { encoding: t('statusBar.encoding'), locale })}</span>
      <span>{info ? t('statusBar.version', { version: info.version }) : 'RemoteShell'}</span>
    </footer>
  )
}
