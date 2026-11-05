import { CH } from '../../../shared/constants'
import { fail, ok } from '../../../shared/errors'
import { registerChannel } from '../register'

export function register(): void {
  registerChannel(CH.windowMinimize, (_payload, _ctx, event) => {
    const win = _ctx.resolveWindow(event)
    if (!win) return fail<void>('E_NOT_FOUND', { detail: 'window' })
    win.minimize()
    return ok(undefined)
  })

  registerChannel(CH.windowToggleMaximize, (_payload, _ctx, event) => {
    const win = _ctx.resolveWindow(event)
    if (!win) return fail<boolean>('E_NOT_FOUND', { detail: 'window' })
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return ok(win.isMaximized())
  })

  registerChannel(CH.windowClose, (_payload, _ctx, event) => {
    const win = _ctx.resolveWindow(event)
    if (!win) return fail<void>('E_NOT_FOUND', { detail: 'window' })
    win.close()
    return ok(undefined)
  })
}
