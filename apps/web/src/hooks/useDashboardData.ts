'use client'

import { useQuery } from '@tanstack/react-query'
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  collectionGroup,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { subWeeks, addWeeks } from 'date-fns'
import {
  TEAMS_COLLECTION,
  SESSIONS_COLLECTION,
  ACTIVITIES_COLLECTION,
  TEAM_WEEKLY_REPORTS_SUBCOLLECTION,
  isoWeekKey,
} from '@linyup/shared'

export interface WeeklyReport {
  iso_week: string
  contacts_count_by_stage?: Record<string, number>
  contacts_with_active_affiliation?: number
  contacts_count_by_affiliation_type?: Record<string, number>
  /** On one of the studio's OWN plans — partner-app plans are counted apart. */
  contacts_with_active_subscription?: number
  /** On a partner-app plan (`source: 'aggregator'`); displayed as "via a partner". */
  contacts_with_aggregator_subscription?: number
  contacts_count_by_subscription_type?: Record<string, number>
  active_contacts_count?: number
  trial_conversions_count?: number
  trial_dropouts_count?: number
  sessions_count?: number
  bookings_count?: number
  bookings_count_by_type?: Record<string, number>
}

export interface SessionDoc {
  id: string
  teamId: string
  activityId?: string
  activityName?: string
  start: { toDate(): Date }
  end?: { toDate(): Date }
  participants_count?: number
  bookings_count?: number
  bio_link_new_contact_bookings_count?: number
  cancelled_at?: { toDate(): Date } | null
}

export interface BookingDoc {
  id: string
  teamId: string
  session?: string
  is_new_contact?: boolean
  joinedAt?: { toDate(): Date }
  status?: string
}

export interface ActivityDoc {
  id: string
  teamId: string
  name?: string
  activityName?: string
}

export interface SubscriptionTypeDoc {
  id: string
  name: string
}

export interface DashboardData {
  weeklyReports: WeeklyReport[]
  comparisonWeeklyReports: WeeklyReport[]
  sessions: SessionDoc[]
  comparisonSessions: SessionDoc[]
  allBookings: BookingDoc[]
  comparisonAllBookings: BookingDoc[]
  newContactBookings: BookingDoc[]
  comparisonNewContactBookings: BookingDoc[]
  activities: ActivityDoc[]
  subscriptionTypes: SubscriptionTypeDoc[]
  isLoading: boolean
}

function periodStart(weeksBack: number): Date {
  const d = subWeeks(new Date(), weeksBack)
  d.setHours(0, 0, 0, 0)
  return d
}

export function useDashboardData(
  teamId: string | null,
  trendsWeeks = 13,
  compareWith: 'none' | 'prev_period' | 'last_year' = 'none'
): DashboardData {
  const comparisonOffset = compareWith === 'last_year' ? 52 : trendsWeeks
  const isComparing = compareWith !== 'none'

  const mainStart = periodStart(trendsWeeks)
  const compStart = isComparing ? periodStart(trendsWeeks + comparisonOffset) : null
  const compEnd = compStart ? addWeeks(compStart, trendsWeeks) : null

  const minIsoWeek = isoWeekKey(mainStart)
  const extMinIsoWeek = compStart ? isoWeekKey(compStart) : minIsoWeek

  const { data: allReports = [], isLoading: reportsLoading } = useQuery({
    queryKey: ['dashboard', 'weekly-reports', teamId, extMinIsoWeek],
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, TEAM_WEEKLY_REPORTS_SUBCOLLECTION),
          where('iso_week', '>=', extMinIsoWeek),
          orderBy('iso_week', 'asc')
        )
      )
      return snap.docs.map((d) => ({ iso_week: d.id, ...d.data() }) as WeeklyReport)
    },
  })

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['dashboard', 'sessions', teamId, mainStart.toISOString()],
    enabled: !!teamId,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('start', '>=', Timestamp.fromDate(mainStart)),
          where('start', '<', Timestamp.fromDate(new Date())),
          orderBy('start', 'asc')
        )
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id }) as SessionDoc)
        .filter((s) => !s.cancelled_at)
    },
  })

  const { data: compSessions = [] } = useQuery({
    queryKey: ['dashboard', 'comp-sessions', teamId, compStart?.toISOString()],
    enabled: !!teamId && isComparing && !!compStart,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSIONS_COLLECTION),
          where('teamId', '==', teamId),
          where('start', '>=', Timestamp.fromDate(compStart!)),
          where('start', '<', Timestamp.fromDate(compEnd!)),
          orderBy('start', 'asc')
        )
      )
      return snap.docs
        .map((d) => ({ ...d.data(), id: d.id }) as SessionDoc)
        .filter((s) => !s.cancelled_at)
    },
  })

  const { data: allBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['dashboard', 'all-bookings', teamId, mainStart.toISOString()],
    enabled: !!teamId,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, 'bookings'),
          where('teamId', '==', teamId),
          where('joinedAt', '>=', Timestamp.fromDate(mainStart)),
          orderBy('joinedAt', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as BookingDoc)
    },
  })

  const { data: newContactBookings = [] } = useQuery({
    queryKey: ['dashboard', 'new-bookings', teamId, mainStart.toISOString()],
    enabled: !!teamId,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, 'bookings'),
          where('teamId', '==', teamId),
          where('is_new_contact', '==', true),
          where('joinedAt', '>=', Timestamp.fromDate(mainStart)),
          orderBy('joinedAt', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as BookingDoc)
    },
  })

  const { data: compAllBookings = [] } = useQuery({
    queryKey: ['dashboard', 'comp-all-bookings', teamId, compStart?.toISOString()],
    enabled: !!teamId && isComparing && !!compStart,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, 'bookings'),
          where('teamId', '==', teamId),
          where('joinedAt', '>=', Timestamp.fromDate(compStart!)),
          where('joinedAt', '<', Timestamp.fromDate(compEnd!)),
          orderBy('joinedAt', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as BookingDoc)
    },
  })

  const { data: compNewBookings = [] } = useQuery({
    queryKey: ['dashboard', 'comp-new-bookings', teamId, compStart?.toISOString()],
    enabled: !!teamId && isComparing && !!compStart,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collectionGroup(db, 'bookings'),
          where('teamId', '==', teamId),
          where('is_new_contact', '==', true),
          where('joinedAt', '>=', Timestamp.fromDate(compStart!)),
          where('joinedAt', '<', Timestamp.fromDate(compEnd!)),
          orderBy('joinedAt', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as BookingDoc)
    },
  })

  const { data: activities = [] } = useQuery({
    queryKey: ['dashboard', 'activities', teamId],
    enabled: !!teamId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(collection(db, ACTIVITIES_COLLECTION), where('teamId', '==', teamId))
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ActivityDoc)
    },
  })

  const { data: subscriptionTypes = [] } = useQuery({
    queryKey: ['dashboard', 'subscription-types', teamId],
    enabled: !!teamId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, 'subscription_types'),
          orderBy('name', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as SubscriptionTypeDoc)
    },
  })

  const weeklyReports = allReports.filter((r) => r.iso_week >= minIsoWeek)
  const comparisonWeeklyReports =
    isComparing && compStart
      ? allReports.filter((r) => r.iso_week >= isoWeekKey(compStart) && r.iso_week < minIsoWeek)
      : []

  return {
    weeklyReports,
    comparisonWeeklyReports,
    sessions,
    comparisonSessions: compSessions,
    allBookings,
    comparisonAllBookings: compAllBookings,
    newContactBookings,
    comparisonNewContactBookings: compNewBookings,
    activities,
    subscriptionTypes,
    isLoading: reportsLoading || sessionsLoading || bookingsLoading,
  }
}
