import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'

export interface DeleteConnectionDialogProps {
  open: boolean
  name: string
  onConfirm: () => void
  onCancel: () => void
}

/** P1-02：刪除連線二次確認（UI-02 delete.* —— 輸入名稱才能刪） */
export function DeleteConnectionDialog({ open, name, onConfirm, onCancel }: DeleteConnectionDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const reset = (): void => setTyped('')

  return (
    <Modal
      open={open}
      title={t('dialog.connection.delete.title')}
      width={440}
      onClose={() => {
        reset()
        onCancel()
      }}
      footer={
        <>
          <Button
            onClick={() => {
              reset()
              onCancel()
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={typed.trim() !== name}
            onClick={() => {
              reset()
              onConfirm()
            }}
          >
            {t('common.delete')}
          </Button>
        </>
      }
    >
      <p style={{ margin: '0 0 8px' }}>{t('dialog.connection.delete.message')}</p>
      <Input label={t('dialog.connection.delete.typeName', { name })} value={typed} onValueChange={setTyped} />
    </Modal>
  )
}
