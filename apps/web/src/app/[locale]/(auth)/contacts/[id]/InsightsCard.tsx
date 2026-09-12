'use client'

/**
 * THE RIGHT-HAND CARD of the contact header: what the studio reads about the
 * person, beside the profile card that says who they are.
 *
 * Top, the AI summary — an experiment (`contact-summary`). While the switch is
 * off the block is ABSENT, not empty, so a studio that never opted in sees a
 * card of numbers and nothing that hints at a model. Under it, straight away:
 * the three counters, then the attendance sparkline growing into whatever
 * height the card has left, with the engagement meter beside them — the foot
 * of the old single header card, no longer docked to the bottom edge (that
 * left a dead band under a short summary). Nothing here is new data; the
 * summary is the one write, and it goes through `generateContactSummary`.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { httpsCallable } from 'firebase/functions'
import { XAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import { Sparkles, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { computeEngagementBand } from '@linyup/shared'
import type { Contact, EngagementBand, EngagementThresholds } from '@linyup/shared'
import { functions } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { useExperimentalFeatures } from '@/hooks/useExperimentalFeatures'
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
  return (
    <div
      className={`flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card ${className}`}
    >
      {/* Keyed so a summary just generated for one contact never shows over
          the next contact this component happens to be re-rendered for. */}
      <SummaryBlock key={contact.id} contact={contact} />
      {/* The counters follow the summary directly; the sparkline takes whatever
          height is left. Docking the strip to the bottom edge left a dead band
          between the two whenever the summary was short — the chart grows
          instead, which is the better use of the room anyway. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <StatsRow contact={contact} />
          <Sparkline contactId={contact.id} />
        </div>
        <EngagementIndicator contact={contact} thresholds={thresholds} />
      </div>
    </div>
  )
}

// ─── AI summary ───────────────────────────────────────────────────────────────

type SummaryResult = { text: string; language: string; model: string }

function SummaryBlock({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts')
  const { isEnabled } = useExperimentalFeatures()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  // What the callable just returned, shown until the contact query refetches
  // and the stored record catches up.
  const [fresh, setFresh] = useState<string | null>(null)

  if (!isEnabled('contact-summary')) return null

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
    <div className="border-b p-5">
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

function StatsRow({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts')
  return (
    <div className="grid grid-cols-3 divide-x">
      <div className="px-4 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">{contact.total_sessions ?? 0}</p>
        <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
          {t('statTotalSessions')}
        </p>
      </div>
      <div className="px-4 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">
          {contact.current_streak ?? 0}
          <span className="text-sm font-normal">w</span>
        </p>
        <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{t('statStreak')}</p>
      </div>
      <div className="px-4 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">{contact.current_month_score ?? 0}</p>
        <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
          {t('statMonthScore')}
        </p>
      </div>
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

/** Attendance over the last 16 weeks — bleeds to the card edges, no padding,
 *  and grows with the card: never shorter than 72px, as tall as the room left
 *  under the counters. */
function Sparkline({ contactId }: { contactId: string }) {
  const { data: weeklyReports = [], isLoading } = useContactWeeklyReports(contactId)
  const chartData = weeklyReports.map((r) => ({
    label: isoWeekLabel(r.iso_week),
    sessions: r.sessions_count,
  }))

  return (
    <div className="min-h-[72px] flex-1">
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
            <XAxis dataKey="label" hide />
            <Tooltip
              contentStyle={tooltipStyle}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <div style={{ ...tooltipStyle, textAlign: 'center', lineHeight: 1.4 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#6366f1' }}>
                      {payload[0].value}
                    </div>
                    <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                      {label}
                    </div>
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

// ─── Engagement meter ─────────────────────────────────────────────────────────

function EngagementIndicator({
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
  const tip = `${t('engagementLabel')} · ${
    daysAgo == null ? t('engagementNoSessions') : t('engagementLastSession', { days: daysAgo })
  }`
  const fill: Record<EngagementBand, string> = {
    active: '100%',
    low: '75%',
    at_risk: '50%',
    inactive: '25%',
  }
  return (
    <div
      title={tip}
      className="flex shrink-0 cursor-default flex-col items-center justify-end gap-1.5 border-l px-3 py-3"
    >
      <div className="relative min-h-[40px] w-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`absolute bottom-0 left-0 right-0 rounded-full transition-all ${ENGAGEMENT_BAR[band]}`}
          style={{ height: fill[band] }}
        />
      </div>
      <span
        className={`hidden whitespace-nowrap text-[10px] font-medium sm:block ${ENGAGEMENT_TEXT[band]}`}
      >
        {t(`engagement_${band}` as Parameters<typeof t>[0])}
      </span>
    </div>
  )
}
