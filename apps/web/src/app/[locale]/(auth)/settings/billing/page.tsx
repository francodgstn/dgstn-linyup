'use client'

import { Suspense, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { useSearchParams } from 'next/navigation'
import { doc, getDoc } from 'firebase/firestore'
import { db, functions } from '@/lib/firebase'
import { httpsCallable } from 'firebase/functions'
import { useAuth } from '@/contexts/AuthContext'
import { usePlanName } from '@/hooks/usePlanName'
import {
  useCancelSaasSubscription,
  useCreateSaasCheckoutSession,
  useOpenBillingPortal,
  useReactivateSaasSubscription,
} from '@/hooks/useSaasBilling'
import { QueryErrorState } from '@/components/ui/query-error'
import { PlanComparison } from '@/components/plan/PlanComparison'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  TEAMS_COLLECTION,
  PLAN_ORDER,
  PLAN_PRICING,
  subscriptionEndsAt,
  subscriptionIsCancelling,
  ORGANIZATIONS_COLLECTION,
  SAAS_SUBSCRIPTIONS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
} from '@linyup/shared'
import type { SaasSubscription, SaasPlan, Team } from '@linyup/shared'
import {
  CreditCard,
  FileText,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from 'lucide-react'
import { SubscriptionCancellationNote } from '@/components/payments/SubscriptionCancellationNote'
import { ORG_ENQUIRY_MAILTO } from '@/lib/salesContact'
import { OrgStudioPricer } from '@/components/plan/OrgStudioPricer'

// ─── types ────────────────────────────────────────────────────────────────────

interface Invoice {
  id: string
  amount: number
  currency: string
  status: string
  created: string
  hostedUrl?: string
  pdfUrl?: string
}

// ─── plan card helpers ────────────────────────────────────────────────────────
// Card copy (taglines, highlights) lives in the `Pricing` i18n namespace; price
// and contact caps come from PLAN_PRICING (the billing source of truth) so they
// can never drift. Suffixes map plan IDs to the message-key casing.

const PLAN_SUFFIX: Record<SaasPlan, string> = {
  free: 'Free',
  coach: 'Coach',
  studio: 'Studio',
  organization: 'Org',
}

/** CHF amount: drop the decimals for whole numbers (149), keep them otherwise (7.99). */
function fmtPrice(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// ─── data hooks ───────────────────────────────────────────────────────────────

function useSubscription(teamId: string | null) {
  return useQuery<SaasSubscription | null>({
    queryKey: ['saas-subscription', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      if (!teamId) return null
      const snap = await getDoc(doc(db, SAAS_SUBSCRIPTIONS_COLLECTION, teamId))
      return snap.exists() ? (snap.data() as SaasSubscription) : null
    },
  })
}

function useIsOwner(teamId: string | null, userId: string | null) {
  return useQuery<boolean>({
    queryKey: ['team-role', teamId, userId],
    enabled: !!teamId && !!userId,
    queryFn: async () => {
      if (!teamId || !userId) return false
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId, TEAM_MEMBERS_SUBCOLLECTION, userId))
      return snap.exists() && snap.data()?.role === 'owner'
    },
  })
}

function useInvoices(teamId: string | null, enabled: boolean) {
  return useQuery<Invoice[]>({
    queryKey: ['saas-invoices', teamId],
    enabled: !!teamId && enabled,
    queryFn: async () => {
      const getSaasInvoices = httpsCallable<{ teamId: string }, { invoices: Invoice[] }>(
        functions,
        'getSaasInvoices'
      )
      const result = await getSaasInvoices({ teamId: teamId! })
      return result.data.invoices
    },
  })
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function toTs(ts: unknown): number | null {
  if (!ts) return null
  const obj = ts as { seconds?: number }
  return obj.seconds ? obj.seconds * 1000 : null
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount / 100)
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'active') return 'default'
  if (status === 'trial') return 'secondary'
  if (status === 'past_due' || status === 'cancelled') return 'destructive'
  return 'outline'
}

/**
 * The stored `status`, or null when the document simply has not got one.
 *
 * NOT defensive padding. `SaasSubscription.status` is declared non-optional, so
 * TypeScript believes this can never be missing — and docs without it exist:
 * the SaaS webhook's `subscription.updated` branch writes no status and persists
 * with `set(…, {merge:true})`, so an `updated` that arrives before its `created`
 * (Stripe guarantees no ordering between them) CREATES the doc without one. A
 * real one, field for field, is reproduced in
 * functions/src/utils/stripe/subscriptionLifecycle.test.ts ("THE REAL DOC").
 *
 * On such a doc this page called `sub.status.replace(…)` and threw, taking the
 * whole billing page down for the one owner who most needed it — the state that
 * shape carries is a cancellation.
 */
function storedStatus(sub: SaasSubscription | null): string | null {
  const raw = sub?.status as string | undefined | null
  return typeof raw === 'string' && raw ? raw : null
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'active') return <CheckCircle2 className="h-4 w-4 text-green-600" />
  if (status === 'trial') return <Clock className="h-4 w-4 text-amber-500" />
  return <AlertTriangle className="h-4 w-4 text-destructive" />
}

function planRank(plan: SaasPlan): number {
  return PLAN_ORDER.indexOf(plan)
}

// ─── checkout result banner ───────────────────────────────────────────────────

function CheckoutBanner() {
  const t = useTranslations('Billing')
  const searchParams = useSearchParams()
  const result = searchParams.get('checkout')

  if (result === 'success') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-green-50 text-green-800 border border-green-200 text-sm">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        {t('checkoutSuccess')}
      </div>
    )
  }
  if (result === 'cancelled') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-muted border text-sm text-muted-foreground">
        {t('checkoutCancelled')}
      </div>
    )
  }
  return null
}

// ─── subscription card ────────────────────────────────────────────────────────

function SubscriptionCard({
  sub,
  team,
  teamId,
}: {
  sub: SaasSubscription | null
  team: Team | null
  teamId: string
}) {
  const t = useTranslations('Billing')
  const fmt = useTeamFormat()
  const tp = useTranslations('Pricing')
  const planName = usePlanName()

  const [confirmCancel, setConfirmCancel] = useState(false)

  // UX-5: the four billing callables are hook-defined mutations now, so every
  // refusal reaches a toast from ONE place (hooks/useSaasBilling.ts). They used
  // to be inline `httpsCallable` calls that console.error'd and returned.
  const checkout = useCreateSaasCheckoutSession()
  const cancel = useCancelSaasSubscription()
  const reactivate = useReactivateSaasSubscription()
  const billingPortal = useOpenBillingPortal()

  // Which plan tile is spinning — the mutation's own in-flight variables, so
  // there is no second copy of "is this pending" to fall out of step.
  const checkoutLoading = checkout.isPending ? (checkout.variables?.plan ?? null) : null

  const plans = ['free', 'coach', 'studio', 'organization'] as const
  const status = storedStatus(sub)
  // Free teams have no subscription doc (or a cancelled one) — current-plan
  // detection for Free must come from the team doc, not the sub.
  const onFreePlan = team?.plan === 'free' && (!sub || status === 'cancelled')
  // UX-7 interim: self-service signup provisions `teams/{id}.plan` +
  // `.plan_status: 'trial'` directly and never creates a saas_subscriptions
  // doc for it (lib/provisioning.ts) — until the trial converts (or the daily
  // downgrade sweep drops it to Free), `sub` is null here even though the
  // team is genuinely on a paid-tier trial. Fall back to the team doc so this
  // card states the real plan instead of "No subscription", and so the plan
  // grid below marks the right tile current.
  const teamTrialFallback =
    !sub && !!team?.plan && team.plan !== 'free' && team.plan_status === 'trial'
  const teamTrialEndMs = teamTrialFallback ? toTs(team?.trial_ends_at) : null
  const teamTrialEndDate = teamTrialEndMs ? new Date(teamTrialEndMs) : null
  const currentPlanRank =
    sub && status !== 'cancelled' && sub.plan
      ? planRank(sub.plan)
      : teamTrialFallback && team?.plan
        ? planRank(team.plan)
        : onFreePlan
          ? planRank('free')
          : -1
  const currentPlanId: SaasPlan | null =
    sub && status !== 'cancelled' && sub.plan
      ? sub.plan
      : teamTrialFallback && team?.plan
        ? team.plan
        : onFreePlan
          ? 'free'
          : null

  function handleUpgrade(plan: SaasPlan) {
    checkout.mutate({ teamId, plan })
  }

  function handleCancel() {
    // `AlertDialogAction` is a plain Button here (see components/ui/alert-dialog.tsx
    // — it is not the primitive's own close control), so the dialog closes only
    // where we close it: on SUCCESS. A failed cancel leaves the confirmation
    // standing behind its toast instead of dismissing as if it had worked.
    // The hook toasts and invalidates the subscription query.
    cancel.mutate(teamId, { onSuccess: () => setConfirmCancel(false) })
  }

  function handleReactivate() {
    reactivate.mutate(teamId)
  }

  function handleUpdatePayment() {
    billingPortal.mutate({ id: teamId, returnUrl: window.location.href })
  }

  const periodEndMs = toTs(sub?.current_period_end)
  const periodStartMs = toTs(sub?.current_period_start)
  const trialEndMs = toTs(sub?.trial_ends_at)

  const periodEndDate = periodEndMs ? new Date(periodEndMs) : null
  const periodStartDate = periodStartMs ? new Date(periodStartMs) : null
  const trialEndDate = trialEndMs ? new Date(trialEndMs) : null

  // ── WHETHER it is winding down, asked apart from WHEN ───────────────────────
  // The ONE shared predicate — the same one org/[orgId]/billing, the contact
  // PaymentsTab and the operator console ask, and the one the member's Space
  // gets through its `Contact.active_subscriptions` mirror. This page was the
  // last surface still asking the RAW `cancel_at_period_end` at its three
  // DECISION points, and that boolean is FALSE for every cancellation made in
  // the Stripe billing portal (which states a `cancel_at` timestamp instead). A
  // studio that cancelled there got no "cancels at period end" badge, no
  // Reactivate button, and a "Cancel subscription" link it had already used.
  // (The end-date line below was already asking the predicate; the actions were
  // not, which is the half that actually strands someone.)
  //
  // Not `subscriptionEndsAt(sub) !== null` either: that additionally demands a
  // DATE, and a cancelling doc from the pre-fix window carries no date at all
  // (see shared/utils/subscriptionLifecycle.ts). The date is shown when we have
  // one and simply omitted when we do not.
  const isCancelling = subscriptionIsCancelling(sub)
  // When it actually stops. Prefers Stripe's own `cancel_at` over the period
  // end — see shared/utils/subscriptionLifecycle.ts.
  const endsAtMs = toTs(subscriptionEndsAt(sub))
  const endsAtDate = endsAtMs ? new Date(endsAtMs) : null

  return (
    <>
      {/* Current plan status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            {t('currentPlan')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sub ? (
            <div className="space-y-4">
              {/* Plan name + status. A doc with no stored status shows no status
                  chip rather than an invented one — but everything below it,
                  the cancellation badge included, still renders. */}
              <div className="flex items-center gap-3 flex-wrap">
                {status && <StatusIcon status={status} />}
                <span className="font-semibold">{planName(sub.plan)} plan</span>
                {status && (
                  <Badge variant={statusVariant(status)} className="capitalize">
                    {status.replace('_', ' ')}
                  </Badge>
                )}
                {isCancelling && (
                  <Badge variant="outline" className="text-amber-600 border-amber-300">
                    {t('cancelAtPeriodEnd')}
                  </Badge>
                )}
              </div>

              {/* Cancelled sub → the team now runs on the Free plan */}
              {onFreePlan && <p className="text-sm text-muted-foreground">{t('onFreePlan', { count: PLAN_PRICING.free.includedContacts ?? 0 })}</p>}

              {/* Billing period */}
              {status !== 'trial' && periodStartDate && periodEndDate && (
                <p className="text-sm text-muted-foreground">
                  {t('periodLabel')}: {fmt.date(periodStartDate)} –{' '}
                  {fmt.date(periodEndDate)}
                </p>
              )}

              {/* Trial end */}
              {status === 'trial' && trialEndDate && (
                <p className="text-sm text-muted-foreground">
                  {t('trialEnds', { date: fmt.date(trialEndDate) })}
                </p>
              )}

              {/* Winding down: say WHEN, always — not only when the period start
                  happens to be missing. This is the line a studio that cancelled
                  in the Stripe portal was never shown. */}
              {endsAtDate && (
                <p className="text-sm text-amber-600">
                  {t('accessUntil', { date: fmt.date(endsAtDate) })}
                </p>
              )}

              {/* …and WHY. `audience="self"` because the studio wrote its own
                  churn survey and does not need it read back — but "payment
                  failed" is the studio's own card, and it is the difference
                  between a decision and an accident. */}
              <SubscriptionCancellationNote subscription={sub} audience="self" />


              {/* Renewal (when period start not available) */}
              {status !== 'trial' && !endsAtDate && !periodStartDate && periodEndDate && (
                <p className="text-sm text-muted-foreground">
                  {t('nextBilling', { date: fmt.date(periodEndDate) })}
                </p>
              )}

              {/* Past due warning */}
              {status === 'past_due' && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {t('pastDueWarning')}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {/* Reactivate is gated on the LIFECYCLE STATE alone, exactly as
                    on org/[orgId]/billing. It used to also demand
                    `status === 'active'`, which hid it from the two populations
                    that need it most: a doc with no stored status at all, and a
                    past-due subscription that is also winding down. The
                    predicate already refuses every ENDED status, so nothing is
                    offered a reactivation it cannot have. */}
                {isCancelling && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleReactivate}
                    disabled={reactivate.isPending}
                  >
                    {reactivate.isPending ? t('reactivating') : t('reactivate')}
                  </Button>
                )}
                {(status === 'active' || status === 'past_due') &&
                  sub.gateway_type === 'stripe' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleUpdatePayment}
                      disabled={billingPortal.isPending}
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      {billingPortal.isPending ? t('updatingPayment') : t('updatePayment')}
                    </Button>
                  )}
                {status === 'active' && !isCancelling && (
                  <button
                    className="text-xs text-muted-foreground hover:text-destructive underline ml-auto"
                    onClick={() => setConfirmCancel(true)}
                  >
                    {t('cancelSubscription')}
                  </button>
                )}
              </div>
            </div>
          ) : teamTrialFallback && team?.plan ? (
            // UX-7 interim: no saas_subscriptions doc yet, but the team doc says
            // this is a genuine paid-tier trial — say so instead of "No
            // subscription" (see the derivation above for why sub can be null here).
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <StatusIcon status="trial" />
                <span className="font-semibold">{planName(team.plan)} plan</span>
                <Badge variant={statusVariant('trial')}>{t('trialStatusBadge')}</Badge>
              </div>
              {teamTrialEndDate && (
                <p className="text-sm text-muted-foreground">
                  {t('trialEnds', { date: fmt.date(teamTrialEndDate) })}
                </p>
              )}
            </div>
          ) : onFreePlan ? (
            <div className="flex items-center gap-3 flex-wrap">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="font-semibold">{t('freePlanName')}</span>
              <span className="text-sm text-muted-foreground">{t('onFreePlan', { count: PLAN_PRICING.free.includedContacts ?? 0 })}</span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noSubscription')}</p>
          )}
        </CardContent>
      </Card>

      {/* Plan selection */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('choosePlan')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan) => {
              const isCurrent =
                plan === 'free'
                  ? onFreePlan
                  : teamTrialFallback
                    ? team?.plan === plan
                    : sub?.plan === plan && status !== 'cancelled'
              const isDowngrade = !isCurrent && currentPlanRank > planRank(plan)
              // Free is never "selected" via checkout — you land on it by
              // cancelling (or letting the trial lapse).
              const selectable = plan !== 'free' && !isCurrent && !isDowngrade
              const featured = plan === 'studio'
              const suffix = PLAN_SUFFIX[plan]
              const price = PLAN_PRICING[plan]
              const included = price.includedContacts
              return (
                <div
                  key={plan}
                  className={`relative flex flex-col rounded-lg border p-4 ${
                    isCurrent
                      ? 'border-primary bg-primary/5'
                      : featured
                        ? 'border-primary/40'
                        : ''
                  }`}
                >
                  {featured && !isCurrent && (
                    <span className="absolute -top-2.5 left-4 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                      {tp('mostPopular')}
                    </span>
                  )}

                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{planName(plan)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{tp(`tag${suffix}`)}</p>
                    </div>
                    {isCurrent && (
                      <Badge variant="default" className="shrink-0 text-xs">
                        {t('currentPlanBadge')}
                      </Badge>
                    )}
                  </div>

                  {/* Price. Three tiers are a scalar from PLAN_PRICING; the
                      organisation is a RATE plus a calculator, so it gets its own
                      branch — see OrgStudioPricer.

                      THE ORG BRANCH COMES FIRST, and that ordering is
                      load-bearing: `baseMonthly === 0` means "free", and the
                      organisation's base fee is now zero because the tier is
                      priced entirely per studio. Tested second, it rendered the
                      Organisation card as Free. */}
                  {plan === 'organization' ? (
                    <OrgStudioPricer className="mt-3" />
                  ) : (
                    <div className="mt-3 flex items-baseline gap-1">
                      {price.baseMonthly === 0 ? (
                        <span className="text-2xl font-bold">{tp('priceFree')}</span>
                      ) : (
                        <>
                          <span className="text-2xl font-bold">CHF {fmtPrice(price.baseMonthly)}</span>
                          <span className="text-xs text-muted-foreground">{tp('perMonth')}</span>
                        </>
                      )}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {included == null
                      ? tp('unlimitedContacts')
                      : tp('contactsLine', { count: included })}
                  </p>

                  <div className="mt-auto pt-4">
                    {plan === 'organization' && !isCurrent ? (
                      // Organisation is sales-led ("Talk to us") — not self-serve
                      // checkout. Route to a contact email rather than Stripe.
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          window.location.href = ORG_ENQUIRY_MAILTO
                        }}
                      >
                        {t('talkToUs')}
                      </Button>
                    ) : selectable ? (
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!!checkoutLoading}
                        onClick={() => handleUpgrade(plan)}
                      >
                        {checkoutLoading === plan ? t('redirecting') : t('selectPlan')}
                      </Button>
                    ) : isCurrent ? (
                      <div className="rounded-md border border-dashed py-1.5 text-center text-xs text-muted-foreground">
                        {t('currentPlanBadge')}
                      </div>
                    ) : (
                      <p className="py-1 text-center text-xs text-muted-foreground">
                        {plan === 'free' ? t('cancelToDowngrade') : t('contactToDowngrade')}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <PlanComparison currentPlan={currentPlanId} />

          <p className="text-xs text-muted-foreground">{t('stripeNotice')}</p>
        </CardContent>
      </Card>

      {/* Cancel confirmation */}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {periodEndDate
                ? t('cancelConfirm', { date: fmt.date(periodEndDate) })
                : t('cancelConfirmGeneric')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keepSubscription')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleCancel}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? t('cancelling') : t('cancelSubscription')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ─── invoices section ─────────────────────────────────────────────────────────

function InvoicesSection({ teamId, hasGateway }: { teamId: string; hasGateway: boolean }) {
  const t = useTranslations('Billing')
  const fmt = useTeamFormat()
  // UX-5/UX-6: `getSaasInvoices` throws `internal` when the Stripe fetch fails,
  // and this list used to fall through to "No invoices yet" — an owner who was
  // billed last month would be told she never was. A failed fetch is not an
  // empty result; say so, and offer the retry.
  const { data: invoices = [], isLoading, isError, error, refetch } = useInvoices(teamId, hasGateway)

  if (!hasGateway) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {t('invoices')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded" />
            ))}
          </div>
        ) : isError ? (
          <QueryErrorState
            title={t('invoicesError')}
            detail={error instanceof Error ? error.message : null}
            onRetry={() => void refetch()}
          />
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('noInvoices')}</p>
        ) : (
          <div className="divide-y">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{formatCurrency(inv.amount, inv.currency)}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmt.date(new Date(inv.created))}
                  </p>
                </div>
                <Badge
                  variant={inv.status === 'paid' ? 'default' : 'outline'}
                  className="text-xs capitalize"
                >
                  {inv.status}
                </Badge>
                <div className="flex items-center gap-1.5">
                  {inv.hostedUrl && (
                    <a
                      href={inv.hostedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      {t('invoiceView')}
                    </a>
                  )}
                  {inv.pdfUrl && (
                    <a
                      href={inv.pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── org-managed banner ───────────────────────────────────────────────────────

function ManagedByOrgBanner({ orgId }: { orgId: string }) {
  const { data: orgDoc } = useQuery<{ name: string } | null>({
    queryKey: ['org-name', orgId],
    queryFn: async () => {
      const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
      return snap.exists() ? { name: snap.data().name as string } : null
    },
  })

  return (
    <div className="rounded-lg border bg-muted/40 p-5 flex items-start gap-3">
      <CreditCard className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
      <div>
        <p className="font-medium text-sm">Billing managed by organization</p>
        {orgDoc?.name && (
          <p className="text-sm text-muted-foreground mt-0.5">
            Your plan is managed by <strong>{orgDoc.name}</strong>. Contact your organization
            administrator for billing details or plan changes.
          </p>
        )}
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { user, currentTeamId, team } = useAuth()
  const t = useTranslations('Billing')

  const { data: isOwner, isLoading: roleLoading } = useIsOwner(currentTeamId, user?.uid ?? null)
  const { data: sub, isLoading: subLoading } = useSubscription(currentTeamId)

  if (roleLoading || subLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight mb-1">{t('title')}</h1>
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">{t('ownerOnly')}</p>
        </div>
      </div>
    )
  }

  const orgId = team?.org_id
  if (orgId) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('subtitle')}</p>
        </div>
        <ManagedByOrgBanner orgId={orgId} />
      </div>
    )
  }

  const hasGateway = !!sub?.gateway_type

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t('subtitle')}</p>
      </div>

      <Suspense fallback={null}>
        <CheckoutBanner />
      </Suspense>

      <SubscriptionCard sub={sub ?? null} team={team} teamId={currentTeamId!} />
      <InvoicesSection teamId={currentTeamId!} hasGateway={hasGateway} />
    </div>
  )
}
