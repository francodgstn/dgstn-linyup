'use client'

/**
 * HOW BIG IS THE FEDERATION — four numbers, full width, on the background.
 *
 * ── WHY THIS IS NOT THE STUDIO DASHBOARD'S FIGURE BLOCK ─────────────────────
 *
 * A studio's figures sit in a 2×2 rail in the right-hand column, BESIDE the
 * day, because a studio's dashboard is answering "what is happening now" and the
 * figures are the margin next to it. An organisation has no "now": no agenda, no
 * queue of bookings, nothing that changes between breakfast and lunch. What it
 * has is SCALE and COMPOSITION, so the numbers stop being the margin and become
 * the first thing on the page — one row, across the full width, above the
 * roster they are the summary of.
 *
 * They are unframed, per `components/dashboard/Figure.tsx`: a card means a
 * bounded thing you can scroll, page or click into, and a bare number is none of
 * those. `Figure` / `FigureNumber` / `FigureRail` are imported from there rather
 * than restated — that module exists precisely because the shell was once
 * written twice and the two copies drifted.
 *
 * `FigureRail` is a two-column instrument panel by construction (its dividers are
 * `nth-child(odd|even)`), so four figures across a full-width row are TWO rails
 * side by side, not one four-up grid. That keeps the hairline between a pair
 * meaning "same instrument" instead of becoming a rule to nowhere.
 */

import { useTranslations } from 'next-intl'
import { Building2, CalendarRange, IdCard, Users } from 'lucide-react'
import { Figure, FigureNumber, FigureNote, FigureRail } from '@/components/dashboard/Figure'
import { orgHref } from '@/lib/org-nav'

export interface ScaleStripProps {
  orgId: string
  /** Studios with `status: 'active'`. */
  activeStudios: number
  /** Studios invited that have not accepted — surfaced as the note, not as a
   *  second figure: it is a queue item, and the queue is its own panel. */
  invitedStudios: number
  /** Live contacts across every member studio. `null` = not asked or denied. */
  people: number | null
  /** People holding an affiliation issued by THIS organisation. */
  affiliated: number | null
  /** Upcoming org-scope events. */
  events: number | null
  /** The organisation's own word for "affiliation". */
  affiliationTerm: string
  loading: boolean
  /** True for an `org_viewer`, whose role cannot read contacts at all. */
  peopleWithheld: boolean
}

export function ScaleStrip({
  orgId,
  activeStudios,
  invitedStudios,
  people,
  affiliated,
  events,
  affiliationTerm,
  loading,
  peopleWithheld,
}: ScaleStripProps) {
  const t = useTranslations('OrgDashboard')

  // COVERAGE IS THE ONE DERIVED NUMBER ON THIS PAGE, and it is the federation's
  // own KPI: of the people its studios look after, how many hold its licence,
  // badge or membership. Withheld when either half is unknown — a percentage of
  // a partial total reads as precision that is not there.
  const coverage =
    people != null && affiliated != null && people > 0
      ? Math.round((affiliated / people) * 100)
      : null

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-2 lg:gap-x-12">
      <FigureRail>
        <Figure title={t('figureStudios')} icon={Building2} href={orgHref(orgId, 'teams')}>
          <FigureNumber
            value={activeStudios}
            subtitle={t('figureStudiosSub')}
            loading={loading}
            note={
              invitedStudios > 0 ? (
                <FigureNote>{t('figureStudiosInvited', { count: invitedStudios })}</FigureNote>
              ) : undefined
            }
          />
        </Figure>

        <Figure title={t('figurePeople')} icon={Users}>
          <FigureNumber
            value={people ?? '—'}
            subtitle={t('figurePeopleSub')}
            loading={loading}
            note={
              peopleWithheld ? <FigureNote>{t('figureWithheld')}</FigureNote> : undefined
            }
          />
        </Figure>
      </FigureRail>

      <FigureRail>
        <Figure title={affiliationTerm} icon={IdCard} href={orgHref(orgId, 'affiliations')}>
          <FigureNumber
            value={affiliated ?? '—'}
            subtitle={
              coverage != null ? t('figureAffiliatedSub', { percent: coverage }) : t('figureAffiliatedSubBare')
            }
            loading={loading}
          />
        </Figure>

        <Figure title={t('figureEvents')} icon={CalendarRange} href={orgHref(orgId, 'events')}>
          <FigureNumber
            value={events ?? '—'}
            subtitle={t('figureEventsSub')}
            loading={loading}
          />
        </Figure>
      </FigureRail>
    </div>
  )
}
