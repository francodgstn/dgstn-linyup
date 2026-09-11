'use client'

/**
 * WHO ARE MY CONTACTS — one card, seven answers.
 *
 * This is the merge of `RosterCard` and `DemographicsCard`, and the two turned
 * out to be THE SAME COMPONENT twice: identical donut (innerRadius 48,
 * outerRadius 72, height 160), a byte-identical legend, a `Select` in the header
 * choosing between mutually-exclusive breakdowns of the same contact list. The
 * only thing roster had that demographics did not was a bar mode for the two
 * dimensions a contact can hold SEVERAL of (affiliation types, subscription
 * types) — which is a view, not a card.
 *
 * So there is one implementation now and it is here. `RosterCard` and
 * `DemographicsCard` still exist as thin wrappers, because `/contacts` renders
 * them side by side and this pass is not a contacts-page pass: they pass one
 * `group` each, and a single-group card renders a flat option list and its own
 * title exactly as before. The dashboard passes both groups and no title (its
 * section band carries that), which is the merged card Franco asked for.
 *
 * ONE GROUPED `Select`, NOT TABS. Seven options is too many for a tab strip at
 * the ~330px a third of the dashboard gives this card, and a two-tab strip over
 * a nested dropdown would be two controls where the merge exists to have one.
 * The grab-bag objection is answered instead by LABELLED GROUPS — the two old
 * card titles, reused verbatim as the group labels, so the dropdown still says
 * which question each option answers.
 */

import { useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Contact, EngagementBand, EngagementThresholds, RankingSystem } from '@linyup/shared'
import { ENGAGEMENT_BANDS, computeEngagementBand, isRosterContact, primaryRank, rankLevelKey, orderedLevels } from '@linyup/shared'

// ─── palettes ────────────────────────────────────────────────────────────────

// Acquisition stage is mutually exclusive (a contact is in exactly one), so it's
// shown as a donut — true "parts of a whole".
const STAGE_CONFIG = [
  { key: 'trial_booked', tKey: 'stage_trial_booked', color: '#10B981' },
  { key: 'trial_attended', tKey: 'stage_trial_attended', color: '#3B82F6' },
  { key: 'joined', tKey: 'stage_joined', color: '#6366F1' },
] as const

// Engagement band is also exclusive (each contact lands in exactly one), so it's
// a donut too. Colours mirror the contact-page meter.
const ENGAGEMENT_COLOR: Record<EngagementBand, string> = {
  active: '#10B981', // Regular
  low: '#F59E0B', // Slipping
  at_risk: '#EF4444', // At risk
  inactive: '#9CA3AF', // Stopped
}

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

type Datum = { name: string; value: number; color: string }

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Fallback display for an affiliation type_key (e.g. 'federation_licence'). */
function humanizeKey(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : k
}

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

// ─── presentation ────────────────────────────────────────────────────────────

function DonutChart({ data, total }: { data: Datum[]; total: number }) {
  if (!data.length || total === 0) return null
  return (
    <ResponsiveContainer width="100%" height={160}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={48}
          outerRadius={72}
          dataKey="value"
          paddingAngle={2}
          startAngle={90}
          endAngle={-270}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value, name) => [
            `${value} (${Math.round((Number(value) / total) * 100)}%)`,
            name,
          ]}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

function DonutLegend({ data, total }: { data: Datum[]; total: number }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      {data.map((item) => {
        const pct = total > 0 ? Math.round((item.value / total) * 100) : 0
        return (
          <div key={item.name} className="flex items-center gap-2">
            <div
              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ background: item.color }}
            />
            <span className="flex-1 truncate text-sm" title={item.name}>
              {item.name}
            </span>
            <span className="min-w-[60px] text-right text-sm text-muted-foreground">
              {item.value} ({pct}%)
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Multi-valued breakdown: each bar is an independent count of contacts holding
// that value, measured against the total contact count. Bars may sum to more
// than 100% (a contact can hold several) — that's why this is bars, not a pie.
function BarList({ data, total }: { data: Datum[]; total: number }) {
  return (
    <div className="flex max-h-[200px] flex-col gap-2.5 overflow-y-auto pt-1">
      {data.map((item) => {
        const pct = total > 0 ? Math.round((item.value / total) * 100) : 0
        return (
          <div key={item.name} className="space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate" title={item.name}>
                {item.name}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {item.value} ({pct}%)
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, background: item.color }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── the card ────────────────────────────────────────────────────────────────

export type ContactsOverviewGroup = 'roster' | 'demographics'

type RosterView = 'engagement' | 'acquisition' | 'affiliation' | 'subscription'
type DemographicsView = 'age' | 'gender' | 'level'
type View = RosterView | DemographicsView

const ROSTER_VIEWS: RosterView[] = ['engagement', 'acquisition', 'affiliation', 'subscription']
/** Multi-valued dimensions: a contact can hold several, so they render as bars. */
const MULTI_VIEWS: View[] = ['affiliation', 'subscription']

export function ContactsOverviewCard({
  contacts,
  thresholds,
  rankingSystems = [],
  groups = ['roster', 'demographics'],
  title,
  subtitle,
}: {
  contacts: Contact[]
  thresholds?: EngagementThresholds
  rankingSystems?: RankingSystem[]
  /** Which families of views the picker offers. Both ⇒ labelled groups. */
  groups?: ContactsOverviewGroup[]
  /** Omit when a section band carries the title instead. */
  title?: string
  subtitle?: string
}) {
  const t = useTranslations('Contacts')
  const tD = useTranslations('Dashboard')

  const showRoster = groups.includes('roster')
  const showDemographics = groups.includes('demographics')
  const hasRanking = rankingSystems.length > 0

  const [view, setView] = useState<View>(showRoster ? 'engagement' : 'age')

  // The ROSTER — people the studio looks after. Externals (partner-app
  // drop-ins, former members who still come now and then) are live but not
  // counted here; see `contactLifecycle` in shared.
  const active = contacts.filter(isRosterContact)
  const total = active.length

  // ── Engagement band (exclusive) — derived from attendance recency ──
  const engCounts: Record<EngagementBand, number> = { active: 0, low: 0, at_risk: 0, inactive: 0 }
  const now = Date.now()
  for (const c of active) {
    const refMs = tsToMs(c.last_session_at) ?? tsToMs(c.created_at)
    engCounts[computeEngagementBand(refMs, thresholds, now)]++
  }
  const engData: Datum[] = (ENGAGEMENT_BANDS as EngagementBand[])
    .map((b) => ({
      name: t(`engagement_${b}` as Parameters<typeof t>[0]),
      value: engCounts[b],
      color: ENGAGEMENT_COLOR[b],
    }))
    .filter((d) => d.value > 0)

  // ── Acquisition stage (exclusive) ──
  const acqData: Datum[] = STAGE_CONFIG.map((s) => ({
    name: t(s.tKey),
    value: active.filter((c) => c.acquisition_stage === s.key).length,
    color: s.color,
  })).filter((d) => d.value > 0)

  // ── Affiliation by type (multi) ──
  const affCounts = new Map<string, number>()
  let noAff = 0
  for (const c of active) {
    const types = Array.from(new Set(c.affiliation_summary?.types ?? []))
    if (types.length === 0) {
      noAff++
      continue
    }
    types.forEach((k) => affCounts.set(k, (affCounts.get(k) ?? 0) + 1))
  }
  const affData: Datum[] = [...affCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value], i) => ({
      name: humanizeKey(key),
      value,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }))
  if (noAff > 0) affData.push({ name: t('filterAffiliationNone'), value: noAff, color: NONE_COLOR })

  // ── Subscription by type (multi) — straight off the denormalised snapshots ──
  const subCounts = new Map<string, { name: string; count: number }>()
  let noSub = 0
  for (const c of active) {
    // Distinct subscription types this contact holds (a type counts once per contact).
    const distinct = new Map<string, string>() // typeId → name
    for (const s of c.active_subscriptions ?? []) {
      if (!distinct.has(s.subscription_type_id))
        distinct.set(s.subscription_type_id, s.subscription_type_name ?? '—')
    }
    if (distinct.size === 0) {
      noSub++
      continue
    }
    for (const [id, name] of distinct) {
      const cur = subCounts.get(id) ?? { name, count: 0 }
      cur.count++
      subCounts.set(id, cur)
    }
  }
  const subData: Datum[] = [...subCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map((e, i) => ({ name: e.name, value: e.count, color: SERIES_COLORS[i % SERIES_COLORS.length] }))
  if (noSub > 0) subData.push({ name: t('filterSubscriptionNone'), value: noSub, color: NONE_COLOR })

  // ── Age / gender / level (exclusive) ──
  const ageData: Datum[] = AGE_GROUPS.map((g) => ({
    name: tD(g.key),
    color: g.color,
    value: active.filter((c) => {
      const age = calcAge(c.birthdate as Parameters<typeof calcAge>[0])
      return age !== null && age >= g.min && age <= g.max
    }).length,
  })).filter((d) => d.value > 0)

  const genderData: Datum[] = GENDER_CONFIG.map((g) => ({
    name: t(g.tKey),
    color: g.color,
    value: active.filter((c) => c.gender === g.key).length,
  })).filter((d) => d.value > 0)

  const levelData: Datum[] = (() => {
    if (!hasRanking) return []
    const primarySystem = rankingSystems.find((s) => s.is_primary) ?? rankingSystems[0]
    const counts: Record<string, number> = {}
    let unranked = 0
    for (const c of active) {
      const result = primaryRank(c, rankingSystems)
      if (!result) {
        unranked++
        continue
      }
      counts[`${result.system.id}:${rankLevelKey(result.level)}`] =
        (counts[`${result.system.id}:${rankLevelKey(result.level)}`] ?? 0) + 1
    }
    const data = orderedLevels(primarySystem ?? { levels: [] })
      .map((l) => ({
        name: l.label,
        color: l.color ?? '#9CA3AF',
        value: counts[`${primarySystem.id}:${rankLevelKey(l)}`] ?? 0,
      }))
      .filter((d) => d.value > 0)
    if (unranked > 0) data.push({ name: t('rankUnranked'), color: '#E5E7EB', value: unranked })
    return data
  })()

  const isMulti = MULTI_VIEWS.includes(view)
  const barData = view === 'affiliation' ? affData : subData
  const donutData =
    view === 'engagement'
      ? engData
      : view === 'acquisition'
        ? acqData
        : view === 'age'
          ? ageData
          : view === 'gender'
            ? genderData
            : levelData

  // Roster's exclusive views are shares of the whole roster; the demographic
  // ones are shares of the contacts that ANSWERED (a missing birthdate is not a
  // zero). Each keeps the denominator its old card used.
  const donutTotal = ROSTER_VIEWS.includes(view as RosterView)
    ? total
    : donutData.reduce((s, d) => s + d.value, 0)

  const hasData = isMulti ? barData.length > 0 : donutData.length > 0

  const rosterItems = (
    <>
      <SelectItem value="engagement">{t('overviewViewEngagement')}</SelectItem>
      <SelectItem value="acquisition">{t('overviewViewType')}</SelectItem>
      <SelectItem value="affiliation">{t('overviewViewAffiliation')}</SelectItem>
      <SelectItem value="subscription">{t('overviewViewSubscription')}</SelectItem>
    </>
  )
  const demographicsItems = (
    <>
      <SelectItem value="age">{tD('demoViewAge')}</SelectItem>
      <SelectItem value="gender">{tD('demoViewGender')}</SelectItem>
      {hasRanking && <SelectItem value="level">{tD('demoViewLevel')}</SelectItem>}
    </>
  )
  const bothGroups = showRoster && showDemographics

  const emptyMessage = isMulti
    ? t('overviewEmpty')
    : view === 'age'
      ? tD('demoEmptyAge')
      : view === 'gender'
        ? tD('demoEmptyGender')
        : view === 'level'
          ? tD('demoEmptyLevel')
          : t('overviewEmpty')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            {title && <CardTitle>{title}</CardTitle>}
            <p className={`truncate text-xs text-muted-foreground ${title ? 'mt-0.5' : ''}`}>
              {subtitle ?? t('overviewActiveContacts', { count: total })}
            </p>
          </div>
          <Select
            value={view}
            onValueChange={(v) => {
              if (v) setView(v as View)
            }}
          >
            <SelectTrigger size="sm" className="w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {bothGroups ? (
                <>
                  <SelectGroup>
                    <SelectLabel>{t('statsTitle')}</SelectLabel>
                    {rosterItems}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>{tD('demoTitle')}</SelectLabel>
                    {demographicsItems}
                  </SelectGroup>
                </>
              ) : showRoster ? (
                rosterItems
              ) : (
                demographicsItems
              )}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        {total === 0 || !hasData ? (
          <p className="py-4 text-sm text-muted-foreground">{emptyMessage}</p>
        ) : isMulti ? (
          <>
            <BarList data={barData} total={total} />
            <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
              {t('overviewOverlapNote')}
            </p>
          </>
        ) : (
          <>
            <DonutChart key={view} data={donutData} total={donutTotal} />
            <DonutLegend data={donutData} total={donutTotal} />
          </>
        )}
      </CardContent>
    </Card>
  )
}
