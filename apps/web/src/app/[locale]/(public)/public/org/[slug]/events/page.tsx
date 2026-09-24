'use client'

import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import { usePublicEvents } from '@/components/events/program/usePublicEvents'
import { PublicEventList } from '@/components/events/program/PublicEventList'
import { usePublicOrgBySlug } from '@/components/events/program/usePublicOrg'

export const dynamic = 'force-dynamic'

// An organisation's own published events. The same events also appear on every
// member studio's public page (see usePublicEvents) — published once, shown in
// both places, which is the whole point for a federation.
export default function PublicOrgEventsIndexPage() {
  const t = useTranslations('EventProgram')
  const { slug } = useParams<{ slug: string }>()
  const org = usePublicOrgBySlug(slug)
  const { loading, events } = usePublicEvents(null, org.orgId)

  return (
    <div className="mx-auto max-w-xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        {org.name && (
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{org.name}</p>
        )}
        <h1 className="text-2xl font-semibold">{t('publicEventsTitle')}</h1>
      </div>

      <PublicEventList
        events={events}
        loading={org.loading || loading}
        hrefFor={(event) => `/public/org/${slug}/events/${event.id}`}
      />
    </div>
  )
}
