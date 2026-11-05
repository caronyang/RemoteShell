import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'

export interface NewGroupDialogProps {
  open: boolean
  parentId: string | null
  onClose: () => void
  onCreate: (name: string, parentId: string | null) => void
}

/** FAIL-3：新增分組小對話框（空白/分組右鍵、側欄資料夾+鈕）；名稱送到 groups.create */
export function NewGroupDialog({ open, parentId, onClose, onCreate }: NewGroupDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    setName('')
    onCreate(trimmed, parentId)
  }

  return (
    <Modal
      open={open}
      title={t('tree.context.newGroup')}
      width={360}
      onClose={() => {
        setName('')
        onClose()
      }}
      footer={
        <>
          <Button
            onClick={() => {
              setName('')
              onClose()
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <Input
        label={t('dialog.connection.field.name')}
        value={name}
        onValueChange={setName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
    </Modal>
  )
}
