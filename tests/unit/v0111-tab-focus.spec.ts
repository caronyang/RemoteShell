import { describe, expect, it } from 'vitest'
import { firstFocus, focusAfterClose } from '../../src/renderer/features/terminal/tabFocus'

describe('v0.1.11 #1：混合分頁關閉後的焦點（R-18 補強）', () => {
  it('① 關 SFTP 留同 session console → activeId 回到 console', () => {
    const next = focusAfterClose(
      { terminals: ['a'], sftp: ['a'] },
      { sessionId: 'a', kind: 'sftp' },
      { activeId: null, sftpViewId: 'a' }
    )
    expect(next).toEqual({ activeId: 'a', sftpViewId: null })
  })

  it('② 關 console（非當前）留另一個 session 的 SFTP → 焦點不變', () => {
    const focus = { activeId: null, sftpViewId: 'b' }
    const next = focusAfterClose(
      { terminals: ['a', 'b'], sftp: ['b'] },
      { sessionId: 'a', kind: 'terminal' },
      focus
    )
    expect(next).toEqual(focus)
  })

  it('③ 關當前 SFTP 留異類 console → 跨類型聚焦', () => {
    const next = focusAfterClose(
      { terminals: ['a', 'b'], sftp: ['a'] },
      { sessionId: 'a', kind: 'sftp' },
      { activeId: null, sftpViewId: 'a' }
    )
    expect(next).toEqual({ activeId: 'b', sftpViewId: null })
  })

  it('④ 連環關至最後一個才允許 null（中間每一步都有存活焦點）', () => {
    const step1 = focusAfterClose(
      { terminals: ['a', 'b'], sftp: ['a'] },
      { sessionId: 'b', kind: 'terminal' },
      { activeId: 'b', sftpViewId: null }
    )
    expect(step1).toEqual({ activeId: null, sftpViewId: 'a' })

    const step2 = focusAfterClose(
      { terminals: ['a'], sftp: ['a'] },
      { sessionId: 'a', kind: 'sftp' },
      step1
    )
    expect(step2).toEqual({ activeId: 'a', sftpViewId: null })

    const step3 = focusAfterClose(
      { terminals: ['a'], sftp: [] },
      { sessionId: 'a', kind: 'terminal' },
      step2
    )
    expect(step3).toEqual({ activeId: null, sftpViewId: null })
  })

  it('關非當前分頁 → 焦點完全不變；firstFocus 只在 0 個時回 null', () => {
    const focus = { activeId: 'a', sftpViewId: null }
    expect(
      focusAfterClose({ terminals: ['a', 'b', 'c'], sftp: [] }, { sessionId: 'c', kind: 'terminal' }, focus)
    ).toEqual(focus)
    expect(firstFocus({ terminals: ['a'], sftp: [] })).toEqual({ activeId: 'a', sftpViewId: null })
    expect(firstFocus({ terminals: [], sftp: ['s'] })).toEqual({ activeId: null, sftpViewId: 's' })
    expect(firstFocus({ terminals: [], sftp: [] })).toEqual({ activeId: null, sftpViewId: null })
  })

  it('關終端分頁會同時移除同 session SFTP 孿生，右鄰優先', () => {
    const next = focusAfterClose(
      { terminals: ['a', 'b', 'c'], sftp: ['a', 'c'] },
      { sessionId: 'b', kind: 'terminal' },
      { activeId: 'b', sftpViewId: null }
    )
    expect(next).toEqual({ activeId: 'c', sftpViewId: null })
  })
})
