'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { usePublicEvent } from '@/components/events/program/usePublicEvents'
import { usePublicOrgBySlug } from '@/components/events/program/usePublicOrg'
import { ProgramSheet } from '@/components/events/program/ProgramSheet'
import { ProgramPrintFrame } from '@/components/events/program/ProgramPrintFrame'

export const dynamic = 'force-dynamic'

// The organization's printable handout — the twin of the studio's
// /public/{slug}/events/{eventId}/print, for an event read from the org's own
// public page.
export default function PublicOrgEventProgramPrintPage() {
  const t = useTranslations('EventProgram')
  const { slug, eventId } = useParams<{ slug: string; eventId: string }>()
  const org = usePublicOrgBySlug(slug)
  const { loading, event } = usePublicEvent(eventId)

  // The mirror is world-readable by id, so confirm the event really belongs to
  // THIS organization before printing it under the org's name.
  const belongsHere = !!event && !!org.orgId && event.orgId === org.orgId

  if (org.loading || loading) {
    return <div className="mx-auto max-w-3xl px-6 py-10"><div className="h-8 w-1/2 animate-pulse rounded bg-muted" /></div>
  }

  if (!event || !belongsHere) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('publicEventNotFound')}</p>
      </div>
    )
  }

  return (
    <ProgramPrintFrame
      documentTitle={event.title}
      backHref={`/public/org/${slug}/events/${event.id}`}
      backLabel={t('backToEvent')}
    >
      <ProgramSheet
        ownerName={org.name}
        title={event.title}
        start={(event.start as unknown as { toDate?: () => Date } | null)?.toDate?.() ?? null}
        end={(event.end as unknown as { toDate?: () => Date } | null)?.toDate?.() ?? null}
        location={event.location}
        coachName={event.coachName}
        description={event.description}
        config={event.program}
        items={event.programItems ?? []}
      />
    </ProgramPrintFrame>
  )
}
