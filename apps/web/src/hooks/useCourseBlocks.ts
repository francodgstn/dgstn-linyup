'use client'

import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { COURSE_BLOCKS_COLLECTION, firstMeeting, type CourseBlock } from '@linyup/shared'

/**
 * A team's courses, a bounded set of lessons sold as one thing
 * ("13 Wednesdays, 9 places, one price"). See `types/courseBlock.ts`.
 *
 * Not the online-courses plugin, which is on-demand video and lives in
 * `courses/{id}`. The two are displayed as *Course* and *Online course*.
 *
 * Ordered by FIRST LESSON, soonest first, because that is the question a studio
 * looking at this list is asking ("what starts next?"). Sorted here rather than
 * with an `orderBy`: the first lesson lives inside the meeting list, so there is
 * no field to index, and a studio's course count is small by nature.
 */
export function useCourseBlocks(teamId: string | null) {
  return useQuery<CourseBlock[]>({
    queryKey: ['course-blocks', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return []
      const snap = await getDocs(
        query(collection(db, COURSE_BLOCKS_COLLECTION), where('teamId', '==', teamId))
      )
      return snap.docs
        .map((d) => ({ ...(d.data() as CourseBlock), id: d.id }))
        .sort((a, b) => {
          // A course with no lessons yet (a draft mid-setup) sorts last rather
          // than first: it is the least urgent thing on the screen.
          const aStart = firstMeeting(a)?.start.toMillis() ?? Infinity
          const bStart = firstMeeting(b)?.start.toMillis() ?? Infinity
          if (aStart !== bStart) return aStart - bStart
          return (a.name ?? '').localeCompare(b.name ?? '')
        })
    },
  })
}
