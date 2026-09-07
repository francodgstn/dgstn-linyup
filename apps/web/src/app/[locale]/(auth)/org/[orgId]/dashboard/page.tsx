'use client'

/**
 * THE ORGANISATION'S DASHBOARD.
 *
 * ── WHY IT IS NOT THE STUDIO DASHBOARD WITH A WIDER QUERY ───────────────────
 *
 * A studio's dashboard is a DAY: today's agenda beside the queue of things
 * waiting on a coach, six figures and a roster donut in the reference column,
 * trends below the fold. Every one of those is answered from a position inside
 * one tenant, and most of them change between breakfast and lunch.
 *
 * An organisation has no day. It runs no sessions, takes no bookings and has no
 * agenda — its studios do. What it has is SCALE (how many studios, how many
 * people, how many of them hold its licence), COMPOSITION (which studios ARE the
 * federation, and how unevenly), and a queue that is almost entirely invitations
 * and requests. So the composition is deliberately the other way round from the
 * studio page:
 *
 *      ┌───────────────────────────────────────────────────────┐
 *      │  STUDIOS · PEOPLE  ‖  {AFFILIATION} · EVENTS          │  full width,
 *      └───────────────────────────────────────────────────────┘  unframed
 *      ┌──────────────────────────────┐ ┌──────────────────────┐
 *      │  STUDIOS        (accent)     │ │  NEEDS YOU           │
 *      │  ranked by size, coverage bar│ │  COMING UP           │
 *      └──────────────────────────────┘ └──────────────────────┘
 *      ┌───────────────────────────────────────────────────────┐
 *      │  THE FEDERATION OVER TIME                             │
 *      └───────────────────────────────────────────────────────┘
 *
 * The figures lead instead of sitting in a margin, because scale IS the
 * organisation's headline; and exactly ONE thing wears the accent frame, because
 * a federation has one subject where a studio's morning has two. Same building
 * blocks (`Figure`, `Panel`, `Card`), a different sentence.
 *
 * ── EVERYTHING HERE IS A READ THE ORGANISATION ALREADY HAD ──────────────────
 *
 * No rule was relaxed and no Cloud Function was added, which is what makes a
 * first cut safe to reshape: see the header of `components/org-dashboard/data.ts`
 * for who may ask what, and why a denial renders as `—` and never as `0`.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * **Money.** `saas_subscriptions/{orgId}` is the org's own bill, not a figure
 * about the federation, and it already has a page. What an organiser would
 * actually want — what its studios take — lives in per-team Connect accounts an
 * org admin has no rule to read.
 *
 * **Sessions, bookings, attendance.** All studio-scoped and all fan-out: no org
 * rollup document exists yet, and computing one in the browser across sixteen
 * tenants is the thing `data.ts` refuses on principle. The honest home for those
 * is a scheduled function writing an org rollup — named as the next step rather
 * than faked here.
 *
 * **A greeting.** The studio dashboard opens with "Good morning, Franco" because
 * it is a personal daily surface. This is a reference surface about an
 * institution; the organisation's own name is the title.
 */

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Plus } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { PageHeader } from '@/components/layout/PageHeader'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useOrg } from '@/contexts/OrgContext'
import { orgHref } from '@/lib/org-nav'
import {
  sumOrNull,
  useOrgAttention,
  useOrgRoster,
  useOrgStudioCounts,
  useOrgUpcomingEvents,
} from '@/components/org-dashboard/data'
import { ScaleStrip } from '@/components/org-dashboard/ScaleStrip'
import { StudiosPanel } from '@/components/org-dashboard/StudiosPanel'
import { AttentionCard } from '@/components/org-dashboard/AttentionCard'
import { UpcomingEventsCard } from '@/components/org-dashboard/UpcomingEventsCard'
import { GrowthCard } from '@/components/org-dashboard/GrowthCard'

export default function OrgDashboardPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('OrgDashboard')
  const { org, loading: orgLoading, isAdmin, userRole, affiliationTerm } = useOrg()

  const { data: roster, isLoading: rosterLoading } = useOrgRoster(orgId)
  const rows = roster ?? []
  const active = rows.filter((r) => r.status === 'active')
  const invited = rows.filter((r) => r.status === 'invited').length

  // COUNTS ARE ASKED FOR ACTIVE STUDIOS ONLY, and not merely because an
  // invitation is not a member. `isOrgAdminOfTeam` resolves through
  // `teams/{teamId}.org_id`, which an invited studio has not been stamped with
  // yet — so asking would be a guaranteed denial per invited row, and the panel
  // would show a dash that means "denied" next to a badge that already says
  // "invited". One explanation per row is enough.
  const { data: counts, isLoading: countsLoading } = useOrgStudioCounts(
    orgId,
    active.map((r) => r.teamId),
    isAdmin
  )
  const { data: events, isLoading: eventsLoading } = useOrgUpcomingEvents(orgId)
  const { data: attention, isLoading: attentionLoading } = useOrgAttention(orgId, isAdmin)

  const people = isAdmin ? sumOrNull(active.map((r) => counts?.[r.teamId]?.people)) : null
  const affiliated = isAdmin ? sumOrNull(active.map((r) => counts?.[r.teamId]?.affiliated)) : null

  const figuresLoading =
    rosterLoading || (isAdmin && active.length > 0 && countsLoading) || eventsLoading

  if (orgLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // A MEMBER STUDIO HAS ITS OWN SUMMARY, and this is not it.
  //
  // Nothing routes them here — the sidebar offers them `ORG_STUDIO_NAV_ITEMS`
  // and `/org/{id}` lands them on the overview — but a pasted link or an old
  // bookmark can, and every read on this page would then deny one at a time.
  // A signpost is a better answer than four dashes and a console full of
  // permission errors.
  if (userRole == null) {
    return (
      <div className="space-y-5">
        <PageHeader title={org?.name ?? ''} subtitle={t('subtitleMemberStudio')} />
        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <p className="text-sm text-muted-foreground">{t('memberStudioBody')}</p>
            {/* A Link WEARING the button, not a Button wrapping a link. The
                shared Button is a base-ui primitive with a `render` prop and no
                `asChild`, and every other link-as-button in this app is written
                this way. */}
            <Link
              href={orgHref(orgId, 'overview') as Route}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('memberStudioAction')}
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={org?.name ?? ''}
        subtitle={t('subtitle')}
        action={
          isAdmin ? (
            <Link
              href={orgHref(orgId, 'teams') as Route}
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              <Plus className="h-4 w-4" />
              {t('addStudio')}
            </Link>
          ) : undefined
        }
      />

      <ScaleStrip
        orgId={orgId}
        activeStudios={active.length}
        invitedStudios={invited}
        people={people}
        affiliated={affiliated}
        events={events?.total ?? null}
        affiliationTerm={affiliationTerm}
        loading={figuresLoading}
        peopleWithheld={!isAdmin}
      />

      {/* 8:4 of twelve, and the seam is the page's only one. The roster is the
          subject and needs the width for a name, two figures and a bar; the
          right column is two short reference cards that never scroll.

          NO FIXED ROW HEIGHT, unlike the studio dashboard's two rows — and the
          difference is not stylistic. A studio's agenda and queue are always
          long enough to fill a pane, so pinning the height buys a straight seam
          for free. A federation's roster is TWO rows for the organisation in
          the seed and sixteen for HMD, and 320px of empty frame under two
          studios reads as a page that failed to load. So the panel sizes to its
          content and starts scrolling only once the roster is genuinely long
          (`StudiosPanel` caps its own body). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <StudiosPanel
            orgId={orgId}
            lines={rows.map((r) => ({ ...r, counts: counts?.[r.teamId] }))}
            loading={rosterLoading}
            affiliationTerm={affiliationTerm}
            countsWithheld={!isAdmin}
          />
        </div>
        <div className="flex flex-col gap-6 lg:col-span-4">
          <AttentionCard
            orgId={orgId}
            invitedStudios={invited}
            accessRequests={attention?.accessRequests ?? null}
            memberInvitations={attention?.memberInvitations ?? null}
            loading={rosterLoading || (isAdmin && attentionLoading)}
          />
          <UpcomingEventsCard
            orgId={orgId}
            rows={events?.rows ?? []}
            total={events?.total ?? null}
            loading={eventsLoading}
          />
        </div>
      </div>

      {/* Below the working rows, and the only thing on the page that is
          history rather than state. */}
      <GrowthCard rows={rows} loading={rosterLoading} />
    </div>
  )
}
