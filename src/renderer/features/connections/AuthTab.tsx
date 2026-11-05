import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Checkbox } from '../../components/Checkbox'

type Method = 'password' | 'passwordFile' | 'publicKey'

interface Values {
  method: Method
  username: string
  password: string
  rememberPassword: boolean
  filePath: string
  keyPath: string
  passphrase: string
  rememberPassphrase: boolean
}

interface Props {
  values: Values
  onChange: (patch: Partial<Values>) => void
  errors: Record<string, string>
  connectionId: string | null
}

const METHOD_OPTIONS = (t: (k: string) => string): { value: string; label: string }[] => [
  { value: 'password', label: t('dialog.connection.auth.method.password') },
  { value: 'passwordFile', label: t('dialog.connection.auth.method.passwordFile') },
  { value: 'publicKey', label: t('dialog.connection.auth.method.publicKey') },
]

export function AuthTab({ values, onChange, errors }: Props) {
  const { t } = useTranslation()
  const [showPw, setShowPw] = useState(false)
  const methodOptions = METHOD_OPTIONS(t)

  /* P1-01：vault 寫入集中在 ConnectionDialog.handleSave（勾選記住才存、取消才清）。
     此處不再逐鍵寫 vault —— 否則會把「輸入到一半的密碼」寫進 vault。 */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Select label={t('dialog.connection.auth.method')} options={methodOptions} value={values.method}
        onValueChange={v => onChange({ method: v as Method })} />

      {values.method === 'password' && (
        <>
          <Input label={t('dialog.connection.auth.username')} value={values.username} onValueChange={v => onChange({ username: v })} />
          <Input label={t('dialog.connection.auth.password')} type={showPw ? 'text' : 'password'} value={values.password}
            onValueChange={v => onChange({ password: v })} error={errors.password} />
          <button type="button" onClick={() => setShowPw(s => !s)}>{showPw ? t('dialog.connection.password.hide') : t('dialog.connection.password.show')}</button>
          <Checkbox checked={values.rememberPassword} onCheckedChange={v => onChange({ rememberPassword: v })} label={t('dialog.connection.auth.rememberPassword')} />
          <p style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{t('dialog.connection.auth.rememberHint')}</p>
        </>
      )}

      {values.method === 'passwordFile' && (
        <>
          <Input label={t('dialog.connection.auth.username')} value={values.username} onValueChange={v => onChange({ username: v })} />
          <Input label={t('dialog.connection.auth.filePath')} value={values.filePath} onValueChange={v => onChange({ filePath: v })} error={errors.filePath} />
          {/* #8：契約 AuthConfig.passwordFile 無 fileUsername 欄位 → 移除死欄位（不硬塞資料） */}
        </>
      )}

      {values.method === 'publicKey' && (
        <>
          <Input label={t('dialog.connection.auth.username')} value={values.username} onValueChange={v => onChange({ username: v })} />
          <Input label={t('dialog.connection.auth.keyPath')} value={values.keyPath} onValueChange={v => onChange({ keyPath: v })} error={errors.keyPath} />
          {/* v0.1.4 #1：金鑰檔改用系統單檔選擇器；取消（null）不覆寫原值 */}
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const picked = await window.rs.app.pickFile(values.keyPath || undefined)
                if (picked.ok && picked.data) onChange({ keyPath: picked.data })
              })()
            }}
          >
            {t('common.browse')}
          </button>
          <p style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{t('dialog.connection.auth.keyHint')}</p>
          <Input label={t('dialog.connection.auth.passphrase')} type="password" value={values.passphrase}
            onValueChange={v => onChange({ passphrase: v })} />
          <Checkbox checked={values.rememberPassphrase} onCheckedChange={v => onChange({ rememberPassphrase: v })} label={t('dialog.connection.auth.rememberPassphrase')} />
        </>
      )}
    </div>
  )
}