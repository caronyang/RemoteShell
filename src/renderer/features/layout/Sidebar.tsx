import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { Input } from '../../components/Input'
import { Tree, type TreeNode } from '../../components/Tree'

export interface SidebarProps {
  width: number
  onWidthChange: (width: number, commit: boolean) => void
  search: string
  onSearch: (value: string) => void
  nodes: TreeNode[]
  selectedId: string | null
  onSelect: (node: TreeNode) => void
  onActivate: (node: TreeNode) => void
  /** FAIL-3：新增連線（groupId 用於分組上右鍵的預填） */
  onNewConnection: (groupId: string | null) => void
  /** FAIL-3：新增分組（parentId 用於分組上右鍵建立子分組） */
  onNewGroup: (parentId: string | null) => void
  /** P1-02：編輯既有連線（右鍵 Edit 與 F2） */
  onEditConnection: (profileId: string) => void
  /** P1-02：刪除既有連線（右鍵 Delete；確認由 MainWindow 依設定決定） */
  onDeleteConnection: (profileId: string) => void
  /** #5：側欄整體收合（settings.ui.sidebarCollapsed 持久化） */
  collapsed: boolean
  onToggleCollapse: () => void
}

/** 右鍵選單狀態：profile 節點 → Edit/Delete；分組/空白 → 新增連線（預填）/新增分組 */
interface MenuState {
  x: number
  y: number
  kind: 'profile' | 'group' | 'empty'
  groupId: string | null
  parentId: string | null
  profileId: string | null
}

/** 左側連線清單（UI-01 §4）：標題列 + 搜尋 + 樹 + 狀態圖例；可拖曳 200–480px */
export function Sidebar({
  width,
  onWidthChange,
  search,
  onSearch,
  nodes,
  selectedId,
  onSelect,
  onActivate,
  onNewConnection,
  onNewGroup,
  onEditConnection,
  onDeleteConnection,
  collapsed,
  onToggleCollapse
}: SidebarProps): JSX.Element {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<MenuState | null>(null)
  /* P3：拖曳後的 dblclick 不可被當成收合手勢 —— 有位移(>4px)的拖曳結束後 300ms 內雙擊忽略 */
  const dragGuardRef = useRef(0)

  const startDrag = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    let moved = false
    const onMove = (moveEvent: globalThis.MouseEvent): void => {
      if (Math.abs(moveEvent.clientX - startX) > 4) moved = true
      const next = Math.min(480, Math.max(200, startWidth + (moveEvent.clientX - startX)))
      onWidthChange(next, false)
    }
    const onUp = (upEvent: globalThis.MouseEvent): void => {
      const next = Math.min(480, Math.max(200, startWidth + (upEvent.clientX - startX)))
      onWidthChange(next, true)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (moved) dragGuardRef.current = Date.now() + 300
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const handleResizerDoubleClick = (): void => {
    if (Date.now() < dragGuardRef.current) return // 剛拖過：視為拖曳收尾，不是收合手勢
    onToggleCollapse()
  }

  /* FAIL-3/P1-02：空白/分組右鍵 → 新增連線（分組預填）/新增分組；連線節點右鍵 → 編輯/刪除 */
  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    const row = (event.target as HTMLElement).closest('[data-node-id]')
    const nodeId = row?.getAttribute('data-node-id') ?? null
    const kind: MenuState['kind'] = nodeId?.startsWith('profile:') ? 'profile' : nodeId?.startsWith('group:') ? 'group' : 'empty'
    const groupId = kind === 'group' && nodeId !== null ? nodeId.slice('group:'.length) : null
    const profileId = kind === 'profile' && nodeId !== null ? nodeId.slice('profile:'.length) : null
    event.preventDefault()
    /* #11：依視窗邊界收斂（選單 min-width 160＋間距；避免貼邊越界） */
    const x = Math.max(0, Math.min(event.clientX, window.innerWidth - 180))
    const y = Math.max(0, Math.min(event.clientY, window.innerHeight - 110))
    setMenu({ x, y, kind, groupId, parentId: groupId, profileId })
  }

  const closeMenu = (): void => setMenu(null)

  /* #11：Esc 關閉右鍵選單（方向鍵列 M6） */
  useEffect(() => {
    if (menu === null) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [menu])

  return (
    <>
      {collapsed ? (
        /* #5：收合後左緣展開鈕（UI-01 可整個收合；Ctrl+Shift+B／雙擊邊界亦可切換） */
        <button
          type="button"
          className="rs-sidebar__expand"
          aria-label={t('sidebar.expand')}
          title={t('sidebar.expand')}
          onClick={onToggleCollapse}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      ) : (
        <>
      <aside className="rs-sidebar" style={{ width }} aria-label={t('tree.title')}>
        <div className="rs-sidebar__header">
          <span>{t('tree.title')}</span>
          <Button
            variant="ghost"
            icon="plus"
            aria-label={t('tree.context.newConnection')}
            onClick={() => onNewConnection(null)}
          />
          <Button
            variant="ghost"
            icon="folder-plus"
            aria-label={t('tree.context.newGroup')}
            onClick={() => onNewGroup(null)}
          />
          {/* #5：收合鈕（chevron-right 旋轉 180° = 朝左收合） */}
          <Button
            variant="ghost"
            icon="chevron-right"
            style={{ transform: 'rotate(180deg)' }}
            aria-label={t('sidebar.collapse')}
            title={t('sidebar.collapse')}
            onClick={onToggleCollapse}
          />
        </div>
        <div className="rs-sidebar__search">
          <Input
            placeholder={t('tree.searchPlaceholder') ?? ''}
            value={search}
            onValueChange={onSearch}
            aria-label={t('tree.searchPlaceholder')}
          />
        </div>
        <div className="rs-sidebar__body" onContextMenu={openContextMenu}>
          <Tree
            nodes={nodes}
            selectedId={selectedId}
            onSelect={onSelect}
            onActivate={onActivate}
            /* P1-02：F2 開編輯（分組節點忽略） */
            onRename={(node) => {
              if (node.id.startsWith('profile:')) onEditConnection(node.id.slice('profile:'.length))
            }}
            /* P2-02：Delete 鍵 → 刪除入口（只對連線節點；分組不刪） */
            onDelete={(node) => {
              if (node.id.startsWith('profile:')) onDeleteConnection(node.id.slice('profile:'.length))
            }}
            /* FAIL-6：空清單顯示引導語；只有查詢無結果才顯示 No matching items */
            emptyLabel={search ? t('tree.noMatches') : t('sidebar.empty')}
          />
        </div>
        <div className="rs-sidebar__legend">
          <span>
            <span className="rs-dot rs-dot--connected" /> {t('tree.legendConnected')}
          </span>
          <span>
            <span className="rs-dot rs-dot--idle" /> {t('tree.legendDisconnected')}
          </span>
          <span>
            <span className="rs-dot rs-dot--connecting" /> {t('tree.legendConnecting')}
          </span>
          <span>
            <span className="rs-dot rs-dot--failed" /> {t('tree.legendFailed')}
          </span>
        </div>
      </aside>
      <button
        type="button"
        className="rs-resizer"
        aria-label={t('sidebar.resize')}
        onMouseDown={startDrag}
        onDoubleClick={handleResizerDoubleClick}
      />
        </>
      )}
      {menu !== null ? <div className="rs-sftp__mask" onMouseDown={closeMenu} /> : null}
      {menu !== null ? (
        <div className="rs-menu__list rs-sftp__ctxmenu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('tree.title')}>
          {menu.kind === 'profile' ? (
            /* P1-02：連線節點 → 編輯/刪除 */
            <>
              <button
                type="button"
                role="menuitem"
                className="rs-menu__item"
                onClick={() => {
                  const profileId = menu.profileId
                  closeMenu()
                  if (profileId) onEditConnection(profileId)
                }}
              >
                {t('tree.context.edit')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="rs-menu__item"
                onClick={() => {
                  const profileId = menu.profileId
                  closeMenu()
                  if (profileId) onDeleteConnection(profileId)
                }}
              >
                {t('tree.context.delete')}
              </button>
            </>
          ) : (
            /* 分組/空白 → 新增連線（分組預填）/新增分組 */
            <>
              <button
                type="button"
                role="menuitem"
                className="rs-menu__item"
                onClick={() => {
                  const groupId = menu.groupId
                  closeMenu()
                  onNewConnection(groupId)
                }}
              >
                {t('tree.context.newConnection')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="rs-menu__item"
                onClick={() => {
                  const parentId = menu.parentId
                  closeMenu()
                  onNewGroup(parentId)
                }}
              >
                {t('tree.context.newGroup')}
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  )
}
