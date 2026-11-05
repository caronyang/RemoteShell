import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppError, SessionInfo } from '../../../shared/ipc-contract'
import { neighborAfterClose } from './tabNeighbor'

export interface CredentialRequest {
  sessionId: string
  profileId: string
  error: AppError
}

/** v0.1.5 P2：錯誤 + i18n 插值參數（例如 E_TARGET_TCP 的 host/port） */
export interface SessionOpenError {
  error: AppError
  params: Record<string, unknown>
}

export interface UseSessionsResult {
  sessions: SessionInfo[]
  activeId: string | null
  setActiveId: (id: string | null) => void
  open: (profileId: string, opts?: { secret?: string; cols?: number; rows?: number; params?: Record<string, unknown> }) => Promise<SessionInfo | null>
  close: (sessionId: string) => Promise<void>
  reconnect: (sessionId: string) => Promise<void>
  active: SessionInfo | null
  /** M4-07：重連因 vault/auth 失敗時要求補輸入憑證（null = 不需） */
  pendingCredential: CredentialRequest | null
  /** 送出暫時憑證：以 ephemeral.secret 重開同 profile（不落盤） */
  submitCredential: (secret: string) => Promise<void>
  /** 取消補輸入：維持斷線，不重試 */
  cancelCredential: () => void
  /** v0.1.5：最近一次 open／reconnect 失敗（非憑證類錯誤）；MainWindow 負責 toast 後清除 */
  lastError: SessionOpenError | null
  clearError: () => void
}

const CREDENTIAL_ERROR_CODES = new Set(['E_VAULT_UNAVAILABLE', 'E_TARGET_AUTH'])

/**
 * P1-01 分頁殭屍防線（兩層的第 2 層）：
 * - upsert：已存在就更新、不存在就加入（呼叫端決定允不允許新增）
 * - info 為 connected → 清掉「同 profileId」的 failed/disconnected 分頁
 *   （憑證重連與 reconnect 兩條路各留一顆的殭屍就是這裡收）
 */
function mergeSession(prev: SessionInfo[], info: SessionInfo): SessionInfo[] {
  const index = prev.findIndex((session) => session.sessionId === info.sessionId)
  const base = index < 0 ? [...prev, info] : prev.map((session, i) => (i === index ? info : session))
  if (info.state !== 'connected') return base
  return base.filter(
    (session) =>
      session.sessionId === info.sessionId ||
      session.profileId !== info.profileId ||
      (session.state !== 'failed' && session.state !== 'disconnected')
  )
}

/**
 * 連線狀態的權威來源仍是 main；這裡只做 renderer 端的鏡像（§2 鐵則 3）。
 * 事件：rs:evt:session:state（連線／斷線／失敗都走同一條）。
 */
export function useSessions(): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [pendingCredential, setPendingCredential] = useState<CredentialRequest | null>(null)
  /* v0.1.5：非憑證類的 open／reconnect 失敗要留下來給 MainWindow toast（不可靜默） */
  const [lastError, setLastError] = useState<SessionOpenError | null>(null)
  const clearError = useCallback(() => setLastError(null), [])
  const sessionsRef = useRef<SessionInfo[]>([])
  sessionsRef.current = sessions
  /* P1-05：連按兩次 Reconnect 不產生重複 session */
  const reconnectingRef = useRef(false)

  useEffect(() => {
    const off = window.rs.session.onState((info) => {
      setSessions((prev) => {
        /* P1-01 第 1 層：只更新「已存在」的 sessionId。
           main close 舊 session 時仍會 broadcast 舊 id —— 未知 id 直接忽略，
           否則會被當新分頁 append 回來（重連一輪 +2 failed 殭屍）。 */
        if (!prev.some((session) => session.sessionId === info.sessionId)) return prev
        return mergeSession(prev, info)
      })
      setActiveId((current) => current ?? info.sessionId)
    })
    return off
  }, [])

  const open = useCallback(
    async (profileId: string, opts?: { secret?: string; cols?: number; rows?: number; params?: Record<string, unknown> }) => {
      const result = await window.rs.session.open({
        profileId,
        cols: opts?.cols ?? 120,
        rows: opts?.rows ?? 30,
        ...(opts?.secret ? { ephemeral: { secret: opts.secret } } : {})
      })
      if (!result.ok) {
        /* 憑證類錯誤交給 CredentialDialog（二選一，不另外 toast）；其他錯誤交給 MainWindow toast */
        if (CREDENTIAL_ERROR_CODES.has(result.error.code)) {
          setPendingCredential({ sessionId: '', profileId, error: result.error })
        } else {
          setLastError({ error: result.error, params: opts?.params ?? {} })
        }
        return null
      }
      setLastError(null)
      /* P1-01：open 是唯一合法的「新分頁」來源 —— 進清單時一併清同 profile 的 failed 殭屍 */
      setSessions((prev) => mergeSession(prev, result.data))
      setActiveId(result.data.sessionId)
      return result.data
    },
    []
  )

  const close = useCallback(async (sessionId: string) => {
    const ids = sessionsRef.current.map((session) => session.sessionId)
    await window.rs.session.close(sessionId)
    setSessions((prev) => prev.filter((session) => session.sessionId !== sessionId))
    setActiveId((current) => neighborAfterClose(ids, sessionId, current))
  }, [])

  const reconnect = useCallback(async (sessionId: string) => {
    if (reconnectingRef.current) return
    reconnectingRef.current = true
    try {
      const result = await window.rs.session.reconnect(sessionId)
      if (!result.ok) {
        const info = sessionsRef.current.find((session) => session.sessionId === sessionId)
        // M4-07：vault 不可用／驗證失敗 → 跳憑證補輸入；其他錯誤維持斷線，不自動重試
        if (CREDENTIAL_ERROR_CODES.has(result.error.code)) {
          if (info) setPendingCredential({ sessionId, profileId: info.profileId, error: result.error })
          return
        }
        /* P1-05：main 的 reconnect 是 close 舊 session + open —— open 失敗後舊 session 已不存在，
           第二次 reconnect 會拿到 E_NOT_FOUND（不在憑證碼清單 → 曾靜默卡死）。
           改以 profileId 直接重新 open：成功取代舊分頁；失敗若為憑證碼 → 再跳憑證框（保留可重試狀態）。 */
        if (result.error.code === 'E_NOT_FOUND' && info) {
          const opened = await window.rs.session.open({ profileId: info.profileId, cols: info.cols, rows: info.rows })
          if (opened.ok) {
            const next = opened.data
            setSessions((prev) => mergeSession(prev.filter((s) => s.sessionId !== sessionId && s.sessionId !== next.sessionId), next))
            setActiveId(next.sessionId)
            setPendingCredential(null)
            setLastError(null)
            return
          }
          if (CREDENTIAL_ERROR_CODES.has(opened.error.code)) {
            setPendingCredential({ sessionId, profileId: info.profileId, error: opened.error })
          } else {
            setLastError({ error: opened.error, params: { host: info.host, port: info.port } })
          }
        } else {
          setLastError({
            error: result.error,
            params: info ? { host: info.host, port: info.port } : {}
          })
        }
        return
      }
      const next = result.data
      // 重連會拿到新的 sessionId：把舊分頁換掉，避免同時留下「已斷線」與「已連線」兩個同名分頁
      // P1-01：走 mergeSession —— 一併清同 profile 的 failed/disconnected 殭屍
      setSessions((prev) => mergeSession(prev.filter((session) => session.sessionId !== sessionId && session.sessionId !== next.sessionId), next))
      setActiveId(next.sessionId)
      setPendingCredential(null)
      setLastError(null)
    } finally {
      reconnectingRef.current = false
    }
  }, [])

  /* 送出暫時憑證：reconnect 契約無 ephemeral 參數，改以 open+ephemeral 重開同 profile
     （main 的 reconnect 本質也是 close+open；open 走同一條 ssh/telnet 管線與 vault 流程） */
  const submitCredential = useCallback(
    async (secret: string) => {
      const request = pendingCredential
      if (!request) return
      const old = sessionsRef.current.find((session) => session.sessionId === request.sessionId)
      const opened = await window.rs.session.open({
        profileId: request.profileId,
        cols: old?.cols ?? 120,
        rows: old?.rows ?? 30,
        ephemeral: { secret }
      })
      setPendingCredential(null)
      if (!opened.ok) {
        /* 憑證仍錯 → 留在憑證對話框；其他錯誤 → toast */
        if (CREDENTIAL_ERROR_CODES.has(opened.error.code)) setPendingCredential(request)
        else setLastError({ error: opened.error, params: old ? { host: old.host, port: old.port } : {} })
        return
      }
      setSessions((prev) => mergeSession(prev.filter((session) => session.sessionId !== request.sessionId && session.sessionId !== opened.data.sessionId), opened.data))
      setActiveId(opened.data.sessionId)
      setLastError(null)
    },
    [pendingCredential]
  )

  const cancelCredential = useCallback(() => {
    // 取消：維持斷線狀態，不重試（使用者可再按重連）
    setPendingCredential(null)
  }, [])

  const active = sessions.find((session) => session.sessionId === activeId) ?? null

  return { sessions, activeId, setActiveId, open, close, reconnect, active, pendingCredential, submitCredential, cancelCredential, lastError, clearError }
}
