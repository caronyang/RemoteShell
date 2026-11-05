import { useTranslation } from 'react-i18next'
import { Checkbox } from '../../components/Checkbox'
import { Select } from '../../components/Select'
import type { ConnectionProfile, ConnectionGroup } from '../../../shared/ipc-contract'

interface Props {
  enabled: boolean
  selectedId: string | null
  profiles: ConnectionProfile[]
  groups: ConnectionGroup[]
  onChange: (patch: { enabled?: boolean; selectedId?: string | null }) => void
  targetLabel: string
  /** P0-01：跳板驗證錯誤（如自己選自己） */
  errors?: Record<string, string>
}

export function JumpTab({ enabled, selectedId, profiles, groups, onChange, targetLabel, errors }: Props) {
  const { t } = useTranslation()
  /* #2：telnet 不能當跳板 —— 只列 ssh 主機（main 端另有防線） */
  const options = [
    { value: '', label: t('common.none') },
    ...profiles.filter(p => p.protocol === 'ssh').map(p => {
      const g = groups.find(x => x.id === p.groupId)
      return { value: p.id, label: g ? `${p.name} (${g.name})` : p.name }
    }),
  ]
  const selected = profiles.find(p => p.id === selectedId)
  const jumpLabel = selected ? selected.name : ''
  const preview = enabled && selected ? t('dialog.connection.jump.previewFormat', { jump: jumpLabel, target: targetLabel }) : ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Checkbox checked={enabled} onCheckedChange={v => onChange({ enabled: v })} label={t('dialog.connection.jump.enable')} />
      <Select label={t('dialog.connection.jump.selectHost')} options={options} value={selectedId ?? ''} disabled={!enabled}
        onValueChange={v => onChange({ selectedId: v === '' ? null : v })} />
      {errors?.jump ? <p role="alert" style={{ fontSize: 11, color: 'var(--danger)' }}>{errors.jump}</p> : null}
      {enabled && preview && <div style={{ fontSize: 12 }}>{t('dialog.connection.jump.preview')}: {preview}</div>}
      <p style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{t('dialog.connection.jump.hint')}</p>
      <p style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{t('dialog.connection.jump.singleHopOnly')}</p>
    </div>
  )
}