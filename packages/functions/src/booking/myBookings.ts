// `getMyBookings` — every upcoming booking the signed-in contact actually holds.
//
// WHY IT IS A CALLABLE, AND WHY THE CLIENT QUERY IT REPLACES COULD NOT BE FIXED
// IN PLACE. The Space listed the TEAM's upcoming public session mirrors and then
// probed each one for a `bookings/{contactId}` document. Three things were wrong
// with that, and only a server read fixes the third:
//
//   1. it filtered on `type == 'session'`, and an appointment is mirrored as
//      `type == 'appointment_session'` (sync/syncSessionPublicProfile.ts), so no
//      appointment could ever match — a member holding a paid 1:1 was told she
//      had no upcoming bookings, on the one surface she would use to cancel it;
//   2. it truncated at 80 mirrors of the TEAM's schedule, so at ten classes a
//      day her list ended about eight days out and a booking four weeks ahead
//      was invisible — a cap that tightens as the studio grows;
//   3. a session is mirrored at all only when `allowBooking === true`, so a
//      session the STUDIO booked her into (online booking off, or an appointment
//      entered by staff) had no public document to find her booking through.
//
// (3) is why widening the `type` filter would have been an interim and not the
// answer: the public mirror is a marketing surface, and the member's own list
// must not be a subset of what the studio happens to be selling. The Admin SDK
// reads `sessions` directly, so mirror liveness and online-bookability stop
// mattering here.
//
// THE QUERY, AND WHAT BOUNDS IT. One collection-group query over her own
// booking documents (`teamId` + `contact`), newest reservation first, one page
// per call. The cap is HERS — her own most recently made reservations — never
// the team's volume, and the boundary is reported honestly through `cursor`
// rather than silently swallowed: a full page means her history continues and
// the surface offers to walk further back. In practice page one is the whole
// answer, because a booking for an upcoming session is, almost by construction,
// among the most recently made ones.
//
// THE ORDERING FIELD IS LOAD-BEARING, and its index is SPARSE: a booking
// written without `joinedAt` is not in the index and would never appear in her
// list — the same silent omission as the `type` filter above, one layer down.
// Every rail that writes a booking stamps it; `myBookings.test.ts` re-derives
// that set from the source rather than leaving it to this sentence, and it
// walks `apps/web/src` as well as this package: the staff "Add contact" dialog
// on the session detail page writes a booking straight from the browser, with
// no server seam to put a guard on, and a derivation that stopped at the
// package boundary called this closed while that door was open.
//
// A booking document carries no session start (denormalising one would put the
// session's clock in the hands of half a dozen writers plus every reschedule),
// so the starts come from a single batched `getAll` of the sessions those
// bookings point at. Read cost per call: 1 query (≤ MY_BOOKINGS_SCAN_PAGE
// documents) + 1 batched session read + 1 batched activity read for the few
// upcoming sessions that do not carry their own `autoConfirm`.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  SESSIONS_COLLECTION,
  isUnclaimedClaimHold,
  resolveAutoConfirm,
  bookingWasPaidFor,
  type SeatHold,
  type ActivityType,
  type MyBooking,
  type MyBookingsResult,
} from '@linyup/shared'
import { requireContactSessionForTeam } from '../utils/contactSession'
import { isSessionCancelled } from './waitlist/constants'

/** Bookings live at `sessions/{sessionId}/bookings/{contactId}`. */
const BOOKINGS_SUBCOLLECTION = 'bookings'

/**
 * How many of her own booking documents one call walks back through.
 *
 * Sized so the whole page fits one `getAll` of sessions without chunking, and
 * so a member who books three times a week is covered for roughly four months
 * of history by page one. Past that the caller pages with `cursor` — the cap
 * moves, it does not hide anything.
 */
export const MY_BOOKINGS_SCAN_PAGE = 60

/** Statuses that mean this document no longer represents a seat she holds here.
 *  'rebooked' moved the seat to ANOTHER session, which has its own document. */
const RESOLVED_BOOKING_STATUSES = new Set(['cancelled', 'rebooked'])

/** The booking fields this module reads. Kept structural so a raw
 *  `DocumentData` can be handed over without narrowing it first. */
export interface MemberBookingDoc {
  status?: string
  payment_status?: string
  expires_at?: { toMillis(): number } | null
  waitlist_claim?: boolean
  claim_expires_at?: { toMillis(): number } | null
  blocked_time?: boolean
  booking_token?: string
}

/**
 * Is this document a booking the MEMBER should see in her own list?
 *
 * Deliberately not `bookingHoldsSeat`: that predicate answers a capacity
 * question ("does this occupy a seat right now"), and a live unpaid hold does
 * occupy one while it lasts. It is still not a booking she HAS — it is a
 * checkout in flight, which either becomes a booking (the webhook confirms it
 * and the next load shows it) or lapses. Telling her she is booked in the
 * meantime is the same class of false statement this callable exists to remove,
 * pointed the other way.
 *
 * An unclaimed waitlist offer is excluded for the same reason and belongs to a
 * different surface: it is a seat OFFERED, with a deadline, and `listMyWaitlist`
 * is what renders it.
 */
export function bookingIsLiveForMember(b: MemberBookingDoc): boolean {
  if (b.status && RESOLVED_BOOKING_STATUSES.has(b.status)) return false
  // A coach's private block on their own calendar. It carries no `contact`, so
  // it cannot match her query anyway — named here so that stays true by
  // intention rather than by luck.
  if (b.blocked_time === true) return false
  if (b.payment_status === 'required') return false
  if (isUnclaimedClaimHold(b)) return false
  return true
}

/**
 * Will `cancelBooking` still accept this booking?
 *
 * It re-derives that callable's own three gates rather than guessing, because
 * the honest failure mode of a member portal is a Cancel button that refuses:
 * she reads the refusal as "nothing happened", presses it again, and either
 * turns up to a class she believes she left or gives up. A session the studio
 * has already called off is excluded too — there is nothing left to cancel, and
 * the row says so instead.
 */
export function memberCanCancel(params: {
  bookingStatus?: string
  hasToken: boolean
  startMs: number | null
  nowMs: number
  /** The session's effective auto-confirm — a session that auto-confirms treats
   *  'confirmed' as the normal booked state; one that does not uses it to mean
   *  the studio checked her in, and that stays locked. */
  autoConfirm: boolean
  sessionCancelled: boolean
}): boolean {
  const { bookingStatus, hasToken, startMs, nowMs, autoConfirm, sessionCancelled } = params
  if (!hasToken || sessionCancelled) return false
  if (startMs === null || startMs <= nowMs) return false
  if (!bookingStatus) return true // absent status reads as pending
  const cancellable = autoConfirm
    ? ['pending', 'no_show', 'confirmed']
    : ['pending', 'no_show']
  return cancellable.includes(bookingStatus)
}

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

export const getMyBookings = onCall(async (request): Promise<MyBookingsResult> => {
  const data = (request.data ?? {}) as { teamId?: string; cursor?: number | null }
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  // WHO is the contact session and only the contact session; WHICH TEAM'S
  // surface is asking is the one thing the body may say. The two are checked
  // against each other (`requireContactSessionForTeam` refuses a session minted
  // for another team, and re-reads the contact so a 7-day token cannot outlive
  // an archived or deleted account). A contactId in the body would make this an
  // enumerator for every contact of the team — see utils/contactSession.ts, and
  // the session-first precedence pinned in appointments/callerIdentity.test.ts.
  const { contactId } = await requireContactSessionForTeam(request, teamId)

  const cursor =
    typeof data.cursor === 'number' && Number.isFinite(data.cursor) ? data.cursor : null

  const db = admin.firestore()
  let q = db
    .collectionGroup(BOOKINGS_SUBCOLLECTION)
    .where('teamId', '==', teamId)
    .where('contact', '==', contactId)
  if (cursor !== null) {
    // Inclusive, not `startAfter`: the boundary document comes back a second
    // time (harmless — the caller merges by sessionId) rather than a tie at the
    // page edge silently dropping a booking.
    q = q.where('joinedAt', '<=', Timestamp.fromMillis(cursor))
  }
  const snap = await q.orderBy('joinedAt', 'desc').limit(MY_BOOKINGS_SCAN_PAGE).get()

  const nowMs = Date.now()
  const candidates = snap.docs.filter((d) => bookingIsLiveForMember(d.data() as MemberBookingDoc))

  // One booking per session per contact (the document id IS the contactId), so
  // the session id is a key, not just a grouping.
  const bySession = new Map<string, FirebaseFirestore.DocumentData>()
  for (const d of candidates) {
    const sessionId = d.ref.parent.parent?.id
    if (sessionId && !bySession.has(sessionId)) bySession.set(sessionId, d.data())
  }

  const sessionIds = [...bySession.keys()]
  const sessionSnaps = sessionIds.length
    ? await db.getAll(...sessionIds.map((id) => db.collection(SESSIONS_COLLECTION).doc(id)))
    : []

  // Upcoming only — same horizon the surface has always shown, now applied to
  // HER sessions rather than to a page of the team's.
  const upcoming: Array<{
    sessionId: string
    booking: FirebaseFirestore.DocumentData
    session: FirebaseFirestore.DocumentData
    startMs: number
  }> = []
  for (const sessionSnap of sessionSnaps) {
    if (!sessionSnap.exists) continue
    const session = sessionSnap.data()!
    const startMs = millisOf(session.start)
    if (startMs === null || startMs < nowMs) continue
    upcoming.push({
      sessionId: sessionSnap.id,
      booking: bySession.get(sessionSnap.id)!,
      session,
      startMs,
    })
  }

  // `autoConfirm` is denormalised onto every session the appointment rails
  // create and onto class sessions that carry it; only the rest need their
  // activity, and only to answer the cancelable question the same way
  // cancelBooking does. Batched, and over the upcoming set alone — typically
  // one or two documents.
  const activityIds = [
    ...new Set(
      upcoming
        .filter((u) => typeof u.session.autoConfirm !== 'boolean')
        .map((u) => u.session.activityId as string | undefined)
        .filter((id): id is string => !!id)
    ),
  ]
  const activities = new Map<string, FirebaseFirestore.DocumentData>()
  if (activityIds.length > 0) {
    const activitySnaps = await db.getAll(
      ...activityIds.map((id) => db.collection(ACTIVITIES_COLLECTION).doc(id))
    )
    for (const a of activitySnaps) if (a.exists) activities.set(a.id, a.data()!)
  }

  upcoming.sort((a, b) => a.startMs - b.startMs)

  const bookings: MyBooking[] = upcoming.map(
    ({ sessionId, booking, session, startMs }) => {
      const isAppointment = session.activityType === 'appointment'
      const activity = session.activityId
        ? activities.get(session.activityId as string)
        : undefined
      const autoConfirm =
        typeof session.autoConfirm === 'boolean'
          ? (session.autoConfirm as boolean)
          : resolveAutoConfirm({
              autoConfirm: activity?.autoConfirm as boolean | undefined,
              type:
                (activity?.type as ActivityType | undefined) ??
                (isAppointment ? 'appointment' : 'class'),
            })
      const sessionCancelled = isSessionCancelled(session)
      const token = (booking.booking_token as string | undefined) ?? null
      const cancellable = memberCanCancel({
        bookingStatus: booking.status as string | undefined,
        hasToken: !!token,
        startMs,
        nowMs,
        autoConfirm,
        sessionCancelled,
      })
      return {
        sessionId,
        kind: isAppointment ? ('appointment' as const) : ('class' as const),
        activityName: (session.activityName as string | undefined) ?? null,
        start: isoOf(session.start),
        end: isoOf(session.end),
        location: (session.location as string | undefined) ?? null,
        onlineUrl: (session.onlineUrl as string | undefined) ?? null,
        providerName: (session.providerName as string | undefined) ?? null,
        status: (booking.status as string | undefined) ?? null,
        cancellable,
        // Only when it is going to work. It is her own token either way (she was
        // mailed it), but a button that exists is a promise.
        cancelToken: cancellable ? token : null,
        sessionCancelled,
        // Read off THIS booking's own markers — the same three fields
        // cancelBooking's transaction acts on. The row can therefore say what
        // canceling returns (and, for a paid seat, what it does not) before
        // she presses, instead of leaving her to guess about her own money.
        cancelEffect: {
          credit: !!booking.credit_grant_id && !!booking.credit_spent,
          usageUnit: !!booking.usage_window_doc_id,
          paid: bookingWasPaidFor(booking as SeatHold),
        },
      }
    }
  )

  // A full page means her reservation history may continue past it; anything
  // short means the server reached the end of it and there is nothing more to
  // ask for.
  const last = snap.docs[snap.docs.length - 1]
  const nextCursor =
    snap.size === MY_BOOKINGS_SCAN_PAGE && last ? millisOf(last.data().joinedAt) : null

  return { bookings, cursor: nextCursor, scanned: snap.size }
})
