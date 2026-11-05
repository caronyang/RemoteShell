import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppSettings, SessionInfo } from '../../../shared/ipc-contract'
import { useToast } from '../../components/Toast'
import { copyTerminalSelection, pasteIntoTerminal } from './clipboard'
import { useTerminal } from './useTerminal'

export interface TerminalViewProps {
  session: SessionInfo
  settings: AppSettings
  active: boolean
}

interface MenuState {
  x: number
  y: number
  canCopy: boolean
}

/** 一個分頁 = 一個 xterm 實例（keep-alive：非 active 只隱藏，不銷毀）
 *  v0.1.10 #2：右鍵選單（複製/貼上）＋ Ctrl+C/Ctrl+V 見 useTerminal/clipboard。 */
export function TerminalView({ session, settings, active }: TerminalViewProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const { containerRef, termRef } = useTerminal({ session, settings, active })
  const [menu, setMenu] = useState<MenuState | null>(null)

  const closeMenu = (): void => setMenu(null)

  /* Esc 關閉選單（不動終端焦點 —— 選單 mousedown 一律 preventDefault，焦點不離開終端） */
  useEffect(() => {
    if (menu === null) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [menu])

  const denied = (): void => toast.show(t('terminal.clipboardDenied'), 'error')

  const runCopy = (): void => {
    closeMenu()
    void copyTerminalSelection(termRef.current).catch(denied)
  }

  const runPaste = (): void => {
    closeMenu()
    void pasteIntoTerminal(termRef.current).catch(denied)
  }

  return (
    <div
      className="rs-terminal__pane"
      style={{ display: active ? 'block' : 'none' }}
      data-session-id={session.sessionId}
      onContextMenu={(event) => {
        if (!active) return
        event.preventDefault()
        /* 貼齊 #11 慣例：依視窗邊界收斂（選單 min-width 220） */
        const x = Math.max(0, Math.min(event.clientX, window.innerWidth - 230))
        const y = Math.max(0, Math.min(event.clientY, window.innerHeight - 80))
        setMenu({ x, y, canCopy: Boolean(termRef.current?.hasSelection()) })
      }}
    >
      <div className="rs-terminal__xterm" ref={containerRef} />
      {menu !== null ? <div className="rs-sftp__mask" onMouseDown={closeMenu} /> : null}
      {menu !== null ? (
        <div
          className="rs-menu__list"
          role="menu"
          aria-label={t('menu.edit')}
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 70 }}
          /* mousedown 不搶焦點：終端的 focus 全程不被打斷（無障礙批要求保留） */
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="rs-menu__item"
            disabled={!menu.canCopy}
            onClick={runCopy}
          >
            {t('menu.edit.copy')}
          </button>
          <button type="button" role="menuitem" className="rs-menu__item" onClick={runPaste}>
            {t('menu.edit.paste')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
