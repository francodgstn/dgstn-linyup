'use client'

import { useTranslations } from 'next-intl'
import { CalendarDays, ChevronRight, MapPin } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { Badge } from '@/components/ui/badge'
import type { PublicEventSummary } from './usePublicEvents'

// Shared list rendering for the public event surfaces (a studio's page and an
// organisation's), so both read identically.

function formatRange(event: PublicEventSummary): string {
  const start = (event.start as unknown as { toDate?: () => Date } | null)?.toDate?.()
  const end = (event.end as unknown as { toDate?: () => Date } | null)?.toDate?.()
  if (!start) return ''
  const dateOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }
  const startStr = start.toLocaleDateString(undefined, dateOpts)
  if (!end) return startStr
  // A multi-day event reads as a range; a single-day one shows the time instead.
  const sameDay = start.toDateString() === end.toDateString()
  if (sameDay) {
    const time = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return `${startStr} · ${time}`
  }
  return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })} – ${end.toLocaleDateString(undefined, dateOpts)}`
}

export function PublicEventList({
  events,
  loading,
  hrefFor,
}: {
  events: PublicEventSummary[]
  loading: boolean
  hrefFor: (event: PublicEventSummary) => string
}) {
  const t = useTranslations('EventProgram')

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-12 text-center">
        <CalendarDays className="mx-auto h-7 w-7 text-muted-foreground/60" />
        <p className="mt-2 text-sm text-muted-foreground">{t('publicNoEvents')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <Link
          key={event.id}
          href={hrefFor(event) as Route}
          className="flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{event.title}</span>
              {event.programItemCount > 0 && (
                <Badge variant="outline" className="text-[0.625rem]">
                  {t('publicHasProgramme')}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatRange(event)}</p>
            {event.location && (
              <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" />
                {event.location}
              </p>
            )}
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  )
}
