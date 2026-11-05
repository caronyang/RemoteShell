import { describe, expect, it } from 'vitest'
import { neighborAfterClose } from '../../src/renderer/features/terminal/tabNeighbor'

describe('v0.1.10 #3：關閉分頁後的焦點轉移（R-18）', () => {
  it('關閉當前分頁 → 右側相鄰優先', () => {
    expect(neighborAfterClose(['a', 'b', 'c'], 'b', 'b')).toBe('c')
    expect(neighborAfterClose(['a', 'b', 'c'], 'a', 'a')).toBe('b')
  })

  it('右側沒有存活分頁 → 左側備援', () => {
    expect(neighborAfterClose(['a', 'b', 'c'], 'c', 'c')).toBe('b')
    expect(neighborAfterClose(['only-left', 'target'], 'target', 'target')).toBe('only-left')
  })

  it('只剩 0 個分頁 → 回空狀態（null）', () => {
    expect(neighborAfterClose(['a'], 'a', 'a')).toBeNull()
  })

  it('關閉非當前分頁 → active 不換', () => {
    expect(neighborAfterClose(['a', 'b', 'c'], 'c', 'a')).toBe('a')
    expect(neighborAfterClose(['a', 'b', 'c'], 'a', 'b')).toBe('b')
  })

  it('SFTP／終端共用同一規則（id 清單由呼叫端決定）', () => {
    expect(neighborAfterClose(['sftp-a', 'sftp-b'], 'sftp-a', 'sftp-a')).toBe('sftp-b')
    expect(neighborAfterClose(['term-a', 'term-b'], 'term-b', 'term-b')).toBe('term-a')
  })
})
