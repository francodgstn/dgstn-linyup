// ─── Events — the team's own, in a bounded window ───────────────────────────

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { EVENTS_COLLECTION, projectEvent, type ApiEvent, type Event } from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import { requireScope, type ListPage } from '../access'
import type { TeamReadContext } from '../context'
import { ApiError } from '../errors'

export const EVENT_WINDOW_MAX_DAYS = 366
const DAY_MS = 86_400_000

export async function listEvents(
  principal: ApiPrincipal,
  team: TeamReadContext,
  input: { fromMs: number; toMs: number; limit: number }
): Promise<ListPage<ApiEvent>> {
  requireScope(principal, 'schedule:read')
  if (!(input.toMs > input.fromMs)) throw new ApiError('invalid_request', '`to` must be after `from`')
  if (input.toMs - input.fromMs > EVENT_WINDOW_MAX_DAYS * DAY_MS) {
    throw new ApiError('window_too_wide', `The window is wider than ${EVENT_WINDOW_MAX_DAYS} days`, 'Ask for at most a year at a time')
  }
  // The (teamId, deleted_at, start) index; organisation events carry no teamId.
  const snap = await admin
    .firestore()
    .collection(EVENTS_COLLECTION)
    .where('teamId', '==', principal.teamId)
    .where('deleted_at', '==', null)
    .where('start', '>=', Timestamp.fromMillis(input.fromMs))
    .where('start', '<', Timestamp.fromMillis(input.toMs))
    .orderBy('start')
    .limit(input.limit + 1)
    .get()
  const data = snap.docs
    .slice(0, input.limit)
    .map((d) => projectEvent({ ...(d.data() as Event), id: d.id }, { currency: team.currency }))
    .filter((e): e is ApiEvent => e !== null)
  return { object: 'list', data, has_more: snap.size > input.limit, next_cursor: null }
}
