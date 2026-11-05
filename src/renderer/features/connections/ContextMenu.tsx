export interface MenuItem { label: string; action: () => void; danger?: boolean }

interface Props { items: MenuItem[]; x: number; y: number; onClose: () => void }

export function ContextMenu({ items, x, y, onClose }: Props) {
  return (
    <div
      role="menu"
      onClick={onClose}
      style={{ position: 'fixed', left: x, top: y, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-panel)', padding: 4, zIndex: 1000, minWidth: 160 }}
    >
      {items.map((it, i) => (
        <div key={i} role="menuitem" onClick={(e) => { e.stopPropagation(); it.action(); onClose() }}
          style={{ padding: '6px 10px', cursor: 'pointer', color: it.danger ? 'var(--danger)' : 'var(--text)', fontSize: 12 }}>
          {it.label}
        </div>
      ))}
    </div>
  )
}