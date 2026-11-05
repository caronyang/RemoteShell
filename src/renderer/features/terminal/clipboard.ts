import type { Terminal } from '@xterm/xterm'

/**
 * v0.1.10 #2 終端剪貼簿（Windows 互通）：
 * renderer 走 navigator.clipboard（Electron = Chromium，預設權限允許）；
 * 任何失敗（權限被拒／非安全環境／無選取）一律拋錯，由呼叫端 toast —— 不可靜默。
 */
export async function readClipboardText(): Promise<string> {
  if (!navigator.clipboard?.readText) throw new Error('clipboard read unavailable')
  return navigator.clipboard.readText()
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('clipboard write unavailable')
  await navigator.clipboard.writeText(text)
}

/** Ctrl+C／選單「複製」：複製選取文字；不清除選取（PM 裁決：複製後保留選取） */
export async function copyTerminalSelection(term: Terminal | null): Promise<void> {
  const selected = term?.getSelection() ?? ''
  if (!selected) throw new Error('no selection')
  await writeClipboardText(selected)
}

/**
 * Ctrl+V／選單「貼上」：交給 xterm.paste() —— 它負責 \n→\r、依 shell 的
 * bracketed-paste 模式自動包裹（不破壞 shell）、CJK 字串原樣送入。
 */
export async function pasteIntoTerminal(term: Terminal | null): Promise<void> {
  if (!term) throw new Error('no terminal')
  const text = await readClipboardText()
  term.paste(text)
}
