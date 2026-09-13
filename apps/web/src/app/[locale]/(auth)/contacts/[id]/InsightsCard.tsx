'use client'

/**
 * THE RIGHT-HAND CARD of the contact header: what the studio reads about the
 * person, beside the profile card that says who they are.
 *
 * Top, the AI summary — an experiment (`contact-summary`). While the switch is
 * off the block is ABSENT, not empty, so a studio that never opted in sees a
 * card of numbers and nothing that hints at a model. Under it: four figures
 * in a row — the three counters and the engagement band as a coloured dot
 * with its name (it used to be a vertical meter beside the strip, a fill
 * level for something that has four words and no level) — then the
 * attendance chart on the card's bottom edge: since the relationship began,
 * up to a year, with the plan periods drawn behind it as bands (since 2026-09-13; they were a ribbon on
 * the Plans & Payments tab). Nothing here is new data; the summary is the one
 * write, and it goes through `generateContactSummary`.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  ReferenceArea,
} from 'recharts'
import { Sparkles, RefreshCw, Trophy, Flame, Star, Activity } from 'lucide-react'
import { toast } from 'sonner'
import { computeEngagementBand, isoWeekKey } from '@linyup/shared'
import type { Contact, EngagementThresholds } from '@linyup/shared'
import { functions } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { useExperimentalFeatures } from '@/hooks/useExperimentalFeatures'
import { useSubscriptionHistory } from '@/hooks/useSubscriptionHistory'
import { isoWeekLabel, useContactWeeklyReports } from './AttendanceTrendCard'
import { ENGAGEMENT_BAR, ENGAGEMENT_TEXT } from './engagement'

function toDate(ts: unknown): Date | undefined {
  if (!ts) return undefined
  if (ts instanceof Date) return ts
  const t = ts as { toDate?: () => Date }
  return typeof t.toDate === 'function' ? t.toDate() : undefined
}

export function InsightsCard({
  contact,
  thresholds,
  className = '',
}: {
  contact: Contact
  thresholds?: EngagementThresholds
  className?: string
}) {
  const { isEnabled } = useExperimentalFeatures()
  const summaryOn = isEnabled('contact-summary')
  return (
    <div
      className={`flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card ${className}`}
    >
      {/* WHERE SPARE HEIGHT GOES. The card is stretched to the profile card's
          height, so there is usually room to spare. The summary block takes
          it (flex-1): the counters follow the summary, the chart sits a fixed
          32px under the counters at a fixed 128px, and the bottoms of the two
          cards still meet. With the experiment off there is no summary block
          to grow, so the strip docks to the bottom edge instead. */}
      {summaryOn && (
        // Keyed so a summary just generated for one contact never shows over
        // the next contact this component happens to be re-rendered for.
        <SummaryBlock key={contact.id} contact={contact} />
      )}
      <div className={`flex min-w-0 flex-col ${summaryOn ? '' : 'mt-auto'}`}>
        <StatsRow contact={contact} thresholds={thresholds} />
        <Sparkline contact={contact} />
      </div>
    </div>
  )
}

// ─── AI summary ───────────────────────────────────────────────────────────────

type SummaryResult = { text: string; language: string; model: string }

function SummaryBlock({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  // What the callable just returned, shown until the contact query refetches
  // and the stored record catches up.
  const [fresh, setFresh] = useState<string | null>(null)

  const stored = contact.ai_summary
  const text = fresh ?? stored?.text ?? null
  const updated = fresh ? new Date() : toDate(stored?.generated_at)
  // An archived or deleted contact keeps the summary it has; nobody asks for a
  // new one about someone who left.
  const closed = !!contact.archived_at || !!contact.deleted_at

  async function generate() {
    if (busy) return
    setBusy(true)
    try {
      const call = httpsCallable<{ teamId: string; contactId: string }, SummaryResult>(
        functions,
        'generateContactSummary'
      )
      const res = await call({ teamId: contact.teamId, contactId: contact.id })
      setFresh(res.data.text)
      toast.success(t('summaryGenerated'))
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
    } catch (err) {
      console.error('[contact-summary] failed:', err)
      toast.error(t('summaryFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    // A floor of 8rem (the empty state was cramped at its natural ~97px), and
    // flex-1 so any height the card has to spare lands here rather than in
    // the gap above the chart. A real four-to-six-sentence summary grows past
    // the floor on its own.
    <div className="min-h-32 flex-1 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          {t('summaryTitle')}
        </h2>
        {!closed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={generate}
            disabled={busy}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            {text ? t('summaryRegenerate') : t('summaryGenerate')}
          </Button>
        )}
      </div>
      {text ? (
        <>
          <p className="mt-2 text-sm leading-relaxed">{text}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {updated
              ? `${t('summaryUpdatedOn', {
                  date: updated.toLocaleDateString(undefined, { dateStyle: 'medium' }),
                })} · `
              : ''}
            {t('summaryDisclaimer')}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{t('summaryEmpty')}</p>
      )}
    </div>
  )
}

// ─── Counters + sparkline ─────────────────────────────────────────────────────

function StatsRow({
  contact,
  thresholds,
}: {
  contact: Contact
  thresholds?: EngagementThresholds
}) {
  const t = useTranslations('Contacts')
  return (
    <div className="grid grid-cols-4 divide-x">
      {/* The same icons and colours the Gamification tab gives these figures,
          so the two readings of one number look like one number. */}
      <div className="px-4 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">{contact.total_sessions ?? 0}</p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-[10px] leading-tight text-muted-foreground">
          <Trophy className="h-3 w-3 text-primary" />
          {t('statTotalSessions')}
        </p>
      </div>
      <div className="px-4 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">
          {contact.current_streak ?? 0}
          <span className="text-sm font-normal">w</span>
        </p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-[10px] leading-tight text-muted-foreground">
          <Flame className="h-3 w-3 text-orange-500" />
          {t('statStreak')}
        </p>
      </div>
      <div className="px-4 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">{contact.current_month_score ?? 0}</p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-[10px] leading-tight text-muted-foreground">
          <Star className="h-3 w-3 text-yellow-500" />
          {t('statMonthScore')}
        </p>
      </div>
      <EngagementCell contact={contact} thresholds={thresholds} />
    </div>
  )
}

const tooltipStyle = {
  fontSize: 11,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid hsl(var(--border))',
  backgroundColor: 'hsl(var(--card) / 0.85)',
  backdropFilter: 'blur(4px)',
  color: 'hsl(var(--card-foreground))',
}

/** The most of the relationship the header chart shows: a year, so a plan
 *  change — and whether attendance moved with it — is on screen. */
const CHART_WEEKS = 52
/** The fewest weeks it ever shows, so a brand-new contact still gets a readable
 *  line rather than two points stretched across the card. */
const MIN_CHART_WEEKS = 12
/** The fewest weeks a plan band needs before it carries the plan's name. */
const BAND_LABEL_MIN_WEEKS = 8
/** The subscription colour the old relationship ribbon gave its plan lane. */
const PLAN_BAND_COLOR = '#3b82f6'

interface PlanBand {
  key: string
  name: string
  /** The period's own weeks, unclamped — for "which plan covered this week". */
  from: string
  to: string
  /** Clamped to the chart window — for drawing. */
  x1: string
  x2: string
  weeks: number
}

/** Plan periods from the subscription history as week ranges on the chart's
 *  window. An open period runs to this week. ISO week keys are zero-padded
 *  (`2026-W05`), so they order correctly as strings. */
function planBands(
  history: readonly {
    id: string
    subscription_type_name?: string
    start_date?: unknown
    end_date?: unknown
  }[],
  weekKeys: readonly string[]
): PlanBand[] {
  if (!weekKeys.length) return []
  const first = weekKeys[0]
  const last = weekKeys[weekKeys.length - 1]
  return history.flatMap((h) => {
    const start = toDate(h.start_date)
    if (!start) return []
    const from = isoWeekKey(start)
    const to = isoWeekKey(toDate(h.end_date) ?? new Date())
    if (to < first || from > last) return []
    const x1 = from < first ? first : from
    const x2 = to > last ? last : to
    return [
      {
        key: h.id,
        name: h.subscription_type_name ?? '',
        from,
        to,
        x1,
        x2,
        weeks: weekKeys.indexOf(x2) - weekKeys.indexOf(x1) + 1,
      },
    ]
  })
}

/**
 * Where the chart starts: the earliest week anything happened — they joined, a
 * plan started, or they attended — but never fewer than MIN_CHART_WEEKS from
 * the end. A fixed year drew a contact who joined two months ago as ten months
 * of flat line, with the weeks that mattered squeezed against the right edge.
 * ISO week keys are zero-padded, so they order as strings; a start before the
 * window lands on its first week.
 */
function chartStartIndex(
  weeks: readonly { week: string; sessions: number }[],
  history: readonly { start_date?: unknown }[],
  contact: Pick<Contact, 'created_at'>
): number {
  if (!weeks.length) return 0
  const keys = weeks.map((w) => w.week)
  const candidates = [contact.created_at, ...history.map((h) => h.start_date)]
    .map((ts) => toDate(ts))
    .filter((d): d is Date => !!d)
    .map((d) => {
      const key = isoWeekKey(d)
      const i = keys.findIndex((k) => k >= key)
      return i === -1 ? keys.length - 1 : i
    })
  const firstAttended = weeks.findIndex((w) => w.sessions > 0)
  if (firstAttended !== -1) candidates.push(firstAttended)
  const earliest = candidates.length ? Math.min(...candidates) : keys.length - MIN_CHART_WEEKS
  return Math.max(0, Math.min(earliest, keys.length - MIN_CHART_WEEKS))
}

/** Attendance since the relationship started, up to a year, bleeding to the
 *  card edges, with the plan periods drawn behind it as faint bands — so "did
 *  they stop coming when the plan ended" is one glance instead of two tabs.
 *  Subscriptions only; affiliations are their own tab's. A fixed 128px, a fixed
 *  32px under the counters: the area fill never climbs up to the figures, and
 *  the gap never balloons either, because the card's spare height goes to the
 *  summary block (see InsightsCard). */
function Sparkline({ contact }: { contact: Contact }) {
  const { data: weeklyReports = [], isLoading } = useContactWeeklyReports(contact.id, CHART_WEEKS)
  const { data: history = [] } = useSubscriptionHistory(contact.id)
  const allWeeks = weeklyReports.map((r) => ({
    week: r.iso_week,
    label: isoWeekLabel(r.iso_week),
    sessions: r.sessions_count,
  }))
  const chartData = allWeeks.slice(chartStartIndex(allWeeks, history, contact))
  const bands = planBands(
    history,
    chartData.map((d) => d.week)
  )

  return (
    <div className="mt-8 h-32 shrink-0">
      {isLoading ? (
        <div className="h-full animate-pulse bg-muted/40" />
      ) : chartData.length === 0 ? (
        <div className="h-full bg-muted/20" />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="hdrSparkGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* The week KEY on the axis, not its label: a band's edges are
                week keys, and a Monday's short date can repeat across years. */}
            <XAxis dataKey="week" hide />
            {/* Headroom above the tallest week, so a peak never runs into the
                card's edge or a band's plan name. */}
            <YAxis hide domain={[0, (dataMax: number) => Math.max(2, Math.ceil(dataMax * 1.35))]} />
            {/* Before the line, so the attendance reads over the bands. */}
            {bands.map((b) => (
              <ReferenceArea
                key={b.key}
                x1={b.x1}
                x2={b.x2}
                fill={PLAN_BAND_COLOR}
                fillOpacity={0.1}
                stroke="none"
                label={
                  b.name && b.weeks >= BAND_LABEL_MIN_WEEKS
                    ? {
                        value: b.name,
                        position: 'insideTopLeft' as const,
                        fontSize: 10,
                        fill: PLAN_BAND_COLOR,
                      }
                    : undefined
                }
              />
            ))}
            <Tooltip
              contentStyle={tooltipStyle}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const row = payload[0].payload as { week: string; label: string }
                const plans = bands
                  .filter((b) => b.name && b.from <= row.week && row.week <= b.to)
                  .map((b) => b.name)
                return (
                  <div style={{ ...tooltipStyle, textAlign: 'center', lineHeight: 1.4 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#6366f1' }}>
                      {payload[0].value}
                    </div>
                    <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                      {row.label}
                    </div>
                    {plans.length > 0 && (
                      <div style={{ fontSize: 10, color: PLAN_BAND_COLOR }}>
                        {plans.join(' · ')}
                      </div>
                    )}
                  </div>
                )
              }}
            />
            <Area
              type="monotone"
              dataKey="sessions"
              stroke="#6366f1"
              strokeWidth={1.5}
              fill="url(#hdrSparkGrad)"
              dot={false}
              activeDot={{ r: 3, fill: '#6366f1' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ─── Engagement cell ──────────────────────────────────────────────────────────

/** The fourth figure: a dot in the band's colour and the band's name, sized
 *  to sit level with the three numbers. A band is one of four words, so a
 *  meter was showing a fill level for something that has no level. */
function EngagementCell({
  contact,
  thresholds,
}: {
  contact: Contact
  thresholds?: EngagementThresholds
}) {
  const t = useTranslations('Contacts')
  const lastMs = toDate(contact.last_session_at)?.getTime() ?? null
  const refMs = lastMs ?? toDate(contact.created_at)?.getTime() ?? null
  const band = computeEngagementBand(refMs, thresholds)
  const daysAgo = lastMs != null ? Math.floor((Date.now() - lastMs) / 86_400_000) : null
  const tip = daysAgo == null ? t('engagementNoSessions') : t('engagementLastSession', { days: daysAgo })
  return (
    <div title={tip} className="cursor-default px-4 py-3 text-center">
      <p
        className={`flex h-8 items-center justify-center gap-1.5 text-sm font-semibold ${ENGAGEMENT_TEXT[band]}`}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ENGAGEMENT_BAR[band]}`} aria-hidden />
        <span className="truncate">{t(`engagement_${band}` as Parameters<typeof t>[0])}</span>
      </p>
      <p className="mt-0.5 flex items-center justify-center gap-1 text-[10px] leading-tight text-muted-foreground">
        <Activity className="h-3 w-3" />
        {t('engagementLabel')}
      </p>
    </div>
  )
}
