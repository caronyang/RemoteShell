import path from 'node:path'
import type { ConflictPolicy, TransferState, TransferTask } from '../../shared/ipc-contract'
import { decideConflict } from './conflict'

/** 一個使用者選取的項目，已展開成實際要傳的檔案 */
export interface ExpandedItem {
  source: string
  target: string
  isDirectory: boolean
  files: Array<{ source: string; target: string; size: number }>
}

export interface BuildTasksInput {
  sessionId: string
  connectionLabel: string
  direction: 'upload' | 'download'
  now: string
  items: ExpandedItem[]
  policy: ConflictPolicy
  decisions?: Record<string, Exclude<ConflictPolicy, 'ask'>>
  /** 目標端在遠端（upload）時，改名候選要用 posix 規則 */
  isRemoteTarget: boolean
  /** 目標是否已存在（遠端 tryStat／本地 existsSync） */
  targetExists: (candidate: string) => Promise<boolean>
  newId: () => string
  /** 目錄任務的父列（可注入固定值方便測試） */
  parentSize?: (files: ExpandedItem['files']) => number
}

export interface BuildTasksResult {
  /** 父列（isDirectory=true，含 children）+ 子任務（帶 parentId）+ 單檔任務 */
  tasks: TransferTask[]
  /** 被 skip 的目標路徑 */
  skipped: string[]
}

type PerItemDecision = Exclude<ConflictPolicy, 'ask'>

/** decisions 的 key 可能是 `source→target`（UI 送出的）或單純 target（舊版／測試） */
function lookupDecision(
  decisions: Record<string, PerItemDecision> | undefined,
  source: string,
  target: string
): PerItemDecision | undefined {
  return decisions?.[`${source}→${target}`] ?? decisions?.[target]
}

function applyDecision(decision: PerItemDecision | undefined, conflict: boolean): 'copy' | 'skip' | 'rename' {
  if (!conflict) return 'copy'
  if (decision === 'skip') return 'skip'
  if (decision === 'rename') return 'rename'
  return 'copy'
}

/** 父目錄改名後，把子檔目標從舊根換成新根（遠端 /、本機 \ 都支援） */
function rebaseTarget(target: string, fromRoot: string, toRoot: string): string {
  const roots = fromRoot.endsWith('/') || fromRoot.endsWith('\\') ? [fromRoot] : [fromRoot + '/', fromRoot + '\\']
  for (const prefix of roots) {
    if (target === prefix.slice(0, -1)) return toRoot
    if (target.startsWith(prefix)) return toRoot + target.slice(prefix.length - 1)
  }
  return target
}

async function nextFreeName(
  target: string,
  isRemote: boolean,
  exists: (candidate: string) => Promise<boolean>
): Promise<string> {
  const parse = isRemote ? path.posix.parse : path.parse
  const join = isRemote ? path.posix.join : path.join
  const parsed = parse(target)
  for (let index = 1; index <= 9999; index++) {
    const candidate = join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`)
    if (!(await exists(candidate))) return candidate
  }
  return join(parsed.dir, `${parsed.name}(${Date.now()})${parsed.ext}`)
}

// 只用得到 parse/join；拉出來避免整個 node:path 進到測試的 mock 面

const FILE_STATE: TransferState = 'queued'

/**
 * 由「已展開的項目」產生佇列任務（v1.11）：
 * - 目錄 → 1 個父列（isDirectory=true、totalBytes=子檔總和、children[]）+ N 個子任務（parentId）
 * - 單檔 → 1 個任務
 * - 衝突：逐項 decisions 優先於全域 policy；skip 不建任務、rename 改寫成 file(1).ext、overwrite 原樣
 */
export async function buildTransferTasks(input: BuildTasksInput): Promise<BuildTasksResult> {
  const tasks: TransferTask[] = []
  const skipped: string[] = []
  const reserved = new Set<string>()

  const exists = async (candidate: string): Promise<boolean> => {
    if (reserved.has(candidate)) return true
    return input.targetExists(candidate)
  }

  for (const item of input.items) {
    /* QA P2-01v2-1：空目錄不建父列（沒有子任務可跑，會永遠 queued）。
       目錄的建立由 handler 負責（上傳 mkdir -p／下載本地 mkdir）。 */
    if (item.isDirectory && item.files.length === 0) continue
    const parentId = item.isDirectory ? input.newId() : null
    const children: NonNullable<TransferTask['children']> = []
    // P1-03：目錄層決策（UI 只送目錄項的 key）要下傳給子檔
    const directoryDecision = item.isDirectory ? lookupDecision(input.decisions, item.source, item.target) : undefined

    // 父=skip：整個目錄不建任務（含 children）
    if (item.isDirectory && directoryDecision === 'skip') {
      skipped.push(item.target)
      continue
    }

    // 父=rename：目錄本身已存在時，若子檔沒有同名衝突 → 改目錄根（子檔搬到新根）；
    // 若子檔有同名衝突 → 依子檔逐一改名（QA P1-03 #2：x → x(1).ext），保留舊目錄內容。
    let rootTarget = item.target
    if (item.isDirectory && directoryDecision === 'rename') {
      const dirExists = await exists(item.target)
      const childConflicts = await Promise.all(item.files.map((file) => exists(file.target)))
      const anyChildConflict = childConflicts.some(Boolean)
      if (dirExists && !anyChildConflict) {
        rootTarget = await nextFreeName(item.target, input.isRemoteTarget, exists)
        reserved.add(rootTarget)
      }
    }
    const renamedRoot = rootTarget !== item.target

    for (const file of item.files) {
      const target = renamedRoot ? rebaseTarget(file.target, item.target, rootTarget) : file.target
      const conflict = await exists(target)
      const childDecision = lookupDecision(input.decisions, file.source, file.target)
      let decision: 'copy' | 'skip' | 'rename'
      if (!item.isDirectory) {
        decision = decideConflict(input.policy, input.decisions, file.source, file.target, conflict)
      } else if (childDecision) {
        // 檔層決策優先於目錄層
        decision = applyDecision(childDecision, conflict)
      } else if (renamedRoot) {
        // 目錄已改名，子檔在新根內的原名不該再被目錄層 rename 影響
        decision = decideConflict(input.policy, undefined, file.source, target, conflict)
      } else if (directoryDecision) {
        decision = applyDecision(directoryDecision, conflict)
      } else {
        decision = decideConflict(input.policy, undefined, file.source, file.target, conflict)
      }
      if (decision === 'skip') {
        skipped.push(target)
        continue
      }
      const finalTarget = decision === 'rename' ? await nextFreeName(target, input.isRemoteTarget, exists) : target
      reserved.add(finalTarget)
      const taskId = input.newId()
      const task: TransferTask = {
        taskId,
        ...(parentId ? { parentId } : {}),
        sessionId: input.sessionId,
        connectionLabel: input.connectionLabel,
        direction: input.direction,
        source: file.source,
        target: finalTarget,
        isDirectory: false,
        totalBytes: file.size,
        transferredBytes: 0,
        bytesPerSec: 0,
        etaSec: null,
        state: FILE_STATE,
        attempts: 0,
        createdAt: input.now
      }
      tasks.push(task)
      if (parentId) {
        children.push({ taskId, source: task.source, target: finalTarget, size: file.size, state: FILE_STATE })
      }
    }

    if (parentId) {
      const totalBytes = input.parentSize ? input.parentSize(item.files) : children.reduce((sum, child) => sum + child.size, 0)
      tasks.unshift({
        taskId: parentId,
        sessionId: input.sessionId,
        connectionLabel: input.connectionLabel,
        direction: input.direction,
        source: item.source,
        target: rootTarget,
        isDirectory: true,
        totalBytes,
        transferredBytes: 0,
        bytesPerSec: 0,
        etaSec: null,
        children,
        state: 'queued',
        attempts: 0,
        createdAt: input.now
      })
    }
  }

  return { tasks, skipped }
}

