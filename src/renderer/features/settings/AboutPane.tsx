import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../../shared/ipc-contract'
import { Button } from '../../components/Button'

export interface AboutPaneProps {
  info: AppInfo | null
}

/**
 * M4-02 關於分頁（UI-05 §關於）：Logo（UI-06 Prompt Tunnel，inline SVG 不連網）+
 * 版本、引擎、授權宣告、檢查更新
 */
export function AboutPane({ info }: AboutPaneProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rs-settings__pane">
      {/* UI-06-LOGO「Prompt Tunnel」：> 提示字元 + 三節點連線鏈（末端綠點），漸層 tile。
          色票依 UI-06 固定 artwork，定義於 base.css（避免 TSX 硬編色值觸发 lint） */}
      <div className="rs-about__brand">
        <svg className="rs-about__logo" viewBox="0 0 128 128" role="img" aria-label="RemoteShell logo">
          <defs>
            <linearGradient id="rs-logo-tile" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" className="rs-logo__stop-a" />
              <stop offset="1" className="rs-logo__stop-b" />
            </linearGradient>
          </defs>
          <rect className="rs-logo__tile" x="0" y="0" width="128" height="128" rx="28" />
          <path className="rs-logo__prompt" d="M34 38 L64 62 L34 86" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <line className="rs-logo__link" x1="60" y1="98" x2="104" y2="98" strokeLinecap="round" />
          <circle className="rs-logo__dot" cx="60" cy="98" r="9" />
          <circle className="rs-logo__dot" cx="82" cy="98" r="9" />
          <circle className="rs-logo__dot rs-logo__dot--end" cx="104" cy="98" r="9" />
        </svg>
        <span className="rs-about__name">RemoteShell</span>
      </div>
      <dl className="rs-kv">
        <dt>{t('settings.about.version')}</dt>
        <dd className="rs-mono">{info ? `RemoteShell v${info.version}` : t('common.unknown')}</dd>
        <dt>{t('settings.about.engine')}</dt>
        <dd className="rs-mono">
          {info ? `ssh2 ${info.sshEngine} · Electron ${info.electron} · Node ${info.node}` : t('common.unknown')}
        </dd>
        <dt>{t('settings.about.license')}</dt>
        <dd>{t('settings.about.fontLicense')}</dd>
        <dt>{t('settings.about.fonts')}</dt>
        {/* 字型名為產品專有名詞（同 RemoteShell），不翻譯 */}
        <dd className="rs-mono">Cascadia Mono · Noto Sans Mono CJK TC</dd>
        <dt>{t('settings.about.fontFiles')}</dt>
        <dd className="rs-mono">OFL-CascadiaMono.txt · OFL-NotoSansMonoCJK.txt</dd>
      </dl>
      {/* TODO(M4): no update-check IPC in the contract yet */}
      <Button disabled title={t('settings.about.checkUpdates')}>
        {t('settings.about.checkUpdates')}
      </Button>
    </div>
  )
}
