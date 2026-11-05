import { z } from 'zod'
import type { ConnectionGroup, ConnectionInput, ConnectionProfile } from '../../../shared/ipc-contract'
import { CH } from '../../../shared/constants'
import { appError, fail, ok } from '../../../shared/errors'
import { StoreValidationError, connectionGroupSchema, connectionInputSchema } from '../../store/schema'
import { ConnectionInUseError } from '../../store/connections'
import { registerChannel } from '../register'

const idSchema = z.string().min(1)
const updateSchema = z.object({ id: idSchema, patch: connectionInputSchema.partial() })
const removeSchema = z.object({ id: idSchema })
const reorderSchema = z.object({ ids: z.array(idSchema) })
const groupCreateSchema = z.object({ name: z.string().min(1), parentId: z.string().nullable() })
const groupUpdateSchema = z.object({
  id: idSchema,
  patch: connectionGroupSchema.omit({ id: true }).partial()
})
const groupRemoveSchema = z.object({ id: idSchema })

/** P0-01-2：main 不信任 UI —— 跳板必須有 id、必須存在、必須是 SSH，且不能是自己 */
export function assertValidJump(
  jump: ConnectionInput['jump'],
  profiles: ConnectionProfile[],
  selfId?: string
): void {
  if (!jump.enabled) return
  if (jump.connectionIds.length === 0) {
    throw appError('E_VALIDATION', { detail: 'jump: enabled but no jump connection selected' })
  }
  for (const id of jump.connectionIds) {
    if (selfId !== undefined && id === selfId) {
      throw appError('E_VALIDATION', { detail: 'jump: a connection cannot use itself as a jump host' })
    }
    const profile = profiles.find((p) => p.id === id)
    if (!profile) {
      throw appError('E_VALIDATION', { detail: `jump: jump profile not found (${id})` })
    }
    if (profile.protocol !== 'ssh') {
      throw appError('E_VALIDATION', {
        detail: `jump: "${profile.name}" is ${profile.protocol}; jump host must be SSH`
      })
    }
  }
}

/** dependent 名稱最多列 5 筆，後面帶總數 */
export function jumpDependentsDetail(dependents: string[]): string {
  const shown = dependents.slice(0, 5).join(', ')
  return `jump dependents (${dependents.length}): ${shown}`
}

export function register(): void {
  registerChannel(CH.connectionsList, (_payload, ctx) => {
    const { profiles, groups } = ctx.connections.list()
    return ok<{ profiles: ConnectionProfile[]; groups: ConnectionGroup[] }>({ profiles, groups })
  })

  registerChannel(CH.connectionsCreate, (payload, ctx) => {
    const input = connectionInputSchema.parse(payload)
    assertValidJump(input.jump, ctx.connections.list().profiles)
    return ok<ConnectionProfile>(ctx.connections.create(input))
  })

  registerChannel(
    CH.connectionsUpdate,
    (payload, ctx) => {
      const { id, patch } = updateSchema.parse(payload)
      const profiles = ctx.connections.list().profiles
      const existing = profiles.find((p) => p.id === id)
      if (existing) {
        // patch 可能只帶部分欄位：用合併後的值驗跳板
        const effectiveJump = patch.jump ?? existing.jump
        assertValidJump(effectiveJump, profiles, id)
        // 這條連線若被別人當跳板，就不能改成非 SSH
        if (patch.protocol !== undefined && patch.protocol !== 'ssh') {
          const dependents = ctx.connections.dependentsOf(id)
          if (dependents.length > 0) {
            throw appError('E_CONFLICT', { detail: jumpDependentsDetail(dependents) })
          }
        }
      }
      return ok<ConnectionProfile>(ctx.connections.update(id, patch))
    }
  )

  registerChannel(CH.connectionsRemove, (payload, ctx) => {
    const { id } = removeSchema.parse(payload)
    try {
      ctx.connections.remove(id)
    } catch (error) {
      if (error instanceof ConnectionInUseError) {
        throw appError('E_CONFLICT', { detail: jumpDependentsDetail(error.dependents) })
      }
      throw error
    }
    return ok(undefined)
  })

  registerChannel(CH.connectionsReorder, (payload, ctx) => {
    const { ids } = reorderSchema.parse(payload)
    ctx.connections.reorder(ids)
    return ok(undefined)
  })

  registerChannel(CH.groupsCreate, (payload, ctx) => {
    const input = groupCreateSchema.parse(payload)
    return ok<ConnectionGroup>(ctx.connections.createGroup(input))
  })

  registerChannel(CH.groupsUpdate, (payload, ctx) => {
    const { id, patch } = groupUpdateSchema.parse(payload)
    return ok<ConnectionGroup>(ctx.connections.updateGroup(id, patch))
  })

  registerChannel(CH.groupsRemove, (payload, ctx) => {
    const { id } = groupRemoveSchema.parse(payload)
    try {
      ctx.connections.removeGroup(id)
    } catch (error) {
      if (error instanceof StoreValidationError && error.message.startsWith('group has children')) {
        return fail<void>('E_CONFLICT', { detail: error.message })
      }
      throw error
    }
    return ok(undefined)
  })
}
