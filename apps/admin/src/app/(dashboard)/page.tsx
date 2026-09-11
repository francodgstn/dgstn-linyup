import Link from 'next/link'
import { getOverviewMetrics } from '@/lib/queries/accounts'
import { getMetricsHistory, type MetricsPoint } from '@/lib/queries/metrics'
import { getPlatformMailVolume, MAIL_LEDGER_NOTE } from '@/lib/queries/messaging'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge, PlanBadge } from '@/components/status-badge'
import { Sparkline } from '@/components/sparkline'
import { formatChf, formatDate } from '@/lib/format'

export const dynamic = 'force-dynamic'

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </CardContent>
    </Card>
  )
}

function Trend({
  label,
  history,
  pick,
  format,
}: {
  label: string
  history: MetricsPoint[]
  pick: (p: MetricsPoint) => number
  format: (n: number) => string
}) {
  const values = history.map(pick)
  const latest = values[values.length - 1] ?? 0
  const first = values[0] ?? 0
  const delta = latest - first
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {delta !== 0 && (
            <span className={delta > 0 ? 'text-xs text-[var(--success)]' : 'text-xs text-destructive'}>
              {delta > 0 ? '+' : ''}
              {format(delta)}
            </span>
          )}
        </div>
        <span className="text-2xl font-semibold tabular-nums">{format(latest)}</span>
        <Sparkline values={values} />
      </CardContent>
    </Card>
  )
}

export default async function OverviewPage() {
  const now = Date.now()
  const [m, history, mail] = await Promise.all([
    getOverviewMetrics(now),
    getMetricsHistory(90),
    getPlatformMailVolume(),
  ])
  const hasTrends = history.length >= 2
  const chf = (n: number) => formatChf(n)
  const num = (n: number) => n.toLocaleString('en-CH')
  const numOrDash = (n: number | null) => (n == null ? '—' : num(n))
  // Only the days the capture job actually recorded mail for — a snapshot from
  // before it did carries no mail block, and plotting those as zero would draw a
  // drought that never happened. Empty until the capture job writes the block
  // (see MetricsPoint.emailsSent), so the trend card below stays absent; the
  // "Emails" KPIs are live counts and are unaffected.
  const mailHistory = history.filter((p) => p.emailsSent != null)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Platform health at a glance.</p>
      </div>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Total accounts" value={String(m.accounts.total)} sub={`${m.accounts.byPlan.coach} coach · ${m.accounts.byPlan.studio} studio · ${m.accounts.byPlan.organization} org`} />
        <Kpi label="Active" value={String(m.accounts.byStatus.active)} sub={`${m.trials.active} on trial`} />
        <Kpi label="Est. MRR" value={formatChf(m.mrr.estimatedChf)} sub="active subscriptions" />
        <Kpi label="Total contacts" value={num(m.contacts.totalActive)} sub="across all teams" />
      </section>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="New (7d)" value={String(m.signups.last7d)} />
        <Kpi label="New (30d)" value={String(m.signups.last30d)} />
        <Kpi label="Past due" value={String(m.accounts.byStatus.past_due)} sub="needs attention" />
        <Kpi label="Trials expiring (7d)" value={String(m.trials.expiring7d)} />
        {/* Platform mail — studio sends AND Linyup's own system mail. A studio's
            own figure is on its account page and is team-scoped, so smaller. */}
        <Kpi label="Emails (30d)" value={numOrDash(mail.last30d)} sub="all streams" />
        <Kpi label="Emails (total)" value={numOrDash(mail.lifetime)} sub="as of last night" />
      </section>
      <p className="-mt-4 text-xs text-muted-foreground">{MAIL_LEDGER_NOTE}</p>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Trends{hasTrends ? ` · last ${history.length} days` : ''}
        </h2>
        {hasTrends ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Trend label="Accounts" history={history} pick={(p) => p.totalAccounts} format={num} />
            <Trend label="Active" history={history} pick={(p) => p.activeAccounts} format={num} />
            <Trend label="Est. MRR" history={history} pick={(p) => p.mrr} format={chf} />
            <Trend label="Contacts" history={history} pick={(p) => p.contacts} format={num} />
            {mailHistory.length >= 2 && (
              <Trend
                label="Emails / day"
                history={mailHistory}
                pick={(p) => p.emailsSent ?? 0}
                format={num}
              />
            )}
          </div>
        ) : (
          <Card>
            <CardContent className="py-4 text-sm text-muted-foreground">
              Collecting data — daily snapshots accumulate from today. Trend charts appear
              once there are at least two days of history.
            </CardContent>
          </Card>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent signups</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          {m.recentSignups.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">No accounts yet.</p>
          )}
          {m.recentSignups.map((a) => (
            <Link
              key={`${a.type}-${a.id}`}
              href={`/accounts/${a.type}/${a.id}`}
              className="flex items-center justify-between py-2.5 text-sm hover:text-foreground"
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <PlanBadge plan={a.plan} />
                <StatusBadge status={a.status} />
              </span>
              <span className="text-xs text-muted-foreground">{formatDate(a.createdMs)}</span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
