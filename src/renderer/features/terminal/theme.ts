import type { ITheme } from '@xterm/xterm'

/**
 * xterm 主題一律吃 tokens.css 的變數（不得在 TS 內硬編色碼）。
 * 16 色 ANSI 交給 xterm 預設（design tokens 目前只定義 bg/fg）。
 */
export function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

export function terminalTheme(): ITheme {
  return {
    background: readToken('--terminal-bg', ''),
    foreground: readToken('--terminal-fg', '')
  }
}

export function terminalFontFamily(): string {
  return readToken('--font-terminal', 'Consolas, monospace')
}
