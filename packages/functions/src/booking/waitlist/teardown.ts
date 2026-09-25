/* eslint-disable no-console */
// Closing a queue for good — what has to happen when the class it is waiting for
// will never run.
//
// A canceled session leaves two things behind that nothing else cleans up: a
// claim hold on a class that is gone (a `pending` booking whose owner can never
// use it, and a `pending_bookings_count` that never comes back down), and a
// queue of people whose "you're on the list" link keeps promising a seat. Both
// outlive the session document itself — a subcollection survives its parent's
// deletion in Firestore, so a deleted session's queue would sit in the
// collection-group sweeps forever.
//
// ORDER IS THE WHOLE DESIGN. The waiting entries are closed FIRST, before any
// hold is released. Releasing a hold writes the session's `bookings_count`,
// which is exactly the edge `promoteWaitlistOnSeatFreed` watches for. With the
// queue already closed the promoter finds nobody waiting and returns without
// writing; the other way round it would cheerfully offer the freed seat to the
// next person in line, on a class that is being canceled as it does so.
//
// That is the SECOND line of defense, not the first: every caller marks the
// session called-off before getting here (`cancelSession` writes the exception
// pair or `allowBooking: false`; the delete trigger's session is already gone),
// so the promoter refuses on `isSessionCancelled` / `allowBooking` before it
// ever looks at the queue. Both guards are kept — this one also covers a join
// that landed a millisecond before the marker.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onDocumentDeleted } from 'firebase-functions/v2/firestore'
import { SESSIONS_COLLECTION, WAITLIST_SUBCOLLECTION } from '@linyup/shared'
import { WAITLIST_QUEUE_SCAN_LIMIT } from './constants'
import { releaseWaitlistOffer } from './release'

/** Pages of `WAITLIST_QUEUE_SCAN_LIMIT` entries one teardown will close (and, on
 *  a deleted session, delete). Far past the queue of any real class — a ceiling
 *  so a pathological queue cannot turn a cancellation into an unbounded job,
 *  not a paging scheme. */
const MAX_TEARDOWN_PAGES = 20

/** Who was holding an unclaimed offer when the class was called off. They were
 *  never a booking, so the caller's own cancellation mail loop cannot reach
 *  them — and they are the one group that genuinely believed they had a seat. */
export interface CancelledOfferHolder {
  contactId: string
  firstname: string
  email: string
}

/**
 * Close every live entry on a session and give back any seat they were holding.
 *
 * Idempotent: a second run finds only terminal entries and writes nothing (the
 * `from` guard inside `releaseWaitlistOffer` is the same one the sweep relies
 * on). Never throws — a cancellation must complete even if the queue does not.
 */
export async function closeSessionWaitlist(
  sessionRef: admin.firestore.DocumentReference,
  options: {
    /** The session document is already gone. Nothing may be written to it —
     *  a merge write on a deleted document CREATES it, and a ghost session
     *  carrying a stale count is worse than the stale count. */
    sessionDeleted?: boolean
  } = {}
): Promise<CancelledOfferHolder[]> {
  const db = admin.firestore()
  const queueRef = sessionRef.collection(WAITLIST_SUBCOLLECTION)
  const holders: CancelledOfferHolder[] = []

  // Pass 1 — the people who hold nothing but a place in the line. Closed FIRST,
  // and to exhaustion, because an entry left `waiting` is a candidate the
  // promoter would hand one of the seats pass 2 is about to free (see the
  // header). Paged: the queue cap scales with the class's seats, so a big class
  // can hold more waiters than one query returns.
  let closed = 0
  try {
    // Bounded rather than "until empty": every pass flips at least one entry, so
    // this terminates on its own — the ceiling is only there so a pathological
    // queue cannot turn a cancellation into an unbounded job.
    for (let pages = 0; pages < MAX_TEARDOWN_PAGES; pages++) {
      const page = await queueRef
        .where('status', '==', 'waiting')
        .limit(WAITLIST_QUEUE_SCAN_LIMIT)
        .get()
      if (page.empty) break
      const batch = db.batch()
      for (const doc of page.docs) {
        batch.update(doc.ref, { status: 'expired', expired_at: FieldValue.serverTimestamp() })
      }
      await batch.commit()
      closed += page.size
      if (page.size < WAITLIST_QUEUE_SCAN_LIMIT) break
    }
    // The session is being canceled, so `waitlist_count` is a display value
    // nobody reads again — but leaving it is the sort of stale number that shows
    // up on a restored session, and it costs one field.
    if (closed > 0 && !options.sessionDeleted) {
      await sessionRef.set({ waitlist_count: 0 }, { merge: true })
    }
  } catch (err) {
    console.error(`[waitlist] could not close the queue of ${sessionRef.path}:`, err)
  }

  // Pass 2 — the offers. Through the SAME guarded release every other path uses:
  // somebody who claimed and paid before the studio canceled owns a real
  // booking, and the cancellation flow (not this) is what refunds and notifies
  // them. Deleting it here would take the seat off them silently. Bounded by the
  // session's own capacity — there can never be more live offers than seats.
  let offered: admin.firestore.QueryDocumentSnapshot[] = []
  try {
    const snap = await queueRef
      .where('status', '==', 'offered')
      .limit(WAITLIST_QUEUE_SCAN_LIMIT)
      .get()
    offered = snap.docs
  } catch (err) {
    console.error(`[waitlist] could not read the offers of ${sessionRef.path}:`, err)
  }

  for (const doc of offered) {
    const entry = doc.data()
    try {
      const { outcome } = await releaseWaitlistOffer({
        entryRef: doc.ref,
        terminalStatus: 'expired',
        from: ['offered'],
      })
      if (outcome === 'released') {
        holders.push({
          contactId: doc.id,
          firstname: (entry.firstname as string) || 'Guest',
          email: (entry.email as string) || '',
        })
      }
    } catch (err) {
      console.error(`[waitlist] could not release the offer on ${doc.ref.path}:`, err)
    }
  }

  return holders
}

/**
 * The queue of a session that no longer exists.
 *
 * Hung on the document rather than on `cancelSession`, for the same reason the
 * promoter is: a standalone session is deleted CLIENT-SIDE
 * (`SessionDeleteDialog`), so a call-site hook would miss the commonest delete
 * there is. Everything converges here.
 *
 * Two jobs, in order. Close the entries — which releases any claim hold, giving
 * the person's `pending_bookings_count` back rather than leaving it permanently
 * one high — and then delete them, because a Firestore subcollection SURVIVES
 * its parent document and the entries would otherwise keep surfacing in the
 * sweep's collection-group passes with no session to resolve them against.
 *
 * Idempotent, and harmless after `cancelSession`'s own teardown: that path
 * leaves the entries terminal, so the close finds nothing and only the delete
 * runs.
 */
export const teardownWaitlistOnSessionDeleted = onDocumentDeleted(
  `${SESSIONS_COLLECTION}/{sessionId}`,
  async (event) => {
    const sessionRef = event.data?.ref
    if (!sessionRef) return
    await closeSessionWaitlist(sessionRef, { sessionDeleted: true })
    try {
      // Paged, exactly like pass 1 above, and for a reason the queue CAP does
      // not cover: only the LIVE entries are capped, while terminal ones
      // (expired, left, claimed) accumulate for the life of the session. A
      // Firestore batch commits at most 500 writes, so a popular class whose
      // queue rolled over a few times would throw here — into a catch that logs
      // and moves on, stranding every one of those documents in the sweep's
      // collection-group passes with no session to resolve them against.
      let removed = 0
      const queueRef = sessionRef.collection(WAITLIST_SUBCOLLECTION)
      for (let pages = 0; pages < MAX_TEARDOWN_PAGES; pages++) {
        // No cursor: each page is deleted before the next is read, so "the
        // first N" is always the next N left.
        const page = await queueRef.limit(WAITLIST_QUEUE_SCAN_LIMIT).get()
        if (page.empty) break
        const batch = admin.firestore().batch()
        page.docs.forEach((d) => batch.delete(d.ref))
        await batch.commit()
        removed += page.size
        if (page.size < WAITLIST_QUEUE_SCAN_LIMIT) break
      }
      if (removed > 0) {
        console.log(`[waitlist] removed ${removed} queue entr(ies) of deleted ${sessionRef.path}`)
      }
    } catch (err) {
      console.error(`[waitlist] could not delete the queue of ${sessionRef.path}:`, err)
    }
  }
)
