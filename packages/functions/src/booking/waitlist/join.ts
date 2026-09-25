/* eslint-disable no-console */
// joinWaitlist — take a place in the queue for a full class.
//
// The free-path sibling of bookSession: same guest handling (exact email+name
// match, else a new contact), same question narrowing, same attribution. What it
// deliberately does NOT do is decide anything about money or access — a
// prospective member's subscription may start before the class, and joining a
// queue snapshots nothing about price. Both are settled when the seat is
// actually offered and claimed.
//
// It DOES decide one thing, and it is the only place that can: whether the class
// is actually full. Having a seat cap is not the same as being at it, and a
// queue on a class with room is not a queue — the promoter would turn it
// straight into claim holds and lock every real booker out.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  CONTACTS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  WAITLIST_SUBCOLLECTION,
  bookingHoldsSeat,
  countHoldingSeats,
  isPastBookingCutoff,
  parseBookingSource,
  sanitizeBookingAnswers,
  seatsFree,
  type FormField,
  type SeatHold,
} from '@linyup/shared'
import { loadBookingSettings } from '../bookingSettings'
import { healSessionSeatCount } from '../seatCount'
import { checkoutRateLimit } from '../../connect/checkout'
import { optionalContactSessionFromRequest } from '../../utils/contactSession'
import { generateSecureToken } from '../../utils/crypto'
import { requirePlan } from '../../utils/plan'
import { getTeam } from '../../utils/teams'
import {
  WAITLIST_QUEUE_SCAN_LIMIT,
  WAITLIST_RATE_LIMIT_BUCKET,
  isSessionCancelled,
  waitlistQueueCap,
} from './constants'
import { notifyWaitlistJoined } from './notify'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A waitlist-born contact is reaped if the queue never comes good. Unlike a
 *  trial booking's provisional contact (no deadline at all), this one has never
 *  been promised anything — 30 days past the class is generous, and
 *  purgeProvisionalContacts re-checks the flag at delete time, so a claim that
 *  confirms them makes them permanent. */
const PROVISIONAL_DAYS_AFTER_SESSION = 30

export const joinWaitlist = onCall(async (request) => {
  const data = request.data as {
    teamId?: string
    sessionId?: string
    contactDetails?: { firstname?: string; lastname?: string; email?: string; phone?: string }
    questionAnswers?: Record<string, unknown>
    source?: string
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!data?.sessionId) throw new HttpsError('invalid-argument', 'sessionId is required')
  const { teamId, sessionId } = data
  const db = admin.firestore()

  // A full class is the one surface an attacker can hammer, and every join can
  // create a contact. This bucket, the queue cap below and the provisional
  // deadline are what bound that.
  await checkoutRateLimit(request.rawRequest?.ip, WAITLIST_RATE_LIMIT_BUCKET)

  // ── The session must be one a queue can even mean something for ────────────
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found')
  const session = sessionSnap.data()!
  if (session.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'Session does not belong to this team')
  }
  if (session.activityType === 'appointment') {
    // An appointment session does not exist until it is booked, so "full" has no
    // meaning; the analogous feature is a queue on an availability window.
    throw new HttpsError('failed-precondition', 'Appointments have no waitlist')
  }
  // Both cancellation shapes: a canceled occurrence of a recurring series keeps
  // its `allowBooking` and gets no `status`, so a status-only test would let a
  // queue form on a class that will never run.
  if (isSessionCancelled(session) || session.allowBooking !== true) {
    throw new HttpsError('permission-denied', 'Bookings are not allowed for this session')
  }
  const start = session.start as Timestamp
  if (start.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Cannot join the waitlist for a past session')
  }
  const maxParticipants = session.max_participants as number | undefined
  if (!maxParticipants || maxParticipants <= 0) {
    // An uncapped class is never full, so its queue could never be offered from.
    throw new HttpsError('failed-precondition', 'This class has no seat limit')
  }

  // The team must exist (the queue is team-scoped), but its booking settings are
  // no longer on the team doc — they live in the ONE store, the world-readable
  // public_profile (see bookingSettings.ts).
  if (!(await getTeam(teamId))) throw new HttpsError('not-found', 'Team not found')
  const { cutoffMinutes } = await loadBookingSettings(teamId)
  // Past the cutoff nothing can be offered from this queue (the promoter clamps
  // the claim window to it), so joining would be a promise we cannot keep.
  if (isPastBookingCutoff(start, cutoffMinutes)) {
    throw new HttpsError('failed-precondition', 'Online booking has closed for this session.')
  }

  const activityId = session.activityId as string | undefined
  if (!activityId) throw new HttpsError('failed-precondition', 'Session has no activity')
  const activitySnap = await db.collection(ACTIVITIES_COLLECTION).doc(activityId).get()
  if (!activitySnap.exists) throw new HttpsError('not-found', 'Activity not found')
  const activity = activitySnap.data()!
  if (activity.waitlistEnabled !== true) {
    throw new HttpsError('failed-precondition', 'This class has no waitlist', {
      reason: 'waitlist_disabled',
    })
  }
  const questionAnswers = sanitizeBookingAnswers(
    Array.isArray(activity.bookingQuestions) ? (activity.bookingQuestions as FormField[]) : null,
    data.questionAnswers
  )

  // Gates control CREATION only — an outstanding offer and an existing queue
  // complete their lifecycle through a downgrade.
  //
  // This is the ONE public caller of `requirePlan`, and that is why both of its
  // refusals carry `details.reason` ('plan_required' / 'plan_inactive'): the
  // messages it throws are the studio's billing prose, in English, and the
  // caller here is a visitor who may be reading a French page. The public form
  // maps those two codes to "the queue is not available for this class" and
  // never renders the message. Keep them mapped if a third plan refusal is ever
  // added.
  await requirePlan(teamId, 'coach')

  // ── Who is joining ─────────────────────────────────────────────────────────
  // Trust ONLY the verified contact-session token for a caller's identity; a
  // contactId in the request body proves nothing and would let anyone enumerate
  // the team's contacts. Guests carry no session and fall through to email+name.
  let contactId: string
  let firstname: string
  let lastname: string
  let email: string
  let phone: string | null = null

  const contactSession = optionalContactSessionFromRequest(request)
  if (contactSession && contactSession.teamId === teamId) {
    const cSnap = await db.collection(CONTACTS_COLLECTION).doc(contactSession.contactId).get()
    const c = cSnap.data()
    if (!cSnap.exists || c?.teamId !== teamId) throw new HttpsError('not-found', 'Contact not found')
    contactId = cSnap.id
    firstname = (c!.firstname as string) || ''
    lastname = (c!.lastname as string) || ''
    // A place in a queue is only ever redeemed by MAIL: the offer carries the
    // single-use claim token, and the SMS nudge says "check your email". So a
    // contact with no address on their record cannot be given a place at all —
    // they would take one, be offered a seat nobody could tell them about, and
    // be dropped from the queue having never been reachable (one offer per
    // entry, ever).
    //
    // The session's own login email is the fallback before refusing: a contact
    // reached through the per-contact login-email allow-list (a parent on a
    // child's profile) may have an empty `Contact.email` while the address they
    // proved control of is right there in the verified token claims.
    email = ((c!.email as string) || '').toLowerCase().trim()
    if (!email)
      email = ((request.auth?.token?.email as string | undefined) ?? '').toLowerCase().trim()
    if (!EMAIL_RE.test(email)) {
      throw new HttpsError(
        'failed-precondition',
        'An email address is needed to hold a place on the waitlist.',
        { reason: 'email_required' }
      )
    }
    phone = (c!.phone as string) || null
  } else {
    const cd = data.contactDetails
    email = (cd?.email ?? '').toLowerCase().trim()
    firstname = (cd?.firstname ?? '').trim()
    lastname = (cd?.lastname ?? '').trim()
    phone = cd?.phone?.trim() || null
    if (!EMAIL_RE.test(email) || !firstname || !lastname) {
      throw new HttpsError('invalid-argument', 'firstname, lastname and a valid email are required')
    }
    const existing = await db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('email', '==', email)
      .get()
    const match = existing.docs.find((d) => {
      const c = d.data()
      return (
        c.firstname?.toLowerCase().trim() === firstname.toLowerCase() &&
        c.lastname?.toLowerCase().trim() === lastname.toLowerCase()
      )
    })
    if (match) {
      contactId = match.id
    } else {
      const ref = db.collection(CONTACTS_COLLECTION).doc()
      await ref.set({
        firstname,
        lastname,
        email,
        phone,
        // NO acquisition_stage, on purpose: joining a queue is not a trial
        // booking, and stamping 'trial_booked' on someone who may never get a
        // seat would report a funnel entry that never happened. The stage is
        // stamped when they claim.
        entry: 'waitlist',
        provisional: true,
        provisional_expires_at: Timestamp.fromMillis(
          start.toMillis() + PROVISIONAL_DAYS_AFTER_SESSION * 24 * 60 * 60 * 1000
        ),
        teamId,
        archived_at: null,
        deleted_at: null,
        created_at: FieldValue.serverTimestamp(),
      })
      contactId = ref.id
      console.log(`[waitlist] new provisional contact ${contactId} joined session ${sessionId}`)
    }
  }

  // ── The place in the queue ─────────────────────────────────────────────────
  // The doc id IS the contactId, so a double-click is a write to the same
  // document rather than a second place in the line; the guards below turn it
  // into an honest refusal instead of a silent overwrite of `joined_at`.
  const waitlistRef = sessionRef.collection(WAITLIST_SUBCOLLECTION)
  const entryRef = waitlistRef.doc(contactId)
  const entryToken = generateSecureToken()
  const queueCap = waitlistQueueCap(maxParticipants)

  /** Either a place in the queue, or the one refusal that has bookkeeping to do
   *  after the transaction closes (see `seat_available` below). */
  type JoinOutcome = { kind: 'joined'; position: number } | { kind: 'seat_available' }

  const outcome = await db.runTransaction<JoinOutcome>(async (tx) => {
    // The session is re-read INSIDE the transaction, and not for its contents:
    // the write below is a merge-set, and a merge-set on a deleted document
    // CREATES it — a ghost session carrying nothing but a `waitlist_count`,
    // visible to every list and every sweep, plus a queue entry underneath it
    // that nobody will ever be offered from. `release.ts` guards the identical
    // hazard the identical way. The pre-flight read above happened before this
    // transaction; only a read in its own read set settles the race.
    const sessionTxSnap = await tx.get(sessionRef)
    if (!sessionTxSnap.exists) throw new HttpsError('not-found', 'Session not found')
    const entrySnap = await tx.get(entryRef)
    const waitingSnap = await tx.get(
      waitlistRef.where('status', '==', 'waiting').limit(WAITLIST_QUEUE_SCAN_LIMIT)
    )
    const bookingsSnap = await tx.get(sessionRef.collection('bookings'))
    const participantSnap = await tx.get(
      sessionRef.collection(PARTICIPANTS_SUBCOLLECTION).doc(contactId)
    )
    const nowMs = Date.now()
    const ownBooking = bookingsSnap.docs.find((d) => d.id === contactId)

    // Already in the class — including on an unclaimed hold of their own, which
    // still occupies the seat they would be queueing for.
    if (
      participantSnap.exists ||
      (ownBooking && bookingHoldsSeat(ownBooking.data() as SeatHold, nowMs))
    ) {
      throw new HttpsError('failed-precondition', 'You already have a place in this class.', {
        reason: 'already_booked',
      })
    }

    const existingStatus = entrySnap.data()?.status as string | undefined
    if (existingStatus === 'waiting' || existingStatus === 'offered') {
      throw new HttpsError('already-exists', 'You are already on the waitlist for this class.', {
        reason: 'already_waiting',
      })
    }

    // A QUEUE ONLY MEANS SOMETHING ON A FULL CLASS. Having a cap is not the same
    // as being at it: without this, twenty joins on an empty ten-seat class
    // become ten claim holds, the class reads `full`, and every real booker is
    // refused for the whole claim window — re-offered every hour, forever. The
    // same thing happens benignly whenever a joiner races a cancellation.
    //
    // Same predicate, same read set, same clock as every capacity gate — and it
    // matches the client, which only offers the queue when `sessionBlockReason`
    // says 'full'. Because it is the JOIN that is wrong here, the sweep's
    // backstop pass is left free to do its real job (re-offering after a missed
    // trigger) instead of being taught to second-guess it.
    if (seatsFree(maxParticipants, countHoldingSeats(bookingsSnap.docs, nowMs, contactId)) > 0) {
      return { kind: 'seat_available' }
    }

    const waiting = waitingSnap.size
    if (waiting >= queueCap) {
      throw new HttpsError('resource-exhausted', 'This waitlist is full.', {
        reason: 'waitlist_full',
      })
    }

    // A full set, not a merge: re-joining after a lapsed offer (or after
    // leaving) starts a genuinely fresh place at the TAIL — new `joined_at`, no
    // trace of the previous round's offer fields. That is the whole reason there
    // is no re-queue machinery.
    tx.set(entryRef, {
      teamId,
      session: sessionId,
      contact: contactId,
      // Denormalised so a collection-group sweep can find entries left on
      // sessions that have already run, without a join.
      session_start: start,
      firstname,
      lastname,
      email,
      phone,
      joined_at: FieldValue.serverTimestamp(),
      status: 'waiting',
      entry_token: entryToken,
      source: parseBookingSource(data.source) ?? 'online',
      ...(questionAnswers ? { question_answers: questionAnswers } : {}),
    })
    // Absolute, from this transaction's read set. `bookings_count` is untouched
    // — joining a queue takes no seat — so this write cannot look like a freed
    // seat to the promotion trigger.
    tx.set(sessionRef, { waitlist_count: waiting + 1 }, { merge: true })
    return { kind: 'joined', position: waiting + 1 }
  })

  if (outcome.kind === 'seat_available') {
    // The class advertised itself as full — that is the only reason this caller
    // is here — and the live count says otherwise. So the stored number is
    // stale, and correcting it is what turns this refusal into something the
    // visitor can act on: the public mirror is derived from it, so until it is
    // healed the slot keeps rendering as a dead "no seats" row. Best-effort and
    // deliberately AFTER the transaction: the refusal stands either way, and a
    // failed recount must not turn into a 500 on a class that has room.
    try {
      await healSessionSeatCount(sessionId)
    } catch (err) {
      console.error(`[waitlist] seat-count heal failed for session ${sessionId}:`, err)
    }
    throw new HttpsError('failed-precondition', 'A seat is available — book the class instead.', {
      reason: 'seat_available',
    })
  }
  const position = outcome.position

  // AFTER the commit, and only then: the response below is otherwise the single
  // copy of `entryToken` that ever exists, so a guest who closes the tab has no
  // way back to their own place in the queue. The mail carries the status link
  // built from it. It never throws — a mail failure must not undo a place in a
  // queue the caller has already been given.
  await notifyWaitlistJoined({
    teamId,
    sessionId,
    contactId,
    firstname,
    email,
    position,
    entryToken,
  })

  return { position, entryToken }
})
