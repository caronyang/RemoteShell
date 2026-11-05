import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { decideConflict, renamedPath } from '../../src/main/queue/conflict'

describe('M3-06 衝突決策（skip / overwrite / rename）', () => {
  it('沒有衝突 → copy', () => {
    expect(decideConflict('ask', undefined, 'a', '/remote/a', false)).toBe('copy')
  })

  it('全域策略：overwrite / skip / rename', () => {
    expect(decideConflict('overwrite', undefined, 'a', '/remote/a', true)).toBe('copy')
    expect(decideConflict('skip', undefined, 'a', '/remote/a', true)).toBe('skip')
    expect(decideConflict('rename', undefined, 'a', '/remote/a', true)).toBe('rename')
  })

  it('逐項決策優先於全域策略（key 可用 target 或 source→target）', () => {
    expect(decideConflict('overwrite', { '/remote/a': 'skip' }, 'a', '/remote/a', true)).toBe('skip')
    expect(decideConflict('overwrite', { 'a→/remote/a': 'rename' }, 'a', '/remote/a', true)).toBe('rename')
  })

  it('ask 但沒有逐項決策 → 保守跳過（不覆寫使用者資料）', () => {
    expect(decideConflict('ask', undefined, 'a', '/remote/a', true)).toBe('skip')
    expect(decideConflict('ask', { '/remote/a': 'overwrite' }, 'a', '/remote/a', true)).toBe('copy')
  })

  it('renamedPath：file.ext → file(1).ext → file(2).ext（遠端用 posix）', () => {
    const taken = new Set(['/r/report.pdf', '/r/report(1).pdf'])
    const first = renamedPath('/r/report.pdf', (candidate) => taken.has(candidate), true)
    expect(first).toBe('/r/report(2).pdf')
    taken.add(first)
    expect(renamedPath('/r/report.pdf', (candidate) => taken.has(candidate), true)).toBe('/r/report(3).pdf')
  })

  it('renamedPath：無副檔名與本地路徑（Windows 分隔符）', () => {
    expect(renamedPath('C:\\dl\\README', (c) => c === 'C:\\dl\\README', false)).toBe(
      path.join('C:\\dl', 'README(1)')
    )
    expect(renamedPath('/r/archive.tar.gz', (c) => c === '/r/archive.tar.gz', true)).toBe('/r/archive.tar(1).gz')
  })
})
