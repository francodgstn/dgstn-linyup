'use client'

/**
 * TEAM SENTIMENT — the `ai-team-sentiment` module of the AI insights plugin.
 *
 * One reading of the team's ACTIVE members: a mood, the overall picture, what is
 * working, what to watch and where to focus. The button starts a RUN
 * (`generateTeamSentiment`): it refreshes the AI briefing of every active member
 * with something new since their last one, then reads them together. The run,
 * its progress and the reading are all on `teams/{teamId}/ai_reports/team_sentiment`,
 * read here with one listener — the same document carries today's run count, so
 * "3 of 5 left today" is never a second read.
 *
 * ── WHERE IT SITS ────────────────────────────────────────────────────────────
 * Below the working rows and above Trends, as its own section. Everything above
 * the seam answers "what is happening now"; a reading of the roster is the
 * bridge between that and the history below it, and it is a thing a manager
 * reads once in a while rather than works from — so it never competes with the
 * day for the fold. The page mounts it only for all-scoped members with the
 * module installed; the rules on the document say the same.
 *
 * ── IT SAYS WHO IT COVERS ────────────────────────────────────────────────────
 * A reading covers active members only — seen within the studio's active
 * threshold — so the footer always says so, with the threshold and how many
 * briefings it read. A mood without its sample is a claim nobody can weigh.
 */

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { doc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { HeartPulse, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  AI_REPORTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_SENTIMENT_DAILY_LIMIT,
  TEAM_SENTIMENT_MIN_SUMMARIES,
  TEAM_SENTIMENT_REFRESH_BATCH,
  TEAM_SENTIMENT_REPORT_ID,
  teamSentimentRunInProgress,
  teamSentimentRunsLeft,
  type TeamSentimentDoc,
  type TeamSentimentMood,
} from '@linyup/shared'
import { db, functions } from '@/lib/firebase'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

function toDate(ts: unknown): Date | undefined {
  if (!ts) return undefined
  if (ts instanceof Date) return ts
  const t = ts as { toDate?: () => Date }
  return typeof t.toDate === 'function' ? t.toDate() : undefined
}

/** The mood as a coloured word. Semantic colours, never the brand accent. */
const MOOD_CLASS: Record<TeamSentimentMood, string> = {
  positive:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  steady:
    'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  mixed:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  concerning:
    'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300',
}

type StartResult = { runId: string; members: number; activeWithinDays: number; runsLeft: number }
type RefusalDetails = { reason?: string; needed?: number; active_within_days?: number }

function useTeamSentiment(teamId: string | null) {
  const [state, setState] = useState<{ data: TeamSentimentDoc | null; loading: boolean }>({
    data: null,
    loading: true,
  })
  useEffect(() => {
    if (!teamId) return
    const ref = doc(db, TEAMS_COLLECTION, teamId, AI_REPORTS_SUBCOLLECTION, TEAM_SENTIMENT_REPORT_ID)
    return onSnapshot(
      ref,
      (snap) => setState({ data: snap.exists() ? (snap.data() as TeamSentimentDoc) : null, loading: false }),
      (err) => {
        console.error('[team-sentiment] listen failed:', err)
        setState({ data: null, loading: false })
      }
    )
  }, [teamId])
  return state
}

export function TeamSentimentSection({ teamId }: { teamId: string | null }) {
  const t = useTranslations('NewDashboard')
  const { data, loading } = useTeamSentiment(teamId)
  const [busy, setBusy] = useState(false)

  const report = data?.report
  const run = data?.run
  const running = teamSentimentRunInProgress(run, Date.now())
  const runsLeft = teamSentimentRunsLeft(data?.usage, new Date())
  const generatedAt = toDate(report?.generated_at)
  const oldestAt = toDate(report?.summaries_oldest_at)
  // A failed run is news only when it is newer than the reading on the card.
  const runFailed =
    run?.status === 'failed' && (!generatedAt || (toDate(run.started_at)?.getTime() ?? 0) > generatedAt.getTime())

  async function generate() {
    if (!teamId || busy || running || runsLeft <= 0) return
    setBusy(true)
    try {
      const res = await httpsCallable<{ teamId: string }, StartResult>(functions, 'generateTeamSentiment')({ teamId })
      toast.success(t('sentimentStarted', { count: res.data.members }))
    } catch (err) {
      console.error('[team-sentiment] start failed:', err)
      const details = (err as { details?: RefusalDetails })?.details
      const reason = details?.reason
      toast.error(
        reason === 'not_enough_members'
          ? t('sentimentNotEnoughMembers', {
              needed: details?.needed ?? TEAM_SENTIMENT_MIN_SUMMARIES,
              days: details?.active_within_days ?? 14,
            })
          : reason === 'run_in_progress'
            ? t('sentimentRunInProgress')
            : reason === 'contact_summary_off'
              ? t('sentimentContactSummaryOff')
              : reason === 'daily_limit'
                ? t('sentimentLimitReached', { limit: TEAM_SENTIMENT_DAILY_LIMIT })
                : t('sentimentFailed')
      )
    } finally {
      setBusy(false)
    }
  }

  // Labels written out as literal keys, so `pnpm i18n:check` can see each one.
  const sections = report
    ? [
        { key: 'overview', label: t('sentimentOverview'), body: report.sections.overview },
        { key: 'strengths', label: t('sentimentStrengths'), body: report.sections.strengths },
        { key: 'concerns', label: t('sentimentConcerns'), body: report.sections.concerns },
        { key: 'focus', label: t('sentimentFocus'), body: report.sections.focus },
      ]
    : []
  const moodLabel: Record<TeamSentimentMood, string> = {
    positive: t('sentimentMood_positive'),
    steady: t('sentimentMood_steady'),
    mixed: t('sentimentMood_mixed'),
    concerning: t('sentimentMood_concerning'),
  }

  const progress =
    running && run
      ? run.status === 'reading'
        ? t('sentimentProgressReading')
        : t('sentimentProgressRefreshing', {
            done: Math.min(run.rounds_done * TEAM_SENTIMENT_REFRESH_BATCH, run.member_ids.length),
            total: run.member_ids.length,
          })
      : null

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-4">
        <div className="flex items-center gap-2">
          <h2 className="font-heading text-base font-bold tracking-tight text-heading">
            {t('sentimentTitle')}
          </h2>
          <Badge
            variant="secondary"
            className="border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300"
          >
            {t('sentimentBeta')}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('sentimentRunsLeft', { left: runsLeft, limit: TEAM_SENTIMENT_DAILY_LIMIT })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={generate}
            disabled={busy || running || runsLeft <= 0 || !teamId}
            className="h-7 gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy || running ? 'animate-spin' : ''}`} />
            {running ? t('sentimentRunning') : report ? t('sentimentRefresh') : t('sentimentGenerate')}
          </Button>
        </div>
      </div>

      {progress && (
        <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {progress}
        </p>
      )}
      {runFailed && !running && <p className="text-xs text-destructive">{t('sentimentRunFailed')}</p>}

      <Card>
        <CardContent className="p-5">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : !report ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <HeartPulse className="h-7 w-7 text-muted-foreground/40" />
              <p className="text-sm font-medium">{t('sentimentEmptyTitle')}</p>
              <p className="max-w-md text-xs text-muted-foreground">
                {t('sentimentEmptyBody', { needed: TEAM_SENTIMENT_MIN_SUMMARIES })}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {report.mood && (
                <Badge variant="outline" className={`text-xs font-semibold ${MOOD_CLASS[report.mood]}`}>
                  {moodLabel[report.mood]}
                </Badge>
              )}
              <div className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm leading-relaxed md:grid-cols-2">
                {sections.map((s) =>
                  s.body ? (
                    <div key={s.key}>
                      <p className="font-semibold">{s.label}</p>
                      <p className="text-muted-foreground">{s.body}</p>
                    </div>
                  ) : null
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {generatedAt
                  ? `${t('sentimentUpdatedOn', {
                      date: generatedAt.toLocaleDateString(undefined, { dateStyle: 'medium' }),
                    })} · `
                  : ''}
                {report.active_within_days != null
                  ? t('sentimentBasedOnActive', { count: report.summaries_used, days: report.active_within_days })
                  : oldestAt
                    ? t('sentimentBasedOnSince', {
                        count: report.summaries_used,
                        date: oldestAt.toLocaleDateString(undefined, { dateStyle: 'medium' }),
                      })
                    : t('sentimentBasedOn', { count: report.summaries_used })}
                {' · '}
                {t('sentimentDisclaimer')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
