'use client'

/**
 * THE ROSTER — and on this page it is the SUBJECT, not a list.
 *
 * A studio's dashboard has two framed panels of equal weight (the day, and the
 * queue), because a studio's morning genuinely has two subjects. A federation
 * has one: the studios in it. So exactly ONE thing on this page wears the accent
 * frame, and this is it — the hierarchy comes from there being a single primary
 * object, which is a different shape from the studio dashboard's pair rather
 * than a copy of it with different words.
 *
 * `Panel` is imported from the dashboard shell rather than restated. It is the
 * one owner of that frame; a second copy would be free to drift, which is
 * exactly what happened to the figure shell before `components/dashboard/
 * Figure.tsx` was extracted.
 *
 * ── ORDERED BY SIZE, NOT ALPHABETICALLY ─────────────────────────────────────
 *
 * The Studios page is the alphabetical one — it is a directory you look a studio
 * up in. This is the opposite question: which studios ARE the federation. A
 * federation whose largest studio holds 60% of its people has a concentration
 * risk that an A–Z list actively hides. Studios whose count could not be read
 * sink to the bottom rather than sorting as zero.
 *
 * ── THE BAR IS COVERAGE, AND IT IS THE POINT OF THE ROW ─────────────────────
 *
 * Not "how big" — the number already says that — but what share of that studio's
 * people hold the organisation's own affiliation. That is the single fact a
 * federation is FOR, it varies enormously between member studios, and it exists
 * nowhere else in the product. A studio at 12% is the row an organiser wants to
 * see without running a report.
 */

import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Building2 } from 'lucide-react'
import { Panel, PanelBody, PanelHeader } from '@/components/dashboard-preview/Panel'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { orgHref } from '@/lib/org-nav'
import type { OrgStudioCounts, OrgStudioRow } from './data'

export interface StudioLine extends OrgStudioRow {
  counts: OrgStudioCounts | undefined
}

/** Size first, unknown last, then by name so the order is stable between renders. */
export function rankStudios(lines: StudioLine[]): StudioLine[] {
  return [...lines].sort((a, b) => {
    const ap = a.counts?.people
    const bp = b.counts?.people
    if (ap == null && bp == null) return (a.name ?? '').localeCompare(b.name ?? '')
    if (ap == null) return 1
    if (bp == null) return -1
    if (ap !== bp) return bp - ap
    return (a.name ?? '').localeCompare(b.name ?? '')
  })
}

export function StudiosPanel({
  orgId,
  lines,
  loading,
  affiliationTerm,
  countsWithheld,
}: {
  orgId: string
  lines: StudioLine[]
  loading: boolean
  affiliationTerm: string
  /** An `org_viewer` never asked for the counts — say so once, in the header,
   *  instead of printing a dash on every row with no explanation. */
  countsWithheld: boolean
}) {
  const t = useTranslations('OrgDashboard')
  const ranked = rankStudios(lines)

  return (
    <Panel>
      <PanelHeader
        title={t('studiosTitle')}
        meta={
          countsWithheld
            ? t('studiosMetaWithheld')
            : // The tenant's OWN noun, verbatim. Lower-casing it to fit the
              // sentence looked right in English and mangles every other locale
              // in the product — German capitalises nouns, so a studio that
              // renamed the concept "Lizenz" would read "lizenz coverage".
              t('studiosMeta', { term: affiliationTerm })
        }
        action={
          <Link
            href={orgHref(orgId, 'teams') as Route}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            {t('studiosAll')}
          </Link>
        }
      />
      {/* `scroll={false}` — THE PAGE SCROLLS, NOT THE PANEL, and for an
          organisation that is the right way round: the roster is what this page
          is about, and a federation of sixteen studios reading four at a time
          through a 320px window is a summary of a summary. It also removes the
          only place the two dimensions could disagree — the panel is exactly as
          tall as the federation is long.

          A PROP rather than a class: passing `max-h-none` through `className`
          does not survive `twMerge` against the shell's own arbitrary value, and
          the first attempt at this shipped a cap that silently never applied.
          See `PanelBody`. */}
      <PanelBody scroll={false}>
        {loading ? (
          <div className="space-y-2 p-1">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : ranked.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <Building2 className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm font-medium">{t('studiosEmptyTitle')}</p>
            <p className="max-w-xs text-xs text-muted-foreground">{t('studiosEmptyBody')}</p>
          </div>
        ) : (
          <ul className="divide-y">
            {ranked.map((s) => (
              <StudioRow key={s.teamId} studio={s} affiliationTerm={affiliationTerm} />
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  )
}

function StudioRow({
  studio,
  affiliationTerm,
}: {
  studio: StudioLine
  affiliationTerm: string
}) {
  const t = useTranslations('OrgDashboard')
  const people = studio.counts?.people ?? null
  const affiliated = studio.counts?.affiliated ?? null
  const coverage =
    people != null && affiliated != null && people > 0
      ? Math.min(100, Math.round((affiliated / people) * 100))
      : null

  return (
    <li className="flex items-center gap-3 px-1 py-2 sm:gap-6">
      {/* THE NAME NO LONGER OWNS THE WHOLE ROW. At 640px the name and its bar
          shared one column because there was no room for two; at full width
          that left ~400px of nothing between the name and its figures. The name
          takes what it needs, the bar becomes its own column and gets the slack,
          and the two figures stay pinned right where a reader scans them down
          the page. */}
      <div className="min-w-0 flex-1 sm:max-w-[22rem] sm:flex-none">
        <div className="flex items-center gap-2">
          {/* A studio with no public profile yet has no readable name — say that,
              rather than printing a document id at somebody who has never seen
              one. The id is still what the Studios page shows, and this page is
              not the place to look one up. */}
          <span
            className={`truncate text-sm font-medium ${studio.name ? '' : 'italic text-muted-foreground'}`}
          >
            {studio.name ?? t('studioUnnamed')}
          </span>
          {studio.status === 'invited' && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {t('studioInvited')}
            </Badge>
          )}
        </div>
        {/* The same bar, under the name, for the widths where it has no column
            of its own. */}
        {coverage != null && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted sm:hidden">
            <div className="h-full rounded-full bg-primary" style={{ width: `${coverage}%` }} />
          </div>
        )}
      </div>

      {/* The bar carries no number of its own — the two figures to the right
          are the number. It is a shape, read at a glance down the column, and
          at full width it is finally long enough for the difference between 34%
          and 62% to be visible rather than inferred. Hidden below `sm`, where
          there is no width to spare and the percentage beside the count says
          the same thing. */}
      <div className="hidden min-w-0 flex-1 sm:block">
        {coverage != null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${coverage}%` }} />
          </div>
        )}
      </div>

      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{people ?? '—'}</div>
        <div className="text-[11px] text-muted-foreground">{t('studioPeople')}</div>
      </div>
      <div className="w-20 shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums text-primary">
          {affiliated ?? '—'}
          {coverage != null && (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              {t('studioCoverage', { percent: coverage })}
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{affiliationTerm}</div>
      </div>
    </li>
  )
}
