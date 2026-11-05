import path from 'node:path'
import type { ConflictPolicy } from '../../shared/ipc-contract'

/**
 * 同名檔改名（UI-04 衝突對話框「保留兩者」）：
 * `report.pdf` → `report(1).pdf` → `report(2).pdf` …
 * `exists` 由呼叫端注入（遠端要問 SFTP，本地用 fs），因此同一套邏輯兩邊都能用。
 */
export function renamedPath(target: string, exists: (candidate: string) => boolean, isRemote: boolean): string {
  const parsed = isRemote ? path.posix.parse(target) : path.parse(target)
  const join = isRemote ? path.posix.join : path.join
  for (let index = 1; index <= 9999; index++) {
    const candidate = join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`)
    if (!exists(candidate)) return candidate
  }
  return join(parsed.dir, `${parsed.name}(${Date.now()})${parsed.ext}`)
}

export type ConflictDecision = 'copy' | 'skip' | 'rename'

/**
 * 決定這個項目要怎麼處理：
 * - 沒有衝突 → copy
 * - 有衝突 → 逐項 decisions（key 可用 target 或 `source→target`）優先，其次全域 policy
 * - `ask` 但沒有逐項決策 → 保守跳過（不覆寫使用者資料）
 */
export function decideConflict(
  policy: ConflictPolicy,
  decisions: Record<string, Exclude<ConflictPolicy, 'ask'>> | undefined,
  source: string,
  target: string,
  conflict: boolean
): ConflictDecision {
  if (!conflict) return 'copy'
  const perItem = decisions?.[target] ?? decisions?.[`${source}→${target}`]
  const effective = perItem ?? (policy === 'ask' ? 'skip' : policy)
  if (effective === 'skip') return 'skip'
  if (effective === 'rename') return 'rename'
  return 'copy'
}
