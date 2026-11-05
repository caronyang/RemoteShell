import { useTranslation } from 'react-i18next'
import type { ConflictPolicy } from '../../../shared/ipc-contract'
import { Button } from '../../components/Button'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { useToast } from '../../components/Toast'
import type { PaneProps } from './GeneralPane'

/** M4-02 傳輸分頁（UI-05 §傳輸） */
export function TransferPane({ settings, onPatch }: PaneProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const transfer = settings.transfer
  const policies: ConflictPolicy[] = ['ask', 'overwrite', 'skip', 'rename']
  const policyKey: Record<ConflictPolicy, string> = {
    ask: 'settings.transfer.conflictAsk',
    overwrite: 'settings.transfer.conflictOverwrite',
    skip: 'settings.transfer.conflictSkip',
    rename: 'settings.transfer.conflictRename'
  }

  const clamp = (value: string, min: number, max: number): number => {
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) return min
    return Math.max(min, Math.min(max, parsed))
  }

  return (
    <div className="rs-settings__pane">
      <Input
        label={t('settings.transfer.maxConcurrent')}
        type="number"
        min={1}
        max={10}
        value={String(transfer.maxConcurrent)}
        onValueChange={(value) => onPatch({ transfer: { maxConcurrent: clamp(value, 1, 10) } })}
      />
      <div className="rs-settings__row">
        <Input
          label={t('settings.transfer.downloadDir')}
          value={transfer.downloadDir}
          onValueChange={(value) => onPatch({ transfer: { downloadDir: value } })}
        />
        <Button
          title={t('common.browse')}
          onClick={() => {
            void (async () => {
              const picked = await window.rs.app.pickDirectory(transfer.downloadDir)
              // 取消選取回 null：不覆寫原值
              if (picked.ok && picked.data !== null && picked.data !== transfer.downloadDir) {
                onPatch({ transfer: { downloadDir: picked.data } })
              }
              if (!picked.ok) toast.show(t(picked.error.i18nKey), 'error')
            })()
          }}
        >
          {t('common.browse')}
        </Button>
      </div>
      <Select
        label={t('settings.transfer.afterDownload')}
        value={transfer.afterDownload}
        options={[
          { value: 'open', label: t('settings.transfer.afterOpen') },
          { value: 'notify', label: t('settings.transfer.afterNotify') }
        ]}
        onValueChange={(value) => {
          if (value === 'open' || value === 'notify') onPatch({ transfer: { afterDownload: value } })
        }}
      />
      <Select
        label={t('settings.transfer.onConflict')}
        value={transfer.onConflict}
        options={policies.map((policy) => ({ value: policy, label: t(policyKey[policy]) }))}
        onValueChange={(value) => {
          if (policies.includes(value as ConflictPolicy)) onPatch({ transfer: { onConflict: value as ConflictPolicy } })
        }}
      />
      <Input
        label={t('settings.transfer.retryCount')}
        type="number"
        min={0}
        max={10}
        value={String(transfer.retryCount)}
        onValueChange={(value) => onPatch({ transfer: { retryCount: clamp(value, 0, 10) } })}
      />
    </div>
  )
}
