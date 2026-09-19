'use client'

import { useQuery } from '@tanstack/react-query'
import type { MyBooking, MyBookingsResult } from '@linyup/shared'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from './SpaceAuthProvider'
import { callFunction } from '@/lib/callFunction'

// "What's next" — the single soonest booking the signed-in contact holds.
//
// `getMyBookings` already returns UPCOMING ONLY, SOONEST FIRST (see
// `MyBookingsResult`), so the answer is the first page's first live row and no
// client-side date logic is needed. Asking the server the same question the
// bookings page asks is deliberate: a second source for "when is my next class"
// is a second answer to it, and the two would drift the first time the server's
// notion of "upcoming" changed (it already did once — an appointment is mirrored
// as `appointment_session`, and the old client-side listing did not know it).
//
// ITS OWN CACHE KEY, not the bookings page's. That page is an INFINITE query
// over the same callable; sharing a key between a `useQuery` and a
// `useInfiniteQuery` shares a cache entry with two incompatible shapes. The cost
// of the separation is one callable round trip on the portal home.
//
// A FAILURE IS NOT "nothing booked". `isError` is returned and every caller must
// read it — the whole point of this block is to answer a member's "am I in
// tomorrow's class", and a silent empty state answers it wrongly.
export function useSpaceNextBooking() {
  const { teamId, contact, isAuthenticated } = useSpaceAuth()
  const contactId = contact?.id ?? null

  return useQuery<MyBooking | null>({
    queryKey: ['space-next-booking', teamId, contactId],
    enabled: isAuthenticated && !!teamId && !!contactId,
    queryFn: async () => {
      try {
        const fn = callFunction<{ teamId: string; cursor: number | null }, MyBookingsResult>(
          'getMyBookings'
        )
        const res = await fn({ teamId, cursor: null })
        const bookings = res.data?.bookings ?? []
        // A session the studio called off is still listed on the bookings page
        // (its disappearance would read as "my booking was lost"), but it is not
        // an answer to "what's next" — she is not going to it.
        return bookings.find((b) => !b.sessionCancelled) ?? null
      } catch (err: unknown) {
        reportPublicLoadFailure('space/next-booking', err)
        throw err
      }
    },
  })
}
