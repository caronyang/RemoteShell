import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './Button'
import { Input } from './Input'
import { Modal } from './Modal'

export interface CredentialDialogProps {
  open: boolean
  title: string
  host: string
  username: string
  onSubmit: (secret: string) => void
  onCancel: () => void
}

/** 連線當下輸入密碼／passphrase（不落盤、不記錄；§2 鐵則 2） */
export function CredentialDialog({
  open,
  title,
  host,
  username,
  onSubmit,
  onCancel
}: CredentialDialogProps): JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  const submit = (): void => {
    if (!value) return
    onSubmit(value)
    setValue('')
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={value.length === 0}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <p className="rs-muted">
        {username}@{host}
      </p>
      <Input
        label={t('dialog.connection.auth.password')}
        type="password"
        autoFocus
        value={value}
        onValueChange={setValue}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <p className="rs-hint">{t('dialog.connection.auth.rememberHint')}</p>
    </Modal>
  )
}
