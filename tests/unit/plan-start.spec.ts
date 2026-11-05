import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTransferTasks } from '../../src/main/queue/plan-start'
import type { ConflictPolicy, TransferTask } from '../../src/shared/ipc-contract'

let seq = 0
const newId = (): string => `id-${++seq}`

const file = (target: string, size = 10) => ({ source: `local/${path.basename(target)}`, target, size })

interface Options {
  policy?: ConflictPolicy
  decisions?: Record<string, Exclude<ConflictPolicy, 'ask'>>
  existing?: string[]
  isRemoteTarget?: boolean
  items?: Parameters<typeof buildTransferTasks>[0]['items']
}

async function build(options: Options = {}) {
  const existing = new Set(options.existing ?? [])
  return buildTransferTasks({
    sessionId: 's1',
    connectionLabel: 'prod-web-01 (經 gw-edge)',
    direction: 'upload',
    now: '2026-10-30T00:00:00.000Z',
    items: options.items ?? [
      { source: 'local/dir', target: '/remote/dir', isDirectory: false, files: [file('/remote/a.txt')] }
    ],
    policy: options.policy ?? 'overwrite',
    ...(options.decisions ? { decisions: options.decisions } : {}),
    isRemoteTarget: options.isRemoteTarget ?? true,
    targetExists: async (candidate) => existing.has(candidate),
    newId
  })
}

beforeEach(() => {
  seq = 0
})

describe('M3-06 start() 的衝突決策（skip / rename / overwrite）', () => {
  it('decisions=skip → 不建立任務，並回報被跳過的路徑', async () => {
    const result = await build({ existing: ['/remote/a.txt'], decisions: { '/remote/a.txt': 'skip' } })
    expect(result.tasks).toHaveLength(0)
    expect(result.skipped).toEqual(['/remote/a.txt'])
  })

  it('decisions=rename → target 改寫成 a(1).txt', async () => {
    const result = await build({ existing: ['/remote/a.txt'], decisions: { '/remote/a.txt': 'rename' } })
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]?.target).toBe('/remote/a(1).txt')
    expect(result.skipped).toEqual([])
  })

  it('rename 會跳過已被佔用的候選名（a(1) 也存在 → a(2)）', async () => {
    const result = await build({
      existing: ['/remote/a.txt', '/remote/a(1).txt'],
      decisions: { '/remote/a.txt': 'rename' }
    })
    expect(result.tasks[0]?.target).toBe('/remote/a(2).txt')
  })

  it('decisions=overwrite → target 不變（照舊覆寫）', async () => {
    const result = await build({ existing: ['/remote/a.txt'], decisions: { '/remote/a.txt': 'overwrite' } })
    expect(result.tasks[0]?.target).toBe('/remote/a.txt')
  })

  it('沒有逐項決策時套用全域 policy（skip 全部略過 / rename 全部改名）', async () => {
    const skipAll = await build({ existing: ['/remote/a.txt'], policy: 'skip' })
    expect(skipAll.tasks).toHaveLength(0)
    expect(skipAll.skipped).toEqual(['/remote/a.txt'])

    const renameAll = await build({ existing: ['/remote/a.txt'], policy: 'rename' })
    expect(renameAll.tasks[0]?.target).toBe('/remote/a(1).txt')
  })

  it('ask 但沒有逐項決策 → 保守跳過（不覆寫使用者資料）', async () => {
    const result = await build({ existing: ['/remote/a.txt'], policy: 'ask' })
    expect(result.tasks).toHaveLength(0)
    expect(result.skipped).toEqual(['/remote/a.txt'])
  })

  it('下載方向（本地目標）用本地改名規則', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-plan-'))
    const existing = path.join(dir, 'b.txt')
    fs.writeFileSync(existing, 'x')
    const result = await build({
      isRemoteTarget: false,
      policy: 'rename',
      existing: [existing],
      items: [
        {
          source: '/remote/b.txt',
          target: existing,
          isDirectory: false,
          files: [{ source: '/remote/b.txt', target: existing, size: 5 }]
        }
      ]
    })
    expect(result.tasks[0]?.target).toBe(path.join(dir, 'b(1).txt'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('M3-02 start() 的目錄任務（一列 + children）', () => {
  it('目錄 → 1 父列（isDirectory、totalBytes=子檔總和、children）+ N 子任務（parentId）', async () => {
    const items = [
      {
        source: 'local/dir',
        target: '/remote/dir',
        isDirectory: true,
        files: [file('/remote/dir/a.txt', 100), file('/remote/dir/b.txt', 200)]
      }
    ]
    const result = await build({ items })
    const parents = result.tasks.filter((t) => t.isDirectory)
    const children = result.tasks.filter((t) => t.parentId)

    expect(parents).toHaveLength(1)
    expect(children).toHaveLength(2)
    const parent = parents[0] as TransferTask
    expect(parent.totalBytes).toBe(300)
    expect(parent.children?.map((c) => c.size)).toEqual([100, 200])
    expect(parent.children?.every((c) => children.some((child) => child.taskId === c.taskId))).toBe(true)
    expect(children.every((child) => child.parentId === parent.taskId)).toBe(true)
    // 父列排在最前面（UI 的列順序）
    expect(result.tasks[0]?.taskId).toBe(parent.taskId)
  })

  it('目錄裡被 skip 的檔案不進 children，父列 totalBytes 只算實際要傳的', async () => {
    const items = [
      {
        source: 'local/dir',
        target: '/remote/dir',
        isDirectory: true,
        files: [file('/remote/dir/a.txt', 100), file('/remote/dir/b.txt', 200)]
      }
    ]
    const result = await build({ items, existing: ['/remote/dir/b.txt'], policy: 'skip' })
    const parent = result.tasks.find((t) => t.isDirectory) as TransferTask
    expect(parent.children).toHaveLength(1)
    expect(parent.totalBytes).toBe(100)
    expect(result.skipped).toEqual(['/remote/dir/b.txt'])
  })

  it('單檔輸入不會產生父列', async () => {
    const result = await build()
    expect(result.tasks.filter((t) => t.isDirectory)).toHaveLength(0)
    expect(result.tasks[0]?.parentId).toBeUndefined()
  })

  it('空目錄不建立父列（QA P2-01v2-1：避免永遠 queued）', async () => {
    const result = await build({
      items: [{ source: 'local/empty', target: '/remote/empty', isDirectory: true, files: [] }]
    })
    expect(result.tasks).toHaveLength(0)
    expect(result.skipped).toEqual([])
  })
})

describe('QA P1-03 目錄層決策要下傳到子檔（UI 只送目錄 key）', () => {
  const dirFiles = [file('/remote/dir/x.txt', 10), file('/remote/dir/y.txt', 20)]
  const dirItem = (source = 'local/dir', target = '/remote/dir', files = dirFiles) => ({
    source,
    target,
    isDirectory: true,
    files
  })

  it('目錄層 overwrite → 兩個同名衝突檔都不改名（都會覆寫）', async () => {
    const result = await build({
      items: [dirItem()],
      existing: ['/remote/dir/x.txt', '/remote/dir/y.txt'],
      decisions: { 'local/dir→/remote/dir': 'overwrite' }
    })
    const children = result.tasks.filter((t) => t.parentId)
    expect(children.map((t) => t.target).sort()).toEqual(['/remote/dir/x.txt', '/remote/dir/y.txt'])
    expect(result.skipped).toEqual([])
  })

  it('目錄層 rename → 兩個衝突檔各自改名 x(1)/y(1)，互不撞名', async () => {
    const result = await build({
      items: [dirItem()],
      existing: ['/remote/dir/x.txt', '/remote/dir/y.txt'],
      decisions: { 'local/dir→/remote/dir': 'rename' }
    })
    const children = result.tasks.filter((t) => t.parentId)
    expect(children.map((t) => t.target).sort()).toEqual(['/remote/dir/x(1).txt', '/remote/dir/y(1).txt'])
    expect(new Set(children.map((t) => t.target)).size).toBe(2)
  })

  it('目錄層 skip → 該目錄 0 子任務，其他目錄不受影響', async () => {
    const otherFiles = [file('/remote/other/a.txt', 5)]
    const result = await build({
      items: [dirItem(), dirItem('local/other', '/remote/other', otherFiles)],
      existing: ['/remote/dir/x.txt', '/remote/dir/y.txt'],
      decisions: { 'local/dir→/remote/dir': 'skip' }
    })
    expect(result.tasks.filter((t) => t.parentId && t.target.startsWith('/remote/dir/'))).toHaveLength(0)
    expect(result.tasks.filter((t) => t.isDirectory).map((t) => t.target)).toEqual(['/remote/other'])
    expect(result.tasks.filter((t) => t.target === '/remote/other/a.txt')).toHaveLength(1)
    expect(result.skipped).toEqual(['/remote/dir'])
  })

  it('檔層決策優先於目錄層決策', async () => {
    const result = await build({
      items: [dirItem()],
      existing: ['/remote/dir/x.txt', '/remote/dir/y.txt'],
      decisions: {
        'local/dir→/remote/dir': 'overwrite',
        'local/x.txt→/remote/dir/x.txt': 'skip'
      }
    })
    const children = result.tasks.filter((t) => t.parentId)
    expect(children.map((t) => t.target)).toEqual(['/remote/dir/y.txt'])
    expect(result.skipped).toEqual(['/remote/dir/x.txt'])
  })

  it('目錄本身已存在、子檔無衝突且父決策 rename → 改目錄根，子檔搬到新根', async () => {
    const result = await build({
      items: [dirItem()],
      existing: ['/remote/dir'],
      decisions: { 'local/dir→/remote/dir': 'rename' }
    })
    const parent = result.tasks.find((t) => t.isDirectory)
    expect(parent?.target).toBe('/remote/dir(1)')
    const children = result.tasks.filter((t) => t.parentId)
    expect(children.map((t) => t.target).sort()).toEqual(['/remote/dir(1)/x.txt', '/remote/dir(1)/y.txt'])
  })

  it('目錄已存在且子檔也同名衝突、父決策 rename → 子檔逐一改名（不搬整個目錄）', async () => {
    const result = await build({
      items: [dirItem()],
      existing: ['/remote/dir', '/remote/dir/x.txt', '/remote/dir/y.txt'],
      decisions: { 'local/dir→/remote/dir': 'rename' }
    })
    const parent = result.tasks.find((t) => t.isDirectory)
    expect(parent?.target).toBe('/remote/dir')
    const children = result.tasks.filter((t) => t.parentId)
    expect(children.map((t) => t.target).sort()).toEqual(['/remote/dir/x(1).txt', '/remote/dir/y(1).txt'])
  })
})
