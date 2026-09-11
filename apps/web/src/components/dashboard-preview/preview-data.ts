'use client'

/**
 * DATA FOR THE PREVIEW DASHBOARD — deliberately a COPY, not a refactor.
 *
 * This lane exists to be compared against the incumbent dashboard, not merged
 * into it, so it does not reach into `(auth)/dashboard/page.tsx` for the
 * queries it needs. The day's sessions are re-declared here with the SAME
 * query key as the incumbent's agenda, which means TanStack hands whichever
 * route mounts second the first one's cache: copying the code did not copy
 * the network.
 *
 * The ROSTER is not declared here at all any more. It came with its own key
 * (`['contacts', teamId]`), which made the dashboard a second whole-roster
 * fetch beside the contacts page's — one of several copies the census found
 * (docs/scalability-2026-09.md §17 A4). The dashboard reads
 * `useActiveContacts` now, the one roster hook, and shares its cache entry.
 *
 * Everything else this page reads (`useDashboardData`, `useMonthlyRevenue`,
 * `useSetupChecklist`, `useMemberPayments`, `usePaymentEvents`) is an existing
 * shared hook, imported as-is.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, limit, orderBy, query, where, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { SESSIONS_COLLECTION } from '@linyup/shared'
import type { Session } from '@linyup/shared'
import { useMemberPayments, usePaymentEvents } from '@/hooks/useConnect'
import {
  byoToUnified,
  connectToUnified,
  mergePaymentRows,
  type UnifiedPaymentRow,
} from '@/lib/payments'

/** Midnight today, in the browser's zone. */
export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** Midnight on Monday of the current week. */
export function startOfWeek(): Date {
  const d = startOfToday()
  d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1))
  return d
}

/** Sessions of one calendar day. Same key + index as the incumbent's agenda. */
export function usePreviewSessionsForDay(teamId: string | null, day: Date) {
  const dayStart = new Date(day)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)
  return useQuery({
    queryKey: ['sessions', 'day', teamId, dayStart.toISOString()],
    enabled: !!teamId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('start', '>=', Timestamp.fromDate(dayStart)),
          where('start', '<', Timestamp.fromDate(dayEnd)),
          orderBy('start', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Session)
    },
  })
}

/**
 * The next few sessions from today onward — the denominator behind the
 * "bookings ahead" figure. Same key and same `limit(8)` as the incumbent's
 * `useUpcomingSessions`, so the two figures agree and share one cache entry.
 */
export function usePreviewUpcomingSessions(teamId: string | null) {
  return useQuery({
    queryKey: ['sessions', 'upcoming', teamId],
    enabled: !!teamId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('start', '>=', Timestamp.fromDate(startOfToday())),
          orderBy('start', 'asc'),
          limit(8)
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as Session)
    },
  })
}

/** Money that arrived but has nobody attached to it — a filing task, not a
 *  statistic, which is why this page puts it in the queue rather than in a
 *  figure. Settled rows only: a failed charge is not a task. */
export function useUnassignedPaymentCount(teamId: string | null): {
  count: number
  isLoading: boolean
} {
  const { data: memberPayments = [], isLoading: loadingConnect } = useMemberPayments(teamId)
  const { data: paymentEvents = [], isLoading: loadingByo } = usePaymentEvents(teamId)

  const count = useMemo(() => {
    const rows: UnifiedPaymentRow[] = mergePaymentRows(
      connectToUnified(memberPayments),
      byoToUnified(paymentEvents)
    )
    return rows.filter(
      (r) =>
        !r.assigned &&
        (r.status === 'succeeded' || r.status === 'partially_refunded' || r.status === 'paid')
    ).length
  }, [memberPayments, paymentEvents])

  return { count, isLoading: (loadingConnect || loadingByo) && !!teamId }
}
