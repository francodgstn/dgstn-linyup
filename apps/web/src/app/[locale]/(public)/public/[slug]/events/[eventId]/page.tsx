'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { usePublicTeam } from '../../PublicTeamProvider'
import { usePublicEvent } from '@/components/events/program/usePublicEvents'
import { PublicEventDetail } from '@/components/events/program/PublicEventDetail'
import { publicHref, publicSubHref } from '@/lib/publicRoutes'

export const dynamic = 'force-dynamic'

export default function PublicEventDetailPage() {
  const t = useTranslations('EventProgram')
  const { eventId } = useParams<{ eventId: string }>()
  const { slug, teamId, team } = usePublicTeam()
  const { loading, event } = usePublicEvent(eventId)

  // The mirror is world-readable by id, so confirm the event actually belongs to
  // THIS tenant (its own team, or its parent org) before rendering it under the
  // studio's slug.
  const belongsHere =
    !!event &&
    ((event.teamId && event.teamId === teamId) ||
      (event.orgId && team.org_id && event.orgId === team.org_id))

  if (loading) {
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
        ownerName={team.name}
        backHref={publicHref(slug, 'events')}
        backLabel={t('publicBackToEvents')}
        printHref={publicSubHref(slug, 'events', [event.id, 'print'])}
      />
    </div>
  )
}
