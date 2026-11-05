import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'

export interface ToolbarProps {
  queueOpen: boolean
  onToggleQueue: () => void
  activeTaskCount: number
  hasSession: boolean
  canReconnect: boolean
  canSftp: boolean
  onSftp: () => void
  onDisconnect: () => void
  onReconnect: () => void
  /** FAIL-3：快速連線入口（契約無 profile-less connect，暫開新增連線對話框） */
  onQuickConnect: () => void
  /** FAIL-3：新增連線入口 */
  onNewConnection: () => void
}

/** 工具列 40px（UI-01 §3）；沒有 session 時連線類按鈕 disabled */
export function Toolbar({
  queueOpen,
  onToggleQueue,
  activeTaskCount,
  hasSession,
  canReconnect,
  canSftp,
  onSftp,
  onDisconnect,
  onReconnect,
  onQuickConnect,
  onNewConnection
}: ToolbarProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <nav className="rs-toolbar" aria-label={t('toolbar.quickConnect')}>
      <Button icon="plus" title={t('toolbar.tooltip.quickConnect')} onClick={onQuickConnect}>
        {t('toolbar.quickConnect')}
      </Button>
      <Button icon="folder-plus" title={t('toolbar.tooltip.newConnection')} onClick={onNewConnection}>
        {t('toolbar.newConnection')}
      </Button>
      <Button
        icon="disconnect"
        title={t('toolbar.tooltip.disconnect')}
        disabled={!hasSession}
        onClick={onDisconnect}
      >
        {t('toolbar.disconnect')}
      </Button>
      <Button
        icon="reconnect"
        title={t('toolbar.tooltip.reconnect')}
        disabled={!canReconnect}
        onClick={onReconnect}
      >
        {t('toolbar.reconnect')}
      </Button>
      <Button icon="transfer" title={t('toolbar.tooltip.sftp')} disabled={!canSftp} onClick={onSftp}>
        {t('toolbar.sftp')}
      </Button>
      <Button icon="queue" title={t('toolbar.tooltip.queue')} aria-pressed={queueOpen} onClick={onToggleQueue}>
        {t('toolbar.queue')}
        {activeTaskCount > 0 ? <span className="rs-badge">{activeTaskCount}</span> : null}
      </Button>
    </nav>
  )
}
