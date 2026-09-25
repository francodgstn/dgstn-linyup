/* eslint-disable no-console */
// sweepWaitlistOffers — the bookkeeper of the queue, and the ONE owner of an
// entry's lifecycle transitions.
//
// It rides the EXISTING hourly booking job rather than adding a schedule of its
// own: an offer minted at 09:00 with a two-hour window has to be rolled on at
// 11:00, and the 02:00 batch would leave that seat dead for fifteen hours. The
// hourly job's doc comment already frames it as the home for offset-accurate,
// time-sensitive booking work.
//
// Hourly granularity is only acceptable because expiry is LAZY: a lapsed hold
// stops occupying its seat the instant any transaction reads it
// (bookingHoldsSeat), and claimWaitlistSeat refuses a lapsed offer whether or
// not this has run. The sweep is bookkeeping and re-offering — never
// correctness. Same posture connect/giftCards.ts documents for card holds.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { WAITLIST_SUBCOLLECTION } from '@linyup/shared'
import { WAITLIST_SWEEP_SCAN_LIMIT } from './constants'
import { notifyWaitlistOfferExpired } from './notify'
import { offerWaitlistSeatsAndNotify } from './promote'
import { releaseWaitlistOffer } from './release'

export interface WaitlistSweepStats {
  /** Offers whose window closed without being taken up. */
  lapsed: number
  /** Seats actually handed back to the queue by pass 1. */
  released: number
  /** Entries whose booking said the person is in the class after all —
   *  corrected to 'claimed', never deleted. Two facts land here: a missed entry
   *  flip upstream (worth a look) and an offer holder who booked the class
   *  directly instead of using their claim link (perfectly ordinary), so this is
   *  no longer expected to stay at zero. */
  selfHealed: number
  /** Entries closed out because their class has already run. */
  stale: number
  /** Sessions the promoter was asked to look at. */
  promoted: number
  errors: number
}

/**
 * Three passes, in this order. Pass 1 frees seats, pass 3 fills them — running
 * them the other way round would re-offer before releasing and leak a seat for
 * an hour.
 */
export async function sweepWaitlistOffers(): Promise<WaitlistSweepStats> {
  const stats: WaitlistSweepStats = {
    lapsed: 0,
    released: 0,
    selfHealed: 0,
    stale: 0,
    promoted: 0,
    errors: 0,
  }
  const db = admin.firestore()
  const now = Timestamp.now()

  // ── Pass 1: offers whose window closed ─────────────────────────────────────
  // Oldest deadline first, so a run that hits the scan limit drains the queue in
  // the order the seats came free rather than at random.
  const lapsed = await db
    .collectionGroup(WAITLIST_SUBCOLLECTION)
    .where('status', '==', 'offered')
    .where('offer_expires_at', '<=', now)
    .orderBy('offer_expires_at', 'asc')
    .limit(WAITLIST_SWEEP_SCAN_LIMIT)
    .get()

  const reoffer = new Set<string>()
  for (const doc of lapsed.docs) {
    stats.lapsed++
    try {
      // The release transaction refuses to delete anything that is not still an
      // UNCLAIMED hold, which is what keeps this pass non-destructive even when
      // a flip was missed elsewhere: a booking that was confirmed or paid — a
      // full-cover gift-card claim, say, whose entry never flipped — corrects
      // the ENTRY and leaves the money and the seat alone.
      const { outcome, sessionId } = await releaseWaitlistOffer({
        entryRef: doc.ref,
        terminalStatus: 'expired',
        from: ['offered'],
      })
      if (outcome === 'released') {
        stats.released++
        if (sessionId) reoffer.add(sessionId)
      }
      // 'released' AND 'stale', because they are the same event to the person:
      // their window closed with nothing to show for it and the entry is now
      // terminal. 'stale' means the seat went back without us — somebody else
      // deleted the hold first (`expirePendingBookings` runs at 02:00 and
      // reaches a lapsed PAID claim before this hourly pass ever sees the entry;
      // an admin deleting the booking by hand lands in the same place), the
      // booking that replaced it was canceled or no-showed, or it was replaced
      // by an unsettled hold of their own (they abandoned the claim link, opened
      // an ordinary drop-in checkout and never paid — that hold occupies the
      // seat but puts nobody in the class). Saying nothing
      // there leaves a claim link that has simply stopped working, which reads
      // as a bug rather than as a deadline: the exact silence this mail exists
      // to end.
      //
      // Still never on 'self_healed' — that person IS in the class, whether they
      // claimed or booked it directly, and "your place was not claimed in time"
      // for a class they are booked into is the one thing this mail must never
      // say. Nor on 'noop' (nothing happened). The swept entry carries the
      // recipient, so this costs
      // no extra read — and it is read from the query snapshot, i.e. the entry
      // as it was BEFORE the release deleted its offer token, which is what keys
      // the mail to the one offer that just lapsed.
      if ((outcome === 'released' || outcome === 'stale') && sessionId) {
        const entry = doc.data()
        await notifyWaitlistOfferExpired({
          teamId: entry.teamId as string,
          sessionId,
          contactId: doc.id,
          firstname: (entry.firstname as string) || '',
          email: (entry.email as string) || '',
          offerToken: (entry.offer_token as string) || '',
        })
      }
      if (outcome === 'self_healed') {
        stats.selfHealed++
        console.warn(
          `[waitlist] entry ${doc.ref.path} was still 'offered' against a booking that holds its seat — corrected to 'claimed'`
        )
      }
    } catch (err) {
      stats.errors++
      console.error(`[waitlist] sweep: releasing ${doc.ref.path} failed:`, err)
    }
  }

  // Re-offer OUTSIDE the release transaction and immediately, rather than
  // waiting for pass 3 or the next hour: the seat is free from the moment that
  // transaction committed, and every minute it sits unoffered is a minute the
  // class looks emptier than it is.
  for (const sessionId of reoffer) {
    try {
      const offers = await offerWaitlistSeatsAndNotify(sessionId)
      stats.promoted++
      if (offers.length > 0) {
        console.log(`[waitlist] sweep re-offered ${offers.length} seat(s) on session ${sessionId}`)
      }
    } catch (err) {
      stats.errors++
      console.error(`[waitlist] sweep: re-offer failed for session ${sessionId}:`, err)
    }
  }

  // ── Pass 2: queues on classes that have already run ────────────────────────
  // Without this an entry lives forever on every past session — which is the
  // whole reason `session_start` is denormalised onto the entry: a
  // collection-group sweep can find them with no join back to the session.
  //
  // An 'offered' entry here is a backstop for one pass 1 could not reach (its
  // deadline is clamped to the session start, so pass 1 owns it in the normal
  // case) and still goes through the guarded release; a 'waiting' one owns
  // nothing and is just closed out in a batch.
  const dead = await db
    .collectionGroup(WAITLIST_SUBCOLLECTION)
    .where('status', 'in', ['waiting', 'offered'])
    .where('session_start', '<=', now)
    .orderBy('session_start', 'asc')
    .limit(WAITLIST_SWEEP_SCAN_LIMIT)
    .get()

  // Wrapped as a whole so a failed commit costs this pass and not pass 3 — the
  // backstop promotion is the one that puts people in classes, and closing out
  // last week's queues must never be what stops it running.
  try {
    let batch = db.batch()
    let batched = 0
    for (const doc of dead.docs) {
      stats.stale++
      if (doc.data().status === 'offered') {
        await releaseWaitlistOffer({
          entryRef: doc.ref,
          terminalStatus: 'expired',
          from: ['offered'],
        })
        continue
      }
      // `waitlist_count` on the session is deliberately left alone: the class has
      // run, nothing reads that number again, and re-deriving it would cost a
      // transaction per past session to correct a display value nobody sees.
      batch.update(doc.ref, { status: 'expired', expired_at: FieldValue.serverTimestamp() })
      batched++
      if (batched % 400 === 0) {
        await batch.commit()
        batch = db.batch()
      }
    }
    if (batched % 400 !== 0) await batch.commit()
  } catch (err) {
    stats.errors++
    console.error('[waitlist] sweep: closing out past queues failed:', err)
  }

  // ── Pass 3: the backstop promotion ─────────────────────────────────────────
  // Driven from the QUEUE, not from "sessions with free seats and a queue":
  // Firestore cannot compare two fields, so that query does not exist. Soonest
  // classes first — if a run is truncated, the ones about to start matter most.
  // offerWaitlistSeats re-reads everything and writes nothing when there is
  // nothing to do, so a session that is genuinely full costs a handful of reads.
  const waiting = await db
    .collectionGroup(WAITLIST_SUBCOLLECTION)
    .where('status', '==', 'waiting')
    .where('session_start', '>', now)
    .orderBy('session_start', 'asc')
    .limit(WAITLIST_SWEEP_SCAN_LIMIT)
    .get()

  const sessions = new Set<string>()
  for (const doc of waiting.docs) {
    const sessionId = doc.data().session as string | undefined
    // Pass 1 already re-offered these; asking twice is only wasted reads.
    if (sessionId && !reoffer.has(sessionId)) sessions.add(sessionId)
  }
  for (const sessionId of sessions) {
    try {
      const offers = await offerWaitlistSeatsAndNotify(sessionId)
      stats.promoted++
      if (offers.length > 0) {
        console.log(
          `[waitlist] backstop offered ${offers.length} seat(s) on session ${sessionId} — a trigger was missed`
        )
      }
    } catch (err) {
      stats.errors++
      console.error(`[waitlist] sweep: backstop promotion failed for session ${sessionId}:`, err)
    }
  }

  console.log('[waitlist] sweepWaitlistOffers completed:', stats)
  return stats
}
