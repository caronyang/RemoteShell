import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../components/Icon'

export interface PathBarProps {
  /** 目前路徑（本地 `C:\a\`；遠端 `/var/www/`） */
  path: string
  /** 歷史路徑（新的在前） */
  history: string[]
  kind: 'local' | 'remote'
  /** Windows 磁碟機清單（localFs.list 回；僅本地端且 >1 時顯示下拉） */
  drives?: string[]
  onNavigate: (path: string) => void
}

interface Crumb {
  label: string
  path: string
}

/** 把路徑切為可點擊面包屑：遠端以 / 切、本地以 \ 切（保留磁碟根） */
export function pathCrumbs(path: string, kind: 'local' | 'remote'): Crumb[] {
  if (kind === 'remote') {
    const parts = path.split('/').filter((part) => part !== '')
    return [
      { label: '/', path: '/' },
      ...parts.map((part, i) => ({ label: part, path: `/${parts.slice(0, i + 1).join('/')}` }))
    ]
  }
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter((part) => part !== '')
  const first = parts.shift()
  if (first === undefined) return [{ label: '', path: path }]
  return [
    { label: first, path: `${first}\\` },
    ...parts.map((part, i) => ({ label: part, path: `${[first, ...parts.slice(0, i + 1)].join('\\')}\\` }))
  ]
}

/** 路徑列（UI-03 §面板規格）：磁碟機下拉＋歷史下拉＋面包屑＋手動輸入 */
export function PathBar({ path, history, kind, drives, onNavigate }: PathBarProps): JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path)
  const crumbs = pathCrumbs(path, kind)

  useEffect(() => {
    if (!editing) setDraft(path)
  }, [editing, path])

  const submit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== path) onNavigate(draft.trim())
  }

  return (
    <div className="rs-sftp__pathbar">
      {kind === 'local' && drives && drives.length > 1 ? (
        <select
          className="rs-select rs-sftp__drives"
          value={
            drives.find((drive) => path.toLowerCase().startsWith(drive.toLowerCase())) ??
            drives[0] ??
            ''
          }
          title={t('sftp.pane.local')}
          aria-label={t('sftp.pane.local')}
          onChange={(event) => {
            if (event.target.value) onNavigate(event.target.value)
          }}
        >
          {drives.map((drive) => (
            <option key={drive} value={drive}>
              {drive}
            </option>
          ))}
        </select>
      ) : null}
      <select
        className="rs-select rs-sftp__history"
        value=""
        title={t('sftp.path.recent')}
        aria-label={t('sftp.path.recent')}
        disabled={history.length === 0}
        onChange={(event) => {
          if (event.target.value) onNavigate(event.target.value)
        }}
      >
        <option value="" hidden>
          {t('sftp.path.recent')}
        </option>
        {history.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      {editing ? (
        <input
          className="rs-input rs-sftp__input"
          value={draft}
          autoFocus
          aria-label={t('sftp.path.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <div className="rs-sftp__crumbs" title={t('sftp.path.placeholder')} onDoubleClick={() => setEditing(true)}>
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="rs-sftp__crumb-slice">
              {i > 0 ? <Icon name="chevron-right" size={10} /> : null}
              <button
                type="button"
                className="rs-sftp__crumb"
                onClick={() => onNavigate(crumb.path)}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  setEditing(true)
                }}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
