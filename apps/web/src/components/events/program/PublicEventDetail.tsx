'use client'

import { useTranslations } from 'next-intl'
import { ArrowLeft, Printer } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { ProgramSheet } from './ProgramSheet'
import type { PublicEventSummary } from './usePublicEvents'

// Shared detail rendering for the public event surfaces — what a member opens
// from the studio's events page or from their Space. The event is shown AS THE
// HANDOUT (ProgramSheet), on a sheet of paper, so what they read here is what
// the print button gives them.
//
// Never receives internal notes — the mirror does not carry them, and
// showInternalNotes is deliberately not passed here.

const asDate = (v: unknown): Date | null =>
  (v as { toDate?: () => Date } | null)?.toDate?.() ?? null

export function PublicEventDetail({
  event,
  ownerName,
  backHref,
  backLabel,
  printHref,
}: {
  event: PublicEventSummary
  /** The studio or organisation name printed above the title. */
  ownerName?: string | null
  backHref: string
  backLabel: string
  printHref?: string
}) {
  const t = useTranslations('EventProgram')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link
          href={backHref as Route}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Link>
        {printHref && (
          <Link
            href={printHref as Route}
            className="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-muted"
          >
            <Printer className="mr-1.5 h-3.5 w-3.5" />
            {t('printOrPdf')}
          </Link>
        )}
      </div>

      <ProgramSheet
        className="rounded-sm border border-neutral-200 shadow-sm"
        ownerName={ownerName}
        title={event.title}
        start={asDate(event.start)}
        end={asDate(event.end)}
        location={event.location}
        coachName={event.coachName}
        description={event.description}
        config={event.program}
        items={event.programItems ?? []}
      />
    </div>
  )
}
