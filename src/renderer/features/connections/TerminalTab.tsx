import { useTranslation } from 'react-i18next'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Checkbox } from '../../components/Checkbox'

interface Values {
  fontFamily: string
  fontSize: number
  theme: string
  scrollback: number
  cursorStyle: 'block' | 'underline'
  cursorBlink: boolean
  applyToAll: boolean
}

interface Props { values: Values; onChange: (patch: Partial<Values>) => void }

export function TerminalTab({ values, onChange }: Props) {
  const { t } = useTranslation()
  const themeOptions = [
    { value: 'dark', label: 'Dark' },
  ]
  const cursorOptions = [
    { value: 'block', label: t('dialog.connection.terminal.cursorBlock') },
    { value: 'underline', label: t('dialog.connection.terminal.cursorUnderline') },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input label={t('dialog.connection.terminal.font')} value={values.fontFamily} onValueChange={v => onChange({ fontFamily: v })} />
      <Input label={t('dialog.connection.terminal.fontSize')} type="number" value={String(values.fontSize)} onValueChange={v => onChange({ fontSize: Number(v) })} />
      <Select
        label={t('dialog.connection.terminal.theme')}
        options={themeOptions}
        /* 裁決：只列 dark；legacy themeId 顯示 dark（存檔仍保留原值，除非使用者真的改選） */
        value={themeOptions.some(o => o.value === values.theme) ? values.theme : 'dark'}
        onValueChange={v => onChange({ theme: v })}
      />
      <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: 0 }}>{t('settings.terminal.themePending')}</p>
      <Input label={t('dialog.connection.terminal.encoding')} value="UTF-8" readOnly />
      <Input label={t('dialog.connection.terminal.scrollback')} type="number" value={String(values.scrollback)} onValueChange={v => onChange({ scrollback: Number(v) })} />
      <Select label={t('dialog.connection.terminal.cursorStyle')} options={cursorOptions} value={values.cursorStyle} onValueChange={v => onChange({ cursorStyle: v as 'block' | 'underline' })} />
      <Checkbox checked={values.cursorBlink} onCheckedChange={v => onChange({ cursorBlink: v })} label={t('dialog.connection.terminal.cursorBlink')} />
      <Checkbox checked={values.applyToAll} onCheckedChange={v => onChange({ applyToAll: v })} label={t('dialog.connection.terminal.applyToAll')} />
    </div>
  )
}