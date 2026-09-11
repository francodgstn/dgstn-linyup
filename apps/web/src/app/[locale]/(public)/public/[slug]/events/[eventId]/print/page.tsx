'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePublicTeam } from '../../../PublicTeamProvider'
import { usePublicEvent } from '@/components/events/program/usePublicEvents'
import { ProgramTimeline } from '@/components/events/program/ProgramTimeline'
import { usePublicFormat } from '../../../usePublicFormat'

export const dynamic = 'force-dynamic'

// The printable handout. Rendered with @media print rules (see globals.css) so
// the browser's "Save as PDF" produces a clean A4 sheet — one page break per
// day, no chrome. Deliberately not jsPDF: hand-laying a multi-day multi-track
// grid there is far more work for a worse-looking result.
export default function PublicEventProgramPrintPage() {
  const t = useTranslations('EventProgram')
  const { eventId } = useParams<{ eventId: string }>()
  const { teamId, team } = usePublicTeam()
  const fmt = usePublicFormat()
  const { loading, event } = usePublicEvent(eventId)

  const belongsHere =
    !!event &&
    ((event.teamId && event.teamId === teamId) ||
      (event.orgId && team.org_id && event.orgId === team.org_id))

  useEffect(() => {
    if (!loading && event && belongsHere) document.title = event.title
  }, [loading, event, belongsHere])

  if (loading) {
    return <div className="mx-auto max-w-3xl px-6 py-10"><div className="h-8 w-1/2 animate-pulse rounded bg-muted" /></div>
  }

  if (!event || !belongsHere) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('publicEventNotFound')}</p>
      </div>
    )
  }

  const start = (event.start as unknown as { toDate?: () => Date } | null)?.toDate?.()
  const end = (event.end as unknown as { toDate?: () => Date } | null)?.toDate?.()

  return (
    <div className="program-print mx-auto max-w-3xl space-y-6 px-6 py-10">
      <div className="flex justify-end print:hidden">
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer className="mr-1.5 h-3.5 w-3.5" />
          {t('print')}
        </Button>
      </div>

      <header className="space-y-1 border-b pb-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{team.name}</p>
        <h1 className="text-2xl font-semibold">{event.title}</h1>
        <p className="text-sm text-muted-foreground">
          {fmt.dayMonthLong(start, true)}
          {end && start && fmt.isoDate(end) !== fmt.isoDate(start) ? ` – ${fmt.dayMonthLong(end, true)}` : ''}
          {event.location ? ` · ${event.location}` : ''}
        </p>
      </header>

      <ProgramTimeline config={event.program ?? undefined} items={event.programItems} />
    </div>
  )
}
