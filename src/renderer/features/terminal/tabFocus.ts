/**
 * v0.1.11 #1：混合「終端分頁＋SFTP 分頁」的關閉聚焦規則。
 * 合併順序＝終端分頁（原序）→ SFTP 分頁（原序）。
 * - 關終端分頁時，同步移除同 session 的 SFTP 孿生分頁
 * - 只有被關分頁原本有焦點才轉移
 * - 右鄰 → 左鄰 → 第一個存活分頁 → {activeId:null, sftpViewId:null}
 */
export interface TabLists {
  terminals: readonly string[]
  sftp: readonly string[]
}

export interface TabFocus {
  activeId: string | null
  sftpViewId: string | null
}

export interface ClosingTab {
  sessionId: string
  kind: 'terminal' | 'sftp'
}

const terminalToken = (id: string): string => `t:${id}`
const sftpToken = (id: string): string => `s:${id}`

function tokens(lists: TabLists): string[] {
  return [...lists.terminals.map(terminalToken), ...lists.sftp.map(sftpToken)]
}

function focusFromToken(token: string): TabFocus {
  if (token.startsWith('t:')) return { activeId: token.slice(2), sftpViewId: null }
  return { activeId: null, sftpViewId: token.slice(2) }
}

/** 第一個存活分頁（終端優先，其次 SFTP）；都沒有回 null/null */
export function firstFocus(lists: TabLists): TabFocus {
  if (lists.terminals.length > 0) return { activeId: lists.terminals[0] as string, sftpViewId: null }
  if (lists.sftp.length > 0) return { activeId: null, sftpViewId: lists.sftp[0] as string }
  return { activeId: null, sftpViewId: null }
}

export function focusAfterClose(lists: TabLists, closing: ClosingTab, focus: TabFocus): TabFocus {
  const all = tokens(lists)
  const closingTokens =
    closing.kind === 'terminal'
      ? [terminalToken(closing.sessionId), sftpToken(closing.sessionId)]
      : [sftpToken(closing.sessionId)]

  const focusedToken =
    focus.sftpViewId !== null
      ? sftpToken(focus.sftpViewId)
      : focus.activeId !== null
        ? terminalToken(focus.activeId)
        : null

  /* 關非當前（含背景分頁）→ 不換焦點；呼叫端仍需移除分頁本體 */
  if (focusedToken === null || !closingTokens.includes(focusedToken)) return focus

  const remaining = all.filter((token) => !closingTokens.includes(token))
  if (remaining.length === 0) return { activeId: null, sftpViewId: null }

  const focusedIndex = all.indexOf(focusedToken)
  const right = remaining.find((token) => all.indexOf(token) > focusedIndex)
  if (right) return focusFromToken(right)
  const left = [...remaining].reverse().find((token) => all.indexOf(token) < focusedIndex)
  if (left) return focusFromToken(left)
  return focusFromToken(remaining[0] as string)
}
