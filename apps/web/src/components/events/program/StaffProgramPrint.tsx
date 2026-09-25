'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { EVENTS_COLLECTION } from '@linyup/shared'
import type { Event } from '@linyup/shared'
import { ProgramSheet } from './ProgramSheet'
import { ProgramPrintFrame } from './ProgramPrintFrame'
import { useProgramItems } from './useProgram'

const asDate = (v: unknown): Date | null =>
  (v as { toDate?: () => Date } | null)?.toDate?.() ?? null

/**
 * The staff printout of an event's program — the handout members get, from
 * the event's OWN documents rather than the public mirror, so it works for an
 * event that is not published (most are not: events are private by default).
 *
 * Internal notes are OFF by default: the usual job is the sheet that goes on
 * the wall or into members' hands. Turning them on makes the coaches' copy.
 *
 * Mounted by `/events/{id}/print` and `/org/{orgId}/events/{id}/print`, which
 * differ only in where "back" goes and whose name heads the sheet.
 */
export function StaffProgramPrint({
  eventId,
  backHref,
  ownerName,
}: {
  eventId: string
  backHref: string
  ownerName?: string | null
}) {
  const t = useTranslations('EventProgram')
  const [withNotes, setWithNotes] = useState(false)

  // Same key as both event detail pages — shared cache, so coming from the
  // event costs no read.
  const eventQ = useQuery<Event | null>({
    queryKey: ['event', eventId],
    enabled: !!eventId,
    queryFn: async () => {
      const snap = await getDoc(doc(db, EVENTS_COLLECTION, eventId))
      return snap.exists() ? ({ ...snap.data(), id: snap.id } as Event) : null
    },
  })
  const itemsQ = useProgramItems(eventId)
  const event = eventQ.data

  if (eventQ.isLoading || itemsQ.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!event) {
    return <p className="px-4 py-16 text-center text-sm text-muted-foreground">{t('publicEventNotFound')}</p>
  }

  return (
    <ProgramPrintFrame
      documentTitle={event.title}
      backHref={backHref}
      backLabel={t('backToEvent')}
      controls={
        <div className="flex items-center gap-2">
          <Switch id="print-internal-notes" checked={withNotes} onCheckedChange={setWithNotes} />
          <Label htmlFor="print-internal-notes" className="text-xs font-normal">
            {t('printIncludeNotes')}
          </Label>
        </div>
      }
    >
      <ProgramSheet
        ownerName={ownerName}
        title={event.title}
        start={asDate(event.start)}
        end={asDate(event.end)}
        location={event.location}
        coachName={event.coachName}
        description={event.description}
        config={event.program}
        items={itemsQ.data ?? []}
        showInternalNotes={withNotes}
      />
    </ProgramPrintFrame>
  )
}
