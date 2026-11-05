import { useTranslation } from 'react-i18next'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'

/** 標題列 32px：拖曳區 + 視窗控制項（frame:false，全部走 window.rs 白名單 API） */
export function TitleBar(): JSX.Element {
  const { t } = useTranslation()

  const minimize = (): void => {
    void window.rs.window.minimize()
  }
  const toggleMaximize = (): void => {
    void window.rs.window.toggleMaximize()
  }
  const close = (): void => {
    void window.rs.window.close()
  }

  return (
    <header className="rs-titlebar">
      <Icon name="terminal" size={14} />
      <span className="rs-titlebar__title">{t('app.windowTitle')}</span>
      <div className="rs-titlebar__controls">
        <Button variant="ghost" aria-label={t('titlebar.minimize')} icon="minimize" onClick={minimize} />
        <Button variant="ghost" aria-label={t('titlebar.maximize')} icon="maximize" onClick={toggleMaximize} />
        <Button variant="ghost" aria-label={t('titlebar.close')} icon="close" onClick={close} />
      </div>
    </header>
  )
}
