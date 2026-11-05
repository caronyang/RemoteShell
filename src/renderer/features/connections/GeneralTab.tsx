import { useTranslation } from 'react-i18next'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import type { ConnectionGroup } from '../../../shared/ipc-contract'

interface Props {
  values: { name: string; protocol: 'ssh' | 'telnet'; host: string; port: number; groupId: string | null; description: string; tags: string }
  groups: ConnectionGroup[]
  onChange: (patch: Partial<Props['values']>) => void
  errors: Record<string, string>
  duplicateName: boolean
}

export function GeneralTab({ values, groups, onChange, errors, duplicateName }: Props) {
  const { t } = useTranslation()
  const protocolOptions = [
    { value: 'ssh', label: 'SSH' },
    { value: 'telnet', label: 'Telnet' },
  ]
  const groupOptions = [
    { value: '', label: t('common.none') },
    ...groups.map(g => ({ value: g.id, label: g.name })),
  ]

  const onProtocol = (v: string) => {
    const protocol = v as 'ssh' | 'telnet'
    onChange({ protocol, port: protocol === 'ssh' ? 22 : 23 })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Input label={t('dialog.connection.field.name')} value={values.name}
        onValueChange={v => onChange({ name: v })}
        error={errors.name || (duplicateName ? t('dialog.connection.validation.nameDuplicate') : undefined)} />
      <Select label={t('dialog.connection.field.protocol')} options={protocolOptions} value={values.protocol} onValueChange={onProtocol} />
      <Input label={t('dialog.connection.field.host')} value={values.host} placeholder={t('dialog.connection.placeholder.host')}
        onValueChange={v => onChange({ host: v })} error={errors.host} />
      <Input label={t('dialog.connection.field.port')} type="number" value={String(values.port)}
        onValueChange={v => onChange({ port: Number(v) })} error={errors.port} />
      <Select label={t('dialog.connection.field.group')} options={groupOptions} value={values.groupId ?? ''}
        onValueChange={v => onChange({ groupId: v === '' ? null : v })} />
      <Input label={t('dialog.connection.field.description')} value={values.description}
        onValueChange={v => onChange({ description: v })} />
      <Input label={t('dialog.connection.field.tags')} value={values.tags} placeholder={t('dialog.connection.placeholder.tags')}
        onValueChange={v => onChange({ tags: v })} />
    </div>
  )
}