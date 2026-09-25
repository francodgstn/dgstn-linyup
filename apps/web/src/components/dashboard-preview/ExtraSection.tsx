'use client'

/**
 * THE EXTRA SHELF — built, working, and deliberately not shown.
 *
 * When the two dashboards were consolidated, the incumbent's page was replaced
 * wholesale. Most of what it dropped was dropped ON PURPOSE and is documented as
 * such in the dashboard page's header. These panels are the other kind: code
 * that works, that nobody had decided against, and that deleting would have
 * thrown away for no reason other than that the new composition had no room for
 * it.
 *
 * So they are parked here rather than removed, behind ONE switch
 * (`extra-dashboard`, Settings → Experimental). The section is off by default,
 * and the honest reading of "off by default" is that this is a holding area, not
 * a feature: whatever is still in here when the shape is decided either earns a
 * place on the page above or gets deleted properly.
 *
 * ── WHAT LEFT, AND WHY (2026-08-31) ─────────────────────────────────────────
 * The shelf is a holding area, so a review of it is a review of what is still
 * worth holding. Three things stopped being:
 *
 *  • Revenue — a DUPLICATE. It is on the dashboard above already
 *    (`FiguresBlock`, same `useMonthlyRevenue` hook), so the shelf was showing
 *    a studio its own takings twice, the second time under a heading that says
 *    the shape is not decided. A parked copy of a shipped figure is not parked
 *    work; it is a second answer to a question the page already answers.
 *  • Unassigned — a FILING TASK wearing a figure's clothes. It belongs beside
 *    the rows it is about, on /payments, not as a headline number you can only
 *    act on elsewhere.
 *  • Recent payments — REPLACED, not dropped. Five rows of the last charges is
 *    a smaller version of the /payments page it links to. `TopSellingCard`
 *    answers the thing a dashboard can say and a table cannot: which of
 *    everything the studio sells actually earns.
 *
 * All three were deleted at the source rather than left as unmounted exports —
 * see the header of `dashboard/DashboardFinanceSection.tsx`, which now holds
 * only the plugin charts below.
 *
 * Active members GRADUATED (2026-09-19) to the Trends section above, gated on
 * the plan's `member_app` feature with an upgrade notice in its place.
 *
 * ── WHY ONE SWITCH AND NOT FOUR ──────────────────────────────────────────────
 * The engagement matrix already had its own experimental id. Keeping it once the
 * card moved in here would have meant two switches gating one card — the outer
 * section and the inner flag — where the inner one could only ever be a no-op or
 * a trap. The section's flag replaced it. Per-card switches become worth it when
 * somebody wants one of these without the others; until then they are four
 * settings rows describing one decision.
 *
 * That is also why the matrix no longer wears its own "Experimental" chip: the
 * whole shelf is the experiment, said once in its heading and again in Settings
 * → Experimental. A chip inside it was labeling one card as less settled than
 * the equally unsettled cards beside it.
 *
 * ── THE PERIOD IS FIXED, DELIBERATELY ────────────────────────────────────────
 * `WeekSection` above owns the range and comparison controls. These cards read
 * the same dataset at its DEFAULTS (13 weeks, no comparison) rather than
 * carrying a second pair of selectors: react-query keys on those arguments, so
 * at the defaults this is a cache hit and costs nothing, and a parked panel does
 * not need its own chrome. If one of these graduates to the page above, it
 * inherits that section's controls and this note goes with it.
 *
 * `TopSellingCard` is the one that pays for its own reads — the payment rails
 * are not in the trends dataset, so it queries them itself over the same 13
 * weeks. That is the price of the card, and the reason it lives on an opt-in
 * shelf rather than on the page above.
 *
 * The team-level AI view did NOT start here after all. The `ai-insights` plugin
 * that reserved this slot was a placeholder and was removed on 2026-09-14; the
 * real one, team sentiment, arrived on 2026-09-16 as a module of the AI insights
 * plugin container, and a plugin module is already its own switch — parking it
 * behind this shelf's experiment too would have been two switches for one card.
 * It mounts on the page above (`dashboard/TeamSentimentSection.tsx`).
 */

import { useTranslations } from 'next-intl'
import { useDashboardData } from '@/hooks/useDashboardData'
import { DashboardFinanceTrends } from '@/components/dashboard/DashboardFinanceSection'
import { EngagementMatrixCard } from '@/components/dashboard/EngagementMatrixCard'
import { TopSellingCard } from '@/components/dashboard/TopSellingCard'
import { TrialFunnelCard } from '@/components/dashboard/TrialFunnelCard'
import { CorrelationExplorerCard } from '@/components/dashboard/CorrelationExplorerCard'

/** WeekSection's defaults. Matching them is what makes the query a cache hit. */
const EXTRA_WEEKS = 13
const EXTRA_COMPARE = 'none' as const

export function ExtraSection({ teamId }: { teamId: string | null }) {
  const t = useTranslations('NewDashboard')
  const data = useDashboardData(teamId, EXTRA_WEEKS, EXTRA_COMPARE)

  const shared = { trendsWeeks: EXTRA_WEEKS, compareWith: EXTRA_COMPARE }

  return (
    <section className="space-y-4">
      {/* Same hairline-and-title idiom as Trends above it, one step quieter:
          this heading names a holding area, not a part of the product. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t pt-4">
        <h2 className="font-heading text-sm font-bold tracking-tight text-heading">
          {t('extraTitle')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('extraSubtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TopSellingCard teamId={teamId} trendsWeeks={EXTRA_WEEKS} />
        <EngagementMatrixCard weeklyReports={data.weeklyReports} trendsWeeks={EXTRA_WEEKS} />
      </div>

      <TrialFunnelCard
        weeklyReports={data.weeklyReports}
        comparisonWeeklyReports={data.comparisonWeeklyReports}
        {...shared}
      />

      {/* Self-gating: returns null unless the finance plugin is installed. */}
      <DashboardFinanceTrends teamId={teamId} />

      <CorrelationExplorerCard
        weeklyReports={data.weeklyReports}
        sessions={data.sessions}
        allBookings={data.allBookings}
        newContactBookings={data.newContactBookings}
        trendsWeeks={EXTRA_WEEKS}
      />
    </section>
  )
}
