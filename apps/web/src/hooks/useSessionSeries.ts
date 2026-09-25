'use client'

// The recurring-series document behind a session — `session_series/{id}`.
//
// Until now nothing in the web app READ this collection: it was written once at
// creation and never looked at again, which is why a manager could not see when
// a weekly class stops. This is the first reader; the surfaces that show a
// series (the peek sheet, the edit dialog's banner) all go through it.

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { SESSION_SERIES_COLLECTION } from '@linyup/shared'
import type { Timestamp } from 'firebase/firestore'

export interface SeriesRecurrence {
  frequency?: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval?: number
  daysOfWeek?: number[]
  duration?: number
  startDate?: Timestamp | null
  endCondition?: 'date' | 'count' | 'never'
  endDate?: Timestamp | null
  maxOccurrences?: number | null
}

export interface SessionSeriesDoc {
  id: string
  teamId?: string
  status?: string
  recurrence?: SeriesRecurrence
  /** How far ahead sessions have actually been materialized. Extended daily by
   *  the `rollSessionSeries` task. */
  lastGeneratedUntil?: Timestamp | null
}

export function useSessionSeries(seriesId?: string | null) {
  return useQuery<SessionSeriesDoc | null>({
    queryKey: ['session-series', seriesId ?? null],
    enabled: !!seriesId,
    staleTime: 60_000,
    queryFn: async () => {
      const snap = await getDoc(doc(db, SESSION_SERIES_COLLECTION, seriesId!))
      if (!snap.exists()) return null
      return { id: snap.id, ...snap.data() } as SessionSeriesDoc
    },
  })
}
