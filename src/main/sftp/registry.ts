import type { SftpSession } from '../sftp/session'
import { appError } from '../../shared/errors'

interface Entry {
  sessionId: string
  session: SftpSession
}

/** sftpId → SftpSession（同一 SSH session 可有多個 sftpId，全部走同一條隧道） */
export class SftpRegistry {
  private readonly entries = new Map<string, Entry>()

  add(sftpId: string, sessionId: string, session: SftpSession): void {
    this.entries.set(sftpId, { sessionId, session })
  }

  get(sftpId: string): SftpSession {
    const entry = this.entries.get(sftpId)
    if (!entry) throw appError('E_NOT_FOUND', { detail: `sftp ${sftpId}` })
    return entry.session
  }

  /** 傳輸任務用：以 sessionId 找唯一的 SFTP session */
  bySession(sessionId: string): SftpSession {
    const found = this.tryBySession(sessionId)
    if (found) return found
    throw appError('E_SFTP_UNAVAILABLE', { detail: `no sftp session for ${sessionId}` })
  }

  tryBySession(sessionId: string): SftpSession | null {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return entry.session
    }
    return null
  }

  has(sessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  remove(sftpId: string): void {
    const entry = this.entries.get(sftpId)
    if (!entry) return
    entry.session.end()
    this.entries.delete(sftpId)
  }

  removeBySession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue
      entry.session.end()
      this.entries.delete(id)
    }
  }

  size(): number {
    return this.entries.size
  }
}
