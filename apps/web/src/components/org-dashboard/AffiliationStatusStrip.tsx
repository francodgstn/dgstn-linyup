'use client'

/**
 * WHERE THE ORGANISATION'S AFFILIATIONS STAND — the breakdown of the figure
 * directly above it.
 *
 * The AFFILIATION figure says how many people currently hold one. That is the
 * outcome; this is the PIPELINE that produces it — how many are active, how many
 * are somewhere in review, how many have lapsed and are renewal work. For a
 * federation that is the whole job, and nothing else on the dashboard shows it.
 *
 * ── UNFRAMED, AND DIRECTLY UNDER THE FIGURES ───────────────────────────────
 *
 * `components/dashboard/Figure.tsx` sets the rule this follows: a card means a
 * bounded thing you can scroll, page or click INTO, and a bar with a legend is
 * none of those. It sits under the figures rather than in the card band because
 * it is a decomposition of one of them, not a fourth subject — the hairline
 * above it is the only separation it needs.
 *
 * ── RECORDS, NEVER PEOPLE ──────────────────────────────────────────────────
 *
 * The counts are affiliation DOCUMENTS (see `useOrgAffiliationStatusCounts` for
 * why they cannot exclude an archived contact's row). Every other figure on this
 * page counts live people, so the copy here says records and the strip states NO
 * percentage of the headcount: a ratio across two different populations is the
 * one number that would read as precise and be wrong.
 *
 * Percentages WITHIN the strip are honest — they are shares of the strip's own
 * total — so the legend carries them and the segments are sized by them.
 *
 * ── A DENIED COUNT IS NOT A ZERO ───────────────────────────────────────────
 *
 * A status whose count did not answer is dropped from the bar entirely rather
 * than drawn as an empty segment, and if NOTHING answered the strip renders
 * nothing at all. Drawing a bar whose segments are missing would misstate the
 * distribution, which is worse than not drawing one.
 */

import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Skeleton } from '@/components/ui/skeleton'
import { orgHref } from '@/lib/org-nav'
import { statusFillClass } from '@/lib/affiliationStatusColors'
import type { OrgAffiliationStatusCount } from './data'

export function AffiliationStatusStrip({
  orgId,
  rows,
  affiliationTerm,
  loading,
}: {
  orgId: string
  rows: OrgAffiliationStatusCount[] | undefined
  affiliationTerm: string
  loading: boolean
}) {
  const t = useTranslations('OrgDashboard')

  // Answered AND non-empty. A status the organisation defined but has never used
  // is noise in a legend that is already six items long.
  const answered = (rows ?? []).filter((r) => r.count != null && r.count > 0)
  const total = answered.reduce((sum, r) => sum + (r.count ?? 0), 0)

  if (loading) {
    return (
      <div className="border-t pt-4">
        <Skeleton className="h-14 w-full" />
      </div>
    )
  }

  // Nothing issued yet, or nothing readable. Either way there is no distribution
  // to draw, and an empty bar would imply there is one.
  if (total === 0) return null

  return (
    <section className="border-t pt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('statusTitle', { term: affiliationTerm })}
        </h2>
        <Link
          href={orgHref(orgId, 'affiliations') as Route}
          className="text-xs font-medium text-primary hover:underline"
        >
          {t('statusAll', { count: total })}
        </Link>
      </div>

      {/* ONE BAR, not one per status. The question is how the federation's
          affiliations are DISTRIBUTED, and a distribution is a whole divided
          up — six separate bars would invite comparing lengths that were never
          on the same scale. `min-w` keeps a one-record status visible instead of
          collapsing it to nothing at 1600px. */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {answered.map((r) => (
          <div
            key={r.def.id}
            className={`h-full min-w-[2px] ${statusFillClass(r.def.color)}`}
            style={{ width: `${((r.count ?? 0) / total) * 100}%` }}
            title={`${r.def.label}: ${r.count}`}
          />
        ))}
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {answered.map((r) => (
          <li key={r.def.id} className="flex items-baseline gap-1.5 text-xs">
            <span
              className={`inline-block h-2 w-2 shrink-0 translate-y-px rounded-full ${statusFillClass(r.def.color)}`}
            />
            <span className="font-medium tabular-nums">{r.count}</span>
            <span className="text-muted-foreground">{r.def.label}</span>
            <span className="text-muted-foreground/60 tabular-nums">
              {Math.round(((r.count ?? 0) / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
