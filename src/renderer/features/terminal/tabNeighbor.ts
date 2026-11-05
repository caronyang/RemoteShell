/**
 * v0.1.10 #3（R-18）：關閉分頁後要移到哪個分頁。
 * 右側相鄰優先、沒有才左側；關閉非當前分頁不換；只剩 0 個回 null（空狀態）。
 * 放在獨立純模組，讓 main/node 測試不需要載入 renderer（window）。
 */
export function neighborAfterClose(ids: readonly string[], closingId: string, activeId: string | null): string | null {
  if (activeId !== closingId) return activeId
  const index = ids.indexOf(closingId)
  if (index < 0) return activeId
  return ids[index + 1] ?? ids[index - 1] ?? null
}
