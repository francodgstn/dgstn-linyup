'use client'

// ─── WHO IS ON THE COURSE ────────────────────────────────────────────────────
//
// The register for a course, and the two things a studio does to it: put
// somebody on, and take somebody off.
//
// Enrolling writes ONE document — the place — and a converger then puts that
// person on every future lesson. So the number that matters here is the COURSE's
// (4 of 9), not any lesson's, and the panel says how many lessons the enrolment
// reached so a partial converge is visible rather than silent.
//
// Withdrawing cancels their FUTURE lessons and leaves the past alone: that is
// attendance history, not a mistake. No money moves either way — a refund is
// handed back from the payments page, deliberately and by hand.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { collection, getDocs } from 'firebase/firestore'
import { toast } from 'sonner'
import { UserMinus } from 'lucide-react'
import {
  COURSE_BLOCKS_COLLECTION,
  COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION,
  courseBlockEnrolmentHoldsPlace,
  placesFree,
  type CourseBlock,
  type CourseBlockEnrolment,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { callFunction } from '@/lib/callFunction'
import { ContactPicker } from '@/components/payments/ContactPicker'
import { Button } from '@/components/ui/button'

/** A course's enrolments. Small by nature — a course holds a handful of people
 *  — so the whole subcollection is read and filtered in memory. */
function useCourseEnrolments(blockId: string | null) {
  return useQuery<Array<CourseBlockEnrolment & { id: string }>>({
    queryKey: ['course-enrolments', blockId],
    enabled: !!blockId,
    queryFn: async () => {
      if (!blockId) return []
      const snap = await getDocs(
        collection(db, COURSE_BLOCKS_COLLECTION, blockId, COURSE_BLOCK_ENROLMENTS_SUBCOLLECTION)
      )
      return snap.docs.map((d) => ({ ...(d.data() as CourseBlockEnrolment), id: d.id }))
    },
  })
}

export function CourseRosterPanel({
  block,
  teamId,
  canEdit,
}: {
  block: CourseBlock
  teamId: string
  canEdit: boolean
}) {
  const t = useTranslations('CourseBlocks')
  const qc = useQueryClient()
  const { data: enrolments = [], isLoading } = useCourseEnrolments(block.id)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)

  // Read through the shared predicate, not by testing `status` here: the gate,
  // the recount and this list must agree about what a lapsed hold means.
  const live = enrolments.filter((e) => courseBlockEnrolmentHoldsPlace(e))
  const free = placesFree(block.places, live.length)

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['course-enrolments', block.id] }),
      qc.invalidateQueries({ queryKey: ['course-blocks', teamId] }),
    ])
  }

  async function enrol() {
    if (!picked || busy) return
    setBusy(true)
    try {
      const res = await callFunction<
        { teamId: string; blockId: string; contactId: string },
        { bookingsWritten: number; conflicts: string[] }
      >('enrolCourseBlockContact')({ teamId, blockId: block.id, contactId: picked })
      setPicked('')
      await refresh()
      toast.success(t('enrolled', { count: res.data.bookingsWritten }))
      if (res.data.conflicts.length > 0) {
        // Surfaced, never fatal — see the converger. The place is theirs; one
        // lesson was already full from an ordinary booking.
        toast.warning(t('enrolConflicts', { count: res.data.conflicts.length }))
      }
    } catch (err) {
      console.error('[course enrol] failed:', err)
      toast.error(err instanceof Error ? err.message : t('enrolFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function withdraw(contactId: string) {
    if (busy) return
    setBusy(true)
    try {
      await callFunction<{ teamId: string; blockId: string; contactId: string }, unknown>(
        'withdrawFromCourseBlock'
      )({ teamId, blockId: block.id, contactId })
      await refresh()
      toast.success(t('withdrawn'))
    } catch (err) {
      console.error('[course withdraw] failed:', err)
      toast.error(err instanceof Error ? err.message : t('withdrawFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium">{t('rosterHeading')}</p>
        <p className="text-xs text-muted-foreground">
          {free === Infinity
            ? t('rosterUncapped', { count: live.length })
            : t('rosterPlaces', { taken: live.length, places: block.places ?? 0 })}
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('rosterLoading')}</p>
      ) : live.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('rosterEmpty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {live.map((e) => (
            <li key={e.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {`${e.firstname ?? ''} ${e.lastname ?? ''}`.trim() || e.email || e.id}
              </span>
              {e.status === 'hold' && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t('rosterHold')}
                </span>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => withdraw(e.id)}
                  aria-label={t('withdraw')}
                >
                  <UserMinus className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <ContactPicker teamId={teamId} value={picked} onChange={setPicked} allowUnassign={false} />
            </div>
            <Button onClick={enrol} disabled={!picked || busy || free <= 0}>
              {busy ? t('enrolling') : t('enrol')}
            </Button>
          </div>
          {free <= 0 && <p className="text-xs text-muted-foreground">{t('rosterFull')}</p>}
          {(block.fanout_conflicts?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('rosterConflicts', { count: block.fanout_conflicts?.length ?? 0 })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
