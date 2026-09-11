import { useQuery } from '@tanstack/react-query'
import { collection, query, where, limit, getDocs, Timestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { SESSION_SERIES_COLLECTION } from '@linyup/shared'

/**
 * Recurring series whose occurrences are still being materialised.
 *
 * Creating a series no longer blocks on generation (see SessionFormDialog's
 * recurring branch): the `session_series` doc is the commit, and the sessions
 * fill in behind it. Without a marker the schedule would simply be missing
 * classes for a few seconds with nothing to say why — which reads as a save
 * that half-failed.
 *
 * THE SIGNAL IS THE ONE THE WRITER ALREADY LEAVES. A new series is written with
 * `lastGeneratedUntil: null`, and `seriesHorizonUpdate` sets it once
 * materialisation finishes. So "still filling in" is an equality query over two
 * fields the doc already carries — no new flag, no new writer, nothing to
 * backfill and nothing that can go stale on its own.
 *
 * WHY IT IS AGE-BOUNDED. A generation that dies mid-way leaves
 * `lastGeneratedUntil` null forever, and the daily `rollSessionSeries` task
 * repairs the series without clearing it (it writes the horizon it reached, so
 * it does clear it — but not until tomorrow). An unbounded banner would
 * therefore sit on the schedule all day. The age filter runs in JS rather than
 * in the query on purpose: adding a range on `createdAt` beside two equality
 * filters is the one shape that needs a composite index, and this list is at
 * most a handful of docs.
 */

/** How long a series may be "filling in" before the banner stops claiming it. */
const GENERATING_MAX_AGE_MS = 10 * 60 * 1000

export interface GeneratingSeries {
  id: string
  activityName: string | null
  createdAt: Timestamp | null
}

export function useGeneratingSeries(teamId: string | null) {
  const { data = [] } = useQuery<GeneratingSeries[]>({
    queryKey: ['generating-series', teamId],
    enabled: !!teamId,
    // Polled rather than subscribed: it is a transient state on a page that is
    // otherwise entirely query-driven, and the poll stops itself below as soon
    // as nothing is generating.
    refetchInterval: (q) => ((q.state.data ?? []).length > 0 ? 3000 : false),
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, SESSION_SERIES_COLLECTION),
          where('teamId', '==', teamId),
          where('status', '==', 'active'),
          where('lastGeneratedUntil', '==', null),
          limit(5)
        )
      )
      const cutoff = Date.now() - GENERATING_MAX_AGE_MS
      return snap.docs
        .map((d) => {
          const v = d.data() as {
            template?: { activityName?: string | null }
            createdAt?: Timestamp | null
          }
          return {
            id: d.id,
            activityName: v.template?.activityName ?? null,
            createdAt: v.createdAt ?? null,
          }
        })
        .filter((s) => !s.createdAt || s.createdAt.toMillis() >= cutoff)
    },
  })

  return data
}
