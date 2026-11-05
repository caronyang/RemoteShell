import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFocusReturn } from '../../components/useFocusReturn'
import { Button } from '../../components/Button'
import { autoRename, formatSize } from './format'

export type ConflictDecision = 'overwrite' | 'skip' | 'rename'

export interface ConflictItem {
  /** 衝突項目唯一 key（`source→target`，與 main decideConflict 查表對齊；見 DualPane.decisionKey）；start.decisions 以此為索引 */
  baseKey: string
  /** 顯示用名稱（不含路徑） */
  displayName: string
  /** 目的地既有檔大小（bytes）；未知給 null */
  existingSize: number | null
}

export interface ConflictDialogProps {
  open: boolean
  items: ConflictItem[]
  /** 全部項目都有決策時回傳（順序 = items 順序） */
  onResolve: (decisions: Array<{ baseKey: string; decision: ConflictDecision }>) => void
  onCancel: () => void
}

/**
 * M3-06 同名檔衝突對話框（UI-03 拖拽傳輸 §「目的地已有同名檔」）:
 * 逐項決策：覆寫 / 跳過 / 保留兩者（自動改名 file(1).ext）＋「全部套用」。
 * 套用結果對應 StartTransferRequest.decisions（onConflict='ask' 時由 UI 逐項決定）。
 */
export function ConflictDialog({ open, items, onResolve, onCancel }: ConflictDialogProps): JSX.Element | null {
  const { t } = useTranslation()
  const [decisions, setDecisions] = useState<ConflictDecision[]>([])

  // 重新開啟時清掉前次的決策序列（關閉/取消也視為放棄）
  useEffect(() => {
    if (!open) setDecisions([])
  }, [open])

  // M4-05 無障礙：Esc 關閉（等同取消全部決策）＋焦點回歸觸發元素
  useFocusReturn(open)
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open || items.length === 0) return null
  const index = decisions.length
  const current = items[index]
  if (!current) return null

  const record = (decision: ConflictDecision): void => {
    const next = [...decisions, decision]
    if (next.length >= items.length) {
      onResolve(items.map((item, i) => ({ baseKey: item.baseKey, decision: next[i] ?? 'skip' })))
      setDecisions([])
      return
    }
    setDecisions(next)
  }

  const applyAll = (decision: ConflictDecision): void => {
    onResolve(items.map((item, i) => ({ baseKey: item.baseKey, decision: i < index ? (decisions[i] ?? 'skip') : decision })))
    setDecisions([])
  }

  return (
    <div className="rs-modal" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="rs-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('sftp.conflict.title')}
        style={{ width: 440 }}
        onKeyDown={(event) => event.key === 'Enter' && record('overwrite')}
      >
        <header className="rs-modal__header">
          <h2>{t('sftp.conflict.title')}</h2>
          <Button variant="ghost" icon="close" title={t('common.close')} onClick={onCancel} />
        </header>
        <div className="rs-modal__body">
          <p className="rs-muted">{t('sftp.conflict.message', { name: current.displayName })}</p>
          {current.existingSize !== null ? (
            <p className="rs-hint">{`${t('sftp.property.size')}: ${formatSize(current.existingSize)}`}</p>
          ) : null}
          {/* 契約 v1.11：rename 決策的最終名稱預覽（file(1).ext） */}
          <p className="rs-hint">{`${t('sftp.conflict.rename')}: ${autoRename(current.displayName)}`}</p>
        </div>
        <footer className="rs-modal__footer rs-conflict__footer">
          <span className="rs-conflict__counter">{`${index + 1} / ${items.length}`}</span>
          <Button variant="secondary" onClick={() => applyAll('overwrite')}>
            {t('sftp.conflict.applyAll')}
          </Button>
          <Button variant="secondary" onClick={() => record('overwrite')}>
            {t('sftp.conflict.overwrite')}
          </Button>
          <Button variant="secondary" onClick={() => record('skip')}>
            {t('sftp.conflict.skip')}
          </Button>
          <Button variant="primary" onClick={() => record('rename')}>
            {t('sftp.conflict.rename')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
