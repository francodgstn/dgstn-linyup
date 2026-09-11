'use client'

import { useEffect, useState } from 'react'
import { collectionGroup, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { EVENTS_COLLECTION, PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import type { EventPublicProfile } from '@linyup/shared'

// Public surfaces read ONLY the world-readable mirrors
// (events/{id}/public_profile/{id}) via a collection-group query — never the
// root `events` collection.
//
// An org event has no teamId, so a studio's public page runs TWO queries and
// merges: its own events plus its parent organisation's. That mirrors what the
// admin calendar already does (useAllEvents in schedule/page.tsx), so admin and
// public agree on what an org event is.

export interface PublicEventSummary extends EventPublicProfile {
  id: string
}

function startMs(e: PublicEventSummary): number {
  const ts = e.start as unknown as { toDate?: () => Date } | null
  const d = ts?.toDate?.()
  return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0
}

async function queryEvents(field: 'teamId' | 'orgId', value: string): Promise<PublicEventSummary[]> {
  const snap = await getDocs(
    query(
      collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
      where('type', '==', 'event'),
      where(field, '==', value),
    ),
  )
  return snap.docs.map((d) => ({ ...(d.data() as EventPublicProfile), id: d.id }))
}

export interface PublicEventsState {
  loading: boolean
  events: PublicEventSummary[]
}

/** Upcoming published events for a studio, including any inherited from its
 *  parent organisation. Pass `orgId` null for an independent studio. */
export function usePublicEvents(
  teamId: string | null,
  orgId: string | null,
  options: { includePast?: boolean; limit?: number } = {},
): PublicEventsState {
  const { includePast = false, limit } = options
  const [state, setState] = useState<PublicEventsState>({ loading: true, events: [] })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const results = await Promise.all([
          teamId ? queryEvents('teamId', teamId) : Promise.resolve([]),
          orgId ? queryEvents('orgId', orgId) : Promise.resolve([]),
        ])
        if (cancelled) return

        // A studio in an org could match both queries if a mirror ever carried
        // both ids; de-duplicate by document id so nothing renders twice.
        const seen = new Set<string>()
        let events = results.flat().filter((e) => {
          if (seen.has(e.id)) return false
          seen.add(e.id)
          return true
        })

        if (!includePast) {
          // Compare against the END so an event running today still shows.
          const now = Date.now()
          events = events.filter((e) => {
            const end = (e.end as unknown as { toDate?: () => Date } | null)?.toDate?.()
            return !end || end.getTime() >= now
          })
        }

        events.sort((a, b) => startMs(a) - startMs(b))
        setState({ loading: false, events: limit ? events.slice(0, limit) : events })
      } catch {
        if (!cancelled) setState({ loading: false, events: [] })
      }
    })()
    return () => { cancelled = true }
  }, [teamId, orgId, includePast, limit])

  return state
}

/** One published event by id. Reads the mirror directly — a missing document
 *  means "not published", which the caller renders as a 404. */
export function usePublicEvent(eventId: string): {
  loading: boolean
  event: PublicEventSummary | null
} {
  const [state, setState] = useState<{ loading: boolean; event: PublicEventSummary | null }>({
    loading: true,
    event: null,
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDoc(
          doc(db, EVENTS_COLLECTION, eventId, PUBLIC_PROFILE_SUBCOLLECTION, eventId),
        )
        if (cancelled) return
        setState({
          loading: false,
          event: snap.exists()
            ? { ...(snap.data() as EventPublicProfile), id: snap.id }
            : null,
        })
      } catch {
        if (!cancelled) setState({ loading: false, event: null })
      }
    })()
    return () => { cancelled = true }
  }, [eventId])

  return state
}
