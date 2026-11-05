import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo, AppSettings, DeepPartial, HostKeyPrompt } from '../shared/ipc-contract'
import { applyLocale } from './i18n'
import { MainWindow } from './features/layout/MainWindow'
import { ToastProvider } from './components/Toast'
import { HostKeyDialog } from './components/HostKeyDialog'

export function App(): JSX.Element | null {
  const { i18n } = useTranslation()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [settingsResult, infoResult] = await Promise.all([
        window.rs.settings.get(),
        window.rs.app.info()
      ])
      if (cancelled) return
      if (settingsResult.ok) setSettings(settingsResult.data)
      if (infoResult.ok) setInfo(infoResult.data)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 跨視窗同步（§3.4 rs:evt:settings:changed）
  useEffect(() => window.rs.settings.onChange((next) => setSettings(next)), [])

  // 主機金鑰 TOFU 詢問（§6.1 第 6 階段）
  useEffect(() => window.rs.hostkey.onPrompt((prompt) => setHostKey(prompt)), [])

  useEffect(() => {
    if (!settings) return
    applyLocale(i18n, settings.locale)
    document.documentElement.setAttribute('lang', settings.locale)
  }, [i18n, settings])

  const patch = useCallback((partial: DeepPartial<AppSettings>) => {
    void (async () => {
      const result = await window.rs.settings.patch(partial)
      if (result.ok) setSettings(result.data)
    })()
  }, [])

  const answerHostKey = useCallback((requestId: string, decision: 'once' | 'always' | 'reject') => {
    setHostKey(null)
    void window.rs.hostkey.answer(requestId, decision)
  }, [])

  if (!settings) return null

  return (
    <ToastProvider>
      <MainWindow settings={settings} info={info} onPatch={patch} />
      <HostKeyDialog prompt={hostKey} onAnswer={answerHostKey} />
    </ToastProvider>
  )
}
