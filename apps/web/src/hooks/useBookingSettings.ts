'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {  TEAMS_COLLECTION, PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import type { BookingSettings } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'

// THE store for the studio's booking settings:
// `teams/{teamId}/public_profile/{teamId}.bookingSettings`. One document, read
// here by every admin surface that needs it (Settings → Booking, the activity
// editor's waitlist control) and by the public booking page + mobile app
// directly.
//
// It used to be two: the form also mirrored the object onto the team doc
// (`settings.booking`), which is owner-only — so a manager's mirror write was
// denied, the form re-hydrated from the mirror and showed her the OLD value, and
// the booking callables (which read the mirror) ignored the cutoff she had just
// set while the public page honoured it. Nothing reads `settings.booking`
// anymore; if you find a reader, it is a bug, not a fallback (UX-6).

export function bookingSettingsRef(teamId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, PUBLIC_PROFILE_SUBCOLLECTION, teamId)
}

export function useBookingSettings(teamId?: string | null) {
  const { currentTeamId } = useAuth()
  const id = teamId ?? currentTeamId

  return useQuery<Partial<BookingSettings>>({
    queryKey: ['booking-settings', id],
    enabled: !!id,
    queryFn: async () => {
      const snap = await getDoc(bookingSettingsRef(id!))
      const raw = snap.data()?.bookingSettings
      return raw && typeof raw === 'object' ? (raw as Partial<BookingSettings>) : {}
    },
  })
}
