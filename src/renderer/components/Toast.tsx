import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastMessage {
  id: number
  kind: ToastKind
  text: string
}

interface ToastContextValue {
  show: (text: string, kind?: ToastKind, ttlMs?: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastMessage[]>([])

  const show = useCallback((text: string, kind: ToastKind = 'info', ttlMs = 4000) => {
    const id = nextId++
    setItems((prev) => [...prev, { id, kind, text }])
    window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id))
    }, ttlMs)
  }, [])

  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="rs-toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={`rs-toast rs-toast--${item.kind}`}
            role={item.kind === 'error' ? 'alert' : undefined}
          >
            <Icon name={item.kind === 'success' ? 'check' : item.kind === 'info' ? 'info' : 'warning'} size={14} />
            <span>{item.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
