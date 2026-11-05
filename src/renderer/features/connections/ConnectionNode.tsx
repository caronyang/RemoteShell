import React from 'react'
import { presentStatus } from './statusMapping'
import type { ConnectionProfile, SessionState } from '../../../shared/ipc-contract'

interface Props {
  profile: ConnectionProfile
  sessionState?: SessionState
  selected: boolean
  onSelect: () => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

export function ConnectionNode({ profile, sessionState, selected, onSelect, onDoubleClick, onContextMenu }: Props) {
  const pres = presentStatus(sessionState)
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 'var(--density-tree-row)',
        padding: '0 8px',
        background: selected ? 'var(--surface-subtle)' : 'transparent',
        cursor: 'pointer',
        color: 'var(--text)',
      }}
    >
      <span style={{ color: pres.color }} aria-label={pres.labelKey}>{pres.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile.name}</div>
        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{profile.host} &middot; {profile.protocol.toUpperCase()}</div>
      </div>
      {profile.jump?.enabled && (
        <span style={{ color: 'var(--jump)', fontSize: 10 }}>{'\u26D3'}</span>
      )}
    </div>
  )
}