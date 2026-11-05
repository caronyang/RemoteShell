import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DRAG_MIME } from './FileTable'

export interface DropZoneProps {
  /** 目的地種類：『正在被拖入的檢視』允許 drop */
  kind: 'local' | 'remote'
  /** 拖曳來源（跨面板）：來源 = 'local' 時表示目的在 remote */
  dropHint: string | null
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  children: React.ReactNode
}

/** 檔案列表外包的拖放區（F-2 整區高亮藍框 + 浮標提示） */
export function DropZone({ kind, dropHint, onDrop, children }: DropZoneProps): JSX.Element {
  const { t } = useTranslation()
  const [hover, setHover] = useState(false)

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setHover(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setHover(false)
  }

  const accept = (event: DragEvent<HTMLDivElement>): void => {
    setHover(false)
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return
    event.preventDefault()
    onDrop(event)
  }

  return (
    <div
      className={`rs-sftp__dropzone${hover ? ' is-dragover' : ''}`}
      data-kind={kind}
      aria-label={t('sftp.pane.' + kind)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={accept}
      onDragEnd={() => setHover(false)}
    >
      {children}
      {hover && dropHint !== null ? <p className="rs-sftp__drophint">{dropHint}</p> : null}
    </div>
  )
}
