'use client'

/**
 * THE ONE READER AND THE ONE WRITER of `teams/{teamId}/queue_seen/current` —
 * what the dashboard's "Waiting on you" card has already shown the studio.
 *
 * The shape, and the argument for keys over a timestamp, belong to
 * `packages/shared/src/types/dashboardQueue.ts`. Two things live here because
 * they are this layer's:
 *
 * READ FOR EVERY MEMBER, WRITE FOR MANAGER/OWNER. A coach sees the same dots as
 * their manager — a card that disagreed between two people looking at one studio
 * would be worse than no dot at all — but acknowledging is a manager's, matching
 * the rules and the bell's own audience. `canAck` is exposed so the card renders
 * no control rather than one that fails on click.
 *
 * AN ACKNOWLEDGEMENT REPLACES A TAB'S KEYS, never appends. That is what keeps
 * the document bounded by the queue instead of by history, and it is why the
 * caller passes the keys CURRENTLY on screen rather than the ones it wants
 * forgotten.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import {
  QUEUE_SEEN_DOC_ID,
  QUEUE_SEEN_MAX_KEYS,
  QUEUE_SEEN_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type DashboardQueueTab,
  type QueueSeenDoc,
} from '@linyup/shared'

export function queueSeenKey(teamId: string | null) {
  return ['queue-seen', teamId] as const
}

/** Absent document ⇒ nothing seen ⇒ everything is new, which is the right
 *  answer on a studio's first visit. */
const EMPTY: QueueSeenDoc = {}

export function useQueueSeen() {
  const { currentTeamId, user, teamRole } = useAuth()
  const qc = useQueryClient()
  const canAck = teamRole === 'owner' || teamRole === 'manager'

  const seenQuery = useQuery<QueueSeenDoc>({
    queryKey: queueSeenKey(currentTeamId),
    enabled: !!currentTeamId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const snap = await getDoc(
        doc(
          db,
          TEAMS_COLLECTION,
          currentTeamId!,
          QUEUE_SEEN_SUBCOLLECTION,
          QUEUE_SEEN_DOC_ID
        )
      )
      return snap.exists() ? (snap.data() as QueueSeenDoc) : EMPTY
    },
  })

  const markSeenMutation = useMutation({
    mutationFn: async ({ tab, keys }: { tab: DashboardQueueTab; keys: string[] }) => {
      if (!currentTeamId) return
      await setDoc(
        doc(db, TEAMS_COLLECTION, currentTeamId, QUEUE_SEEN_SUBCOLLECTION, QUEUE_SEEN_DOC_ID),
        {
          // The newest keys survive the cap: the caller hands them in queue
          // order, which is newest-first on every tab.
          [tab]: keys.slice(0, QUEUE_SEEN_MAX_KEYS),
          updated_at: serverTimestamp(),
          updated_by: user?.uid ?? null,
        },
        // MERGE, so acknowledging one tab cannot blank another's record — two
        // managers on two tabs at the same moment is an ordinary Tuesday.
        { merge: true }
      )
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queueSeenKey(currentTeamId) }),
  })

  return {
    seen: seenQuery.data ?? EMPTY,
    isLoading: seenQuery.isLoading,
    canAck,
    markSeen: (tab: DashboardQueueTab, keys: string[]) => markSeenMutation.mutate({ tab, keys }),
    isSaving: markSeenMutation.isPending,
  }
}
