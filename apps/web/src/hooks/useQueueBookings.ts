'use client'

/**
 * The BOOKINGS half of the dashboard's "Waiting on you" card.
 *
 * ── PENDING IS THE ABSENT VALUE ──────────────────────────────────────────────
 *
 * `bookSession` writes `status: 'confirmed'` when the class auto-confirms and
 * writes NO status otherwise — so a seat that is actually waiting for somebody
 * to approve it carries no `status` field at all. `where('status','==',
 * 'pending')` would therefore match almost none of them and come back looking
 * like a working query, which is the `== null` / `!=` trap `CLAUDE.md` records
 * for `teams where archived_at == null`.
 *
 * So there is ONE query, on the index that already exists — `(teamId, joinedAt
 * desc)` — and the pending test is `(status ?? 'pending')` in memory, the same
 * spelling `/bookings` and the contact's Bookings tab already use.
 *
 * ── WHY A WINDOW, AND WHAT IT COSTS ──────────────────────────────────────────
 *
 * `bookings` is a LOG list (docs/scalability-2026-09.md §17), so this is capped
 * and never grows with the studio's age. The cost is stated rather than hidden:
 * a booking still awaiting approval from BEFORE the most recent
 * `QUEUE_BOOKINGS_LIMIT` seats does not appear on the card. That is the right
 * trade for a dashboard card — an unconfirmed seat for a class that already
 * happened is not work waiting on anybody — and `/bookings` is the surface that
 * answers the unbounded question.
 *
 * ── NO SESSION ENRICHMENT, DELIBERATELY ──────────────────────────────────────
 *
 * Nothing on a booking carries the class name; it is on the session. Fetching
 * it is one read per distinct session, from the dashboard, on every load — for
 * a label the row's own link reaches in one click. The row says WHO and HOW
 * LONG AGO, and the chevron says where the rest is.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { collectionGroup, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  SESSION_BOOKINGS_SUBCOLLECTION,
  bookingQueueKey,
  type Booking,
} from '@linyup/shared'

/** The window. Bounded for the reason in the header; big enough that a studio
 *  taking a few dozen seats a day still sees a full day of arrivals. */
export const QUEUE_BOOKINGS_LIMIT = 100

/** Statuses that are not work and not news — a canceled seat is neither. */
const DEAD_STATUSES = new Set(['cancelled', 'rebooked', 'no_show'])

export interface QueueBooking {
  /** `booking:{sessionId}:{bookingId}` — see `bookingQueueKey` for why both. */
  key: string
  bookingId: string
  sessionId: string
  contactId: string | null
  name: string
  joinedAt: Date | null
  /** Nobody has approved this seat yet. */
  pending: boolean
}

export function queueBookingsKey(teamId: string | null) {
  return ['queue-bookings', teamId] as const
}

export function useQueueBookings(teamId: string | null) {
  const bookingsQuery = useQuery<QueueBooking[]>({
    queryKey: queueBookingsKey(teamId),
    enabled: !!teamId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, SESSION_BOOKINGS_SUBCOLLECTION),
          where('teamId', '==', teamId!),
          orderBy('joinedAt', 'desc'),
          limit(QUEUE_BOOKINGS_LIMIT)
        )
      )
      return snap.docs.flatMap((d) => {
        const b = d.data() as Booking
        const status = b.status ?? 'pending'
        if (DEAD_STATUSES.has(status)) return []
        // A waitlist offer holds its seat as an ordinary booking; the claim
        // window settles it, not a manager (docs/waitlist.md).
        if (b.waitlist_claim === true) return []
        // `sessions/{sessionId}/bookings/{bookingId}` — the grandparent is the
        // session. A collection-group hit has no other way to name it.
        const sessionId = d.ref.parent.parent?.id ?? ''
        const name = `${b.firstname ?? ''} ${b.lastname ?? ''}`.trim()
        return [
          {
            key: bookingQueueKey(sessionId, d.id),
            bookingId: d.id,
            sessionId,
            contactId: b.contact ?? null,
            name: name || d.id,
            joinedAt: b.joinedAt?.toDate?.() ?? null,
            pending: status === 'pending',
          },
        ]
      })
    },
  })

  const rows = useMemo(() => bookingsQuery.data ?? [], [bookingsQuery.data])
  return { rows, isLoading: bookingsQuery.isLoading }
}
