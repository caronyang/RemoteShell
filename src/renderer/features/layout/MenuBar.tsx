import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../components/Icon'
import type { Locale } from '../../../shared/ipc-contract'

interface MenuEntry {
  key: string
  items: Array<{ key: string; action?: 'exit' | 'language-en' | 'language-zh' | 'settings' | 'about' | 'new-connection'; disabled?: boolean }>
}

const MENUS: MenuEntry[] = [
  {
    key: 'menu.file',
    items: [
      /* FAIL-3：匯入/匯出設定 M4 未實作，依主管裁示移除死選項（key 保留給後續里程碑） */
      { key: 'menu.file.quickConnect', action: 'new-connection' },
      { key: 'menu.file.newConnection', action: 'new-connection' },
      { key: 'menu.file.exit', action: 'exit' }
    ]
  },
  {
    key: 'menu.edit',
    items: [
      { key: 'menu.edit.copy', disabled: true },
      { key: 'menu.edit.paste', disabled: true },
      { key: 'menu.edit.selectAll', disabled: true },
      { key: 'menu.edit.settings', action: 'settings' }
    ]
  },
  {
    key: 'menu.view',
    items: [
      { key: 'menu.view.connectionList', disabled: true },
      { key: 'menu.view.transferQueue', disabled: true },
      { key: 'menu.view.fontIncrease', disabled: true },
      { key: 'menu.view.fontDecrease', disabled: true },
      { key: 'menu.view.colorScheme', disabled: true }
    ]
  },
  {
    key: 'menu.connection',
    items: [
      /* FAIL-3：Connection 選單也可開新增連線 */
      { key: 'tree.context.newConnection', action: 'new-connection' },
      { key: 'menu.connection.connect', disabled: true },
      { key: 'menu.connection.disconnect', disabled: true },
      { key: 'menu.connection.reconnect', disabled: true },
      { key: 'menu.connection.rename', disabled: true },
      { key: 'menu.connection.properties', disabled: true }
    ]
  },
  {
    key: 'menu.transfer',
    items: [
      { key: 'menu.transfer.openSftp', disabled: true },
      { key: 'menu.transfer.upload', disabled: true },
      { key: 'menu.transfer.download', disabled: true },
      { key: 'menu.transfer.queue', disabled: true }
    ]
  },
  {
    key: 'menu.tools',
    items: [
      { key: 'menu.tools.languageEnglish', action: 'language-en' },
      { key: 'menu.tools.languageTraditionalChinese', action: 'language-zh' },
      { key: 'menu.tools.checkUpdates', disabled: true }
    ]
  },
  {
    key: 'menu.help',
    items: [
      { key: 'menu.help.userGuide', disabled: true },
      { key: 'menu.help.about', action: 'about' }
    ]
  }
]

export interface MenuBarProps {
  locale: Locale
  onLocaleChange: (locale: Locale) => void
  /** 開啟設定對話框（UI-05 入口）；pane='about' 直達關於頁 */
  onOpenSettings: (pane: 'general' | 'about') => void
  /** FAIL-3：新增連線／快速連線入口（契約無 profile-less connect，快速連線暫同此入口） */
  onNewConnection: () => void
}

/** 功能表列 26px + 右上語言切換器（UI-05 入口 1） */
export function MenuBar({ locale, onLocaleChange, onOpenSettings, onNewConnection }: MenuBarProps): JSX.Element {
  const { t } = useTranslation()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [langOpen, setLangOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenKey(null)
        setLangOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const runAction = (action?: string): void => {
    setOpenKey(null)
    setLangOpen(false)
    if (action === 'exit') void window.rs.window.close()
    if (action === 'language-en') onLocaleChange('en-US')
    if (action === 'language-zh') onLocaleChange('zh-TW')
    if (action === 'settings') onOpenSettings('general')
    if (action === 'about') onOpenSettings('about')
    if (action === 'new-connection') onNewConnection()
  }

  return (
    <div className="rs-menubar" ref={rootRef}>
      {MENUS.map((menu) => (
        <div key={menu.key} className="rs-menu">
          <button
            type="button"
            className="rs-menu__title"
            aria-haspopup="menu"
            aria-expanded={openKey === menu.key}
            onClick={() => setOpenKey((prev) => (prev === menu.key ? null : menu.key))}
          >
            {t(menu.key)}
          </button>
          {openKey === menu.key ? (
            <ul className="rs-menu__list" role="menu">
              {menu.items.map((item) => (
                <li key={item.key} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="rs-menu__item"
                    disabled={item.disabled}
                    onClick={() => runAction(item.action)}
                  >
                    {t(item.key)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      <div className="rs-menubar__spacer" />
      <div className="rs-menu">
        <button
          type="button"
          className="rs-menu__title"
          aria-haspopup="menu"
          aria-expanded={langOpen}
          onClick={() => setLangOpen((prev) => !prev)}
        >
          <Icon name="globe" size={14} />
          {t(locale === 'en-US' ? 'language.shortEn' : 'language.shortZh')}
        </button>
        {langOpen ? (
          <ul className="rs-menu__list rs-menu__list--right" role="menu">
            <li role="none">
              <button type="button" role="menuitem" className="rs-menu__item" onClick={() => runAction('language-en')}>
                {t('menu.tools.languageEnglish')}
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" className="rs-menu__item" onClick={() => runAction('language-zh')}>
                {t('menu.tools.languageTraditionalChinese')}
              </button>
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  )
}
