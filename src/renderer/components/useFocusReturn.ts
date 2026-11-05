import { useEffect, useRef } from 'react'

/**
 * M4-05 無障礙：對話框焦點回歸。
 * 開啟時記住觸發元素（document.activeElement），關閉（含直接 unmount）後把焦點還回去，
 * 覆蓋「按鈕開啟 → 關閉 → 焦點留在原按鈕」的 QA 項目（design README 鍵盤可操作）。
 *
 * v0.1.9：有些對話框是「開啟才 mount」（ConnectionDialog 內的 Modal），關閉時是 unmount
 * 而不是 open=false render；因此回歸要放在 effect cleanup，unmount 才會執行。
 */
export function useFocusReturn(open: boolean): void {
  const trigger = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpen.current = false
      return undefined
    }
    if (!wasOpen.current) {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      wasOpen.current = true
    }
    return () => {
      const element = trigger.current
      trigger.current = null
      wasOpen.current = false
      if (element && element.isConnected) element.focus()
    }
  }, [open])
}
