'use client'

/**
 * THE RIGHT-HAND CARD of the contact header: what the studio reads about the
 * person, beside the profile card that says who they are.
 *
 * Top, the AI summary — the `ai-contact-summary` module of the AI insights plugin
 * (it was the `contact-summary` experiment until 2026-09-16). While the module is
 * not installed the block is ABSENT, not empty, so a studio that never opted in
 * sees a card of numbers and nothing that hints at a model. Inside it, with the
 * `ai-member-recap` module, a "Send to member" action opens `MemberRecapDialog`
 * with the member-facing part of the same summary. Under it: four figures
 * in a row — the three counters and the engagement band as a coloured dot
 * with its name (it used to be a vertical meter beside the strip, a fill
 * level for something that has four words and no level) — then the
 * attendance chart on the card's bottom edge, since the relationship began
 * and up to a year. Nothing here is new data; the summary is the one
 * write, and it goes through `generateContactSummary`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { useQueryClient } from '@tanstack/react-query'
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts'
import { Sparkles, RefreshCw, Trophy, Flame, Star, Activity, Send } from 'lucide-react'
import { toast } from 'sonner'
import { AI_MODULES, computeEngagementBand, isoWeekKey } from '@linyup/shared'
import type {
  Contact,
  ContactAiMemberRecap,
  ContactAiSummarySections,
  EngagementThresholds,
} from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useCapabilities } from '@/hooks/useCapabilities'
import { isoWeekLabel, useContactWeeklyReports } from './AttendanceTrendCard'
import { ENGAGEMENT_BAR, ENGAGEMENT_TEXT } from './engagement'
import { MemberRecapDialog } from './MemberRecapDialog'
import { callFunction } from '@/lib/callFunction'

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
  const { isInstalled } = useInstalledPlugins()
  const summaryOn = isInstalled(AI_MODULES.contactSummary)
  return (
    <div
      className={`flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card ${className}`}
    >
      {/* WHERE SPARE HEIGHT GOES. The card is stretched to the profile card's
          height, so there is usually room to spare. The summary block takes
          it (flex-1): the counters follow the summary, the chart sits a fixed
          8px under the counters at a fixed 80px, and the bottoms of the two
          cards still meet. With the module off there is no summary block to
          grow, so the CHART takes the spare height, under the counters: docking
          the strip to the bottom left the top of the card empty. */}
      {summaryOn && (
        // Keyed so a summary just generated for one contact never shows over
        // the next contact this component happens to be re-rendered for.
        <SummaryBlock
          key={contact.id}
          contact={contact}
          recapOn={isInstalled(AI_MODULES.memberRecap)}
        />
      )}
      <div className={`flex min-w-0 flex-col ${summaryOn ? '' : 'flex-1'}`}>
        <StatsRow contact={contact} thresholds={thresholds} />
        <Sparkline contact={contact} grow={!summaryOn} />
      </div>
    </div>
  )
}

// ─── AI summary ───────────────────────────────────────────────────────────────

type SummaryResult = {
  text: string
  sections: ContactAiSummarySections | null
  member: ContactAiMemberRecap | null
  language: string
  model: string
}

type FreshSummary = {
  text: string
  sections: ContactAiSummarySections | null
  member: ContactAiMemberRecap | null
  language: string
}

function SummaryBlock({ contact, recapOn }: { contact: Contact; recapOn: boolean }) {
  const t = useTranslations('Contacts')
  const fmt = useTeamFormat()
  const qc = useQueryClient()
  const { can } = useCapabilities()
  const [busy, setBusy] = useState(false)
  const [recapOpen, setRecapOpen] = useState(false)
  // What the callable just returned, shown until the contact query refetches
  // and the stored record catches up.
  const [fresh, setFresh] = useState<FreshSummary | null>(null)

  const stored = contact.ai_summary
  const text = fresh?.text ?? stored?.text ?? null
  // The parts, when the summary has them — one written before 2026-09-14 does
  // not, and reads as the paragraph it always was.
  const sections = fresh ? fresh.sections : (stored?.sections ?? null)
  // The member-facing recap, when the summary has one (since 2026-09-16).
  const member = fresh ? fresh.member : (stored?.member ?? null)
  const language = fresh?.language ?? stored?.language ?? 'en'
  const updated = fresh ? new Date() : toDate(stored?.generated_at)
  // A fresh summary has not been sent; a stored one may have been.
  const sentAt = fresh ? undefined : toDate(stored?.member_sent_at)
  // An archived or deleted contact keeps the summary it has; nobody asks for a
  // new one about someone who left.
  const closed = !!contact.archived_at || !!contact.deleted_at

  async function generate() {
    if (busy) return
    setBusy(true)
    try {
      const call = callFunction<{ teamId: string; contactId: string }, SummaryResult>(
        'generateContactSummary'
      )
      const res = await call({ teamId: contact.teamId, contactId: contact.id })
      setFresh({
        text: res.data.text,
        sections: res.data.sections ?? null,
        member: res.data.member ?? null,
        language: res.data.language,
      })
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
          {sections ? (
            // THE LABELS ARE THE APP'S, in the reader's language; the parts are
            // the model's, in the studio's. A part the model left empty is
            // skipped rather than shown as a bare label.
            // CAPPED, AND SCROLLS INSIDE (Franco, 2026-09-25). A full summary
            // grew the card, and the grid stretched the profile card beside it
            // to match, leaving a blank block under the name. The header, the
            // date line and the send action stay outside the scroll.
            <SummaryScroll className="space-y-1.5">
              {sections.status && (
                <p>
                  <span className="font-semibold">{t('summarySectionStatus')}</span> {sections.status}
                </p>
              )}
              {sections.outlook && (
                <p>
                  <span className="font-semibold">{t('summarySectionOutlook')}</span> {sections.outlook}
                </p>
              )}
              {sections.nextSession && (
                <p>
                  <span className="font-semibold">{t('summarySectionNextSession')}</span>{' '}
                  {sections.nextSession}
                </p>
              )}
            </SummaryScroll>
          ) : (
            <SummaryScroll>
              <p>{text}</p>
            </SummaryScroll>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-xs text-muted-foreground">
              {updated
                ? `${t('summaryUpdatedOn', {
                    date: fmt.custom(updated, { dateStyle: 'medium' }),
                  })} · `
                : ''}
              {t('summaryDisclaimer')}
            </p>
            {recapOn && !closed && can('contacts.manage') && (
              <RecapAction
                member={member}
                email={contact.email}
                unsubscribed={contact.email_unsubscribed === true}
                sentAt={sentAt}
                onOpen={() => setRecapOpen(true)}
              />
            )}
          </div>
          {member && (
            <MemberRecapDialog
              open={recapOpen}
              onOpenChange={setRecapOpen}
              contact={contact}
              recap={member}
              language={language}
            />
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{t('summaryEmpty')}</p>
      )}
    </div>
  )
}

/**
 * The summary's text, capped in height and scrolling inside, with a FADE at the
 * bottom edge while there is more below — the one sign that the text goes on,
 * since a scrollbar is invisible until hovered on most systems. It lifts once
 * the reader reaches the end, and never shows for a summary that fits.
 */
function SummaryScroll({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2)
  }, [])
  useEffect(() => {
    measure()
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  return (
    <div
      ref={ref}
      onScroll={measure}
      className={`mt-2 max-h-44 overflow-y-auto pr-1 text-sm leading-relaxed ${
        more ? '[mask-image:linear-gradient(to_bottom,#000_calc(100%-2.5rem),transparent)]' : ''
      } ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * "Send to member" beside the summary's footer. Always SHOWN while the module is
 * on and the reader may mail contacts, and DISABLED with its reason as the
 * tooltip otherwise — a button that silently vanished for a contact with no email
 * would read as the feature being off.
 */
function RecapAction({
  member,
  email,
  unsubscribed,
  sentAt,
  onOpen,
}: {
  member: ContactAiMemberRecap | null
  email: string | undefined
  unsubscribed: boolean
  sentAt: Date | undefined
  onOpen: () => void
}) {
  const t = useTranslations('Contacts')
  const fmt = useTeamFormat()
  // A summary written before 2026-09-16 carries no recap: regenerating writes one.
  const blocked = !member
    ? t('recapNeedsRegenerate')
    : !email
      ? t('recapNoEmail')
      : unsubscribed
        ? t('recapUnsubscribed')
        : null
  return (
    <div className="flex items-center gap-2">
      {sentAt && (
        <span className="text-xs text-muted-foreground">
          {t('recapSentOn', { date: fmt.custom(sentAt, { dateStyle: 'medium' }) })}
        </span>
      )}
      <span title={blocked ?? undefined}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpen}
          disabled={!!blocked}
          className="h-7 gap-1.5 text-xs"
        >
          <Send className="h-3.5 w-3.5" />
          {t('recapAction')}
        </Button>
      </span>
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
      <div className="px-2 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">{contact.total_sessions ?? 0}</p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-xs leading-tight text-muted-foreground">
          <Trophy className="h-3 w-3 text-primary" />
          {t('statTotalSessions')}
        </p>
      </div>
      <div className="px-2 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">
          {contact.current_streak ?? 0}
          <span className="text-sm font-normal">w</span>
        </p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-xs leading-tight text-muted-foreground">
          <Flame className="h-3 w-3 text-orange-500" />
          {t('statStreak')}
        </p>
      </div>
      <div className="px-2 py-3 text-center">
        <p className="text-2xl font-bold tabular-nums">{contact.current_month_score ?? 0}</p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-xs leading-tight text-muted-foreground">
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

/** The most of the relationship the header chart shows: a year, enough to see
 *  a habit form or fade. */
const CHART_WEEKS = 52
/** The fewest weeks it ever shows, so a brand-new contact still gets a readable
 *  line rather than two points stretched across the card. */
const MIN_CHART_WEEKS = 12

/**
 * Where the chart starts: the week they joined or first attended, whichever
 * came first, but never fewer than MIN_CHART_WEEKS from the end. A fixed year
 * drew a contact who joined two months ago as ten months of flat line, with the
 * weeks that mattered squeezed against the right edge. ISO week keys are
 * zero-padded, so they order as strings; a start before the window lands on its
 * first week.
 */
function chartStartIndex(
  weeks: readonly { week: string; sessions: number }[],
  contact: Pick<Contact, 'created_at'>
): number {
  if (!weeks.length) return 0
  const keys = weeks.map((w) => w.week)
  const candidates: number[] = []
  const joined = toDate(contact.created_at)
  if (joined) {
    const key = isoWeekKey(joined)
    const i = keys.findIndex((k) => k >= key)
    candidates.push(i === -1 ? keys.length - 1 : i)
  }
  const firstAttended = weeks.findIndex((w) => w.sessions > 0)
  if (firstAttended !== -1) candidates.push(firstAttended)
  const earliest = candidates.length ? Math.min(...candidates) : keys.length - MIN_CHART_WEEKS
  return Math.max(0, Math.min(earliest, keys.length - MIN_CHART_WEEKS))
}

/** Attendance since the relationship began, up to a year, bleeding to the card
 *  edges. ATTENDANCE ONLY, by decision (2026-09-13): plan periods drawn behind
 *  it as bands made one small chart carry two stories, and the plans have their
 *  own place on the Plans & Payments tab. A fixed 128px, a fixed 32px under the
 *  counters: the area fill never climbs up to the figures, and the gap never
 *  balloons either, because the card's spare height goes to the summary block
 *  (see InsightsCard). */
function Sparkline({ contact, grow = false }: { contact: Contact; grow?: boolean }) {
  const { data: weeklyReports = [], isLoading } = useContactWeeklyReports(contact.id, CHART_WEEKS)
  const allWeeks = weeklyReports.map((r) => ({
    week: r.iso_week,
    label: isoWeekLabel(r.iso_week),
    sessions: r.sessions_count,
  }))
  const chartData = allWeeks.slice(chartStartIndex(allWeeks, contact))

  return (
    <div className={grow ? 'mt-2 min-h-20 flex-1' : 'mt-2 h-20 shrink-0'}>
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
            {/* The week KEY on the axis, not its label: a Monday's short date
                can repeat across years. The tooltip shows the label. */}
            <XAxis dataKey="week" hide />
            {/* Headroom above the tallest week, so a peak never runs into the
                card's edge. */}
            <YAxis hide domain={[0, (dataMax: number) => Math.max(2, Math.ceil(dataMax * 1.35))]} />
            <Tooltip
              contentStyle={tooltipStyle}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const row = payload[0].payload as { label: string }
                return (
                  <div style={{ ...tooltipStyle, textAlign: 'center', lineHeight: 1.4 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#6366f1' }}>
                      {payload[0].value}
                    </div>
                    <div style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                      {row.label}
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
    <div title={tip} className="cursor-default px-2 py-3 text-center">
      <p
        className={`flex h-8 items-center justify-center gap-1.5 text-sm font-semibold ${ENGAGEMENT_TEXT[band]}`}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ENGAGEMENT_BAR[band]}`} aria-hidden />
        <span className="truncate">{t(`engagement_${band}` as Parameters<typeof t>[0])}</span>
      </p>
      <p className="mt-0.5 flex items-center justify-center gap-1 text-xs leading-tight text-muted-foreground">
        <Activity className="h-3 w-3" />
        {t('engagementLabel')}
      </p>
    </div>
  )
}
