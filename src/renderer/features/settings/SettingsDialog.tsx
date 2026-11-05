import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo, AppSettings, DeepPartial } from '../../../shared/ipc-contract'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import { AboutPane } from './AboutPane'
import { GeneralPane, type PaneProps } from './GeneralPane'
import { LanguagePane } from './LanguagePane'
import { TerminalPane } from './TerminalPane'
import { TransferPane } from './TransferPane'

export type SettingsPaneId = 'general' | 'terminal' | 'transfer' | 'language' | 'about'

export interface SettingsDialogProps {
  open: boolean
  settings: AppSettings
  info: AppInfo | null
  initialPane?: SettingsPaneId
  onPatch: (patch: DeepPartial<AppSettings>) => void
  onClose: () => void
}

const PANE_ORDER: SettingsPaneId[] = ['general', 'terminal', 'transfer', 'language', 'about']
const PANE_KEY: Record<SettingsPaneId, string> = {
  general: 'settings.category.general',
  terminal: 'settings.category.terminal',
  transfer: 'settings.category.transfer',
  language: 'settings.category.language',
  about: 'settings.category.about'
}

/** M4-02 全域設定對話框（UI-05）：720x520，左分類右內容；語言切換立即生效、不需重啟 */
export function SettingsDialog({ open, settings, info, initialPane, onPatch, onClose }: SettingsDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  const toast = useToast()
  const [pane, setPane] = useState<SettingsPaneId>(initialPane ?? 'general')
  /* v0.1.4：Restore defaults 是破壞性操作，改用 ConfirmDialog（不用 window.confirm 阻塞 renderer） */
  const [confirmReset, setConfirmReset] = useState(false)

  const resetSettings = (): void => {
    setConfirmReset(false)
    void (async () => {
      const result = await window.rs.settings.reset()
      if (result.ok) toast.show(t('settings.reset'), 'success')
      else toast.show(t(result.error.i18nKey), 'error')
    })()
  }

  // reopen with the requested pane (menu / About entry)
  useEffect(() => {
    if (open) setPane(initialPane ?? 'general')
  }, [open, initialPane])

  const paneProps: PaneProps = { settings, onPatch }

  return (
    <>
    <Modal
      open={open}
      title={t(PANE_KEY[pane])}
      width={720}
      height={520}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            title={t('settings.reset')}
            onClick={() => setConfirmReset(true)}
          >
            {t('settings.reset')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="rs-settings">
        <nav className="rs-settings__nav" aria-label={t('settings.category.general')}>
          {PANE_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              className={`rs-settings__navitem${pane === id ? ' is-active' : ''}`}
              aria-current={pane === id ? 'page' : undefined}
              onClick={() => setPane(id)}
            >
              {t(PANE_KEY[id])}
            </button>
          ))}
        </nav>
        <div className="rs-settings__content">
          {pane === 'general' ? <GeneralPane {...paneProps} /> : null}
          {pane === 'terminal' ? <TerminalPane {...paneProps} /> : null}
          {pane === 'transfer' ? <TransferPane {...paneProps} /> : null}
          {pane === 'language' ? <LanguagePane {...paneProps} /> : null}
          {pane === 'about' ? <AboutPane info={info} /> : null}
        </div>
      </div>
    </Modal>
    <ConfirmDialog
      open={confirmReset}
      title={t('settings.reset')}
      message={t('settings.resetConfirm')}
      confirmLabel={t('settings.reset')}
      onCancel={() => setConfirmReset(false)}
      onConfirm={resetSettings}
    />
    </>
  )
}
