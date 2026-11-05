import type { SessionState, ConnectPhase } from '../../../shared/ipc-contract'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed'

export interface StatusPresentation {
  status: ConnectionStatus
  color: string
  icon: string
  labelKey: string
}

const STATUS_MAP: Record<ConnectionStatus, StatusPresentation> = {
  disconnected: { status: 'disconnected', color: 'var(--text-secondary)', icon: 'o', labelKey: 'tree.legendDisconnected' },
  connecting: { status: 'connecting', color: 'var(--warning)', icon: '~', labelKey: 'tree.legendConnecting' },
  connected: { status: 'connected', color: 'var(--success)', icon: '+', labelKey: 'tree.legendConnected' },
  failed: { status: 'failed', color: 'var(--danger)', icon: 'x', labelKey: 'tree.legendFailed' },
}

export function mapSessionState(state: SessionState | undefined): ConnectionStatus {
  if (!state) return 'disconnected'
  if (state === 'connecting') return 'connecting'
  if (state === 'connected') return 'connected'
  if (state === 'failed') return 'failed'
  return 'disconnected'
}

export function presentStatus(state: SessionState | undefined): StatusPresentation {
  return STATUS_MAP[mapSessionState(state)]
}

export const CONNECT_PHASE_LABELS: Record<ConnectPhase, string> = {
  'jump-dns': 'statusBar.phase.jumpDns',
  'jump-tcp': 'statusBar.phase.jumpTcp',
  'jump-auth': 'statusBar.phase.jumpAuth',
  tunnel: 'statusBar.phase.tunnel',
  'target-tcp': 'statusBar.phase.targetTcp',
  hostkey: 'statusBar.phase.hostkey',
  'target-auth': 'statusBar.phase.targetAuth',
  ready: 'statusBar.phase.ready',
}

export function phaseDisplayName(phase: ConnectPhase): string {
  return CONNECT_PHASE_LABELS[phase] ?? 'statusBar.phase.ready'
}

export const ERROR_FALLBACK = 'error.E_INTERNAL'

export function errorKey(code: string | undefined): string {
  if (!code) return ERROR_FALLBACK
  return `error.${code}`
}

export function isUnknownErrorCode(code: string | undefined): boolean {
  return !code || !code.startsWith('E_')
}
