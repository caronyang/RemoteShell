import { describe, it, expect } from 'vitest'
import { mapSessionState, presentStatus, phaseDisplayName, errorKey } from '../../src/renderer/features/connections/statusMapping'

describe('statusMapping', () => {
  it('maps states', () => {
    expect(mapSessionState('connected')).toBe('connected')
    expect(mapSessionState('failed')).toBe('failed')
    expect(mapSessionState(undefined)).toBe('disconnected')
  })
  it('presentStatus has icon+color+label', () => {
    const p = presentStatus('connected')
    expect(p.icon).toBeTruthy()
    expect(p.color).toBeTruthy()
    expect(p.labelKey).toBeTruthy()
  })
  it('phaseDisplayName returns key', () => {
    expect(phaseDisplayName('ready')).toBe('statusBar.phase.ready')
  })
  it('errorKey fallback', () => {
    expect(errorKey(undefined)).toBe('error.E_INTERNAL')
    expect(errorKey('E_NOT_FOUND')).toBe('error.E_NOT_FOUND')
  })
})