// ─── Sessions — the schedule, in bounded windows ─────────────────────────────

import * as admin from 'firebase-admin'
import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { SESSIONS_COLLECTION, apiTimeMs, projectSession, type ApiSession, type Session } from '@linyup/shared'
import { principalSeesSession, type ApiPrincipal } from '../auth/principal'
import { requireScope, type ListPage } from '../access'
import { cursorFingerprint, decodeCursor, encodeCursor } from '../cursor'
import { ApiError, notFound } from '../errors'

const PAGE = 200
export const SESSION_SCAN_BUDGET = 1000
/** The widest window one REST request may ask for. */
export const SESSION_WINDOW_MAX_DAYS = 62
const DAY_MS = 86_400_000

export interface SessionListInput {
  fromMs: number
  toMs: number
  limit: number
  cursor?: string | null
  activityId?: string | null
  /** A caller-specific ceiling (the MCP tool asks for less). */
  maxWindowDays?: number
}

function seesAll(principal: ApiPrincipal): boolean {
  return principal.dataScope === 'all' || principal.capabilities.has('schedule.view.all')
}

export async function listSessions(
  principal: ApiPrincipal,
  input: SessionListInput,
  nowMs: number
): Promise<ListPage<ApiSession>> {
  requireScope(principal, 'schedule:read')
  if (!(input.toMs > input.fromMs)) {
    throw new ApiError('invalid_request', '`to` must be after `from`')
  }
  const maxDays = input.maxWindowDays ?? SESSION_WINDOW_MAX_DAYS
  if (input.toMs - input.fromMs > maxDays * DAY_MS) {
    throw new ApiError('window_too_wide', `The window is wider than ${maxDays} days`, `Ask for at most ${maxDays} days at a time`)
  }

  const fingerprint = cursorFingerprint({ from: input.fromMs, to: input.toMs, activity: input.activityId })
  let position = decodeCursor(input.cursor, fingerprint)?.key as [number, string] | undefined
  const data: ApiSession[] = []
  let scanned = 0
  let reachedEnd = false
  const all = seesAll(principal)
  const db = admin.firestore()

  pages: while (scanned < SESSION_SCAN_BUDGET) {
    let query: FirebaseFirestore.Query = db.collection(SESSIONS_COLLECTION).where('teamId', '==', principal.teamId)
    if (input.activityId) query = query.where('activityId', '==', input.activityId)
    query = query
      .where('start', '>=', Timestamp.fromMillis(input.fromMs))
      .where('start', '<', Timestamp.fromMillis(input.toMs))
      .orderBy('start')
      .orderBy(FieldPath.documentId())
      .limit(PAGE)
    if (position) query = query.startAfter(Timestamp.fromMillis(position[0]), position[1])
    const snap = await query.get()

    for (let i = 0; i < snap.docs.length; i++) {
      const session = { ...(snap.docs[i].data() as Session), id: snap.docs[i].id }
      scanned += 1
      position = [apiTimeMs(session.start) ?? 0, session.id]
      if (!all && !principalSeesSession(principal, session)) continue
      const projected = projectSession(session, { nowMs })
      if (projected) data.push(projected)
      if (data.length >= input.limit) {
        reachedEnd = snap.docs.length < PAGE && i === snap.docs.length - 1
        break pages
      }
    }
    if (snap.docs.length < PAGE) {
      reachedEnd = true
      break
    }
  }

  const hasMore = !reachedEnd
  return {
    object: 'list',
    data,
    has_more: hasMore,
    next_cursor: hasMore && position ? encodeCursor({ key: position, fingerprint }) : null,
    scanned,
    scan_exhausted: hasMore && data.length < input.limit,
  }
}

export async function getSession(principal: ApiPrincipal, sessionId: string, nowMs: number): Promise<ApiSession> {
  requireScope(principal, 'schedule:read')
  const snap = await admin.firestore().collection(SESSIONS_COLLECTION).doc(sessionId).get()
  if (!snap.exists) throw notFound('session')
  const session = { ...(snap.data() as Session), id: snap.id }
  if (session.teamId !== principal.teamId) throw notFound('session')
  if (!seesAll(principal) && !principalSeesSession(principal, session)) throw notFound('session')
  const projected = projectSession(session, { nowMs })
  if (!projected) throw notFound('session')
  return projected
}
