import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toast'
import { GeneralTab } from './GeneralTab'
import { AuthTab } from './AuthTab'
import { JumpTab } from './JumpTab'
import { TerminalTab } from './TerminalTab'
import type { AppSettings, ConnectionProfile, ConnectionGroup, ConnectionInput, SecretRef, ThemeId } from '../../../shared/ipc-contract'

interface Props {
  open: boolean
  connection?: ConnectionProfile | null
  groups: ConnectionGroup[]
  profiles?: ConnectionProfile[]
  /** FAIL-3：分組上右鍵「新增連線」時預填的分組（僅新連線生效） */
  initialGroupId?: string | null
  /** P2 regression：終端初值顯示來源 = profile.terminal ?? 全域 settings.terminal（MainWindow 傳入） */
  settings?: AppSettings
  /** #4：儲存並連線 —— 存好的 profile 回傳後立即開 session（MainWindow 接 openProfile） */
  onConnect?: (profile: ConnectionProfile) => void
  onClose: () => void
  onSaved: () => void
}

type Tab = 'general' | 'auth' | 'jump' | 'terminal'

const TABS: Tab[] = ['general', 'auth', 'jump', 'terminal']

export function ConnectionDialog({ open, connection, groups, profiles = [], initialGroupId = null, settings, onConnect, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('general')
  const [dirty, setDirty] = useState(false)
  const [general, setGeneral] = useState({
    name: connection?.name ?? '',
    protocol: (connection?.protocol ?? 'ssh') as 'ssh' | 'telnet',
    host: connection?.host ?? '',
    port: connection?.port ?? 22,
    groupId: connection?.groupId ?? initialGroupId ?? null,
    description: connection?.description ?? '',
    tags: (connection?.tags ?? []).join(','),
  })
  const [auth, setAuth] = useState({
    method: (connection?.auth?.method ?? 'password') as 'password' | 'passwordFile' | 'publicKey',
    username: (connection?.auth as { username?: string })?.username ?? '',
    password: '',
    rememberPassword: true,
    filePath: (connection?.auth as { filePath?: string })?.filePath ?? '',
    keyPath: (connection?.auth as { keyPath?: string })?.keyPath ?? '',
    passphrase: '',
    rememberPassphrase: false,
  })
  const [jump, setJump] = useState({ enabled: connection?.jump?.enabled ?? false, selectedId: (connection?.jump?.connectionIds?.[0] ?? null) as string | null })
  /* P2 regression：顯示來源 = profile 的值 ?? 全域 settings（顯示不等於寫入 —— 寫入看 terminalDirty） */
  const [terminal, setTerminal] = useState({
    fontFamily: connection?.terminal?.fontFamily ?? settings?.terminal.fontFamily ?? 'Cascadia Mono',
    fontSize: connection?.terminal?.fontSize ?? settings?.terminal.fontSize ?? 11,
    theme: (connection?.terminal?.themeId ?? settings?.terminal.themeId ?? 'dark') as string,
    scrollback: connection?.terminal?.scrollback ?? settings?.terminal.scrollback ?? 10000,
    cursorStyle: (connection?.terminal?.cursorStyle ?? settings?.terminal.cursorStyle ?? 'block') as 'block' | 'underline',
    cursorBlink: connection?.terminal?.cursorBlink ?? settings?.terminal.cursorBlink ?? true,
    applyToAll: false,
  })
  /* 使用者真的改過任一「可入檔」終端欄位才為 true（applyToAll 是 UI 動作旗標不算） */
  const [terminalDirty, setTerminalDirty] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  /* P1-01 #7：Save 連點防護（in-flight 時按鈕 disabled ＋ handler 早退） */
  const [saving, setSaving] = useState(false)
  /* P0 #2/#3：未儲存變更的 App 內確認（原 window.confirm 是原生同步對話框會阻塞 renderer） */
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  /* P0 #2/#3：焦點回歸／focus trap／Esc 全改由共用 Modal 負責（原本自製對話框沒有這些，
     且 Esc 路徑上的 window.confirm 是會阻塞 renderer 的原生對話框 → 改走 ConfirmDialog） */

  if (!open) return null

  const isNew = !connection
  // 同分組同名檢查（M4 修正：原本寫死 false，重名驗證永不觸發）
  const trimmedName = general.name.trim()
  const isDuplicate =
    trimmedName !== '' &&
    profiles.some(
      p => p.id !== connection?.id && p.name.trim() === trimmedName && (p.groupId ?? null) === general.groupId
    )
  const validate = () => {
    const e: Record<string, string> = {}
    if (!general.name.trim()) e.name = t('dialog.connection.validation.nameRequired')
    else if (isDuplicate) e.name = t('dialog.connection.validation.nameDuplicate')
    if (!general.host.trim()) e.host = t('dialog.connection.validation.hostRequired')
    if (general.port < 1 || general.port > 65535) e.port = t('dialog.connection.validation.portRange')
    if (auth.method === 'publicKey' && !auth.keyPath.trim()) e.keyPath = t('dialog.connection.validation.keyPathRequired')
    if (auth.method === 'passwordFile' && !auth.filePath.trim()) e.filePath = t('dialog.connection.validation.filePathRequired')
    /* P0-01（review 補強）：
       - 自己跳自己 → jumpSelf
       - 啟用但未選主機 / 選到已刪除的跳板（stale id）/ 選到 telnet → 視同未選，jumpRequired 擋下 */
    if (jump.enabled) {
      const target = jump.selectedId ? profiles.find((p) => p.id === jump.selectedId) : undefined
      if (jump.selectedId && jump.selectedId === connection?.id) {
        e.jump = t('dialog.connection.validation.jumpSelf')
      } else if (!jump.selectedId || !target || target.protocol !== 'ssh') {
        e.jump = t('dialog.connection.validation.jumpRequired')
      }
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const authWithSecret = (secret: SecretRef): ConnectionInput['auth'] =>
    auth.method === 'password'
      ? { method: 'password', username: auth.username, secret }
      : auth.method === 'passwordFile'
      ? { method: 'passwordFile', username: auth.username, secret, filePath: auth.filePath }
      : { method: 'publicKey', username: auth.username, secret, keyPath: auth.keyPath }

  const secretField = auth.method === 'password' ? auth.password : auth.method === 'publicKey' ? auth.passphrase : ''
  const rememberSecret = auth.method === 'password' ? auth.rememberPassword : auth.method === 'publicKey' ? auth.rememberPassphrase : false

  /* #4：回傳存好的 profile（供 saveAndConnect 立即連線）；失敗回 null（錯誤已 toast、不靜默） */
  const handleSave = async (): Promise<ConnectionProfile | null> => {
    /* #7：Save 連點防護 */
    if (saving) return null
    if (!validate()) return null
    /* P0-01：JumpTab 的選擇寫入 profile（enabled 且有選才帶 id；否則清空） */
    const jumpConfig = { enabled: jump.enabled, connectionIds: jump.enabled && jump.selectedId ? [jump.selectedId] : [] }
    /* #13：終端頁不再丟棄 —— 寫入 profile.terminal（applyToAll 是 UI 動作旗標不入檔）。
       P2 regression（未動就不寫）：terminalDirty=false → 新連線送 {}（沿用全域）；
       編輯則送 connection.terminal 原值（有值保留、無值維持 {}，絕不把全域預設當覆寫寫入）。 */
    const terminalOverride: ConnectionInput['terminal'] = terminalDirty
      ? {
          fontFamily: terminal.fontFamily,
          fontSize: terminal.fontSize,
          themeId: terminal.theme as ThemeId,
          scrollback: terminal.scrollback,
          cursorStyle: terminal.cursorStyle,
          cursorBlink: terminal.cursorBlink,
        }
      : (connection?.terminal ?? {})
    const base = {
      name: general.name,
      groupId: general.groupId,
      protocol: general.protocol,
      host: general.host,
      port: general.port,
      jump: jumpConfig,
      terminal: terminalOverride,
      tags: general.tags.split(',').map(s => s.trim()).filter(Boolean),
      description: general.description,
    }
    const wantsStored = Boolean(secretField) && rememberSecret && (auth.method === 'password' || auth.method === 'publicKey')

    setSaving(true)
    try {
      let finalProfile: ConnectionProfile | null = null
      if (isNew) {
        /* 順序：create（先用 none）→ setSecret → update 帶 dpapi ref。
           任一步失敗 → 回滾已建立的草稿（remove＋clearSecret）並保持開窗，
           使用者可重試或取消「記住」再存 —— 不可靜默成功（#4/#5/#6）。 */
        const created = await window.rs.connections.create({ ...base, auth: authWithSecret({ kind: 'none' }) })
        if (!created.ok) {
          toast.show(t(created.error.i18nKey), 'error')
          return null
        }
        finalProfile = created.data
        if (wantsStored) {
          const stored = await window.rs.vault.setSecret(created.data.id, secretField)
          if (!stored.ok) {
            await window.rs.connections.remove(created.data.id)
            toast.show(t(stored.error.i18nKey), 'error')
            return null
          }
          const updated = await window.rs.connections.update(created.data.id, { auth: authWithSecret(stored.data) })
          if (!updated.ok) {
            await window.rs.vault.clearSecret(created.data.id)
            await window.rs.connections.remove(created.data.id)
            toast.show(t(updated.error.i18nKey), 'error')
            return null
          }
          finalProfile = updated.data
        }
      } else if (connection) {
        const prev: SecretRef = connection.auth.secret ?? { kind: 'none' }
        let secret = prev
        let setSecretRan = false
        if (auth.method === 'password' || auth.method === 'publicKey') {
          if (rememberSecret && secretField) {
            /* 勾選且有輸入 → setSecret 取 dpapi ref */
            const stored = await window.rs.vault.setSecret(connection.id, secretField)
            if (!stored.ok) {
              toast.show(t(stored.error.i18nKey), 'error')
              return null
            }
            secret = stored.data
            setSecretRan = true
          } else if (rememberSecret && !secretField) {
            /* 勾選但留空 → 保留原 ref（不要清掉） */
            secret = prev
          } else if (prev.kind === 'dpapi') {
            /* 取消勾選且原本 dpapi → clear 回 none（clear 失敗也要回報，不靜默） */
            const cleared = await window.rs.vault.clearSecret(connection.id)
            if (!cleared.ok) {
              toast.show(t(cleared.error.i18nKey), 'error')
              return null
            }
            secret = { kind: 'none' }
          }
        }
        const updated = await window.rs.connections.update(connection.id, { ...base, auth: authWithSecret(secret) })
        if (!updated.ok) {
          /* #6：update 失敗 → 回滾本次寫入的 secret（清掉，避免孤兒 ref 流通） */
          if (setSecretRan) await window.rs.vault.clearSecret(connection.id)
          toast.show(t(updated.error.i18nKey), 'error')
          return null
        }
        finalProfile = updated.data
      }
      if (!finalProfile) return null
      setDirty(false)
      onSaved()
      return finalProfile
    } finally {
      setSaving(false)
    }
  }

  /* #4：儲存並連線 —— 存成功才連（新建與既有都要）；失敗 handleSave 已 toast 且回 null（不靜默） */
  const saveAndConnect = async (): Promise<void> => {
    const saved = await handleSave()
    if (saved) onConnect?.(saved)
  }

  const closeWithCheck = () => {
    /* P0 #2/#3：不再用 window.confirm（原生同步對話框阻塞 renderer）→ App 內 ConfirmDialog */
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  return (
    <>
      <Modal
        open={open}
        title={t('menu.connection.properties')}
        width={640}
        height={520}
        onClose={closeWithCheck}
        footer={
          <>
            <Button onClick={closeWithCheck}>{t('dialog.connection.button.cancel')}</Button>
            {/* #7：in-flight 時三個儲存鈕 disabled，連點只送一次 */}
            <Button disabled={saving} onClick={() => { void handleSave() }}>{t('dialog.connection.button.save')}</Button>
            <Button variant="primary" disabled={isNew || saving} onClick={() => { void saveAndConnect() }}>{t('dialog.connection.button.connect')}</Button>
            <Button variant="primary" disabled={saving} onClick={() => { void saveAndConnect() }}>{t('dialog.connection.button.saveAndConnect')}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 4, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
            {TABS.map(tb => (
              <button key={tb} type="button" onClick={() => setTab(tb)} style={{ fontWeight: tab === tb ? 600 : 400 }}>
                {t(`dialog.connection.tab.${tb === 'jump' ? 'jump' : tb === 'terminal' ? 'terminal' : tb === 'auth' ? 'auth' : 'general'}`)}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
            {tab === 'general' && <GeneralTab values={general} groups={groups} onChange={p => { setGeneral(g => ({ ...g, ...p })); setDirty(true) }} errors={errors} duplicateName={isDuplicate} />}
            {tab === 'auth' && <AuthTab values={auth} onChange={p => { setAuth(a => ({ ...a, ...p })); setDirty(true) }} errors={errors} connectionId={connection?.id ?? null} />}
            {tab === 'jump' && <JumpTab enabled={jump.enabled} selectedId={jump.selectedId} profiles={profiles.filter(p => p.id !== connection?.id)} groups={groups} errors={errors} onChange={p => { setJump(j => ({ ...j, ...p })); setDirty(true) }} targetLabel={general.host} />}
            {tab === 'terminal' && (
              <TerminalTab
                values={terminal}
                onChange={(p) => {
                  setTerminal(tl => ({ ...tl, ...p }))
                  setDirty(true)
                  /* 只有可入檔欄位的變更才標 terminalDirty（applyToAll 僅 UI） */
                  if (Object.keys(p).some(key => key !== 'applyToAll')) setTerminalDirty(true)
                }}
              />
            )}
          </div>
        </div>
      </Modal>
      {/* P0 #2/#3：未儲存變更的 App 內確認（Modal 同套疊層，兩顆都 portal 到 body） */}
      <ConfirmDialog
        open={confirmDiscard}
        title={t('dialog.connection.unsaved.title')}
        message={t('dialog.connection.unsaved.message')}
        confirmLabel={t('common.discard')}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false)
          setDirty(false)
          onClose()
        }}
      />
    </>
  )
}