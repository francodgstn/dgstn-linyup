'use client'

// Booking actions (confirm / revert / no-show / cancel / rebook) — extracted
// from `bookings/page.tsx` so the per-contact Bookings tab can mount the same
// mutations against the same rows via the shared `BookingRow`. A pure move:
// the batch writes below are byte-for-byte what the bookings page did.
//
// NOT absorbed here: `app/[locale]/(auth)/sessions/[id]/page.tsx` has its OWN,
// third implementation of confirm/no-show/removal, independent of this file.
// It was knowingly left alone — the session detail page's roster acts on a
// `participants` doc it already has open, not a `Booking`, and folding it in
// was out of scope. Do not assume this file is the only place these verbs live.

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  doc,
  writeBatch,
  serverTimestamp,
  increment,
  deleteField,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import {
  bookingContactId,
  confirmClearedHoldFields,
  buildParticipantDoc,
  type Booking,
  CONTACTS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  SESSION_BOOKINGS_SUBCOLLECTION,
} from '@linyup/shared'

export type BookingAction = 'confirm' | 'no_show' | 'cancel' | 'revert'

// The windowed list (bookings page), the per-contact list (contact Bookings
// tab), the reference band and the rebook picker's exclusion set all read the
// same booking documents, so an action taken from ANY mount has to refresh
// the others — a cancelled seat that stays in the exclusion set keeps a class
// out of the picker it is now free for, and a confirm taken from the contact
// tab that never invalidates `contact-bookings` leaves that tab showing
// "pending" until the tab remounts.
export function invalidateBookings(qc: QueryClient, teamId: string | null) {
  qc.invalidateQueries({ queryKey: ['bookings', 'window', teamId] })
  qc.invalidateQueries({ queryKey: ['bookings', 'reference', teamId] })
  qc.invalidateQueries({ queryKey: ['bookings', 'contact-sessions', teamId] })
  // Partial match: `['contact-bookings', teamId]` invalidates every
  // `['contact-bookings', teamId, contactId]` entry regardless of contactId —
  // see useContactBookings in contacts/[id]/page.tsx.
  qc.invalidateQueries({ queryKey: ['contact-bookings', teamId] })
}

export function useBookingAction(teamId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ booking, action }: { booking: Booking; action: BookingAction }) => {
      if (!booking.session) throw new Error('Missing session ID on booking')
      const bookingRef = doc(db, SESSIONS_COLLECTION, booking.session, SESSION_BOOKINGS_SUBCOLLECTION, booking.id)
      const sessionRef = doc(db, SESSIONS_COLLECTION, booking.session)
      const batch = writeBatch(db)

      if (action === 'confirm') {
        // Mark booking confirmed. The hold markers go with the same write: a
        // confirmed seat is an ordinary booking, and a leftover `waitlist_claim`
        // would keep this person out of `sendBookingReminders` forever. For a
        // claim that was mid-payment the drop-in hold's own markers have to go
        // too, or the confirmed booking loses its seat at `expires_at` and
        // `releaseExpiredBookingHolds` deletes it at 02:00 — see
        // `confirmClearedHoldFields`, which all four confirm surfaces share.
        batch.update(bookingRef, {
          status: 'confirmed',
          confirmed_at: serverTimestamp(),
          ...confirmClearedHoldFields(booking, deleteField()),
        })
        // The attendance row — ONE builder, shared with session detail and the
        // two check-in callables. This page used to key the row by the BOOKING
        // id, spell `fullname` "firstname lastname" against everyone else's
        // "lastname firstname", and write neither `checkedInAt` nor
        // `checkedInBy` — so the same act produced a different document here
        // than it did one click away on the session.
        const contactId = bookingContactId(booking)
        const participantRef = doc(db, SESSIONS_COLLECTION, booking.session, PARTICIPANTS_SUBCOLLECTION, contactId)
        batch.set(
          participantRef,
          buildParticipantDoc({
            contactId,
            sessionId: booking.session,
            who: booking,
            checkedInBy: 'booking-confirm',
            checkedInAt: serverTimestamp(),
            fromBooking: true,
          })
        )
        // Conversion only. `bookings_count` is never written from a client:
        // it has one writing style (an absolute value from a server read set,
        // or trackBookings' recount, which this status flip fires) and a blind
        // increment from here would fight the booking transactions for it.
        batch.update(sessionRef, {
          conversions_count: increment(1),
        })
        if (booking.contact) {
          batch.update(doc(db, CONTACTS_COLLECTION, booking.contact), {
            pending_bookings_count: increment(-1),
          })
        }
      } else if (action === 'revert') {
        // Revert confirmed → pending
        batch.update(bookingRef, {
          status: 'pending',
          confirmed_at: null,
        })
        // Remove participant doc — same id the confirm above wrote it under.
        const participantRef = doc(
          db,
          SESSIONS_COLLECTION,
          booking.session,
          PARTICIPANTS_SUBCOLLECTION,
          bookingContactId(booking)
        )
        batch.delete(participantRef)
        // Undo the conversion only — see the note above.
        batch.update(sessionRef, {
          conversions_count: increment(-1),
        })
        if (booking.contact) {
          batch.update(doc(db, CONTACTS_COLLECTION, booking.contact), {
            pending_bookings_count: increment(1),
          })
        }
      } else if (action === 'no_show') {
        batch.update(bookingRef, { status: 'no_show', no_show_at: serverTimestamp() })
        const wasPending = !booking.status || booking.status === 'pending'
        if (wasPending) {
          // The freed seat is trackBookings' recount to write — see above.
          if (booking.contact) {
            batch.update(doc(db, CONTACTS_COLLECTION, booking.contact), {
              pending_bookings_count: increment(-1),
            })
          }
        }
      } else if (action === 'cancel') {
        batch.update(bookingRef, {
          status: 'cancelled',
          cancelled_at: serverTimestamp(),
          cancelled_by: 'admin',
        })
        const wasPending = !booking.status || booking.status === 'pending'
        if (wasPending) {
          // The freed seat is trackBookings' recount to write — see above.
          if (booking.contact) {
            batch.update(doc(db, CONTACTS_COLLECTION, booking.contact), {
              pending_bookings_count: increment(-1),
            })
          }
        }
      }

      await batch.commit()
    },
    onSuccess: () => invalidateBookings(qc, teamId),
  })
}

export function useRebookAction(teamId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ token, newSessionId }: { token: string; newSessionId: string }) => {
      const fn = httpsCallable(functions, 'rebookSession')
      await fn({ token, newSessionId })
    },
    onSuccess: () => invalidateBookings(qc, teamId),
  })
}
