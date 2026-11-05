import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export interface TreeNode {
  id: string
  label: string
  secondary?: string
  icon?: IconName
  children?: TreeNode[]
  /** 預設是否展開（僅第一次渲染參考） */
  expanded?: boolean
  /** 列首元素（圖示之前），例如連線狀態點（UI-01 §4 三重表達） */
  lead?: ReactNode
  /** 小字之後的元素，例如跳板標示 ⛓（UI-01 §4） */
  trail?: ReactNode
  badge?: ReactNode
  /** v0.1.9 #4：額外縮排（px）；被 jump.connectionIds 參照的跳板主機比直連多一層 */
  indentPx?: number
}

export interface TreeProps {
  nodes: TreeNode[]
  selectedId?: string | null
  onSelect?: (node: TreeNode) => void
  onActivate?: (node: TreeNode) => void
  onRename?: (node: TreeNode) => void
  /** P2-02：Delete 鍵觸發刪除流程（分組節點由呼叫端過濾） */
  onDelete?: (node: TreeNode) => void
  onContextMenu?: (node: TreeNode) => void
  emptyLabel?: string
}

function flattenVisible(nodes: TreeNode[], expanded: Set<string>, out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node)
    if (node.children && node.children.length > 0 && expanded.has(node.id)) {
      flattenVisible(node.children, expanded, out)
    }
  }
  return out
}

/** 收集 expanded 旗標（僅供「首次有資料」時初始化） */
function collectExpanded(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.expanded) out.add(node.id)
    if (node.children) collectExpanded(node.children, out)
  }
  return out
}

/** 樹：支援 ↑↓ / Enter / F2 / ContextMenu（UI-01 §4 鍵盤規格） */
export function Tree({
  nodes,
  selectedId,
  onSelect,
  onActivate,
  onRename,
  onDelete,
  onContextMenu,
  emptyLabel
}: TreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => collectExpanded(nodes))
  /* 連線清單是 async 載入：nodes 常在首輪 render 之後才到，expanded 旗標改在「首次有資料」時初始化 */
  const seededRef = useRef(nodes.length > 0)
  useEffect(() => {
    if (nodes.length > 0 && !seededRef.current) {
      seededRef.current = true
      setExpanded(collectExpanded(nodes))
    }
  }, [nodes])

  const visible = useMemo(() => flattenVisible(nodes, expanded), [nodes, expanded])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (visible.length === 0) return
    const index = visible.findIndex((n) => n.id === selectedId)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      onSelect?.(visible[Math.min(index + 1, visible.length - 1)] as TreeNode)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      onSelect?.(visible[Math.max(index - 1, 0)] as TreeNode)
    } else if (event.key === 'ArrowRight' && index >= 0) {
      const node = visible[index] as TreeNode
      if (node.children?.length) {
        event.preventDefault()
        setExpanded((prev) => new Set(prev).add(node.id))
      }
    } else if (event.key === 'ArrowLeft' && index >= 0) {
      const node = visible[index] as TreeNode
      if (node.children?.length) {
        event.preventDefault()
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(node.id)
          return next
        })
      }
    } else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault()
      onActivate?.(visible[index] as TreeNode)
    } else if (event.key === 'F2' && index >= 0) {
      event.preventDefault()
      onRename?.(visible[index] as TreeNode)
    } else if (event.key === 'Delete' && index >= 0) {
      /* P2-02：Delete 鍵 = 刪除流程（由 Sidebar 交給 MainWindow 的 confirmDelete 邏輯，不繞過確認） */
      event.preventDefault()
      onDelete?.(visible[index] as TreeNode)
    } else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && index >= 0) {
      event.preventDefault()
      onContextMenu?.(visible[index] as TreeNode)
    }
  }

  const renderNodes = (list: TreeNode[], depth: number): JSX.Element[] =>
    list.flatMap((node) => {
      const isExpanded = expanded.has(node.id)
      const hasChildren = !!node.children && node.children.length > 0
      const row = (
        <div
          key={node.id}
          role="treeitem"
          data-node-id={node.id}
          aria-selected={node.id === selectedId}
          aria-expanded={hasChildren ? isExpanded : undefined}
          tabIndex={node.id === selectedId ? 0 : -1}
          className={['rs-tree__row', node.id === selectedId ? 'is-selected' : ''].filter(Boolean).join(' ')}
          style={{ paddingLeft: 8 + depth * 14 + (node.indentPx ?? 0) }}
          onClick={() => onSelect?.(node)}
          onDoubleClick={() => onActivate?.(node)}
        >
          {hasChildren ? (
            <button
              type="button"
              className="rs-tree__twisty"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              onClick={(event) => {
                event.stopPropagation()
                toggle(node.id)
              }}
            >
              <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className="rs-tree__twisty" aria-hidden="true" />
          )}
          {node.lead}
          {node.icon ? <Icon name={node.icon} size={14} /> : null}
          <span className="rs-tree__label">{node.label}</span>
          {/* 跳板標示（v1.4 裁決）：名稱之後、小字之前，不貼右緣 */}
          {node.trail}
          {node.secondary ? <span className="rs-tree__secondary">{node.secondary}</span> : null}
          {node.badge}
        </div>
      )
      const children =
        hasChildren && isExpanded ? renderNodes(node.children as TreeNode[], depth + 1) : []
      return [row, ...children]
    })

  if (nodes.length === 0) {
    return <p className="rs-empty">{emptyLabel}</p>
  }

  return (
    <div className="rs-tree" role="tree" tabIndex={0} onKeyDown={handleKeyDown}>
      {renderNodes(nodes, 0)}
    </div>
  )
}
