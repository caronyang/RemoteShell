import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConnectionProfile, ConnectionGroup } from '../../../shared/ipc-contract'
import { GroupNode } from './GroupNode'
import { ConnectionNode } from './ConnectionNode'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ConnectionDialog } from './ConnectionDialog'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Input } from '../../components/Input'
import { Modal } from '../../components/Modal'

interface Props { onConnect?: (id: string) => void }

export function ConnectionTree({ onConnect }: Props) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [groups, setGroups] = useState<ConnectionGroup[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ConnectionProfile | null>(null)
  /* v0.1.4：F2 改名與 Delete 改用 App 內對話框（不用 window.prompt／confirm） */
  const [renameTarget, setRenameTarget] = useState<ConnectionProfile | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await window.rs.connections.list()
    if (res.ok) {
      setProfiles(res.data.profiles)
      setGroups(res.data.groups)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const q = query.trim().toLowerCase()
  const filteredProfiles = profiles.filter(p => {
    if (!q) return true
    return p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      p.tags.some(tg => tg.toLowerCase().includes(q)) ||
      groups.some(g => g.id === p.groupId && g.name.toLowerCase().includes(q))
  })

  const toggleGroup = async (g: ConnectionGroup) => {
    await window.rs.groups.update(g.id, { collapsed: !g.collapsed })
    load()
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // 鍵盤導航順序與視覺一致：分組內成員在前、未分組在後
      const ids = [
        ...groups.filter(g => g.parentId === null).flatMap(g => filteredProfiles.filter(p => p.groupId === g.id).map(p => p.id)),
        ...filteredProfiles.filter(p => p.groupId === null || !groups.some(g => g.id === p.groupId)).map(p => p.id)
      ]
      if (ids.length === 0) return
      const idx = selectedId ? ids.indexOf(selectedId) : -1
      const next = e.key === 'ArrowDown' ? Math.min(idx + 1, ids.length - 1) : Math.max(idx - 1, 0)
      const nextId = ids[next < 0 ? 0 : next]
      if (nextId) setSelectedId(nextId)
    } else if (e.key === 'Enter' && selectedId) {
      onConnect?.(selectedId)
    } else if (e.key === 'F2' && selectedId) {
      const p = profiles.find(x => x.id === selectedId)
      if (p) {
        setRenameTarget(p)
        setRenameDraft(p.name)
      }
    } else if (e.key === 'Delete' && selectedId) {
      setDeleteTargetId(selectedId)
    }
  }

  const openCtx = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, items })
  }

  const topLevelGroups = groups.filter(g => g.parentId === null)
  const ungrouped = filteredProfiles.filter(p => p.groupId === null || !groups.some(g => g.id === p.groupId))

  const nodeFor = (p: ConnectionProfile) => (
    <ConnectionNode
      key={p.id}
      profile={p}
      selected={selectedId === p.id}
      onSelect={() => setSelectedId(p.id)}
      onDoubleClick={() => onConnect?.(p.id)}
      onContextMenu={e => openCtx(e, [
        { label: t('tree.context.connect'), action: () => onConnect?.(p.id) },
        { label: t('tree.context.openTransfer'), action: () => {} },
        { label: t('tree.context.edit'), action: () => { setEditing(p); setDialogOpen(true) } },
        { label: t('tree.context.copy') ?? 'Copy', action: () => {} },
        { label: t('common.delete'), action: () => {}, danger: true },
        { label: t('common.rename'), action: () => {} },
      ])}
    />
  )

  return (
    <div role="tree" tabIndex={0} onKeyDown={handleKey} style={{ outline: 'none' }}>
      <div style={{ padding: 8, display: 'flex', gap: 4 }}>
        <input
          placeholder={t('tree.searchPlaceholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          style={{ flex: 1, padding: 4, border: '1px solid var(--border)', borderRadius: 'var(--radius-control)' }}
        />
        <button type="button" onClick={() => { setEditing(null); setDialogOpen(true) }}>{t('tree.context.newConnection')}</button>
      </div>
      {filteredProfiles.length === 0 && query && (
        <div style={{ padding: 8, color: 'var(--text-secondary)', fontSize: 12 }}>{t('tree.noMatches')}</div>
      )}
      {topLevelGroups.map(g => {
        const members = filteredProfiles.filter(p => p.groupId === g.id)
        return (
          <GroupNode key={g.id} group={g} collapsed={g.collapsed} onToggle={() => toggleGroup(g)}
            onContextMenu={e => openCtx(e, [
              { label: t('tree.context.newConnection'), action: () => {} },
              { label: t('tree.context.newGroup'), action: () => {} },
              { label: t('common.rename'), action: () => {} },
              { label: t('common.delete'), action: () => {}, danger: true },
            ])}>
            {members.map(nodeFor)}
          </GroupNode>
        )
      })}
      {/* 未分組連線（M4 修正：groupId=null 也必須顯示；鍵盤導航用 filteredProfiles 已涵蓋） */}
      {ungrouped.length > 0 && (
        <div role="group" aria-label={t('tree.ungrouped')}>
          <div style={{ padding: '4px 8px', color: 'var(--text-secondary)', fontSize: 11 }}>{t('tree.ungrouped')}</div>
          {ungrouped.map(nodeFor)}
        </div>
      )}
      {ctx && <ContextMenu items={ctx.items} x={ctx.x} y={ctx.y} onClose={() => setCtx(null)} />}
      <ConnectionDialog open={dialogOpen} connection={editing} groups={groups} profiles={profiles}
        onClose={() => setDialogOpen(false)} onSaved={() => { setDialogOpen(false); load() }} />
      <Modal
        open={renameTarget !== null}
        title={t('tree.context.rename')}
        width={420}
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button onClick={() => setRenameTarget(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={renameDraft.trim().length === 0}
              onClick={() => {
                const target = renameTarget
                const name = renameDraft.trim()
                setRenameTarget(null)
                if (target && name) void window.rs.connections.update(target.id, { name }).then(load)
              }}
            >
              {t('common.rename')}
            </Button>
          </>
        }
      >
        <Input label={t('tree.context.rename')} value={renameDraft} onValueChange={setRenameDraft} />
      </Modal>
      <ConfirmDialog
        open={deleteTargetId !== null}
        title={t('dialog.connection.delete.title')}
        message={t('tree.deleteConfirm')}
        confirmLabel={t('common.delete')}
        onCancel={() => setDeleteTargetId(null)}
        onConfirm={() => {
          const id = deleteTargetId
          setDeleteTargetId(null)
          if (id) void window.rs.connections.remove(id).then(load)
        }}
      />
    </div>
  )
}