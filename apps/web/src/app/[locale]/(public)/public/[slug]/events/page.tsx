'use client'

import { useTranslations } from 'next-intl'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicEvents } from '@/components/events/program/usePublicEvents'
import { PublicEventList } from '@/components/events/program/PublicEventList'
import { publicSubHref } from '@/lib/publicRoutes'

export const dynamic = 'force-dynamic'

// A studio's published events. Reads ONLY the world-readable mirrors, and lists
// the parent organization's events alongside the studio's own — an org event has
// no teamId, so it can only be found by orgId (see usePublicEvents).
export default function PublicEventsIndexPage() {
  const t = useTranslations('EventProgram')
  const { slug, teamId, team } = usePublicTeam()
  const { loading, events } = usePublicEvents(teamId, team.org_id ?? null)

  return (
    <div className="mx-auto max-w-xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{team.name}</p>
        <h1 className="text-2xl font-semibold">{t('publicEventsTitle')}</h1>
      </div>

      <PublicEventList
        events={events}
        loading={loading}
        hrefFor={(event) => publicSubHref(slug, 'events', event.id)}
      />
    </div>
  )
}
