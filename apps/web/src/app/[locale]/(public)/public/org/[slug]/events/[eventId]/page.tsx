'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { usePublicEvent } from '@/components/events/program/usePublicEvents'
import { PublicEventDetail } from '@/components/events/program/PublicEventDetail'
import { usePublicOrgBySlug } from '@/components/events/program/usePublicOrg'

export const dynamic = 'force-dynamic'

export default function PublicOrgEventDetailPage() {
  const t = useTranslations('EventProgram')
  const { slug, eventId } = useParams<{ slug: string; eventId: string }>()
  const org = usePublicOrgBySlug(slug)
  const { loading, event } = usePublicEvent(eventId)

  // The mirror is world-readable by id, so confirm the event really belongs to
  // THIS organization before rendering it under the org's slug.
  const belongsHere = !!event && !!org.orgId && event.orgId === org.orgId

  if (org.loading || loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 px-4 py-8">
        <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-lg bg-muted/60" />
      </div>
    )
  }

  if (!event || !belongsHere) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('publicEventNotFound')}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PublicEventDetail
        event={event}
        ownerName={org.name}
        backHref={`/public/org/${slug}/events`}
        backLabel={t('publicBackToEvents')}
        printHref={`/public/org/${slug}/events/${event.id}/print`}
      />
    </div>
  )
}
