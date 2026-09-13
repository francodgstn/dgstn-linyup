'use client'

// "Issue for every member" — the year-end run. Starts `startTarif595BulkIssue`
// for a window and follows the job document it returns (tarif595_jobs/{id})
// until it lands; the recent runs below are the record. Every member who got
// NO receipt is listed with the reason — the same codes the single-contact
// preview shows — with a link to their Receipts segment, because the point of
// a bulk run is finding the missing AHV numbers before the insurer does.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Loader2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { tarif595BulkIsTerminal, type Tarif595BulkJob, type Tarif595BulkSkip } from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { callStartTarif595BulkIssue, useInvalidateTarif595, useTarif595Job, useTarif595Jobs, type Tarif595JobRow } from './hooks'

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function currentYear(): { from: string; to: string } {
  const y = new Date().getFullYear()
  return { from: `${y}-01-01`, to: `${y}-12-31` }
}

function tsToDate(v: unknown): Date | null {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate(): Date }).toDate()
  return null
}

/** The skips, grouped by reason, most frequent first. */
function groupSkips(skips: Tarif595BulkSkip[]): Array<{ code: Tarif595BulkSkip['code']; contactIds: string[] }> {
  const byCode = new Map<Tarif595BulkSkip['code'], Set<string>>()
  for (const s of skips) {
    if (!byCode.has(s.code)) byCode.set(s.code, new Set())
    byCode.get(s.code)!.add(s.contactId)
  }
  return [...byCode.entries()]
    .map(([code, ids]) => ({ code, contactIds: [...ids] }))
    .sort((a, b) => b.contactIds.length - a.contactIds.length)
}

function JobStatusBadge({ status }: { status: Tarif595BulkJob['status'] }) {
  const t = useTranslations('Tarif595')
  const variant = status === 'running' ? 'secondary' : status === 'completed' ? 'default' : status === 'failed' ? 'destructive' : 'outline'
  return <Badge variant={variant}>{t(`bulk.status_${status}`)}</Badge>
}

function SkipList({ skips, skipped }: { skips: Tarif595BulkSkip[]; skipped: number }) {
  const t = useTranslations('Tarif595')
  const groups = useMemo(() => groupSkips(skips), [skips])
  if (groups.length === 0) return null
  const SHOW = 8
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{t('bulk.skipsTitle', { count: skipped })}</p>
      {groups.map((g) => (
        <div key={g.code} className="space-y-1">
          {/* The reason text is the preview's own: a warning code reads from
              `warning.*`, every other code from `blocking.*`. */}
          <p className="text-muted-foreground">
            {g.code === 'overlapping_receipt' || g.code === 'attendance_truncated' || g.code === 'insured_number_missing' || g.code === 'insurer_unknown' || g.code === 'unit_price_zero'
              ? t(`warning.${g.code}`)
              : t(`blocking.${g.code}`)}
            {' · '}
            {t('bulk.membersCount', { count: g.contactIds.length })}
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {g.contactIds.slice(0, SHOW).map((id) => (
              <li key={id}>
                <Link href={`/contacts/${id}?seg=receipts` as Route} className="text-primary hover:underline">
                  {t('bulk.openContact')}
                </Link>
              </li>
            ))}
            {g.contactIds.length > SHOW && (
              <li className="text-muted-foreground">{t('bulk.skipsMore', { count: g.contactIds.length - SHOW })}</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  )
}

function JobRow({ job, expanded }: { job: Tarif595JobRow; expanded: boolean }) {
  const t = useTranslations('Tarif595')
  const when = tsToDate(job.created_at)
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {job.from} – {job.to}
        </span>
        <JobStatusBadge status={job.status} />
        <span className="ml-auto text-xs text-muted-foreground">{when ? when.toLocaleString() : ''}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        {job.status === 'running'
          ? t('bulk.running', { processed: job.processed, total: job.total })
          : t('bulk.summary', { issued: job.issued, skipped: job.skipped, failed: job.failed })}
        {job.status === 'failed' && job.error ? ` · ${job.error}` : ''}
      </p>
      {expanded && <SkipList skips={job.skips ?? []} skipped={job.skipped} />}
    </li>
  )
}

export function BulkIssueCard({ teamId, setupDone }: { teamId: string; setupDone: boolean }) {
  const t = useTranslations('Tarif595')
  const [{ from, to }, setWindow] = useState(currentYear)
  const [starting, setStarting] = useState(false)
  const [followId, setFollowId] = useState<string | null>(null)
  const followed = useTarif595Job(teamId, followId)
  const jobsQ = useTarif595Jobs(teamId)
  const invalidate = useInvalidateTarif595(teamId)
  // The refresh + toast fire exactly once per run, whether the studio is still
  // watching or the terminal snapshot arrives later.
  const settled = useRef<string | null>(null)

  useEffect(() => {
    if (!followed || !tarif595BulkIsTerminal(followed.status) || settled.current === followed.id) return
    settled.current = followed.id
    const summary = t('bulk.summary', { issued: followed.issued, skipped: followed.skipped, failed: followed.failed })
    if (followed.status === 'completed') toast.success(summary)
    else if (followed.status === 'completed_with_errors') toast.warning(summary, { duration: 10_000 })
    else toast.error(t('bulk.failed', { error: followed.error ?? '' }), { duration: 10_000 })
    invalidate()
  }, [followed, invalidate, t])

  const running = jobsQ.data?.find((j) => j.status === 'running' && j.id !== followId) ?? null
  const busy = starting || (followed !== null && !tarif595BulkIsTerminal(followed.status))
  const windowValid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to

  async function start() {
    if (!windowValid) return
    setStarting(true)
    try {
      const { data } = await callStartTarif595BulkIssue({ teamId, from, to })
      setFollowId(data.jobId)
      if (data.mode === 'inline') invalidate()
    } catch (err) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason
      if (reason === 'job_already_running') toast.error(t('bulk.alreadyRunning'))
      else if (reason === 'plugin_config_incomplete' || reason === 'legal_profile_incomplete') toast.error(t('bulk.setupIncomplete'))
      else toast.error(t('bulk.startFailed'))
      console.error('[tarif-595] bulk start failed:', err)
    } finally {
      setStarting(false)
    }
  }

  const rows: Tarif595JobRow[] = useMemo(() => {
    const list = jobsQ.data ?? []
    if (followed && !list.some((j) => j.id === followed.id)) return [followed, ...list]
    return list.map((j) => (followed && j.id === followed.id ? followed : j))
  }, [jobsQ.data, followed])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4 text-muted-foreground" />
          {t('bulk.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('bulk.intro')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="tarif595-bulk-from">{t('bulk.from')}</Label>
            <Input id="tarif595-bulk-from" type="date" value={from} max={to} onChange={(e) => setWindow((w) => ({ ...w, from: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tarif595-bulk-to">{t('bulk.to')}</Label>
            <Input id="tarif595-bulk-to" type="date" value={to} min={from} max={isoDate(new Date(Date.now() + 400 * 86_400_000))} onChange={(e) => setWindow((w) => ({ ...w, to: e.target.value }))} />
          </div>
          <Button onClick={start} disabled={busy || !windowValid || !setupDone || !!running}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('bulk.start')}
          </Button>
        </div>
        {!setupDone && <p className="text-xs text-muted-foreground">{t('bulk.setupIncomplete')}</p>}
        {running && <p className="text-xs text-muted-foreground">{t('bulk.alreadyRunning')}</p>}

        <div>
          <p className="mb-1 text-sm font-medium">{t('bulk.recentTitle')}</p>
          {jobsQ.isLoading ? (
            <Skeleton className="h-12" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('bulk.recentEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {rows.map((j) => (
                <JobRow key={j.id} job={j} expanded={j.id === followId || j.id === rows[0]?.id} />
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
