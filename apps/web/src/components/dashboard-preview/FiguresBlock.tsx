'use client'

/**
 * THE SNAPSHOT — six figures, two columns, top right.
 *
 * ── WHERE THIS CAME FROM ─────────────────────────────────────────────────────
 *
 * The incumbent's six, now FIVE: four stats (engaged, bookings ahead,
 * subscribed, affiliation) plus revenue, each with the SUBTITLE AND NOTE that
 * tell it apart from its neighbour. That pairing is the point of the block and
 * the reason it is worth the cells: a bare "84" beside a bare "96" is the
 * confusion this page has now failed to fix twice.
 *
 * UNASSIGNED IS GONE FROM HERE, and it did not go anywhere — it was never only
 * a figure. Money that arrived with nobody attached to it is WORK, so it is a
 * row in the queue (`QueuePanel`, the `payments` task), which is where this
 * page put it before it ever adopted the incumbent's figure grid. Dropping the
 * figure removed a duplicate, not a route: the task row is the one that can be
 * cleared, and it carries the count. Do not re-add the figure without deleting
 * the row, or the studio gets told twice and can act once.
 *
 * It replaced a four-fact column whose subscription/affiliation pair was
 * explained by a proportion bar. The bar is GONE by decision (Franco,
 * 2026-08-18) — he has seen both and prefers the subtitles carrying it, which
 * is what the incumbent always did. Do not reintroduce it: the two subtitles
 * below (`figSubscribedSub`, `figAffiliationSub`) are now the only thing
 * distinguishing those two numbers, so they are load-bearing copy, not
 * decoration, and they may not be shortened into labels.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────────
 *
 * Value and subtitle share a BASELINE, with the note under the subtitle. That
 * is the incumbent's own figure geometry and it is what makes five of these fit
 * a ~417px column inside row 1's 264px: a caption-over-number-over-two-lines
 * cell costs 85px, this one costs ~51px.
 *
 * REVENUE LEADS, at the full width of the block and one type size up
 * (`text-4xl`, against `text-3xl` for the rest). Five figures in two columns
 * leave an odd cell, and the odd cell is an opportunity: revenue is the figure
 * an owner opens the app for, and it had been sharing a size with the count of
 * trials on next week's classes. The full width is not decoration either — it
 * is what makes the long-currency case behave. `CHF 12'450.00` at `text-4xl`
 * is ~254px, which overflows a 198px half-column and wrapped its subtitle to a
 * second line; across 417px it sits on ONE line beside its subtitle with ~50px
 * to spare, so the block's height stops depending on how much a studio earns.
 *
 * The lead cell is the block's only size distinction, and it ranks WITHIN the
 * reference material — it does not make the block compete with the day.
 *
 * ── THE HEIGHT BUDGET, AND THE FACT THAT IT IS ALREADY SPENT ─────────────────
 *
 * This used to read "~238px against row 1's 264px; if it ever exceeds that, the
 * right column starts setting the row height". MEASURED 2026-08-21 at 1440px,
 * before this round touched anything, it was **294px** — so that had already
 * happened: the grid row is as tall as THIS block, the day's `h-[264px]` no
 * longer sets it, and the warning had been true for some time without anyone
 * noticing. It is recorded here rather than quietly corrected because the
 * arithmetic in this file has been wrong twice before in the same direction.
 *
 * This round spent a further ~8px on purpose (gap-y-5 -> 6, and the lead cell's
 * margin with it) at Franco's request for a less cramped block. So the honest
 * position: the day is no longer the tallest thing in row 1, and the next
 * addition here costs the page height directly. Take it out of the figures
 * before taking it out of the queue or the sign-off, both of which have lost
 * this argument already.
 *
 * Unframed, on the background — the page's second material. It sits opposite a
 * framed agenda and does NOT take the accent frame: the frame marks work, not
 * position and not importance.
 *
 * THE "Snapshot" HEADING IS GONE. It was set at `text-2xl font-black` — the
 * loudest word on the page — and was the last thing carried over from the
 * column this block replaced. It labelled the one block that needs no label,
 * and it did so at the top of a column already over its height budget.
 *
 * DEGRADATION IS BY SUBTRACTION. Revenue is Studio-tier, so Free and Coach get
 * the 2x2 with no lead cell above it — a shorter block, not a holed one, and no
 * upgrade nag in something meant to be read in one glance.
 */

import type React from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import {
  ArrowUpRight,
  Banknote,
  BookOpen,
  CreditCard,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react'
import type { Contact, SubscriptionType } from '@linyup/shared'
import { isRosterContact, partnerSubscriptionTypeIds } from '@linyup/shared'
import { Skeleton } from '@/components/ui/skeleton'
import { usePlan } from '@/hooks/usePlan'
import { useMonthlyRevenue } from '@/hooks/useMonthlyRevenue'
import { useAffiliationTerm } from '@/hooks/useAffiliationTerm'
import { useSubscriptionTypes } from '@/hooks/useSubscriptionTypes'
import { formatMoneyMinor } from '@/lib/payments'
import { cn } from '@/lib/utils'
import { startOfWeek, usePreviewUpcomingSessions } from './preview-data'

/**
 * One figure: caption, then a value sharing a baseline with its subtitle, then
 * the note. `flex-wrap` is what lets a long money value drop its subtitle to a
 * second line instead of overflowing a ~196px column.
 */
function Figure({
  icon: Icon,
  caption,
  value,
  subtitle,
  note,
  loading,
  href,
  lead,
}: {
  icon: React.ElementType
  caption: string
  value: React.ReactNode
  subtitle: React.ReactNode
  note?: React.ReactNode
  loading?: boolean
  href: Route
  /** The block's one ranked cell — full width, one type size up. */
  lead?: boolean
}) {
  return (
    <Link href={href} className="group/figure block">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-primary/60" />
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {caption}
        </p>
        {/* EVERY FIGURE IS A LINK, and until now nothing said so: the only
            affordance was a colour change on hover, which a touch device never
            shows at all. Revenue was the one that made this a report — the
            studio wanted a way to the payments list and did not know the number
            already was one. A persistent arrow, on all of them rather than on
            the one that was reported, because they are one block and a single
            arrow would read as "this one is special". */}
        <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-colors group-hover/figure:text-primary" />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {loading ? (
          <Skeleton className={cn('w-20', lead ? 'h-9' : 'h-7')} />
        ) : (
          <p
            className={cn(
              'font-black leading-none tracking-tight tabular-nums transition-colors group-hover/figure:text-primary',
              lead ? 'text-4xl' : 'text-3xl'
            )}
          >
            {value}
          </p>
        )}
        <p className="min-w-0 text-xs leading-snug text-muted-foreground">{subtitle}</p>
      </div>
      {/* THE NOTE IS ITS OWN ROW, under the value rather than under the
          subtitle. Nested inside the baseline row it started at the SUBTITLE's
          left edge — an indent with nothing above it to justify the indent —
          and it hung below the value's box, so a cell with a note read as a
          number floating up and a text block sagging away from it. Out here it
          starts at the cell's left edge, level with the caption and the value,
          and every line of a figure lines up on one rule (Franco, 2026-08-21).

          The value and its SUBTITLE still share a baseline; that pairing is
          the block's geometry and is untouched. */}
      {!loading && note ? (
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground/70">{note}</div>
      ) : null}
    </Link>
  )
}

function RevenueFigure({ teamId }: { teamId: string | null }) {
  const t = useTranslations('NewDashboard')
  const { data, isLoading } = useMonthlyRevenue(teamId)
  const delta = data?.deltaPercent ?? null
  const up = delta !== null && delta >= 0

  return (
    <Figure
      lead
      icon={Banknote}
      caption={t('figRevenue')}
      value={formatMoneyMinor(data?.thisMonth ?? 0, data?.currency ?? 'CHF')}
      subtitle={t('figRevenueSub')}
      loading={isLoading}
      href={'/payments' as Route}
      note={
        delta !== null ? (
          <span
            className={cn('flex items-center gap-1', up ? 'text-emerald-600' : 'text-amber-600')}
          >
            {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {t('figRevenueDelta', { percent: Math.abs(delta) })}
          </span>
        ) : undefined
      }
    />
  )
}

export function FiguresBlock({
  teamId,
  contacts,
  loading,
}: {
  teamId: string | null
  contacts: Contact[] | undefined
  loading: boolean
}) {
  const t = useTranslations('NewDashboard')
  const { isAtLeast } = usePlan()
  const affiliationTerm = useAffiliationTerm()
  const seesMoney = isAtLeast('studio')

  const { data: sessions, isLoading: sessionsLoading } = usePreviewUpcomingSessions(teamId)
  const { data: subTypes = [] } = useSubscriptionTypes(teamId)

  // The ROSTER, not merely the live set: an external is bookable but not one
  // of the studio's own people — see `contactLifecycle` in shared.
  const live = (contacts ?? []).filter(isRosterContact)

  // ── attendance: this week, and the DIFFERENT people whose last visit was the
  // week before. Deliberately not phrased as a comparison — `last_session_at`
  // holds one date, so somebody who came both weeks appears only in this one,
  // and "vs last week" off these two counts would understate every returning
  // member. The two sets are disjoint by construction; the copy says so.
  const thisWeek = startOfWeek()
  const prevWeek = new Date(thisWeek)
  prevWeek.setDate(prevWeek.getDate() - 7)
  const lastSessionMs = (c: Contact) => {
    const ts = c.last_session_at as { toDate(): Date } | null | undefined
    return ts ? ts.toDate().getTime() : null
  }
  const engaged = live.filter((c) => {
    const ms = lastSessionMs(c)
    return ms !== null && ms >= thisWeek.getTime()
  }).length
  const engagedPrev = live.filter((c) => {
    const ms = lastSessionMs(c)
    return ms !== null && ms >= prevWeek.getTime() && ms < thisWeek.getTime()
  }).length

  // ── what is booked on the sessions ahead
  const booked = (sessions ?? []).reduce((sum, s) => sum + (s.bookings_count ?? 0), 0)
  const trials = (sessions ?? []).reduce((sum, s) => sum + (s.trial_bookings_count ?? 0), 0)

  // ── subscriptions: YOUR plans, with partner-app ones counted apart.
  // A ClassPass-style type is a subscription the studio did not sell, so
  // folding it into "on one of your own plans" would make the subtitle false.
  // The same predicate the weekly report uses (subscriptionSource.ts in shared).
  const aggregatorIds = partnerSubscriptionTypeIds(subTypes as SubscriptionType[])
  const withSub = live.filter((c) => !!c.subscription_type_id)
  const internalSubs = withSub.filter((c) => !aggregatorIds.has(c.subscription_type_id!)).length
  const aggregatorSubs = withSub.length - internalSubs

  const affiliated = live.filter((c) => c.affiliation_summary?.has_active).length

  return (
    <div>
      {/* NO HEADING (Franco, 2026-08-21). "Snapshot" was the loudest word on the
          page and it labelled the one block that needs no label: six captioned
          figures under a greeting are self-evidently a summary, and the word
          cost a 24px line plus its margin at the top of a column that was
          already over its height budget. What it used to buy — a name for the
          right-hand column — is now carried by the figures themselves. */}

      {/* THE LEAD CELL — full width, above the grid rather than inside it.
          A `col-span-2` cell would work too; a sibling above says more plainly
          that this one is not a member of the 2x2 it leads. Studio-only, so
          below that tier the block simply starts at the grid. */}
      {seesMoney && (
        <div className="mb-6">
          <RevenueFigure teamId={teamId} />
        </div>
      )}

      {/* TWO COLUMNS, two rows. Gaps rather than a divider — nothing in this
          block is ruled off.

          `gap-y-6`, up from 5, and the lead cell's margin with it: six figures
          set tight read as a table of numbers, and this block is meant to be
          glanced at, not scanned. The cost is real and is stated at the foot of
          this file — the block already sets row 1's height. */}
      <div className="grid grid-cols-2 gap-x-5 gap-y-6">
        <Figure
          icon={TrendingUp}
          caption={t('figEngaged')}
          value={loading ? '' : engaged}
          subtitle={t('figEngagedSub')}
          loading={loading}
          href={'/contacts' as Route}
          note={engagedPrev > 0 ? t('figEngagedPrev', { count: engagedPrev }) : undefined}
        />
        <Figure
          icon={BookOpen}
          caption={t('figBookings')}
          value={sessionsLoading ? '' : booked}
          subtitle={t('figBookingsSub')}
          loading={sessionsLoading}
          href={'/bookings' as Route}
          note={trials > 0 ? t('figBookingsTrial', { count: trials }) : undefined}
        />
        <Figure
          icon={CreditCard}
          caption={t('figSubscribed')}
          value={loading ? '' : internalSubs}
          subtitle={t('figSubscribedSub')}
          loading={loading}
          // Straight to the tab rather than through the redirect: one fewer
          // navigation, and the figure keeps pointing at the list it counts.
          href={'/payments?tab=subscriptions' as Route}
          note={aggregatorSubs > 0 ? t('figSubscribedAgg', { count: aggregatorSubs }) : undefined}
        />
        <Figure
          icon={Users}
          caption={affiliationTerm}
          value={loading ? '' : affiliated}
          subtitle={t('figAffiliationSub')}
          loading={loading}
          href={'/affiliations' as Route}
        />
      </div>
    </div>
  )
}
