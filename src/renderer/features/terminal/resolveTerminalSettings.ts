import type { AppSettings, TerminalOverride } from '../../../shared/ipc-contract'

/**
 * 終端設定「讀」端（CodeReview 跨卡 #13 的第二半）：
 * profile.terminal 的六個欄位逐欄 fallback —— profile 有值用 profile，沒有才用全域 settings.terminal。
 * 欄位名兩端都是契約命名（themeId；dialog state 只在編輯時叫 theme，映射在 ConnectionDialog 存檔端）。
 * 注意：ambiguousWidth 不在 TerminalOverride（契約無此欄）→ 恆用全域。
 */
export function resolveTerminalSettings(
  global: AppSettings['terminal'],
  profile?: TerminalOverride
): AppSettings['terminal'] {
  if (!profile) return global
  return {
    fontFamily: profile.fontFamily ?? global.fontFamily,
    fontSize: profile.fontSize ?? global.fontSize,
    themeId: profile.themeId ?? global.themeId,
    scrollback: profile.scrollback ?? global.scrollback,
    cursorStyle: profile.cursorStyle ?? global.cursorStyle,
    cursorBlink: profile.cursorBlink ?? global.cursorBlink,
    ambiguousWidth: global.ambiguousWidth
  }
}
