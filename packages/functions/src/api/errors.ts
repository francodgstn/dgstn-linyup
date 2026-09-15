// ─── Public API errors — one vocabulary for REST and MCP ─────────────────────
//
// A read that cannot be answered throws an `ApiError`. The REST router turns it
// into `{ error: { code, message, hint?, details? } }` with its status; the MCP
// server turns it into a tool result with `isError: true`, so a model reads the
// hint ("narrow the range") and recovers instead of seeing a protocol failure.

export type ApiErrorCode =
  | 'unauthenticated'
  | 'insufficient_scope'
  | 'not_found'
  | 'invalid_request'
  | 'invalid_cursor'
  | 'feature_unavailable'
  | 'window_too_wide'
  | 'rate_limited'
  | 'internal'

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  insufficient_scope: 403,
  not_found: 404,
  invalid_request: 400,
  invalid_cursor: 400,
  feature_unavailable: 409,
  window_too_wide: 422,
  rate_limited: 429,
  internal: 500,
}

export class ApiError extends Error {
  readonly status: number
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.status = STATUS[code]
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  console.error('[api] unexpected error:', err)
  return new ApiError('internal', 'Something went wrong on our side')
}

/** The same 404 whether the record does not exist, belongs to another team or is out of scope. */
export function notFound(what: string): ApiError {
  return new ApiError('not_found', `No such ${what}`)
}
