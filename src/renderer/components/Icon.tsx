import type { ReactNode } from 'react'

export type IconName =
  | 'plus'
  | 'folder-plus'
  | 'search'
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'globe'
  | 'terminal'
  | 'transfer'
  | 'queue'
  | 'chevron-right'
  | 'chevron-down'
  | 'disconnect'
  | 'reconnect'
  | 'folder'
  | 'server'
  | 'check'
  | 'warning'
  | 'info'

const PATHS: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  'folder-plus': <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 4v6m-3-3h6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
  restore: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="1" />
      <path d="M5 15V5h10" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.5 2.4 2.5 13.2 0 16-2.5-2.8-2.5-13.6 0-16Z" />
    </>
  ),
  terminal: <path d="M4 5h16v14H4zM7 10l3 2-3 2M13 15h4" />,
  transfer: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  queue: <path d="M4 6h16M4 12h16M4 18h10" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  disconnect: <path d="M8 5v6a4 4 0 0 0 8 0V5M5 19h14" />,
  reconnect: <path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="1" />
      <rect x="4" y="13" width="16" height="7" rx="1" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </>
  ),
  check: <path d="m5 13 4 4L19 7" />,
  warning: <path d="M12 4 3 20h18L12 4Zm0 5v6m0 3h.01" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5m0-8h.01" />
    </>
  )
}

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  title?: string
}

export function Icon({ name, size = 16, className, title }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}
