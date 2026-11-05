import { useTranslation } from 'react-i18next'
import type { Locale } from '../../../shared/ipc-contract'
import type { PaneProps } from './GeneralPane'

/** M4-02 語言分頁（UI-05 §語言，G-3）：單選卡片，選取即時生效（settings.onChange 同步到全域） */
export function LanguagePane({ settings, onPatch }: PaneProps): JSX.Element {
  const { t } = useTranslation()
  const languages: Array<{ id: Locale; label: string }> = [
    { id: 'en-US', label: t('settings.language.english') },
    { id: 'zh-TW', label: t('settings.language.traditionalChinese') }
  ]
  return (
    <div className="rs-settings__pane">
      <p className="rs-field__label">{t('settings.language.title')}</p>
      <div className="rs-settings__radios" role="radiogroup" aria-label={t('settings.language.title')}>
        {languages.map((language) => (
          <label key={language.id} className={`rs-settings__card${settings.locale === language.id ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name="locale"
              value={language.id}
              checked={settings.locale === language.id}
              onChange={() => onPatch({ locale: language.id })}
            />
            {language.label}
          </label>
        ))}
      </div>
      <p className="rs-hint">{t('settings.language.immediate')}</p>
      <p className="rs-hint">{t('settings.language.hint')}</p>
      <p className="rs-hint">{`${t('statusBar.encoding')}: UTF-8`}</p>
    </div>
  )
}
