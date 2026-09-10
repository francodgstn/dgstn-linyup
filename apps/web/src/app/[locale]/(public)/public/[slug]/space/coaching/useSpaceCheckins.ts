'use client'

// The member's own performance check-ins — `contacts/{contactId}/performance_checkins`,
// same `isSelfContact` grant as goals (see useSpaceGoals.ts). The payload —
// including the profile heuristic, run client-side at submit time because
// there is no Cloud Function trigger for it yet (see the `onGoalWrite` note in
// useSpaceGoals.ts) — and the one-per-day rule are the shared
// `buildPerformanceCheckin` / `sameDayCheckin`, the same ones the member app
// and the coach's tab write with.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Timestamp, addDoc, collection, doc, getDocs, limit, orderBy, query, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION, buildPerformanceCheckin, sameDayCheckin } from '@linyup/shared'
import type { PerformanceCheckin } from '@linyup/shared'
import { reportPublicActionFailure, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { useSpaceAuth } from '../SpaceAuthProvider'

const HISTORY_LIMIT = 10

export function useSpaceCheckins() {
  const { isAuthenticated, contact } = useSpaceAuth()
  const contactId = contact?.id ?? null
  const qc = useQueryClient()

  const checkinsQuery = useQuery<PerformanceCheckin[]>({
    queryKey: ['space-checkins', contactId],
    enabled: isAuthenticated && !!contactId,
    queryFn: async () => {
      try {
        const col = collection(db, CONTACTS_COLLECTION, contactId!, CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION)
        // Single orderBy, no equality filter — the automatic single-field
        // index covers this. Deliberately: see the dedup note below for why a
        // second, filtered query is avoided rather than added.
        const snap = await getDocs(query(col, orderBy('taken_at', 'desc'), limit(HISTORY_LIMIT)))
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as PerformanceCheckin)
      } catch (err: unknown) {
        reportPublicLoadFailure('space/checkins', err)
        throw err
      }
    },
  })

  const submitCheckin = useMutation({
    mutationFn: async ({ scores, notes }: { scores: Record<string, number>; notes: string | null }) => {
      if (!contactId) throw new Error('Not signed in')
      const col = collection(db, CONTACTS_COLLECTION, contactId, CONTACT_PERFORMANCE_CHECKINS_SUBCOLLECTION)
      const payload = buildPerformanceCheckin(
        { scores, notes, filled_by: 'student', context: 'self' },
        Timestamp.now(),
      )
      // One self check-in per day — overwrite rather than accumulate. Found
      // from the page already in hand rather than a second query: a
      // `where('filled_by', …).where('taken_at', '>=', …)` query needs a
      // composite index this surface does not (yet) ship, and today's entry —
      // if it exists — is necessarily the single most recent one, so it is
      // always on this page.
      const existing = sameDayCheckin(checkinsQuery.data ?? [], 'student')
      if (existing) {
        await updateDoc(doc(col, existing.id), payload)
      } else {
        await addDoc(col, payload)
      }
    },
    onError: (err) => reportPublicActionFailure('space/submit-checkin', err),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['space-checkins', contactId] }),
  })

  return {
    ...checkinsQuery,
    checkins: checkinsQuery.data ?? [],
    submitCheckin,
  }
}

export type SpaceCheckinsState = ReturnType<typeof useSpaceCheckins>
