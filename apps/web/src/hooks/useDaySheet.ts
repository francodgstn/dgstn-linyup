'use client'

// Day-sheet data: every session on one calendar day, each with its roster
// (bookings + checked-in participants) and its waitlist resolved. Backs the
// printable manifest (/manifest) — the sheet a coach carries to the door.
//
// One query for the day's sessions (reusing the existing (teamId, start)
// composite index — same shape as the dashboard agenda), then one bookings, one
// participants and one waitlist read per session. That fan-out is fine at day
// scale (a studio runs single-digit-to-~20 sessions a day) and keeps the hook
// honest: the roster shown is the roster stored, with no denormalised counter to
// drift. The queue is read the same way and for the same reason — a coach with a
// no-show at the door needs the names, not `waitlist_count`.

import { useQuery } from '@tanstack/react-query'
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  SESSIONS_COLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  WAITLIST_SUBCOLLECTION,
  bookingHoldsSeat,
  isUnclaimedClaimHold,
  type Booking,
  type Session,
  type WaitlistEntry,
} from '@linyup/shared'

const BOOKINGS_SUB = 'bookings'

export interface DaySheetParticipant {
  contactId: string
  checked_in_at?: { toDate(): Date } | null
}

export interface DaySheetEntry {
  session: Session
  /** Every booking doc on the session, cancelled/rebooked included — the sheet
   *  filters for display so the counts here stay auditable. */
  bookings: Booking[]
  /** Check-in records; a booking whose contact appears here has arrived. */
  participants: DaySheetParticipant[]
  /** Every queue entry, terminal ones included — filtered for display by
   *  `waitingEntries` so the raw state stays auditable, exactly like bookings. */
  waitlist: WaitlistEntry[]
}

/**
 * The roster: the people who are actually expected in the room.
 *
 * Canceled and rebooked seats are gone. So is an UNCLAIMED waitlist offer —
 * the promoter's hold is a real booking document that really occupies a seat
 * (`heldOfferSeats` below counts it), but its holder has not taken it up and is
 * printed on the waiting line instead. Listing them in both places is the same
 * double count `waitingEntries` avoids for 'claimed', in the other direction:
 * "10/10 booked · 1 waiting" where the 1 IS one of the 10.
 *
 * A no-show stays: it is a name the coach ticked (or didn't) at this door.
 */
export function activeBookings(bookings: Booking[]): Booking[] {
  return bookings.filter(
    (b) => b.status !== 'cancelled' && b.status !== 'rebooked' && !isUnclaimedClaimHold(b)
  )
}

/**
 * Seats held by offers nobody has claimed yet — off the roster, but NOT free.
 *
 * The headcount printed against capacity has to include them or the sheet says
 * "9/10" about a room where the tenth seat is being held for someone with a
 * live claim link, and the coach lets a walk-in into it. `bookingHoldsSeat` is
 * the same predicate the server's capacity gates use, so a LAPSED hold (the
 * offer ran out, the sweep hasn't rolled it on yet) reads as free here exactly
 * as it does there.
 */
export function heldOfferSeats(bookings: Booking[]): number {
  return bookings.filter((b) => isUnclaimedClaimHold(b) && bookingHoldsSeat(b)).length
}

/**
 * The people actually still in line, in queue order.
 *
 * 'offered' counts: their seat is held but unclaimed, so at the door they are
 * both the next person to get in AND someone worth chasing. This is the ONE
 * line they appear on — `activeBookings` drops their hold from the roster for
 * exactly that reason. 'claimed' does not count: that booking is settled and is
 * on the roster, and printing them twice on one sheet is how a coach ends up
 * counting the room wrong.
 */
export function waitingEntries(waitlist: WaitlistEntry[]): WaitlistEntry[] {
  return waitlist
    .filter((e) => e.status === 'waiting' || e.status === 'offered')
    .sort((a, b) => (a.joined_at?.toMillis() ?? 0) - (b.joined_at?.toMillis() ?? 0))
}

export function useDaySheet(teamId: string | null, day: Date) {
  const dayStart = new Date(day)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  return useQuery<DaySheetEntry[]>({
    queryKey: ['day-sheet', teamId, dayStart.toISOString()],
    enabled: !!teamId,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const sessionsSnap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('start', '>=', Timestamp.fromDate(dayStart)),
          where('start', '<', Timestamp.fromDate(dayEnd)),
          orderBy('start', 'asc')
        )
      )
      const sessions = sessionsSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as Session)

      return Promise.all(
        sessions.map(async (session) => {
          const [bookingsSnap, participantsSnap, waitlistSnap] = await Promise.all([
            getDocs(collection(db, SESSIONS_COLLECTION, session.id, BOOKINGS_SUB)),
            getDocs(collection(db, SESSIONS_COLLECTION, session.id, PARTICIPANTS_SUBCOLLECTION)),
            getDocs(collection(db, SESSIONS_COLLECTION, session.id, WAITLIST_SUBCOLLECTION)),
          ])
          return {
            session,
            bookings: bookingsSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as Booking),
            participants: participantsSnap.docs.map(
              (d) => ({ contactId: d.id, ...d.data() }) as DaySheetParticipant
            ),
            waitlist: waitlistSnap.docs.map((d) => ({ ...d.data(), id: d.id }) as WaitlistEntry),
          }
        })
      )
    },
  })
}
