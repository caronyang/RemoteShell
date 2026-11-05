import { useTranslation } from 'react-i18next'
import type { AppSettings, DeepPartial } from '../../../shared/ipc-contract'
import { Checkbox } from '../../components/Checkbox'
import { Select } from '../../components/Select'

export interface PaneProps {
  settings: AppSettings
  onPatch: (patch: DeepPartial<AppSettings>) => void
}

/** M4-02 一般分頁（UI-05 §一般）：還原工作區 / 關閉行為 / 系統匣 / 刪除確認 */
export function GeneralPane({ settings, onPatch }: PaneProps): JSX.Element {
  const { t } = useTranslation()
  const general = settings.general
  return (
    <div className="rs-settings__pane">
      <Checkbox
        label={t('settings.general.restoreWorkspace')}
        checked={general.restoreWorkspace}
        onCheckedChange={(checked) => onPatch({ general: { restoreWorkspace: checked } })}
      />
      <Select
        label={t('settings.general.onCloseWithActive')}
        value={general.onCloseWithActive}
        options={[
          { value: 'ask', label: t('settings.general.onCloseAsk') },
          { value: 'disconnect', label: t('settings.general.onCloseDisconnect') }
        ]}
        onValueChange={(value) => {
          if (value === 'ask' || value === 'disconnect') onPatch({ general: { onCloseWithActive: value } })
        }}
      />
      <Checkbox
        label={t('settings.general.minimizeToTray')}
        checked={general.minimizeToTray}
        onCheckedChange={(checked) => onPatch({ general: { minimizeToTray: checked } })}
      />
      <Checkbox
        label={t('settings.general.confirmDelete')}
        checked={general.confirmDelete}
        onCheckedChange={(checked) => onPatch({ general: { confirmDelete: checked } })}
      />
    </div>
  )
}
