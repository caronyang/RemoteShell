import { useTranslation } from 'react-i18next'
import type { DeepPartial, ThemeId } from '../../../shared/ipc-contract'
import { Button } from '../../components/Button'
import { Checkbox } from '../../components/Checkbox'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { useToast } from '../../components/Toast'
import type { PaneProps } from './GeneralPane'

const THEMES: ThemeId[] = ['dark']

/** M4-02 終端分頁（UI-05 §終端）：全域預設；套用到所有連線走 connections.update */
export function TerminalPane({ settings, onPatch }: PaneProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const terminal = settings.terminal

  const clamp = (value: string, min: number, max: number): number => {
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) return min
    return Math.max(min, Math.min(max, parsed))
  }

  const applyToAll = (): void => {
    void (async () => {
      const list = await window.rs.connections.list()
      if (!list.ok) {
        toast.show(t(list.error.i18nKey), 'error')
        return
      }
      const patch: DeepPartial<{ terminal: typeof terminal }> = {
        terminal: {
          fontFamily: terminal.fontFamily,
          fontSize: terminal.fontSize,
          themeId: terminal.themeId,
          scrollback: terminal.scrollback,
          cursorStyle: terminal.cursorStyle,
          cursorBlink: terminal.cursorBlink
        }
      }
      for (const profile of list.data.profiles) {
        await window.rs.connections.update(profile.id, { terminal: patch.terminal })
      }
      toast.show(t('settings.terminal.applyToAll'), 'success')
    })()
  }

  return (
    <div className="rs-settings__pane">
      <Input label={t('settings.terminal.font')} value={terminal.fontFamily} onValueChange={(value) => onPatch({ terminal: { fontFamily: value } })} />
      <Input
        label={t('settings.terminal.fontSize')}
        type="number"
        min={8}
        max={24}
        value={String(terminal.fontSize)}
        onValueChange={(value) => onPatch({ terminal: { fontSize: clamp(value, 8, 24) } })}
      />
      <Select
        label={t('settings.terminal.theme')}
        /* 裁決：v0.1.1 只留 dark（其他主題無 token 調色盤=假選項）。
           legacy themeId（light/solarized/monokai）僅顯示成 dark，不在此改寫使用者設定 */
        value={THEMES.includes(terminal.themeId) ? terminal.themeId : 'dark'}
        options={THEMES.map((theme) => ({ value: theme, label: theme }))}
        onValueChange={(value) => {
          if (THEMES.includes(value as ThemeId)) onPatch({ terminal: { themeId: value as ThemeId } })
        }}
      />
      <p className="rs-hint" style={{ margin: 0 }}>{t('settings.terminal.themePending')}</p>
      {/* 差異裁示：補唯讀 Encoding 列（v1 固定 UTF-8、不可選） */}
      <Input label={t('settings.terminal.encoding')} value={t('statusBar.encoding')} readOnly tabIndex={-1} />
      <Input
        label={t('settings.terminal.scrollback')}
        type="number"
        min={0}
        max={100000}
        value={String(terminal.scrollback)}
        onValueChange={(value) => onPatch({ terminal: { scrollback: clamp(value, 0, 100000) } })}
      />
      <Select
        label={t('settings.terminal.cursor')}
        value={terminal.cursorStyle}
        options={[
          { value: 'block', label: t('dialog.connection.terminal.cursorBlock') },
          { value: 'underline', label: t('dialog.connection.terminal.cursorUnderline') }
        ]}
        onValueChange={(value) => {
          if (value === 'block' || value === 'underline') onPatch({ terminal: { cursorStyle: value } })
        }}
      />
      <Checkbox
        label={t('dialog.connection.terminal.cursorBlink')}
        checked={terminal.cursorBlink}
        onCheckedChange={(checked) => onPatch({ terminal: { cursorBlink: checked } })}
      />
      <Button icon="check" onClick={applyToAll}>
        {t('settings.terminal.applyToAll')}
      </Button>
    </div>
  )
}
