import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'

export interface SftpToolbarProps {
  hasLocalSelection: boolean
  hasRemoteSelection: boolean
  canTransfer: boolean
  showHidden: boolean
  onUpload: () => void
  onDownload: () => void
  onNewFolder: () => void
  onRename: () => void
  onDelete: () => void
  onRefresh: () => void
  onToggleHidden: () => void
}

/** SFTP 工具列（UI-03：上傳/下載/新增資料夾/重新命名/刪除/重新整理/顯示隱藏檔） */
export function SftpToolbar({
  hasLocalSelection,
  hasRemoteSelection,
  canTransfer,
  showHidden,
  onUpload,
  onDownload,
  onNewFolder,
  onRename,
  onDelete,
  onRefresh,
  onToggleHidden
}: SftpToolbarProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <nav className="rs-sftp__toolbar" aria-label={t('toolbar.sftp')}>
      <Button icon="transfer" disabled={!canTransfer || !hasLocalSelection} onClick={onUpload}>
        {t('sftp.toolbar.upload')}
      </Button>
      <Button icon="transfer" disabled={!canTransfer || !hasRemoteSelection} onClick={onDownload}>
        {t('sftp.toolbar.download')}
      </Button>
      <Button icon="folder-plus" onClick={onNewFolder}>
        {t('sftp.toolbar.newFolder')}
      </Button>
      <Button icon="folder" disabled={!hasLocalSelection && !hasRemoteSelection} onClick={onRename}>
        {t('sftp.toolbar.rename')}
      </Button>
      <Button icon="close" disabled={!hasLocalSelection && !hasRemoteSelection} variant="danger" onClick={onDelete}>
        {t('sftp.toolbar.delete')}
      </Button>
      <Button icon="reconnect" onClick={onRefresh} title={t('common.refresh')}>
        {t('sftp.toolbar.refresh')}
      </Button>
      <Button aria-pressed={showHidden} onClick={onToggleHidden}>
        {t('sftp.toolbar.showHidden')}
      </Button>
    </nav>
  )
}
