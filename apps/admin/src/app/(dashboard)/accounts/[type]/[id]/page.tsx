import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { getAccount } from '@/lib/queries/account'
import type { AccountType } from '@/lib/queries/accounts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge, PlanBadge, PaymentsBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { formatChf, formatDate } from '@/lib/format'
import { getMessagingInfo, MAIL_LEDGER_NOTE } from '@/lib/queries/messaging'
import { describeFirebaseTarget } from '@/lib/firebase-admin'
import { CompCard } from './comp-card'
import { InternalCard } from './internal-card'
import { ConnectToggle } from './connect-toggle'
import { DisconnectConnect } from './disconnect-connect'
import { MessagingPolicyCard } from './messaging-policy-card'
import { LEDGER_RETENTION_DAYS } from '@linyup/shared'

export const dynamic = 'force-dynamic'

/** A count with its share of the member base. The share is what makes the count
 *  mean anything: 12 active is a triumph at 20 members and a problem at 400. */
function UsageFigure({ n, of }: { n: number; of: number }) {
  const pct = of > 0 ? Math.round((n / of) * 100) : null
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-lg font-semibold tabular-nums">{n}</span>
      {pct !== null && <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>}
    </span>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  )
}

// A count that failed (typically a missing index) renders as a dash — never as
// a zero, which an operator would read as "this studio sends nothing".
function Figure({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">
        {value == null ? '—' : value.toLocaleString('en-CH')}
      </span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ type: string; id: string }>
}) {
  const { type, id } = await params
  if (type !== 'team' && type !== 'org') notFound()
  const account = await getAccount(type as AccountType, id)
  if (!account) notFound()

  const sub = account.subscription
  const usage = account.contactUsage
  const appUsage = account.appUsage
  const messaging = await getMessagingInfo(account.id)

  // The tenant's own front door. `/public/{slug}` is the team root and renders
  // whatever surface the studio chose as its default, so this is the page a
  // member or prospect actually lands on — the fastest way for an operator to
  // see a tenant as the world sees it. Teams only: org slugs do not resolve
  // there (the public route matches `type == 'team'`), and a link that 404s is
  // worse than no link.
  const target = describeFirebaseTarget()
  const publicUrl =
    account.type === 'team' && account.slug && target.publicBaseUrl
      ? `${target.publicBaseUrl}/public/${account.slug}`
      : null

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/accounts"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Accounts
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{account.name}</h1>
        <PlanBadge plan={account.plan} />
        <StatusBadge status={account.status} />
        <span className="text-sm text-muted-foreground capitalize">· {account.type}</span>
        {publicUrl && (
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={publicUrl}
          >
            <ExternalLink className="size-3.5" />
            <span className="font-mono text-xs">/{account.slug}</span>
          </a>
        )}
      </div>

      {/* ACTIVE MEMBERS. `last_seen_at` is stamped when the member app comes to
          the foreground and when a contact session is established on the web, so
          this counts members who OPENED something — not members who did
          anything. Said plainly under the figures, because an engagement number
          whose definition is a guess is worse than no engagement number. */}
      {appUsage && (
        <Card>
          <CardHeader>
            <CardTitle>Member app &amp; Space usage</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label="Active today" value={<UsageFigure n={appUsage.activeToday} of={appUsage.members} />} />
              <Field label="Active 7 days" value={<UsageFigure n={appUsage.activeWeek} of={appUsage.members} />} />
              <Field label="Active 30 days" value={<UsageFigure n={appUsage.activeMonth} of={appUsage.members} />} />
              <Field label="Members" value={<span className="tabular-nums">{appUsage.members}</span>} />
            </div>
            <p className="text-xs text-muted-foreground">
              Counts contacts who opened the member app or signed into the public Space.
              Not a measure of what they did there.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Studio → Linyup: the platform subscription the studio pays Linyup. */}
        <Card>
          <CardHeader>
            <CardTitle>
              {account.type === 'org' ? 'Organization' : 'Studio'} → Linyup (platform billing)
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            {sub ? (
              <>
                <Field label="Plan" value={<span className="capitalize">{sub.plan}</span>} />
                <Field label="Status" value={<StatusBadge status={sub.status} />} />
                {/* The organisation tier has no base fee — it is a RATE per
                    studio, so `baseMonthly` is 0 for it and printing that showed
                    an operator CHF 0.00 for a paying federation. */}
                <Field
                  label={sub.perStudioMonthly == null ? 'Base price' : 'Rate'}
                  value={
                    sub.perStudioMonthly == null
                      ? `${formatChf(sub.baseMonthly)}/mo`
                      : `${formatChf(sub.perStudioMonthly)}/studio/mo`
                  }
                />
                <Field label="Gateway" value={sub.gatewayType ?? 'manual'} />
                <Field label="Current period" value={`${formatDate(sub.currentPeriodStartMs)} → ${formatDate(sub.currentPeriodEndMs)}`} />
                <Field label="Trial ends" value={formatDate(sub.trialEndsAtMs)} />
                {/* A DATE where we have one — a billing-portal cancellation
                    leaves the boolean false, so this field used to read "No" for
                    a studio that had already cancelled.

                    But the date is NOT the signal. Docs written before the
                    Dahlia field migration carry the cancellation with no
                    `current_period_end` at all, so falling silent whenever the
                    date is missing hides the entire pre-migration population
                    from the operator. Say "cancelling" without the date rather
                    than saying nothing. */}
                <Field
                  label="Cancels on"
                  value={
                    sub.endsAtMs
                      ? formatDate(sub.endsAtMs)
                      : sub.cancelling
                        ? 'at period end (date not recorded)'
                        : '—'
                  }
                />
                <Field
                  label="Cancellation"
                  value={
                    sub.cancelling || sub.canceledAtMs || sub.cancellationReason ? (
                      <span className="text-sm">
                        {/* A pre-migration doc has the cancellation and none of
                            its detail. "Cancelling" is still the true and useful
                            answer; an empty cell is not. */}
                        {[
                          sub.canceledAtMs ? `requested ${formatDate(sub.canceledAtMs)}` : null,
                          sub.cancellationReason,
                          sub.cancellationFeedback,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'cancelling — no reason recorded'}
                        {sub.cancellationComment ? (
                          <em className="block text-muted-foreground">
                            “{sub.cancellationComment}”
                          </em>
                        ) : null}
                      </span>
                    ) : (
                      '—'
                    )
                  }
                />
                <Field label="Last payment" value={sub.lastPaymentStatus ?? '—'} />
                <Field label="Stripe customer" value={<code className="text-xs">{sub.customerId ?? '—'}</code>} />
                <Field label="Stripe subscription" value={<code className="text-xs">{sub.subscriptionId ?? '—'}</code>} />
              </>
            ) : (
              <p className="col-span-2 text-sm text-muted-foreground">
                No saas_subscriptions record (manually managed or not yet provisioned).
              </p>
            )}
          </CardContent>
        </Card>

        {/* Linyup → tenant: is this tenant billed at all?
            Sits directly under the subscription card because it is the ANSWER to
            the question that card raises for a comped tenant — a paid plan badge
            with no subscription record, which reads as broken until you know it
            was a decision. */}
        <Card>
          <CardHeader>
            <CardTitle>Linyup billing</CardTitle>
          </CardHeader>
          <CardContent>
            <CompCard
              kind={account.type}
              entityId={account.id}
              initialComped={account.comped}
              initialReason={account.compedReason}
              compedSince={account.compedSinceMs ? formatDate(account.compedSinceMs) : null}
            />
            {account.type === 'org' && account.comped && (
              <p className="mt-3 text-xs text-muted-foreground">
                Every studio in this organisation also pays no platform fee on member
                payments — the waiver is read from this document, so a studio that
                joins later inherits it.
              </p>
            )}
            {/* Whether it is COUNTED, beside whether it is BILLED — the two
                flags an operator sets on Linyup's own tenants. */}
            <div className="mt-4">
              <InternalCard kind={account.type} entityId={account.id} initialInternal={account.internal} />
            </div>
          </CardContent>
        </Card>

        {/* Member → Studio: Stripe Connect (the studio collects from its members). */}
        {account.payments && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <CardTitle>Member → Studio (Stripe Connect)</CardTitle>
              <ConnectToggle
                teamId={account.id}
                initialEnabled={account.payments.status !== 'disabled'}
              />
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Field label="Status" value={<PaymentsBadge status={account.payments.status} />} />
                <Field
                  label="Onboarding"
                  value={account.payments.model ? account.payments.model.toUpperCase() : '—'}
                />
                <Field
                  label="Charges / payouts"
                  value={`${account.payments.chargesEnabled ? 'on' : 'off'} / ${account.payments.payoutsEnabled ? 'on' : 'off'}`}
                />
                <Field
                  label="Collected (gross)"
                  value={formatChf(account.payments.grossCollectedChf)}
                />
                <Field
                  label="Linyup fees earned"
                  value={formatChf(account.payments.platformFeesChf)}
                />
                <Field label="Refunded" value={formatChf(account.payments.refundedChf)} />
                <Field label="Payments" value={account.payments.paymentsCount} />
                <Field label="Active subscriptions" value={account.payments.activeSubscriptions} />
                <Field
                  label="Connected account"
                  value={
                    <code className="text-xs">{account.payments.connectAccountId ?? '—'}</code>
                  }
                />
              </div>

              {/* The other half of teardown: the toggle above stops charges,
                  this removes the link. `purgeTeam` cannot do it, which is why
                  its runbook otherwise ends in a manual Stripe step. */}
              {account.payments.connectAccountId && (
                <DisconnectConnect
                  teamId={account.id}
                  accountId={account.payments.connectAccountId}
                />
              )}

              {account.payments.requirementsDue.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    Outstanding requirements
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {account.payments.requirementsDue.map((r) => (
                      <Badge key={r} variant="warning" className="font-normal">
                        {r}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Outbound messaging — operator-only delivery policy + recent ledger. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Outbound messaging policy</CardTitle>
          </CardHeader>
          <CardContent>
            <MessagingPolicyCard
              entityId={account.id}
              initialPolicy={messaging.policy}
              env={messaging.env}
            />
          </CardContent>
        </Card>

        <Card className="py-0">
          <div className="flex flex-col gap-3 px-4 pt-4">
            <CardTitle>Outbound volume</CardTitle>
            <div className="grid grid-cols-3 gap-3">
              <Figure
                label="Email · 30d"
                value={messaging.volume.email?.last30d ?? null}
                sub={
                  messaging.volume.email && messaging.volume.email.suppressed30d > 0
                    ? `${messaging.volume.email.suppressed30d} sends suppressed`
                    : undefined
                }
              />
              <Figure label={`Email · ${LEDGER_RETENTION_DAYS.mail_sends}d`} value={messaging.volume.email?.retained ?? null} />
              {/* SMS stays its own figure — it spends prepaid credits, mail does not. */}
              <Figure label="SMS · 30d" value={messaging.volume.smsLast30d} />
            </div>
            <p className="text-xs text-muted-foreground">{MAIL_LEDGER_NOTE}</p>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent sends
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messaging.recentSends.length === 0 && (
                <TableRow>
                  <TableCell className="py-4 text-muted-foreground" colSpan={3}>
                    No ledger entries yet.
                  </TableCell>
                </TableRow>
              )}
              {messaging.recentSends.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-muted-foreground">{formatDate(s.updatedMs)}</TableCell>
                  <TableCell className="text-xs">{s.channel}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === 'suppressed' || s.status === 'failed' || s.status === 'bounced'
                          ? 'warning'
                          : 'outline'
                      }
                      className="font-normal"
                    >
                      {s.status}
                      {s.suppressReason ? ` · ${s.suppressReason}` : ''}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contact usage</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {usage ? (
            <>
              <div className="flex items-end justify-between">
                <span className="text-2xl font-semibold tabular-nums">{usage.used}</span>
                <span className="text-sm text-muted-foreground">
                  {usage.isUnlimited ? 'unlimited' : `of ${usage.included} included`}
                </span>
              </div>
              {!usage.isUnlimited && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={usage.overBy > 0 ? 'h-full bg-destructive' : 'h-full bg-primary'}
                    style={{ width: `${usage.percent}%` }}
                  />
                </div>
              )}
              {usage.overBy > 0 && (
                <p className="text-sm text-destructive">{usage.overBy} over the included limit.</p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Contact usage is tracked per team (orgs aggregate their teams).
            </p>
          )}
          <Field label="Created" value={formatDate(account.createdMs)} />
        </CardContent>
      </Card>

      <Card className="py-0">
        <div className="px-4 pt-4">
          <CardTitle>Members</CardTitle>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {account.members.length === 0 && (
              <TableRow>
                <TableCell className="py-4 text-muted-foreground" colSpan={3}>
                  No members.
                </TableCell>
              </TableRow>
            )}
            {account.members.map((mb) => (
              <TableRow key={mb.userId}>
                <TableCell>{mb.email ?? mb.userId}</TableCell>
                <TableCell className="capitalize">{mb.role.replace('_', ' ')}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(mb.joinedMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {account.type === 'team' && (
        <Card className="py-0">
          <div className="px-4 pt-4">
            <CardTitle>Recent activity</CardTitle>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {account.activity.length === 0 && (
                <TableRow>
                  <TableCell className="py-4 text-muted-foreground" colSpan={3}>
                    No activity recorded.
                  </TableCell>
                </TableRow>
              )}
              {account.activity.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-muted-foreground">{formatDate(row.createdMs)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.event}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{row.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
