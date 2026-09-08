'use client'

/**
 * THE CHECK-INS FOR ONE EVENT — `checkins` where `event.id` matches.
 *
 * Written out three times before it was written down once: the org event detail
 * page and `CheckinPanel` each carried a byte-identical copy under the SAME
 * cache key, and the demographics card would have been the third. They shared a
 * key, so react-query already served them one fetch — which is exactly why the
 * duplication was invisible and could have drifted: two of them could have
 * started returning different rows under one key with nothing to notice.
 *
 * The key is unchanged (`['event-checkins', eventId]`), so every existing
 * `invalidateQueries` call site still reaches it.
 */

import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CHECKINS_COLLECTION } from '@linyup/shared'
import type { EventCheckin } from '@linyup/shared'

export function useEventCheckins(eventId: string) {
  return useQuery<EventCheckin[]>({
    queryKey: ['event-checkins', eventId],
    enabled: !!eventId,
    queryFn: async () => {
      const snap = await getDocs(
        query(collection(db, CHECKINS_COLLECTION), where('event.id', '==', eventId))
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as EventCheckin)
    },
  })
}
