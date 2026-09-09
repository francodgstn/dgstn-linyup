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
 *      ├───────────────────────────────────────────────────────┤  unframed
 *      │  {AFFILIATION} BY STATUS  ▓▓▓▓▓▓▒▒▒░░  + legend       │
 *      └───────────────────────────────────────────────────────┘
 *      ┌───────────┐ ┌───────────┐ ┌───────────────────────────┐
 *      │ NEEDS ATT │ │ COMING UP │ │ OVER TIME                 │
 *      └───────────┘ └───────────┘ └───────────────────────────┘
 *      ┌───────────────────────────────────────────────────────┐
 *      │  STUDIOS                                    (accent)  │
 *      │  ranked by size · coverage bar · every studio         │
 *      └───────────────────────────────────────────────────────┘
 *
 * The figures lead instead of sitting in a margin, because scale IS the
 * organisation's headline; and exactly ONE thing wears the accent frame, because
 * a federation has one subject where a studio's morning has two. Same building
 * blocks (`Figure`, `Panel`, `Card`), a different sentence.
 *
 * ── WHY THE ROSTER MOVED TO THE BOTTOM, FULL WIDTH (Franco, 2026-09-08) ─────
 *
 * It used to sit in an 8:4 row with the two reference cards beside it, which
 * looked balanced against the seeded federation of TWO studios and fell apart
 * against a real one: at twelve studios the roster ran to 700px and the right
 * column held ~350px of content, stranding 400px of empty page beside the most
 * important thing on it. Column layouts only balance when both columns grow at
 * the same rate, and these do not — the roster grows with the federation and the
 * cards never grow at all.
 *
 * So the things that DON'T grow are a band of three, and the thing that does
 * gets the full width and the bottom, where it can be as long as the federation
 * is without pulling anything out of alignment. It no longer scrolls inside
 * itself either: reading sixteen studios four at a time through a 320px window
 * is a summary of a summary.
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
  useOrgAffiliationStatusCounts,
  useOrgAffiliationStatusDefs,
  useOrgAttention,
  useOrgRoster,
  useOrgStudioCounts,
  useOrgUpcomingEvents,
} from '@/components/org-dashboard/data'
import { ScaleStrip } from '@/components/org-dashboard/ScaleStrip'
import { AffiliationStatusStrip } from '@/components/org-dashboard/AffiliationStatusStrip'
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

  // THE VOCABULARY FIRST, THEN THE COUNTS — one aggregation per status, so the
  // second query cannot be built until the first has said which statuses exist.
  // Both are org-member reads; the counts additionally need the collection-group
  // rule added on 2026-09-08, without which every one of them was denied.
  const { data: statusDefs, isLoading: statusDefsLoading } = useOrgAffiliationStatusDefs(orgId)
  // SCOPED TO THE ACTIVE STUDIOS, like every other count on this page: the
  // breakdown now asks the CONTACT which status it is in, and `teamId` is what
  // the rules grant an org admin over contacts.
  //
  // WHICH ALSO MAKES IT ADMIN-ONLY, where the old document count was not. That
  // is the right way round: an `org_viewer` cannot read contacts at all, so the
  // page already withholds PEOPLE from them, and a breakdown OF that number
  // should not be the one thing that leaks it.
  // No studio scope: the breakdown counts affiliation ROWS through the collection
  // group, where `org_id` already bounds it to this organisation — and where the
  // rules can prove it. See the hook's own note.
  const { data: statusCounts, isLoading: statusCountsLoading } = useOrgAffiliationStatusCounts(
    orgId,
    statusDefs,
    isAdmin
  )

  const onBooks = isAdmin ? sumOrNull(active.map((r) => counts?.[r.teamId]?.onBooks)) : null
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
        onBooks={onBooks}
        affiliated={affiliated}
        events={events?.total ?? null}
        affiliationTerm={affiliationTerm}
        loading={figuresLoading}
        peopleWithheld={!isAdmin}
      />

      {/* THE BREAKDOWN OF THE FIGURE ABOVE IT, so it sits with the figures
          rather than in the band — a decomposition, not a fourth subject. */}
      <AffiliationStatusStrip
        orgId={orgId}
        breakdown={statusCounts}
        affiliationTerm={affiliationTerm}
        loading={statusDefsLoading || statusCountsLoading}
      />

      {/* THE THINGS THAT DO NOT GROW. Three cards of roughly one screenful
          between them, whatever the federation's size: a queue that is usually
          short, the next few events, and twelve months of one line. Equal
          thirds at `lg`; two-up at `sm` with the chart taking the full row
          under them, because a 12-month axis in a half column is unreadable. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <div className="sm:col-span-2 lg:col-span-1">
          {/* ACTIVE studios only. An invitation is not a member, and counting
              one here made the chart's subtitle disagree with the STUDIOS
              figure at the top of this very page. */}
          <GrowthCard rows={active} loading={rosterLoading} />
        </div>
      </div>

      {/* THE SUBJECT, and it gets the width and the bottom. Uncapped: as long
          as the federation is. */}
      <StudiosPanel
        orgId={orgId}
        lines={rows.map((r) => ({ ...r, counts: counts?.[r.teamId] }))}
        loading={rosterLoading}
        affiliationTerm={affiliationTerm}
        countsWithheld={!isAdmin}
      />
    </div>
  )
}
