/* eslint-disable no-console */
// The promoter — when a seat frees on a full class, hand it to the front of the
// queue and hold it for them.
//
// It hangs on ONE trigger: a session document whose write freed a seat
// (`seatFreedEdge`). Every event that can free a seat converges there — a
// cancellation, a no-show flip, a rebooking out, a released payment hold, a
// raised cap — either through the writer's own absolute count or through
// `trackBookings`' recount. Wiring six call sites instead would have missed the
// seventh.
//
// The offer is an ORDINARY booking carrying `waitlist_claim` + `claim_expires_at`
// (see Booking), so the seat it holds is counted by the same predicate as every
// other seat: nothing else in the codebase needs to learn what a waitlist is for
// the class to stop selling that seat out from under the queue.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  CONTACTS_COLLECTION,
  SESSIONS_COLLECTION,
  WAITLIST_SUBCOLLECTION,
  bookingHoldsSeat,
  countHoldingSeats,
  isPastBookingCutoff,
  seatFreedEdge,
  seatsFree,
  type BookingSource,
  type SeatHold,
} from '@linyup/shared'
import { bookingSettingsFrom, teamPublicProfileRef } from '../bookingSettings'
import { generateBookingReference, generateSecureToken } from '../../utils/crypto'
import { nextSmsWindowOpen } from '../../utils/sms'
import {
  WAITLIST_MAX_OFFERS_PER_RUN,
  WAITLIST_QUEUE_SCAN_LIMIT,
  isSessionCancelled,
  resolveClaimWindow,
  selectOfferHeads,
} from './constants'
import { notifyWaitlistOffers } from './notify'
import { releaseWaitlistOffer } from './release'

/** One minted offer, returned so the caller can notify the person — the mail and
 *  the SMS are sent AFTER the commit, never inside the transaction. */
export interface WaitlistOffer {
  teamId: string
  sessionId: string
  contactId: string
  firstname: string
  lastname: string
  email: string
  phone: string | null
  offerToken: string
  offerExpiresAt: Timestamp
}

export interface OfferWaitlistOptions {
  /**
   * Offer the seat to THIS contact, ahead of the queue — the admin's "Offer now"
   * row action, where a coach has a reason to skip the order (the front of the
   * queue is the person who just told them they cannot make it).
   *
   * It changes exactly two things and nothing else: which entry is picked, and
   * what happens when no offer can be made. A pinned run **throws** rather than
   * returning empty, because a human asked for a specific outcome and "nothing
   * happened" is not an answer they can act on. Every guard below is still
   * re-verified from storage — pinning skips the queue order, never the rules.
   */
  pinnedContactId?: string
}

/**
 * Offer as many free seats as this session currently has, oldest waiter first.
 *
 * ONE transaction, and the session document is in both its read set and its
 * write set — that is the serialization point. Two people cannot take the same
 * seat because `bookSession`, `createDropInCheckout`, `rebookSession` and this
 * function all conflict on that one document; the bookings subcollection only
 * supplies the number.
 *
 * Idempotent by construction: it re-derives everything from storage (the trigger
 * payload is used for nothing but "wake up") and returns without writing when
 * there is nothing to offer. That is what makes a double fire — the seat-freeing
 * write AND `trackBookings`' recount of the same booking both write the session —
 * produce exactly one offer. It is also why the no-op path MUST NOT touch the
 * session document: a "harmless" write would re-enter the trigger forever.
 *
 * Called by the trigger below, and directly by anything that frees a seat and
 * wants it re-offered immediately rather than at the next backstop pass.
 */
export async function offerWaitlistSeats(
  sessionId: string,
  options: OfferWaitlistOptions = {}
): Promise<WaitlistOffer[]> {
  const db = admin.firestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const bookingsRef = sessionRef.collection('bookings')
  const waitlistRef = sessionRef.collection(WAITLIST_SUBCOLLECTION)
  const pinned = options.pinnedContactId ?? null

  /** Every "nothing to offer" exit goes through here. Automatic runs (the
   *  trigger, the sweep, a re-offer after someone leaves) must be silent no-ops
   *  — that silence IS the idempotency that lets the trigger fire twice for one
   *  cancellation. A pinned run is a person pressing a button, so it reports
   *  which guard stopped it instead. */
  const stop = (reason: string, message: string): WaitlistOffer[] => {
    if (!pinned) return []
    throw new HttpsError('failed-precondition', message, { reason })
  }

  return db.runTransaction<WaitlistOffer[]>(async (tx) => {
    // ── READS (every one of them, before the first write) ────────────────────
    // Ordered cheapest-first so the overwhelmingly common case — a session with
    // no queue at all — costs two reads and stops.
    const sessionSnap = await tx.get(sessionRef)
    if (!sessionSnap.exists) return stop('session_unavailable', 'Session not found')
    const session = sessionSnap.data()!

    const nowMs = Date.now()
    const start = session.start as Timestamp | undefined
    const teamId = session.teamId as string | undefined
    const activityId = session.activityId as string | undefined
    if (!start || !teamId || !activityId) return stop('session_unavailable', 'Session not found')
    // Re-verified from storage, never from the event: the trigger may fire on a
    // write that has nothing to do with why we can or cannot offer.
    // BOTH cancellation shapes — a canceled occurrence of a series keeps its
    // `allowBooking` and gets no `status` (see isSessionCancelled).
    if (isSessionCancelled(session)) return stop('booking_closed', 'This class is canceled.')
    if (session.allowBooking !== true) {
      return stop('booking_closed', 'Bookings are not allowed for this session')
    }
    if (session.activityType === 'appointment') {
      return stop('session_unavailable', 'Appointments have no waitlist')
    }
    if (start.toMillis() <= nowMs) return stop('booking_closed', 'This class has already started.')

    // THE queue: `joined_at ASC`, always. Nothing else is read — an entry that
    // has already been offered is not a candidate (one offer per entry, ever)
    // and its seat is accounted for by its booking hold, below.
    const queueSnap = await tx.get(
      waitlistRef
        .where('status', '==', 'waiting')
        .orderBy('joined_at', 'asc')
        .limit(WAITLIST_QUEUE_SCAN_LIMIT)
    )
    if (queueSnap.empty) return stop('not_waiting', 'Nobody is waiting for this class.')

    // The waitlist flag lives on the ACTIVITY only (no session copy, no
    // fan-out, no backfill — see Session.waitlist_count). One extra read on a
    // path that runs only when a seat frees.
    const activitySnap = await tx.get(db.collection(ACTIVITIES_COLLECTION).doc(activityId))
    if (activitySnap.data()?.waitlistEnabled !== true) {
      return stop('waitlist_disabled', 'This class has no waitlist')
    }

    // THE booking-settings store — the team's public_profile doc, read inside the
    // transaction like every other input to the offer (bookingSettings.ts).
    const settingsSnap = await tx.get(teamPublicProfileRef(teamId))
    const bookingSettings = bookingSettingsFrom(settingsSnap.data())
    // Offering past the cutoff would hand someone a claim their own booking
    // callables then refuse — the claim page's worst possible failure.
    if (isPastBookingCutoff(start, bookingSettings.cutoffMinutes, nowMs)) {
      return stop('booking_closed', 'Online booking has closed for this class.')
    }

    const claimWindow = resolveClaimWindow({
      nowMs,
      claimStartMs: nextSmsWindowOpen(new Date(nowMs)).getTime(),
      sessionStartMs: start.toMillis(),
      cutoffMinutes: bookingSettings.cutoffMinutes,
      claimMinutes: bookingSettings.waitlistClaimMinutes,
    })
    // Too little window left to be reachable. The seat stays visibly FREE — the
    // day sheet and the walk-in door can take it, which is the right owner for a
    // seat that frees minutes before class.
    if (!claimWindow.offerable) {
      return stop('claim_window_too_short', 'There is no longer time to claim this seat.')
    }

    const bookingsSnap = await tx.get(bookingsRef)
    const bookingsById = new Map(bookingsSnap.docs.map((d) => [d.id, d.data() as SeatHold]))
    const holding = countHoldingSeats(bookingsSnap.docs, nowMs)
    // Outstanding offers need NO separate subtraction: a live claim hold IS a
    // booking that holds a seat (`bookingHoldsSeat` counts it until
    // `claim_expires_at`), so `holding` already covers them. Subtracting the
    // offered entries on top would double-count them and stall the queue one
    // seat short — 8 confirmed plus 1 live offer on a 10-seat class leaves a
    // genuinely empty seat that nobody would ever be offered.
    //
    // The mirror case is why the count, not the entry, is the authority: an
    // offer whose window has passed stops holding its seat the instant anyone
    // reads it (lazy expiry), so the seat rolls on to the next person without
    // waiting for a sweep to tidy the entry.
    const free = seatsFree(session.max_participants as number | undefined, holding)

    // Heads, oldest first. Someone who got into the class another way since
    // joining (booked the moment a seat appeared, paid a drop-in) is PASSED OVER
    // rather than offered: the offer writes over the booking document, and
    // overwriting their confirmed — possibly paid — booking with an unclaimed
    // hold would destroy the seat they already own.
    const candidates = queueSnap.docs.filter((d) => {
      const existing = bookingsById.get(d.id)
      return !existing || !bookingHoldsSeat(existing, nowMs)
    })

    const room = Math.min(free, WAITLIST_MAX_OFFERS_PER_RUN)
    // THE idempotency point, and the only reason the trigger may safely fire
    // twice for one cancellation. Nothing has been written yet, and on these two
    // exits nothing will be — least of all the session document (see the note
    // above). The queue clean-up further down writes ENTRIES only, which no
    // trigger watches.
    if (room <= 0) return stop('session_full', 'This class has no free seat to offer.')
    if (candidates.length === 0) return stop('not_waiting', 'Nobody is waiting for this class.')

    // The contact documents are read, not blind-updated: `tx.update` on a
    // contact that was deleted since joining throws, which would abort every
    // other offer in this pass and wedge the queue on that session forever.
    //
    // They are read for EVERY candidate, and BEFORE the head is taken — that
    // ordering is the whole fix (see selectOfferHeads). One extra `getAll`,
    // bounded by the queue read above (WAITLIST_QUEUE_SCAN_LIMIT) and in
    // practice by waitlistQueueCap, on a path that runs only when a seat frees.
    const contactRefs = candidates.map((d) => db.collection(CONTACTS_COLLECTION).doc(d.id))
    const contactSnaps = await tx.getAll(...contactRefs)
    const liveContacts = new Set(contactSnaps.filter((s) => s.exists).map((s) => s.id))
    const { heads, dropped } = selectOfferHeads(candidates, room, pinned, (c) =>
      liveContacts.has(c.id)
    )

    // ── WRITES ───────────────────────────────────────────────────────────────
    // An entry whose contact was hard-deleted is closed out, on EVERY path that
    // reaches here — including the one that then makes no offer at all. Without
    // it that entry is re-read and re-skipped by every trigger and every hourly
    // backstop for the life of the class; with it the queue heals in one pass.
    // The write is on the ENTRY, never on the session document, so the
    // promoter's no-op rule (a session touch re-enters its own trigger) still
    // holds.
    if (dropped.length > 0) {
      console.warn(
        `[waitlist] expiring ${dropped.length} entr${dropped.length === 1 ? 'y' : 'ies'} on session ${sessionId} whose contact no longer exists: ${dropped
          .map((d) => d.id)
          .join(', ')}`
      )
    }
    for (const doc of dropped) {
      tx.update(doc.ref, { status: 'expired', expired_at: FieldValue.serverTimestamp() })
    }
    if (heads.length === 0) {
      // A pinned run throws from `stop`, which rolls the clean-up above back
      // with it — the next automatic pass redoes it, and telling the coach why
      // their button did nothing matters more than the bookkeeping.
      return pinned && dropped.some((d) => d.id === pinned)
        ? stop('not_waiting', 'This contact no longer exists.')
        : stop('not_waiting', 'This person is no longer waiting for a seat.')
    }

    // ONE computed instant, copied to the hold and the entry. Two copies of one
    // value, never two computations — every job that asks "when did this claim
    // die?" has to get the same answer.
    const offerExpiresAt = Timestamp.fromMillis(claimWindow.expiresAtMs)
    const offers: WaitlistOffer[] = []

    for (const doc of heads) {
      const entry = doc.data()
      const contactRef = db.collection(CONTACTS_COLLECTION).doc(doc.id)
      const offerToken = generateSecureToken()
      const firstname = (entry.firstname as string) || ''
      const lastname = (entry.lastname as string) || ''
      const email = (entry.email as string) || ''
      const phone = (entry.phone as string | null) ?? null

      // A full set, not a merge: it deliberately replaces whatever booking
      // document this contact left behind on this session (a canceled one, a
      // lapsed hold). The candidate filter above already excluded anyone whose
      // booking still holds a seat.
      tx.set(bookingsRef.doc(doc.id), {
        firstname,
        lastname,
        email,
        phone,
        contact: doc.id,
        session: sessionId,
        teamId,
        joinedAt: FieldValue.serverTimestamp(),
        fromBioLink: true,
        is_new_contact: false,
        booking_token: generateSecureToken(),
        booking_reference: generateBookingReference(),
        source: (entry.source as BookingSource | undefined) ?? 'online',
        // Captured at JOIN so the claim never re-asks them.
        ...(entry.question_answers ? { question_answers: entry.question_answers } : {}),
        // Written EXPLICITLY rather than left absent: an absent status reads as
        // pending everywhere, but being explicit is what lets the no-show job
        // and the sweeps filter on the hold fields instead of on status trivia.
        status: 'pending',
        waitlist_claim: true,
        claim_expires_at: offerExpiresAt,
      })
      tx.update(doc.ref, {
        status: 'offered',
        offer_token: offerToken,
        offered_at: FieldValue.serverTimestamp(),
        offer_expires_at: offerExpiresAt,
      })
      // The hold is a pending booking on this person's record, exactly like the
      // one bookSession writes — the counter has to move with it, or a later
      // cancel/expiry drives it negative.
      tx.update(contactRef, { pending_bookings_count: FieldValue.increment(1) })

      offers.push({
        teamId,
        sessionId,
        contactId: doc.id,
        firstname,
        lastname,
        email,
        phone,
        offerToken,
        offerExpiresAt,
      })
    }

    tx.set(
      sessionRef,
      {
        has_bookings: true,
        // Absolute, from this transaction's own read set — never an increment.
        bookings_count: holding + offers.length,
        // `queueSnap` counted the dead entries this pass just expired as well as
        // the ones it offered to, so both come off. A pass that expires dead
        // entries and offers NOTHING leaves this number high until the next
        // absolute write (a join, a release, the next promotion) — deliberately,
        // because touching the session on a no-offer path is the one thing the
        // promoter may not do, and this is a display value.
        waitlist_count: Math.max(queueSnap.size - offers.length - dropped.length, 0),
      },
      { merge: true }
    )
    return offers
  })
}

/**
 * Give back the seats of offers that reached nobody.
 *
 * Through the ordinary guarded release, not a bespoke delete: by the time this
 * runs the person may already have claimed (a mail that "failed" can still have
 * arrived, and a redelivered send is reported as skipped), and
 * `releaseWaitlistOffer` is the one path that reads the booking's settlement
 * before touching it.
 */
async function releaseUndeliverableOffers(
  sessionId: string,
  undeliverable: readonly WaitlistOffer[]
): Promise<void> {
  const db = admin.firestore()
  const queueRef = db
    .collection(SESSIONS_COLLECTION)
    .doc(sessionId)
    .collection(WAITLIST_SUBCOLLECTION)
  for (const offer of undeliverable) {
    try {
      await releaseWaitlistOffer({
        entryRef: queueRef.doc(offer.contactId),
        terminalStatus: 'expired',
        from: ['offered'],
      })
      console.warn(
        `[waitlist] released the unreachable offer to contact ${offer.contactId} on session ${sessionId}`
      )
    } catch (err) {
      console.error(
        `[waitlist] could not release the unreachable offer to contact ${offer.contactId} on session ${sessionId}:`,
        err
      )
    }
  }
}

/**
 * Offer, then TELL THE PEOPLE OFFERED — the entry point every caller uses.
 *
 * The two halves are separate functions because the offer commits inside a
 * transaction and mail must not be sent from inside one (a send for a commit
 * that may still fail, repeated on every retry). They are joined HERE, in one
 * place, for the same reason the promoter hangs on one trigger instead of six
 * call sites: an offer that reaches nobody is worse than no offer at all — the
 * seat is held, hidden from the day sheet and from every booking callable, and
 * then lost. Every caller uses THIS one; `offerWaitlistSeats` stays exported
 * only so the transaction can be exercised on its own in the emulator.
 *
 * So an offer the mail could not deliver is UNDONE here, in the same breath: the
 * seat goes straight back and rolls on to the next person. Without that, a
 * suppressed address (an earlier hard bounce), a tenant messaging policy of
 * `silent`, or `MAIL_ENABLED=false` swallow the offer with no exception at all —
 * and since an entry is offered once ever, that person leaves the queue having
 * never been reachable while the seat sits held and invisible until the window
 * closes.
 *
 * THE ROLL IS BOUNDED, twice over. This function re-offers exactly once (an
 * unreachable second round is released and left to the hourly sweep), and the
 * release's own session write may re-enter the trigger — which terminates
 * because an entry is offered once ever: every pass moves at least one candidate
 * to a terminal status, so the candidate set strictly shrinks and an entirely
 * unreachable queue drains rather than looping.
 *
 * `notifyWaitlistOffers` never throws, so a mail outage never fails a seat that
 * was genuinely held. A PINNED run is the one exception in the other direction:
 * it names one person, so its seat is given back but never re-offered to
 * somebody else, and the coach is told rather than left reading "offered" for a
 * mail that never went.
 */
export async function offerWaitlistSeatsAndNotify(
  sessionId: string,
  options: OfferWaitlistOptions = {}
): Promise<WaitlistOffer[]> {
  const offers = await offerWaitlistSeats(sessionId, options)
  const undeliverable = await notifyWaitlistOffers(offers)
  if (undeliverable.length === 0) return offers

  const reached = offers.filter((o) => !undeliverable.includes(o))
  await releaseUndeliverableOffers(sessionId, undeliverable)

  if (options.pinnedContactId) {
    if (reached.length > 0) return reached
    throw new HttpsError(
      'failed-precondition',
      'This person could not be reached by email, so the seat was not held. Check their address, or book them in at the door.',
      { reason: 'undeliverable' }
    )
  }

  // Roll the seat on immediately — ONCE. The trigger woken by the release above
  // would get here eventually, but "eventually" is a seat sitting free on a
  // class with a queue.
  let rolled: WaitlistOffer[] = []
  try {
    rolled = await offerWaitlistSeats(sessionId)
  } catch (err) {
    console.error(`[waitlist] re-offer after an unreachable offer failed on ${sessionId}:`, err)
    return reached
  }
  if (rolled.length === 0) return reached

  const stillUnreachable = await notifyWaitlistOffers(rolled)
  if (stillUnreachable.length > 0) await releaseUndeliverableOffers(sessionId, stillUnreachable)
  return [...reached, ...rolled.filter((o) => !stillUnreachable.includes(o))]
}

/**
 * The one hook. Fires on every session write and does nothing at all unless that
 * write freed a seat, which is the only condition under which a queue can move.
 *
 * Deliberately NOT wired into cancelBooking / markNoShowBookings / rebookSession /
 * the capacity form: they all converge on this document, and one of them (an
 * admin deleting a booking by hand) has no callable to hook at all.
 */
export const promoteWaitlistOnSeatFreed = onDocumentWritten(
  `${SESSIONS_COLLECTION}/{sessionId}`,
  async (event) => {
    const before = event.data?.before.data() ?? null
    const after = event.data?.after.data() ?? null
    if (!seatFreedEdge(before, after)) return
    // Appointments have no waitlist — nothing exists to be full until a booking
    // creates it — and canceling one produces this edge on every single one.
    if (after?.activityType === 'appointment') return

    const { sessionId } = event.params
    try {
      const offers = await offerWaitlistSeatsAndNotify(sessionId)
      if (offers.length > 0) {
        console.log(
          `[waitlist] offered ${offers.length} seat(s) on session ${sessionId}: ${offers
            .map((o) => o.contactId)
            .join(', ')}`
        )
      }
    } catch (err) {
      // A failed promotion must not poison the write that freed the seat. The
      // queue is re-derived from storage on the next attempt, so nothing is lost
      // beyond the delay.
      console.error(`[waitlist] promotion failed for session ${sessionId}:`, err)
    }
  }
)
