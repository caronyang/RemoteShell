import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Modal } from './Modal'

export interface ConfirmDialogProps {
  open: boolean
  /** 標題（沿用各對話框既有 key，例如 dialog.connection.unsaved.title） */
  title: string
  message: string
  /** 確認鈕文字（預設 common.ok；毀滅性動作傳 common.discard 等） */
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * P0 #2/#3：App 內確認框 —— 替代 window.confirm。
 * Electron 的 window.confirm 是原生同步對話框（會阻塞 renderer 主執行緒，
 * 終端 focus 下觸發時整個 App 像當掉），一律改用本元件（Modal 同套 z-index/focus/Esc）。
 */
export function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  return (
    <Modal
      open={open}
      title={title}
      width={400}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={onConfirm}>
            {confirmLabel ?? t('common.ok')}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{message}</p>
    </Modal>
  )
}
