'use client'

// The bookings list's data: a BOUNDED window on ONE of two dates, plus the
// booking-reference lookup that reaches outside it.
//
// The two axes are different queries, not two filters over one result set,
// because the dates live in different documents. `joinedAt` (when the booking
// was taken) is on the booking, so that axis ranges the collection-group query
// server-side. The class date is on the SESSION — nothing on the booking carries
// it — so that axis queries sessions in the window first and reads each one's
// `bookings` subcollection, the same shape `useDaySheet` uses and served by the
// existing (teamId, start) session index. It reaches the future by construction,
// which the booking axis cannot: `joinedAt` is never later than now.
//
// The fan-out is N+1 and that is the whole reason the window is capped: a busy
// studio over a quarter is thousands of reads from a browser. Two ceilings, not
// one — capping CLASSES alone still lets 250 well-attended classes flatten into
// thousands of rows. When the window matches more classes than
// `MAX_WINDOW_SESSIONS`, this returns `tooWide` and fetches NOTHING — a list
// quietly built from the first N classes is the silent truncation the window was
// introduced to remove. When the seats it reads pass `MAX_WINDOW_BOOKINGS` it
// stops reading and says `truncated`, which the header then reports; the same
// flag the booking axis raises when its page fills up.

import { useQuery } from '@tanstack/react-query'
import {
  Timestamp,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {  SESSIONS_COLLECTION, type Booking, SESSION_BOOKINGS_SUBCOLLECTION } from '@linyup/shared'


/** Longest window either axis will accept, in days. Bounds the fan-out below and
 *  the manual From/To edits on the page. */
export const MAX_RANGE_DAYS = 92

/** Classes the class-date fan-out will read bookings for. Past it the window is
 *  refused rather than trimmed. */
export const MAX_WINDOW_SESSIONS = 250

/** Seats either axis will return. Hitting it is reported, not hidden. */
export const MAX_WINDOW_BOOKINGS = 400

/** How many classes the class-date fan-out reads at once. Small enough that the
 *  booking ceiling stops the reads soon after it is passed, large enough that a
 *  quiet window still resolves in a couple of round trips. */
const CLASS_FANOUT_CHUNK = 25

/** Codes are minted without a collision check, so a lookup may answer with more
 *  than one booking — see `generateBookingReference`. */
const MAX_REFERENCE_MATCHES = 5

export type BookingDateAxis = 'class' | 'booking'

export interface SessionInfo {
  activityName?: string
  start?: string
  end?: string
  allowBooking?: boolean
}

export interface BookingsWindow {
  bookings: Booking[]
  /** Session info for the loaded bookings, keyed by session id — filled by the
   *  class axis only, whose fan-out already holds the docs. The booking axis
   *  leaves it empty and the page resolves the sessions it needs. */
  sessions: Record<string, SessionInfo>
  /** The window matches more classes than `MAX_WINDOW_SESSIONS`; nothing was
   *  read. The page says so instead of showing a partial list. */
  tooWide: boolean
  /** The seat ceiling was reached: `bookings` is the newest part of the window,
   *  not the window. Raised by the booking axis when its page fills up and by
   *  the class axis when its fan-out passes `MAX_WINDOW_BOOKINGS`. */
  truncated: boolean
}

const EMPTY_WINDOW: BookingsWindow = {
  bookings: [],
  sessions: {},
  tooWide: false,
  truncated: false,
}

function tsToIso(ts: unknown): string | undefined {
  if (!ts) return undefined
  if (typeof (ts as { toDate?: unknown }).toDate === 'function')
    return (ts as { toDate(): Date }).toDate().toISOString()
  return undefined
}

function sessionInfo(data: Record<string, unknown>): SessionInfo {
  return {
    activityName: data.activityName as string | undefined,
    start: tsToIso(data.start),
    end: tsToIso(data.end),
    allowBooking: data.allowBooking as boolean | undefined,
  }
}

function joinedMillis(b: Booking): number {
  const ts = b.joinedAt as { toMillis?: () => number } | undefined
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0
}

async function loadByClassDate(
  teamId: string,
  from: Timestamp,
  to: Timestamp
): Promise<BookingsWindow> {
  // No `where('has_bookings', '==', true)` here, however inviting the
  // (has_bookings, teamId, start) index looks: the flag is set by the server
  // booking rails only, so a class whose seats a manager filled by hand from the
  // session page carries no flag and the equality would hide it entirely.
  const snap = await getDocs(
    query(
      collection(db, SESSIONS_COLLECTION),
      where('teamId', '==', teamId),
      where('start', '>=', from),
      where('start', '<=', to),
      orderBy('start', 'desc'),
      limit(MAX_WINDOW_SESSIONS + 1)
    )
  )
  if (snap.size > MAX_WINDOW_SESSIONS) return { ...EMPTY_WINDOW, tooWide: true }

  // Classes are capped above; SEATS are capped here. 250 classes at 30 seats is
  // 7,500 documents read from a browser and flattened into one un-virtualised
  // list, so the fan-out walks the classes newest-first in chunks and stops once
  // the seats it holds pass MAX_WINDOW_BOOKINGS. A class is always read whole —
  // half a roster is worse than a class the header admits it left out.
  const sessions: Record<string, SessionInfo> = {}
  const bookings: Booking[] = []
  let truncated = false
  for (let i = 0; i < snap.docs.length; i += CLASS_FANOUT_CHUNK) {
    const chunk = snap.docs.slice(i, i + CLASS_FANOUT_CHUNK)
    const perSession = await Promise.all(
      chunk.map(async (d) => {
        const seats = await getDocs(collection(db, SESSIONS_COLLECTION, d.id, SESSION_BOOKINGS_SUBCOLLECTION))
        return seats.docs
          .map((b) => ({ ...b.data(), id: b.id }) as Booking)
          .sort((a, b) => joinedMillis(b) - joinedMillis(a))
      })
    )
    // Sessions came back newest class first, and each class's own seats are
    // newest first inside it — so the flattened order is already the list's.
    chunk.forEach((d, j) => {
      sessions[d.id] = sessionInfo(d.data())
      bookings.push(...perSession[j])
    })
    if (bookings.length >= MAX_WINDOW_BOOKINGS && i + CLASS_FANOUT_CHUNK < snap.docs.length) {
      truncated = true
      break
    }
  }
  return { ...EMPTY_WINDOW, bookings, sessions, truncated }
}

async function loadByBookingDate(
  teamId: string,
  from: Timestamp,
  to: Timestamp
): Promise<BookingsWindow> {
  const snap = await getDocs(
    query(
      collectionGroup(db, SESSION_BOOKINGS_SUBCOLLECTION),
      where('teamId', '==', teamId),
      where('joinedAt', '>=', from),
      where('joinedAt', '<=', to),
      orderBy('joinedAt', 'desc'),
      limit(MAX_WINDOW_BOOKINGS + 1)
    )
  )
  const truncated = snap.size > MAX_WINDOW_BOOKINGS
  const docs = truncated ? snap.docs.slice(0, MAX_WINDOW_BOOKINGS) : snap.docs
  return {
    ...EMPTY_WINDOW,
    bookings: docs.map((d) => ({ ...d.data(), id: d.id }) as Booking),
    truncated,
  }
}

/** Bookings in `[from, to]` on the chosen axis. Both bounds are required — an
 *  unbounded read is what this hook exists to prevent. */
export function useBookingsWindow(
  teamId: string | null,
  axis: BookingDateAxis,
  from: Date | null,
  to: Date | null
) {
  const fromMs = from?.getTime() ?? null
  const toMs = to?.getTime() ?? null
  return useQuery<BookingsWindow>({
    queryKey: ['bookings', 'window', teamId, axis, fromMs, toMs],
    enabled: !!teamId && fromMs !== null && toMs !== null,
    queryFn: async () => {
      if (!teamId || fromMs === null || toMs === null) return EMPTY_WINDOW
      const fromTs = Timestamp.fromMillis(fromMs)
      const toTs = Timestamp.fromMillis(toMs)
      return axis === 'class'
        ? loadByClassDate(teamId, fromTs, toTs)
        : loadByBookingDate(teamId, fromTs, toTs)
    },
  })
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const REFERENCE_RE = new RegExp(`^(?:BK-)?([${REFERENCE_ALPHABET}]{6})$`, 'i')

/**
 * The `BK-…` code off a confirmation email or the booking success screen,
 * normalised — or null for anything that isn't one.
 *
 * The prefix is optional because a caller reads out the six characters as often
 * as the whole code. That means a six-letter NAME drawn from the same alphabet
 * ("SANDRA") parses too, which is why the page only reports a miss when the
 * search actually carried the `BK-` prefix; a bare word that finds nothing just
 * goes on filtering the list.
 */
export function parseBookingReference(input: string): string | null {
  const m = REFERENCE_RE.exec(input.trim())
  return m ? `BK-${m[1].toUpperCase()}` : null
}

export interface BookingReferenceMatches {
  bookings: Booking[]
  sessions: Record<string, SessionInfo>
}

/**
 * Look a reference up ACROSS the whole tenant, not inside the loaded window —
 * the booking someone is phoning about is exactly the one the window missed.
 */
export function useBookingReference(teamId: string | null, code: string | null) {
  return useQuery<BookingReferenceMatches>({
    queryKey: ['bookings', 'reference', teamId, code],
    enabled: !!teamId && !!code,
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!teamId || !code) return { bookings: [], sessions: {} }
      const snap = await getDocs(
        query(
          collectionGroup(db, SESSION_BOOKINGS_SUBCOLLECTION),
          where('teamId', '==', teamId),
          where('booking_reference', '==', code),
          limit(MAX_REFERENCE_MATCHES)
        )
      )
      const bookings = snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Booking)
      const sessionIds = [
        ...new Set(bookings.map((b) => b.session).filter((s): s is string => !!s)),
      ]
      const sessionDocs = await Promise.all(
        sessionIds.map((id) => getDoc(doc(db, SESSIONS_COLLECTION, id)))
      )
      const sessions: Record<string, SessionInfo> = {}
      for (const d of sessionDocs) if (d.exists()) sessions[d.id] = sessionInfo(d.data())
      return { bookings, sessions }
    },
  })
}

/** Recent bookings scanned for the rebook picker's exclusion set. Bounded so a
 *  long-standing member does not turn opening a dialog into a full history read;
 *  newest-first, which is where a booking on a class still to come lives. */
const CONTACT_BOOKINGS_SCAN = 100

/** A booking whose seat is gone frees the class again, so it must not exclude it. */
const SEAT_HELD_BY: ReadonlySet<string> = new Set(['pending', 'confirmed', 'no_show'])

/**
 * Sessions this contact already holds a seat on, for the rebook picker to leave
 * out of its options.
 *
 * Asked of the tenant rather than filtered out of the loaded window: the window
 * is a date range on one axis and the picker offers whatever classes are still
 * to come, so on the default 'this week' view the two barely overlap and the
 * manager gets offered a class the contact is already in — a duplicate that only
 * surfaces when `rebookSession` refuses it. Served by the existing collection-
 * group index (teamId, contact, joinedAt DESC).
 */
export function useContactBookedSessions(teamId: string | null, contactId: string | null) {
  return useQuery<Set<string>>({
    queryKey: ['bookings', 'contact-sessions', teamId, contactId],
    enabled: !!teamId && !!contactId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!teamId || !contactId) return new Set<string>()
      const snap = await getDocs(
        query(
          collectionGroup(db, SESSION_BOOKINGS_SUBCOLLECTION),
          where('teamId', '==', teamId),
          where('contact', '==', contactId),
          orderBy('joinedAt', 'desc'),
          limit(CONTACT_BOOKINGS_SCAN)
        )
      )
      const held = new Set<string>()
      for (const d of snap.docs) {
        const b = d.data() as Booking
        if (!b.session) continue
        if (!SEAT_HELD_BY.has((b.status as string | undefined) ?? 'pending')) continue
        held.add(b.session)
      }
      return held
    },
  })
}
