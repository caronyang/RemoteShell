import { useTranslation } from 'react-i18next'
import type { AppSettings, SessionInfo } from '../../../shared/ipc-contract'
import { Icon } from '../../components/Icon'
import { DualPane } from '../sftp/DualPane'
import { TerminalView } from '../terminal/TerminalView'

export interface TerminalAreaProps {
  sessions: SessionInfo[]
  activeId: string | null
  settings: AppSettings
  /** 開了 SFTP 分頁的 sessionId（視為額外的「傳輸」分頁） */
  sftpSessionIds: string[]
  /** 目前分頁區顯示的 SFTP session（非 terminal） */
  sftpViewId: string | null
  profileName: (profileId: string) => string
  /** #13 讀取端：每 session 依其 profile.terminal 逐欄合併（resolveTerminalSettings） */
  terminalSettingsFor: (profileId: string) => AppSettings['terminal']
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onSelectSftp: (sessionId: string) => void
  onCloseSftp: (sessionId: string) => void
  closeSftpTab: () => void
  /** FAIL-4：分頁列 [＋] 開新快速連線 */
  onQuickConnect: () => void
}

const DOT: Record<SessionInfo['state'], string> = {
  connecting: 'rs-dot rs-dot--connecting',
  connected: 'rs-dot rs-dot--connected',
  disconnected: 'rs-dot rs-dot--idle',
  failed: 'rs-dot rs-dot--failed'
}

/**
 * 右側分頁區（UI-01 §5 / UI-03）：終端分頁 + 傳輸雙面板分頁共用同一列。
 * 終端 keep-alive：非 active 只隱藏不銷毀；SFTP 分頁以覆蓋層顯示，終端仍掛載。
 */
export function TerminalArea({
  sessions,
  activeId,
  settings,
  sftpSessionIds,
  sftpViewId,
  profileName,
  terminalSettingsFor,
  onSelect,
  onClose,
  onSelectSftp,
  onCloseSftp,
  closeSftpTab,
  onQuickConnect
}: TerminalAreaProps): JSX.Element {
  const { t } = useTranslation()
  const twins = new Set(sftpSessionIds)

  return (
    <>
      <div className="rs-tabs" role="tablist">
        {sessions.map((session) => (
          <div
            key={session.sessionId}
            role="tab"
            aria-selected={sftpViewId === null && session.sessionId === activeId}
            tabIndex={0}
            className={`rs-tab${sftpViewId === null && session.sessionId === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(session.sessionId)}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('.rs-tab__close')) return
              onClose(session.sessionId)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(session.sessionId)
            }}
            title={`${profileName(session.profileId)} — ${session.host}:${session.port}`}
          >
            <span className={DOT[session.state]} aria-hidden="true" />
            <span className="rs-tab__title">{profileName(session.profileId)}</span>
            <button
              type="button"
              className="rs-tab__close"
              aria-label={t('tabs.close')}
              onClick={(event) => {
                event.stopPropagation()
                onClose(session.sessionId)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {sessions
          .filter((session) => twins.has(session.sessionId))
          .map((session) => (
            <div
              key={`sftp-${session.sessionId}`}
              role="tab"
              aria-selected={sftpViewId === session.sessionId}
              tabIndex={0}
              className={`rs-tab${sftpViewId === session.sessionId ? ' is-active' : ''}`}
              onClick={() => onSelectSftp(session.sessionId)}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest('.rs-tab__close')) return
                onCloseSftp(session.sessionId)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectSftp(session.sessionId)
              }}
              title={`${profileName(session.profileId)} — ${t('toolbar.sftp')}`}
            >
              <Icon name="transfer" size={12} />
              <span className="rs-tab__title">{t('tabs.openSftp')}</span>
              <button
                type="button"
                className="rs-tab__close"
                aria-label={t('tabs.close')}
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseSftp(session.sessionId)
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        <span className="rs-tabs__spacer" />
        {/* FAIL-4：[＋] 新快速連線（UI-01 §5） */}
        <button
          type="button"
          className="rs-tabs__add"
          aria-label={t('toolbar.tooltip.quickConnect')}
          title={t('toolbar.tooltip.quickConnect')}
          onClick={onQuickConnect}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <section className="rs-terminal" aria-label={t('tabs.newTab')}>
        {sessions.length === 0 ? <p className="rs-terminal__empty">{t('statusBar.disconnected')}</p> : null}
        {sessions.map((session) => (
          <TerminalView
            key={session.sessionId}
            session={session}
            /* #13 讀取端：per-profile 終端設定（profile.terminal 六欄逐欄 fallback 全域） */
            settings={{ ...settings, terminal: terminalSettingsFor(session.profileId) }}
            active={sftpViewId === null && session.sessionId === activeId}
          />
        ))}
        {sftpViewId !== null &&
          sessions
            .filter((session) => session.sessionId === sftpViewId)
            .map((session) => (
              <div key={`sftpview-${session.sessionId}`} className="rs-sftp__view">
                <DualPane session={session} onClose={closeSftpTab} />
              </div>
            ))}
      </section>
    </>
  )
}
