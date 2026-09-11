'use client'

// Shared session feed for the kiosk (KioskSchedule + NowNext + WalkIn's session
// picker) — one collection-group query, refetched periodically since the tablet
// stays open for hours. Adapted from the ScheduleBlock query in
// components/site/sections.tsx: same collectionGroup('public_profile') filter on
// teamId/type/allowBooking, but the lower bound on `start` is the START OF TODAY
// rather than "now" — the literal "now" bound (used by the website's schedule
// section, which never needs to know about sessions already in progress) would
// make it impossible for NowNext to ever find an "ongoing" class, since a session
// that started a few minutes ago would already be excluded from the feed.
import { useEffect, useState } from 'react'
import {
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'

export interface KioskSession {
  id: string
  /** Public-mirror kind: 'session' (group class) or 'appointment_session'. */
  type?: string
  activityId?: string
  activityName?: string
  activityColor?: string
  start: Timestamp
  end: Timestamp
  location?: string
  providerName?: string
  /** Appointment slots only: 'open' | 'full' | 'cancelled' — walk-in offers open ones. */
  status?: string
}

const REFRESH_MS = 5 * 60 * 1000 // 5 minutes — plenty fresh for a wall display

export function useKioskSessions(teamId: string) {
  const [sessions, setSessions] = useState<KioskSession[]>([])
  const [loading, setLoading] = useState(true)
  // A wall display cannot be asked to retry, so the board must not lie while
  // unattended: `error` is what lets it say "couldn't load" instead of showing a
  // blank day, and the last good feed is KEPT on failure (see the catch below).
  const [error, setError] = useState<unknown>(null)
  // …and keeping the last good feed is exactly why `error` alone cannot decide
  // the wording: an EMPTY last good feed is a real answer about a real day, and
  // it stays real when a later refresh fails. Only a board that has never once
  // loaded can honestly say the schedule is unavailable, so the consumer needs
  // this fact too — `sessions.length === 0` cannot tell the two apart.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true

    function load() {
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      // Group classes AND appointment slots — the front desk sees private lessons
      // too. `in` runs on the same (teamId,type,allowBooking,start) index.
      const q = query(
        collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
        where('teamId', '==', teamId),
        where('type', 'in', ['session', 'appointment_session']),
        where('allowBooking', '==', true),
        where('start', '>=', Timestamp.fromDate(startOfToday)),
        orderBy('start', 'asc'),
        limit(100)
      )
      getDocs(q)
        .then((snap) => {
          if (!alive) return
          const list = snap.docs.map(
            (d) => ({ ...(d.data() as Omit<KioskSession, 'id'>), id: d.id }) as KioskSession
          )
          setSessions(list)
          setError(null)
          setLoaded(true)
        })
        .catch((err: unknown) => {
          if (!alive) return
          // The old behaviour blanked the board on any failure — one refresh
          // through a flaky router and a studio's whole day read "no classes".
          // Keep the last good feed; the schedule surfaces the error only when
          // it has nothing left to show.
          reportPublicLoadFailure('kiosk/sessions', err)
          setError(err)
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }

    load()
    const interval = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [teamId])

  return { sessions, loading, error, loaded }
}
