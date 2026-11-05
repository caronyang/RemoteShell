import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useFocusReturn } from './useFocusReturn'
import { Icon } from './Icon'
import { Button } from './Button'

export interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  /** 固定高度（px）；內容超過時 body 內部捲動（設定對話框 720x520 精準規格） */
  height?: number
}

/** 目前開啟中的 Modal（後開的在最上層）。Esc／focus trap 只由最上層處理。 */
let modalSeq = 0
const modalStack: number[] = []

/** 面板圓角 8px、控制項 4px；ESC 關閉、點遮罩關閉、開場聚焦第一個可聚焦元素 */
export function Modal({ open, title, onClose, children, footer, width = 480, height }: ModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const stackIdRef = useRef<number | null>(null)
  if (stackIdRef.current === null) stackIdRef.current = ++modalSeq
  useFocusReturn(open)

  /* v0.1.9 #3：呼叫端常傳 inline arrow，每次輸入 re-render 都是新 identity；
     focus 初始化 effect 只認 open，onClose 走 ref，避免每字重設焦點到頁籤。 */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const dialog = dialogRef.current
    const stackId = stackIdRef.current as number
    modalStack.push(stackId)
    const isTopmost = (): boolean => modalStack[modalStack.length - 1] === stackId
    const focusables = (): HTMLElement[] =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )

    const onKeyDown = (event: KeyboardEvent): void => {
      /* v0.1.4：巢狀 Modal 時只有最上層能處理 Esc／Tab（不依賴 listener 註冊順序） */
      if (!isTopmost()) return
      if (event.key === 'Escape') {
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      // 焦點陷阱：Tab / Shift+Tab 只在對話框內循環
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0] as HTMLElement
      const last = items[items.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    // 優先聚焦內容區第一個可聚焦元素（例如表單輸入），沒有才退回關閉鈕
    const bodyFirst = dialog?.querySelector<HTMLElement>(
      '.rs-modal__body button:not([disabled]), .rs-modal__body input:not([disabled]), .rs-modal__body select:not([disabled]), .rs-modal__body textarea:not([disabled]), .rs-modal__body [href]'
    )
    ;(bodyFirst ?? focusables()[0])?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = modalStack.lastIndexOf(stackId)
      if (index >= 0) modalStack.splice(index, 1)
    }
  }, [open])

  if (!open) return null

  /* P0 #2/#3：portal 到 body —— 對話框不留在 React 樹深處，
     任何祖先的 stacking context 都疊不到它頭上（.rs-modal z-index:50 > xterm link-layer z:2） */
  return createPortal(
    <div className="rs-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="rs-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={height !== undefined ? { width, height } : { width }}
        ref={dialogRef}
      >
        <header className="rs-modal__header">
          <h2>{title}</h2>
          <Button variant="ghost" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="close" />
          </Button>
        </header>
        <div className="rs-modal__body">{children}</div>
        {footer ? <footer className="rs-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}
