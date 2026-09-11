// Bookings nobody ever turned up for. One task per tenant rather than one
// global scan over every studio's past week — see utils/tenantFanOut.ts and
// docs/scalability-2026-09.md §9.
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { SESSIONS_COLLECTION, CONTACTS_COLLECTION } from '@linyup/shared'
import { dispatchTenantJob, type FanOutResult } from '../utils/tenantFanOut'

export interface NoShowRunStats {
  sessions: number
  updated: number
  errors: number
}

/** ONE tenant's past week. The worker body and the dispatcher's inline path. */
export async function markNoShowBookingsForTeam(teamId: string): Promise<NoShowRunStats> {
  const db = admin.firestore()
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600000)
  const stats: NoShowRunStats = { sessions: 0, updated: 0, errors: 0 }

  const [sessErr, sessSnap] = await to(
    db
      .collection(SESSIONS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('end', '>=', Timestamp.fromDate(sevenDaysAgo))
      .where('end', '<', Timestamp.fromDate(now))
      .get()
  )
  if (sessErr) {
    console.error(`markNoShowBookings: error fetching sessions for team ${teamId}:`, sessErr) // eslint-disable-line no-console
    throw sessErr
  }

  stats.sessions = sessSnap!.size

  for (const sessionDoc of sessSnap!.docs) {
    // Nobody booked, so nobody failed to turn up — and no subcollection read.
    // `bookings_count` is absolute (trackBookings owns it); an ABSENT count is
    // not the same claim and still reads.
    if (sessionDoc.data().bookings_count === 0) continue
    const [bookErr, bookSnap] = await to(
      sessionDoc.ref.collection('bookings').where('fromBioLink', '==', true).get()
    )
    if (bookErr) {
      console.error(
        `markNoShowBookings: error fetching bookings for session ${sessionDoc.id}:`,
        bookErr
      ) // eslint-disable-line no-console
      stats.errors++
      continue
    }

    // Include docs with no status field (treated as pending), but never an
    // UNSETTLED HOLD. A hold is not an attendance record: an abandoned drop-in
    // checkout (`payment_status: 'required'`) and a waitlist claim that was
    // never taken up (`waitlist_claim`) are both `pending` with `fromBioLink`,
    // so this job used to stamp "no_show" on a real person who never had a
    // booking — and decrement a counter that was never incremented for them.
    // expirePendingBookings owns those documents; it deletes them.
    const pendingDocs = bookSnap!.docs.filter((d) => {
      const b = d.data()
      if (b.status && b.status !== 'pending') return false
      return b.payment_status !== 'required' && b.waitlist_claim !== true
    })
    if (pendingDocs.length === 0) continue

    try {
      const batch = db.batch()

      for (const bookingDoc of pendingDocs) {
        const booking = bookingDoc.data()
        batch.update(bookingDoc.ref, {
          status: 'no_show',
          no_show_at: FieldValue.serverTimestamp(),
        })

        const contactId = (booking.contact || booking.contactId) as string | undefined
        if (contactId) {
          batch.update(db.collection(CONTACTS_COLLECTION).doc(contactId), {
            pending_bookings_count: FieldValue.increment(-1),
          })
        }
      }

      // No session counter write. `bookings_count` has one writing style —
      // absolute, from a read set — and a batch has no conflict detection, so
      // this `increment(-n)` could clobber (or be clobbered by) a concurrent
      // booking's absolute write. trackBookings recounts on each 'no_show' flip.
      await batch.commit()
      stats.updated += pendingDocs.length
      console.log(
        `markNoShowBookings: session ${sessionDoc.id} — flipped ${pendingDocs.length} bookings to no_show`
      ) // eslint-disable-line no-console
    } catch (err) {
      console.error(
        `markNoShowBookings: error updating session ${sessionDoc.id}:`,
        (err as Error).message
      ) // eslint-disable-line no-console
      stats.errors++
    }
  }

  return stats
}

/** THE DISPATCHER — one task per tenant, daily. Idempotent per tenant by its
 *  own rule: only a `pending` booking is ever flipped, so a redelivered task
 *  finds nothing left to do. */
export async function markNoShowBookings(): Promise<FanOutResult> {
  console.log('markNoShowBookings dispatch started') // eslint-disable-line no-console
  const result = await dispatchTenantJob({
    functionName: 'noShowsForTeam',
    granularity: 'day',
    perTeam: markNoShowBookingsForTeam,
    label: 'noShows',
  })
  console.log('markNoShowBookings dispatch completed:', result) // eslint-disable-line no-console
  return result
}
