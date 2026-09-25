import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import {
  EVENTS_COLLECTION,
  EVENT_CATEGORIES_SUBCOLLECTION,
  EVENT_PROGRAM_ITEMS_SUBCOLLECTION,
  MAX_PROGRAM_ITEMS,
  daysBetweenISO,
  isoDateInTimezone,
  shiftProgramDays,
} from '@linyup/shared'
import type { EventProgramConfig } from '@linyup/shared'
import { DEFAULT_TIMEZONE } from '../utils/dateFormatting'

// Region comes from the single setGlobalOptions call in index.ts — see the note
// there. A second call warns "Calling setGlobalOptions twice leads to undefined
// behavior".

// Duplicating an event copies its SETUP — settings, categories and the whole
// program — and never its PARTICIPANTS. Attendees, invitations, check-ins and
// every counter start empty on the copy.
//
// Server-side rather than a client batch because it copies a subcollection and
// must not leave a half-copied event behind if the client disappears mid-write.

interface DuplicateEventInput {
  eventId: string
  /** ISO date or datetime for the copy's start. The end and every program day
   *  shift by the same delta, so a five-day camp keeps its shape. */
  newStart?: string
  title?: string
}

/** Fields that are deliberately NOT carried over. Everything else on the source
 *  event is copied verbatim, so a new event field is inherited by default —
 *  which is the safe direction for setup data. */
export const DROPPED_FIELDS = new Set([
  'id',
  // participant state
  'participants_count',
  'completed_checkins_count',
  'attendees_count',
  'invitations_sent_count',
  'last_invitation_sent_at',
  // provenance + publication
  'created_at',
  'createdBy',
  'deleted_at',
  'updated_at',
  'publicVisibility',
  // handled explicitly below
  'title',
  'start',
  'end',
  'program',
])

/** The subset of the source event that survives duplication, before the copy's
 *  own title/dates/program/counters are layered on top. Pure, so the "never
 *  copy participant state, never inherit published" contract is unit-testable. */
export function carriedFields(source: Record<string, unknown>): Record<string, unknown> {
  const carried: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!DROPPED_FIELDS.has(key)) carried[key] = value
  }
  return carried
}

/** The event's calendar date as the STUDIO sees it, not as the server does.
 *  Cloud Functions run in UTC, so reading the date off the Date directly puts an
 *  event starting 00:30 in Zurich on the previous day — and the program day
 *  shift derived from it then lands a full day out. */
function isoDateOfTimestamp(ts: unknown): string | null {
  const d = (ts as Timestamp | undefined)?.toDate?.()
  if (!d || Number.isNaN(d.getTime())) return null
  return isoDateInTimezone(d, DEFAULT_TIMEZONE)
}

export const duplicateEvent = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required.')

  const { eventId, newStart, title } = (request.data ?? {}) as DuplicateEventInput
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId is required.')

  const db = admin.firestore()
  const sourceRef = db.collection(EVENTS_COLLECTION).doc(eventId)
  const sourceSnap = await sourceRef.get()
  if (!sourceSnap.exists) throw new HttpsError('not-found', 'Event not found.')

  const source = sourceSnap.data()!
  const isOrgEvent = source.scope === 'org' && !!source.orgId

  // ── authorization — the same shape as addEventCheckin ──────────────────────
  if (isOrgEvent) {
    const member = await db
      .collection('organizations').doc(source.orgId as string)
      .collection('org_members').doc(request.auth.uid)
      .get()
    if (!member.exists || member.data()?.role !== 'org_admin') {
      throw new HttpsError('permission-denied', 'Only org admins can duplicate org events.')
    }
  } else {
    const teamId = source.teamId as string | undefined
    if (!teamId) throw new HttpsError('failed-precondition', 'Event has no team.')
    const member = await db
      .collection('teams').doc(teamId)
      .collection('team_members').doc(request.auth.uid)
      .get()
    if (!member.exists) throw new HttpsError('permission-denied', 'Not a member of this team.')
    const role = member.data()?.role as string | undefined
    if (role !== 'owner' && role !== 'manager') {
      throw new HttpsError('permission-denied', 'Only managers and owners can duplicate events.')
    }
  }

  // ── dates ──────────────────────────────────────────────────────────────────
  const sourceStart = (source.start as Timestamp | undefined)?.toDate?.() ?? null
  const sourceEnd = (source.end as Timestamp | undefined)?.toDate?.() ?? null

  let nextStart = sourceStart
  if (newStart) {
    const parsed = new Date(newStart)
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpsError('invalid-argument', 'newStart is not a valid date.')
    }
    // Keep the original time of day when only a calendar date was supplied.
    if (sourceStart && /^\d{4}-\d{2}-\d{2}$/.test(newStart.trim())) {
      parsed.setHours(sourceStart.getHours(), sourceStart.getMinutes(), 0, 0)
    }
    nextStart = parsed
  }

  const shiftMs =
    sourceStart && nextStart ? nextStart.getTime() - sourceStart.getTime() : 0
  const nextEnd = sourceEnd ? new Date(sourceEnd.getTime() + shiftMs) : null

  // ── program ──────────────────────────────────────────────────────────────
  // Days are wall-clock calendar dates, so they shift by whole DAYS rather than
  // by the millisecond delta — a camp moved by "one day and two hours" still
  // lands on consecutive calendar days.
  const sourceProgram = source.program as EventProgramConfig | undefined
  let nextProgram = sourceProgram
  if (sourceProgram?.days?.length) {
    const fromDate = isoDateOfTimestamp(source.start)
    // Both endpoints read through the SAME timezone, or the delta between them
    // is meaningless.
    const toDate = nextStart ? isoDateInTimezone(nextStart, DEFAULT_TIMEZONE) : null
    const dayShift = fromDate && toDate ? daysBetweenISO(fromDate, toDate) : 0
    nextProgram = shiftProgramDays(sourceProgram, dayShift)
  }

  const programItemsSnap = await sourceRef
    .collection(EVENT_PROGRAM_ITEMS_SUBCOLLECTION)
    .get()
  if (programItemsSnap.size > MAX_PROGRAM_ITEMS) {
    // Refuse rather than silently truncating — a partial program on the copy
    // would look complete and be wrong.
    throw new HttpsError(
      'failed-precondition',
      `This program has ${programItemsSnap.size} items, above the ${MAX_PROGRAM_ITEMS} limit.`,
    )
  }

  // ── write ──────────────────────────────────────────────────────────────────
  const targetRef = db.collection(EVENTS_COLLECTION).doc()
  const batch = db.batch()

  const carried = carriedFields(source)

  batch.set(targetRef, {
    ...carried,
    title: title?.trim() || `${source.title ?? 'Event'} (copy)`,
    ...(nextStart ? { start: Timestamp.fromDate(nextStart) } : {}),
    ...(nextEnd ? { end: Timestamp.fromDate(nextEnd) } : {}),
    ...(nextProgram ? { program: nextProgram } : {}),
    // Participant state always starts empty on a copy.
    participants_count: 0,
    completed_checkins_count: 0,
    attendees_count: 0,
    invitations_sent_count: 0,
    // A duplicate must NEVER inherit "published" — that would silently expose a
    // draft event the moment it is created.
    publicVisibility: 'hidden',
    status: source.status === 'cancelled' ? 'open' : (source.status ?? 'open'),
    deleted_at: null,
    created_at: FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
  })

  // Program items keep their tenant stamp — it must match the new event's,
  // which is identical because scope/teamId/orgId are carried over verbatim.
  for (const item of programItemsSnap.docs) {
    const data = item.data()
    batch.set(targetRef.collection(EVENT_PROGRAM_ITEMS_SUBCOLLECTION).doc(), {
      ...data,
      eventId: targetRef.id,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })
  }

  // Categories are per-event SETUP (weight classes, age brackets), not
  // participant data, so they come across too.
  const categoriesSnap = await sourceRef.collection(EVENT_CATEGORIES_SUBCOLLECTION).get()
  for (const category of categoriesSnap.docs) {
    batch.set(
      targetRef.collection(EVENT_CATEGORIES_SUBCOLLECTION).doc(category.id),
      category.data(),
    )
  }

  await batch.commit()

  return {
    eventId: targetRef.id,
    programItems: programItemsSnap.size,
    categories: categoriesSnap.size,
  }
})
