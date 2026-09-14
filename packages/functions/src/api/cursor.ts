// ─── Opaque list cursors ─────────────────────────────────────────────────────
//
// A cursor carries the sort key of the last row a page returned and a
// fingerprint of the filters that produced it. A cursor replayed against
// different filters is refused rather than silently skipping rows. It is not
// signed: the team always comes from the principal, so tampering with a cursor
// can only move where a page starts inside data the caller may already read.

import { ApiError } from './errors'

const VERSION = 1

export interface CursorPayload {
  /** The sort key of the last returned row, document id last. */
  key: Array<string | number | null>
  /** `cursorFingerprint` of the request's filters. */
  fingerprint: string
}

export function cursorFingerprint(filters: Record<string, unknown>): string {
  const stable = Object.keys(filters)
    .sort()
    .filter((k) => filters[k] !== undefined && filters[k] !== null)
    .map((k) => [k, filters[k]])
  return Buffer.from(JSON.stringify(stable)).toString('base64url').slice(0, 64)
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ v: VERSION, k: payload.key, f: payload.fingerprint })).toString('base64url')
}

export function decodeCursor(raw: string | null | undefined, fingerprint: string): CursorPayload | null {
  if (raw == null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new ApiError('invalid_cursor', 'The cursor is not one this API issued')
  }
  const p = parsed as { v?: unknown; k?: unknown; f?: unknown }
  if (p.v !== VERSION || !Array.isArray(p.k) || typeof p.f !== 'string') {
    throw new ApiError('invalid_cursor', 'The cursor is not one this API issued')
  }
  if (p.f !== fingerprint) {
    throw new ApiError('invalid_cursor', 'The cursor was issued for different filters', 'Start again without a cursor')
  }
  return { key: p.k as CursorPayload['key'], fingerprint: p.f }
}
