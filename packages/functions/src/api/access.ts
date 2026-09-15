import type { ApiScope } from '@linyup/shared'
import { principalMay, type ApiPrincipal } from './auth/principal'
import { ApiError } from './errors'

/** Refuse unless the scope is granted AND usable by the member right now. */
export function requireScope(principal: ApiPrincipal, scope: ApiScope): void {
  if (principalMay(principal, scope)) return
  throw new ApiError(
    'insufficient_scope',
    `This connection cannot read ${scope.split(':')[0]}`,
    'The studio owner can grant it when creating a key; a team member can only use what their role allows',
    { required: scope }
  )
}

/** The HTTPS handler's request and response, from the SDK's own signature. */
type HttpsHandler = Parameters<typeof import('firebase-functions/v2/https').onRequest>[0]
export type ApiRequest = Parameters<HttpsHandler>[0]
export type ApiResponse = Parameters<HttpsHandler>[1]

export interface ListPage<T> {
  object: 'list'
  data: T[]
  has_more: boolean
  next_cursor: string | null
  /** Present when rows were filtered in memory: how many were read, and whether the read budget ran out first. */
  scanned?: number
  scan_exhausted?: boolean
}
