// `getMyAttendance` — the sessions the signed-in contact actually attended.
//
// WHY IT IS A CALLABLE. `firestore.rules` lets a contact GET her own
// `sessions/{id}/participants/{contactId}` row and never LIST across sessions,
// the same split that made `getMyBookings` a callable. The member app worked
// around it the only way a client can: it listed the TEAM's sessions in the
// window and then read one participant document per session to ask "was I
// there?". A month at a busy studio is 150–200 document reads per calendar
// open, per member, and the training chart repeated the whole thing over its
// weeks (docs/scalability-2026-09.md §17 C1, C2). One collection-group query
// over her own rows replaces all of it.
//
// ── THE WINDOW IS ON THE SESSION'S CLOCK, THE SCAN IS ON THE ROW'S ───────────
//
// The question is "which sessions in this month did I attend", so the answer is
// filtered on `session.start`. The SCAN cannot be: an attendance row carries no
// session start (denormalising one would hand the session's clock to every
// writer plus every reschedule — the same reasoning as myBookings.ts), so the
// only indexed field to bound it by is `checkedInAt`.
//
// Those two clocks are NOT the same, in BOTH directions, which is what the
// margin below is for:
//
//   • EARLY — a booking confirmed in advance writes the attendance row there
//     and then (`buildParticipantDoc`'s `fromBooking`), so `checkedInAt` can
//     precede the session by however long the studio takes bookings ahead.
//   • LATE — a coach tidying a roster after the fact stamps `checkedInAt` days
//     after the class ran.
//
// So the scan asks for a window widened by ATTENDANCE_SCAN_MARGIN_DAYS at each
// end and then filters precisely on the sessions. A margin is a heuristic and
// is named as one: it is generous (a quarter either way), the page cap is far
// above what any real person generates inside it, and a scan that does hit the
// cap says so through `truncated` rather than returning a calendar with days
// quietly missing.
//
// Read cost per call: 1 collection-group query (≤ MY_ATTENDANCE_SCAN_PAGE rows)
// + 1 batched `getAll` of the sessions those rows point at.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  SESSIONS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  type MyAttendance,
  type MyAttendanceResult,
} from '@linyup/shared'
import { requireContactSessionForTeam } from '../utils/contactSession'

/**
 * How far outside the requested window an attendance row may be stamped and
 * still be found. See the module header for the two directions it covers.
 */
export const ATTENDANCE_SCAN_MARGIN_DAYS = 90

/**
 * How many of her own attendance rows one call walks.
 *
 * The window a caller asks for is a month (the calendar) or a year (the chart's
 * longest view), and the margin adds two quarters. Somebody training six times
 * a week for a whole year inside that scan produces about 400 rows, so this cap
 * is roughly triple the busiest real case — and `truncated` reports it rather
 * than hiding it if a caller ever asks for more.
 */
export const MY_ATTENDANCE_SCAN_PAGE = 1200

const DAY_MS = 86_400_000

function isoOf(v: unknown): string | null {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate(): Date }).toDate().toISOString()
  }
  return null
}

function millisOf(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis(): number }).toMillis()
  }
  return null
}

export const getMyAttendance = onCall(async (request): Promise<MyAttendanceResult> => {
  const data = (request.data ?? {}) as { teamId?: string; fromMs?: number; toMs?: number }
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  const fromMs = Number(data.fromMs)
  const toMs = Number(data.toMs)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new HttpsError('invalid-argument', 'fromMs and toMs must bound a window')
  }

  // WHO is the contact session and only the contact session — a contactId in
  // the body would turn this into an attendance enumerator for every member of
  // the team. Same guard, and the same reasoning, as getMyBookings.
  const { contactId } = await requireContactSessionForTeam(request, teamId)

  const db = admin.firestore()
  const margin = ATTENDANCE_SCAN_MARGIN_DAYS * DAY_MS
  const snap = await db
    .collectionGroup(PARTICIPANTS_SUBCOLLECTION)
    .where('contactId', '==', contactId)
    .where('checkedInAt', '>=', Timestamp.fromMillis(fromMs - margin))
    .where('checkedInAt', '<=', Timestamp.fromMillis(toMs + margin))
    .orderBy('checkedInAt', 'desc')
    .limit(MY_ATTENDANCE_SCAN_PAGE)
    .get()

  // One attendance row per session per contact (the document id IS the contact
  // id), so the session id is a key and not merely a grouping.
  const sessionIds = [
    ...new Set(
      snap.docs.map((d) => d.ref.parent.parent?.id).filter((id): id is string => !!id)
    ),
  ]

  // `getAll` takes a variadic list and one call is one round trip; chunked so a
  // long history cannot build a single oversized request.
  const CHUNK = 300
  const sessionSnaps: FirebaseFirestore.DocumentSnapshot[] = []
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const refs = sessionIds
      .slice(i, i + CHUNK)
      .map((id) => db.collection(SESSIONS_COLLECTION).doc(id))
    sessionSnaps.push(...(await db.getAll(...refs)))
  }

  const attended: MyAttendance[] = []
  for (const sessionSnap of sessionSnaps) {
    if (!sessionSnap.exists) continue
    const session = sessionSnap.data()!
    // The row carries no tenant stamp, and a contact belongs to one team, so
    // this can only differ if the data is already wrong — checked anyway, since
    // the alternative is showing one studio's session on another's calendar.
    if (session.teamId !== teamId) continue
    const startMs = millisOf(session.start)
    if (startMs === null || startMs < fromMs || startMs > toMs) continue
    attended.push({
      sessionId: sessionSnap.id,
      activityId: (session.activityId as string | undefined) ?? null,
      activityName: (session.activityName as string | undefined) ?? null,
      start: isoOf(session.start),
      end: isoOf(session.end),
      location: (session.location as string | undefined) ?? null,
      providerName: (session.providerName as string | undefined) ?? null,
    })
  }

  attended.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))

  return {
    attended,
    truncated: snap.size === MY_ATTENDANCE_SCAN_PAGE,
    scanned: snap.size,
  }
})
