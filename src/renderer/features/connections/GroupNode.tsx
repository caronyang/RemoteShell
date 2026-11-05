import React from 'react'
import type { ConnectionGroup } from '../../../shared/ipc-contract'

interface Props {
  group: ConnectionGroup
  collapsed: boolean
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
  children?: React.ReactNode
}

export function GroupNode({ group, collapsed, onToggle, onContextMenu, children }: Props) {
  return (
    <div role="group">
      <div
        onClick={onToggle}
        onContextMenu={onContextMenu}
        style={{ display: 'flex', alignItems: 'center', gap: 6, height: 'var(--density-tree-row)', padding: '0 8px', cursor: 'pointer', color: 'var(--text)' }}
      >
        <span>{collapsed ? '\u25B6' : '\u25BC'}</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{group.name}</span>
      </div>
      {!collapsed && <div style={{ paddingLeft: 12 }}>{children}</div>}
    </div>
  )
}