'use client'

/**
 * THE CONTACTS SNAPSHOT — a chart on the left, its legend on the right, and no
 * card around either.
 *
 * ── WHY IT IS BACK ───────────────────────────────────────────────────────────
 *
 * This page cut the roster and demographics cards on the argument that
 * composition analysis belongs in `/contacts`. Franco has seen the page without
 * them and decided otherwise (2026-08-18). Recording that honestly: the
 * argument lost, and this is not a grudging minimum — a small unframed chart
 * with its legend beside it is a genuinely different object from the card that
 * was cut, and the differences are the point:
 *
 *  - **Unframed.** The card is gone, not shrunk. Figures and charts on the
 *    background are this page's reference material; only work is framed.
 *  - **Side by side.** The card stacked a 160px donut over its legend, which
 *    made a tall block out of a small fact. Chart left, legend right halves the
 *    height and lets the legend's rows be read as a list rather than a caption.
 *  - **The total in the hole.** A hole in the ring is the one place a donut can
 *    state its own denominator, which the legend's percentages leave implicit.
 *
 * ── ONE SHAPE, AND WHAT IT COST TO GET THERE ────────────────────────────────
 *
 * All seven of the incumbent card's views are here (Franco, 2026-08-18: "in the
 * chart, include all visualizations like for the old"), and since 2026-09-11
 * every one of them is a RING (Franco: "donut for all dimensions in contact
 * snapshot"). Getting there was not a styling decision — it needed a change
 * to what the multi-hold views COUNT.
 *
 *  - **Exclusive** dimensions — engagement, funnel stage, age, gender, level —
 *    partition the roster already. Every contact lands in exactly one slice and
 *    the parts sum to the whole.
 *  - **Multi-hold** dimensions — affiliation TYPES and subscription TYPES — did
 *    not. One contact can hold three affiliations, so counting holders per type
 *    sums PAST 100% and a ring of those parts states a false denominator. That
 *    is why they used to be bars, and the objection was correct.
 *
 * `partitionByHeld` answers that objection rather than overriding it: a contact
 * with ONE value lands on that value, a contact with SEVERAL lands in one "more
 * than one" slice, and a contact with none lands in "none". Every contact is in
 * exactly one slice again, so the ring's denominator is true by construction.
 *
 * **The cost, stated plainly:** a type's slice is now the contacts who hold ONLY
 * it, not everyone who holds it. A studio where multi-holding is common reads a
 * big "more than one" slice and small per-type ones — a true picture of the
 * roster, but NOT the per-type holder count, and nothing on this block shows
 * that any more. If somebody needs holders-per-type back it belongs in
 * `/contacts`, where a filter can show the actual people, not as a second shape
 * here.
 *
 * ── THE FIXED HEIGHT IS LOAD-BEARING ─────────────────────────────────────────
 *
 * `CHART_AREA` is a hard height every view lives inside, and it is not
 * cosmetic. The quote at the foot of this column ends ~21px above a 720px fold
 * (measured in a browser, not computed). If switching views changed this
 * block's height, picking "subscription types" would push the sign-off off the
 * first screen. So: the donut is centred in the box, and a legend longer than
 * the box scrolls inside it rather than growing it.
 *
 * If a future view genuinely cannot fit, take the space from the QUEUE, never
 * from the quote — see the rule beside the height in the page source. The quote
 * has lost that argument twice; the queue shows 6 of 8 rows and can spare one.
 *
 * Band, stage and gender NAMES come from the `Contacts` namespace — the same
 * keys `/contacts` and the incumbent's card read, because they are the
 * vocabulary of the CONTACT RECORD rather than dashboard copy. Everything that
 * is dashboard copy — the view labels, their groups, the age bands (which the
 * incumbent keeps in its own `Dashboard` namespace) — is this page's own, and
 * deliberately a COPY of the incumbent's strings rather than a reference to its
 * keys: message keys here are untyped strings and that card is a separate live
 * surface, so a rename there would break this page silently and at runtime.
 */

import { useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { useTranslations } from 'next-intl'
import type { Contact, EngagementBand, EngagementThresholds, RankingSystem } from '@linyup/shared'
import { ENGAGEMENT_BANDS, computeEngagementBand, isRosterContact, primaryRank } from '@linyup/shared'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'

type Datum = { name: string; value: number; color: string }

/** Already a partition of the roster: one contact, one slice. */
type ExclusiveView = 'engagement' | 'acquisition' | 'age' | 'gender' | 'level'
/** A contact can hold several — made into a partition by `partitionByHeld`. */
type MultiView = 'affiliation' | 'subscription'
type View = ExclusiveView | MultiView

/** The one height both shapes live inside. See the header — this is not cosmetic. */
const CHART_AREA = 'h-[150px]'

/** Mirrors the contact page's engagement meter. */
const ENGAGEMENT_COLOR: Record<EngagementBand, string> = {
  active: '#10B981',
  low: '#F59E0B',
  at_risk: '#EF4444',
  inactive: '#9CA3AF',
}

const STAGE_CONFIG = [
  { key: 'trial_booked', tKey: 'stage_trial_booked', color: '#10B981' },
  { key: 'trial_attended', tKey: 'stage_trial_attended', color: '#3B82F6' },
  { key: 'joined', tKey: 'stage_joined', color: '#6366F1' },
] as const

// Age bands, gender and the series palette are the incumbent card's values,
// copied rather than imported: that card is a live surface on another lane and
// this page must not break when it is refactored.
const AGE_GROUPS = [
  { key: 'demoAgeKids', min: 5, max: 9, color: '#4ADE80' },
  { key: 'demoAgeYouth', min: 10, max: 14, color: '#60A5FA' },
  { key: 'demoAgeTeens', min: 15, max: 17, color: '#A78BFA' },
  { key: 'demoAgeAdults', min: 18, max: 39, color: '#F59E0B' },
  { key: 'demoAgeMasters', min: 40, max: 999, color: '#F97316' },
] as const

const GENDER_CONFIG = [
  { key: 'F', tKey: 'gender_F', color: '#EC4899' },
  { key: 'M', tKey: 'gender_M', color: '#3B82F6' },
  { key: 'other', tKey: 'gender_other', color: '#9CA3AF' },
] as const

const SERIES_COLORS = [
  '#6366F1',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#0EA5E9',
  '#EF4444',
  '#84CC16',
  '#14B8A6',
]
const NONE_COLOR = '#D1D5DB'
/** Deliberately a NEUTRAL, like `NONE_COLOR`: "more than one" is an answer about
 *  the shape of the roster, not one of the types being compared, and a series
 *  colour would put it in the running with them. */
const SEVERAL_COLOR = '#94A3B8'

function tsToMs(ts: unknown): number | null {
  if (!ts) return null
  if (typeof (ts as { toDate?: unknown }).toDate === 'function')
    return (ts as { toDate(): Date }).toDate().getTime()
  if (typeof (ts as { seconds?: unknown }).seconds === 'number')
    return (ts as { seconds: number }).seconds * 1000
  return null
}

function calcAge(birthdate: { toDate(): Date } | string | null | undefined): number | null {
  if (!birthdate) return null
  const d = typeof birthdate === 'string' ? new Date(birthdate) : birthdate.toDate()
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000))
}

/** Fallback display for an affiliation type_key (e.g. 'federation_licence'). */
function humanizeKey(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : k
}

/**
 * Turn a MULTI-HOLD dimension into a partition, so a ring can state a true
 * denominator for it. See the header for what this costs.
 *
 * `held` returns the DISTINCT values one contact holds; the contact then lands
 * in exactly one slice: that value if there is one of them, "more than one" if
 * there are several, "none" if there are none.
 */
function partitionByHeld(
  live: Contact[],
  held: (c: Contact) => { id: string; name: string }[],
  labels: { several: string; none: string },
): Datum[] {
  const only = new Map<string, { name: string; count: number }>()
  let several = 0
  let none = 0
  for (const c of live) {
    const values = held(c)
    if (values.length === 0) {
      none++
    } else if (values.length > 1) {
      several++
    } else {
      const cur = only.get(values[0].id) ?? { name: values[0].name, count: 0 }
      cur.count++
      only.set(values[0].id, cur)
    }
  }
  const data: Datum[] = [...only.values()]
    .sort((a, b) => b.count - a.count)
    .map((e, i) => ({
      name: e.name,
      value: e.count,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }))
  // Both tails go LAST and in this order, so the two neutral slices sit
  // together at the end of every legend rather than sorted among the types.
  if (several > 0) data.push({ name: labels.several, value: several, color: SEVERAL_COLOR })
  if (none > 0) data.push({ name: labels.none, value: none, color: NONE_COLOR })
  return data
}

export function RosterDonut({
  contacts,
  thresholds,
  rankingSystems,
  loading,
}: {
  contacts: Contact[] | undefined
  thresholds?: EngagementThresholds
  /** Absent or empty hides the Level view — most studios award no ranks (UX-39). */
  rankingSystems?: RankingSystem[]
  loading: boolean
}) {
  const t = useTranslations('NewDashboard')
  const tc = useTranslations('Contacts')
  const [view, setView] = useState<View>('engagement')

  const live = (contacts ?? []).filter(isRosterContact)
  const total = live.length
  const systems = rankingSystems ?? []
  const hasRanking = systems.length > 0

  let data: Datum[] = []
  switch (view) {
    case 'engagement': {
      const counts: Record<EngagementBand, number> = { active: 0, low: 0, at_risk: 0, inactive: 0 }
      const now = Date.now()
      for (const c of live) {
        counts[
          computeEngagementBand(tsToMs(c.last_session_at) ?? tsToMs(c.created_at), thresholds, now)
        ]++
      }
      data = (ENGAGEMENT_BANDS as EngagementBand[])
        .map((b) => ({
          name: tc(`engagement_${b}` as 'engagement_active'),
          value: counts[b],
          color: ENGAGEMENT_COLOR[b],
        }))
        .filter((d) => d.value > 0)
      break
    }
    case 'acquisition':
      data = STAGE_CONFIG.map((s) => ({
        name: tc(s.tKey),
        value: live.filter((c) => c.acquisition_stage === s.key).length,
        color: s.color,
      })).filter((d) => d.value > 0)
      break
    case 'age':
      data = AGE_GROUPS.map((g) => ({
        // Age band labels are this page's own copies (the incumbent keeps its
        // set in the `Dashboard` namespace) — see the header on why not shared.
        name: t(g.key),
        color: g.color,
        value: live.filter((c) => {
          const age = calcAge(c.birthdate as Parameters<typeof calcAge>[0])
          return age !== null && age >= g.min && age <= g.max
        }).length,
      })).filter((d) => d.value > 0)
      break
    case 'gender':
      data = GENDER_CONFIG.map((g) => ({
        name: tc(g.tKey),
        color: g.color,
        value: live.filter((c) => c.gender === g.key).length,
      })).filter((d) => d.value > 0)
      break
    case 'level': {
      if (!hasRanking) break
      const primary = systems.find((s) => s.is_primary) ?? systems[0]
      const counts: Record<string, number> = {}
      let unranked = 0
      for (const c of live) {
        const result = primaryRank(c, systems)
        if (!result) {
          unranked++
          continue
        }
        const k = `${result.system.id}:${result.level.value}`
        counts[k] = (counts[k] ?? 0) + 1
      }
      data = (primary?.levels ?? [])
        .map((l) => ({
          name: l.label,
          color: l.color ?? '#9CA3AF',
          value: counts[`${primary.id}:${l.value}`] ?? 0,
        }))
        .filter((d) => d.value > 0)
      if (unranked > 0) data.push({ name: tc('rankUnranked'), color: '#E5E7EB', value: unranked })
      break
    }
    case 'affiliation':
      data = partitionByHeld(
        live,
        (c) =>
          Array.from(new Set(c.affiliation_summary?.types ?? [])).map((k) => ({
            id: k,
            name: humanizeKey(k),
          })),
        { several: t('rosterSeveral'), none: tc('filterAffiliationNone') },
      )
      break
    case 'subscription':
      data = partitionByHeld(
        live,
        (c) => {
          // A TYPE counts once per contact, however many subscriptions of it
          // they hold — two Essential plans is one type, not "more than one".
          const distinct = new Map<string, string>()
          for (const sub of c.active_subscriptions ?? []) {
            if (!distinct.has(sub.subscription_type_id))
              distinct.set(sub.subscription_type_id, sub.subscription_type_name ?? '—')
          }
          return [...distinct].map(([id, name]) => ({ id, name }))
        },
        { several: t('rosterSeveral'), none: tc('filterSubscriptionNone') },
      )
      break
  }

  const plotted = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <div className="flex h-full flex-col">
      {/* The block's own label + its one control, on one line — the same
          grammar the panels' headers use, without the frame they sit in. The
          Select is the first interactive thing in this otherwise-reference
          column, so it sits ON the chart's header rather than loose above it. */}
      <div className="mb-3 flex items-center gap-3">
        <h2 className="font-heading truncate text-sm font-bold tracking-tight text-heading">
          {t('rosterTitle')}
        </h2>
        <div className="flex-1" />
        <Select value={view} onValueChange={(v) => setView(v as View)}>
          <SelectTrigger className="h-7 w-[148px] shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Grouped the way the incumbent groups them: who they are to the
                studio, then who they are as people. Seven flat options read as
                a grab-bag. */}
            <SelectGroup>
              <SelectLabel>{t('rosterGroupRoster')}</SelectLabel>
              <SelectItem value="engagement">{t('rosterViewEngagement')}</SelectItem>
              <SelectItem value="acquisition">{t('rosterViewAcquisition')}</SelectItem>
              <SelectItem value="affiliation">{t('rosterViewAffiliation')}</SelectItem>
              <SelectItem value="subscription">{t('rosterViewSubscription')}</SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>{t('rosterGroupPeople')}</SelectLabel>
              <SelectItem value="age">{t('rosterViewAge')}</SelectItem>
              <SelectItem value="gender">{t('rosterViewGender')}</SelectItem>
              {hasRanking && <SelectItem value="level">{t('rosterViewLevel')}</SelectItem>}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {/* ONE fixed-height box for every view — see the header. */}
      <div className={CHART_AREA}>
        {loading ? (
          <div className="flex h-full items-center gap-5">
            <Skeleton className="h-[150px] w-[150px] shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-3.5 w-full" />
              ))}
            </div>
          </div>
        ) : plotted === 0 ? (
          <p className="pt-6 text-sm text-muted-foreground">{t('rosterEmpty')}</p>
        ) : (
          /* Chart left, legend right. `items-center` so a two-row legend still
             reads as belonging to the ring rather than floating. */
          <div className="flex h-full items-center gap-5">
            <div className="relative h-[150px] w-[150px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data}
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={70}
                    dataKey="value"
                    paddingAngle={2}
                    startAngle={90}
                    endAngle={-270}
                  >
                    {data.map((d) => (
                      <Cell key={d.name} fill={d.color} stroke="none" />
                    ))}
                  </Pie>
                  {/* `wrapperStyle` is the fix for a real defect, not polish:
                      the centre figure below is an absolutely-positioned
                      sibling that comes LATER in the DOM, so with both at
                      `z-index: auto` it painted OVER the tooltip and a slice
                      hovered near the middle showed its label behind the big
                      number. Giving the tooltip a stacking order beats the
                      overlay without reordering anything. */}
                  <Tooltip
                    wrapperStyle={{ zIndex: 10 }}
                    formatter={(value, name) => [
                      `${value} (${Math.round((Number(value) / plotted) * 100)}%)`,
                      name,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* The denominator, in the one place a donut has for it. */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-black leading-none tabular-nums">{total}</span>
                <span className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('rosterTotal')}
                </span>
              </div>
            </div>

            <ul className="min-w-0 flex-1 space-y-1.5 overflow-y-auto py-0.5">
              {data.map((d) => (
                <li key={d.name} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: d.color }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={d.name}>
                    {d.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {d.value} ({Math.round((d.value / plotted) * 100)}%)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
