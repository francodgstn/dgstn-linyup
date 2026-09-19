'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useParams, useSearchParams } from 'next/navigation'
import { db } from '@/lib/firebase'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { useOrg } from '@/contexts/OrgContext'
import { useQuery } from '@tanstack/react-query'
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
import { CreditCard, CheckCircle2, AlertTriangle, FileText, ExternalLink } from 'lucide-react'
import {
  ORGANIZATIONS_COLLECTION,
  ORG_TEAMS_SUBCOLLECTION,
  orgMonthlyForStudios,
  subscriptionEndsAt,
  subscriptionIsCancelling,
} from '@linyup/shared'
import { SubscriptionCancellationNote } from '@/components/payments/SubscriptionCancellationNote'
import {
  useCancelSaasSubscription,
  useCreateOrgCheckoutSession,
  useOpenBillingPortal,
  useReactivateSaasSubscription,
} from '@/hooks/useSaasBilling'
import { callFunction } from '@/lib/callFunction'

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

// ─── helpers ──────────────────────────────────────────────────────────────────

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'active') return 'default'
  if (status === 'trial') return 'secondary'
  if (status === 'past_due' || status === 'cancelled') return 'destructive'
  return 'outline'
}

function formatDate(ts: { seconds: number } | null | undefined) {
  if (!ts) return ''
  return new Date(ts.seconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount / 100)
}

// ─── invoices ─────────────────────────────────────────────────────────────────

function InvoicesSection({
  orgId,
  hasGateway,
  comped,
}: {
  orgId: string
  hasGateway: boolean
  /** A comped organisation is never charged. Nothing to fetch, nothing to show. */
  comped: boolean
}) {
  const t = useTranslations('OrgBilling')
  // A comped organisation is never charged, so it has nothing to list — and
  // fetching anyway is what put "open invoices" in front of HMD.
  const { data: invoices = [], isLoading } = useQuery<Invoice[]>({
    queryKey: ['saas-invoices', orgId],
    enabled: hasGateway && !comped,
    queryFn: async () => {
      // getOrgInvoices, not getSaasInvoices: the latter guards on team ownership,
      // so an org id put through it was refused and this list rendered as
      // "No invoices yet" — a wrong answer with no way to see through it (UX-75).
      const fn = callFunction<{ orgId: string }, { invoices: Invoice[] }>('getOrgInvoices')
      const result = await fn({ orgId })
      return result.data.invoices
    },
  })

  if (!hasGateway || comped) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {t('invoicesTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
          </div>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">{t('noInvoices')}</p>
        ) : (
          <div className="divide-y">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{formatCurrency(inv.amount, inv.currency)}</p>
                  <p className="text-xs text-muted-foreground">{new Date(inv.created).toLocaleDateString()}</p>
                </div>
                <Badge variant={inv.status === 'paid' ? 'default' : 'outline'} className="text-xs capitalize">
                  {inv.status}
                </Badge>
                <div className="flex items-center gap-1.5">
                  {inv.hostedUrl && (
                    <a href={inv.hostedUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-foreground underline">
                      {t('invoiceView')}
                    </a>
                  )}
                  {inv.pdfUrl && (
                    <a href={inv.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
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

// ─── page ─────────────────────────────────────────────────────────────────────

export default function OrgBillingPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const t = useTranslations('OrgBilling')
  const searchParams = useSearchParams()
  const checkoutResult = searchParams.get('checkout')

  const { org, subscription, loading, isAdmin } = useOrg()
  const [cancelOpen, setCancelOpen] = useState(false)

  // UX-73: the four billing callables were inline `httpsCallable` calls reporting
  // through a hand-rolled green banner that printed the RAW ENGLISH server
  // message to a French, German or Italian owner — and invalidated nothing, so a
  // successful cancel left the badge saying "active" until a reload. They are the
  // shared hook's mutations now (hooks/useSaasBilling.ts): code-matched reasons,
  // translated copy, a success toast, and invalidation of the key OrgProvider
  // actually caches this org's subscription under.
  const invalidateKeys = (id: string) => [['org-subscription', id]]
  const checkout = useCreateOrgCheckoutSession()
  const cancel = useCancelSaasSubscription({ scope: 'org', invalidateKeys })
  const reactivate = useReactivateSaasSubscription({ scope: 'org', invalidateKeys })
  const billingPortal = useOpenBillingPortal({ scope: 'org' })
  // One flag per action instead of one shared `actionLoading`: a failed cancel
  // used to leave every other button disabled for the length of its own request.
  const actionPending =
    checkout.isPending || cancel.isPending || reactivate.isPending || billingPortal.isPending

  function handleCancel() {
    // `AlertDialogAction` is a plain Button here (components/ui/alert-dialog.tsx),
    // so the dialog closes only where we close it: on SUCCESS. A failed cancel
    // keeps the confirmation standing behind its toast instead of dismissing as
    // though it had worked. Same rule as settings/billing.
    cancel.mutate(orgId, { onSuccess: () => setCancelOpen(false) })
  }

  // ── IS THIS ORGANISATION BILLED AT ALL? ──────────────────────────────────
  // `flags.comped` means the platform agreed to bill it nothing, indefinitely.
  // Everything below it on this page — the status badge, the Subscribe button,
  // the invoice list — is written for an organisation that pays, and shown to
  // one that does not it is a screen full of wrong answers. HMD read "open
  // invoices" on staging for exactly this reason (Franco, 2026-09-05).
  //
  // The callables already refuse a comped tenant (`assertNotComped`), so this is
  // the display catching up with a decision the server had already made.
  const comped = org?.flags?.comped === true

  // What it WOULD cost, struck through — the point is not to hide the price but
  // to show what is being waived. Counted from the roster because the
  // organisation tier is priced per studio; the minimum applies below two.
  const { data: studioCount = 0 } = useQuery<number>({
    queryKey: ['org-active-teams-count', orgId],
    enabled: !!orgId && comped,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, ORGANIZATIONS_COLLECTION, orgId, ORG_TEAMS_SUBCOLLECTION),
          where('status', '==', 'active')
        )
      )
      return snap.size
    },
  })

  const status = subscription?.status ?? 'trial'
  const hasActiveSubscription = status === 'active' || status === 'past_due'
  // The ONE shared predicate, so this page and settings/billing cannot drift on
  // what "cancels at period end" means or when it lands.
  //
  // WHETHER and WHEN are two questions, and this page must not fuse them. Asking
  // `subscriptionEndsAt(...) !== null` additionally demands a DATE — and a
  // cancelling saas_subscriptions doc from the pre-fix window carries the boolean
  // and no date at all (see shared/utils/subscriptionLifecycle.ts), so fusing
  // them hid "Reactivate" from exactly the orgs that are cancelled and still
  // live. The date is shown when we have it and simply omitted when we do not.
  const isCancelling = subscriptionIsCancelling(subscription)
  const endsAt = subscriptionEndsAt(subscription) as { seconds: number } | null
  const hasGateway = !!subscription?.gateway_type

  const periodStart = subscription?.current_period_start as { seconds: number } | null | undefined
  const periodEnd = subscription?.current_period_end as { seconds: number } | null | undefined

  return (
    <div className="space-y-6">
      {checkoutResult === 'success' && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-green-50 text-green-800 border border-green-200 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t('checkoutSuccess')}
        </div>
      )}

      <PageHeader title={t('title')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            {t('planLabel')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : comped ? (
            /* NOT BILLED. Deliberately static: no status badge (there is no
               subscription to have a status), no Subscribe, no cancel, no
               billing portal. An action here would either fail at the callable
               or start charging an organisation that was promised it would not
               be. */
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-lg">Organization</span>
                <Badge
                  variant="secondary"
                  className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
                >
                  {t('compedBadge')}
                </Badge>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-muted-foreground line-through">
                  {formatCurrency(orgMonthlyForStudios(studioCount) * 100, 'CHF')}
                  {t('perMonthSuffix')}
                </span>
                <span className="text-lg font-semibold">{t('compedFree')}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {org?.flags?.comped_reason?.trim() || t('compedNote')}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-lg capitalize">Organization</span>
                <Badge variant={statusVariant(status)}>
                  {status === 'trial' ? t('statusTrial')
                    : status === 'active' ? t('statusActive')
                    : status === 'past_due' ? t('statusPastDue')
                    : status === 'expired' ? t('statusExpired')
                    : t('statusCancelled')}
                </Badge>
                {isCancelling && (
                  <Badge variant="outline" className="text-amber-600 border-amber-300">
                    {t('cancelAtPeriodEnd')}
                  </Badge>
                )}
              </div>

              {/* Trial end */}
              {status === 'trial' && subscription?.trial_ends_at && (
                <p className="text-sm text-muted-foreground">
                  {t('trialEnds', { date: formatDate(subscription.trial_ends_at as { seconds: number }) })}
                </p>
              )}

              {/* Billing period */}
              {status !== 'trial' && periodStart && periodEnd && (
                <p className="text-sm text-muted-foreground">
                  {t('periodLabel')}: {formatDate(periodStart)} – {formatDate(periodEnd)}
                </p>
              )}

              {/* Access until (cancelling) */}
              {endsAt && (
                <p className="text-sm text-amber-600">
                  {t('activeUntil', { date: formatDate(endsAt) })}
                </p>
              )}

              {/* …and why. Same component and same copy as settings/billing —
                  two org owners must not read two different sentences about the
                  same Stripe field. */}
              <SubscriptionCancellationNote subscription={subscription} audience="self" />

              {/* Trial ended (handleTrialLifecycle phase 2). The studios this
                  organisation was paying for are on Free and unlinked — say so,
                  because the org's Studios tab is now empty and nothing else on
                  this page would explain why. */}
              {status === 'expired' && (
                <div className="rounded-md bg-muted px-3 py-2.5 flex items-start gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {t('expiredNotice')}
                </div>
              )}

              {/* Past due warning */}
              {status === 'past_due' && (
                <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2.5 flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {t('pastDueWarning')}
                </div>
              )}

              {isAdmin && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {!hasActiveSubscription && !isCancelling && (
                    <Button onClick={() => checkout.mutate(orgId)} disabled={actionPending}>
                      {checkout.isPending ? '…' : t('upgradeButton')}
                    </Button>
                  )}
                  {isCancelling && (
                    <Button
                      variant="outline"
                      onClick={() => reactivate.mutate(orgId)}
                      disabled={actionPending}
                    >
                      {reactivate.isPending ? '…' : t('reactivate')}
                    </Button>
                  )}
                  {hasActiveSubscription && hasGateway && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        billingPortal.mutate({ id: orgId, returnUrl: window.location.href })
                      }
                      disabled={actionPending}
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      {t('updatePayment')}
                    </Button>
                  )}
                  {hasActiveSubscription && !isCancelling && (
                    <Button
                      variant="outline"
                      onClick={() => setCancelOpen(true)}
                      disabled={actionPending}
                    >
                      {t('cancelButton')}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <InvoicesSection orgId={orgId} hasGateway={hasGateway} comped={comped} />

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cancelConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('cancelConfirmMessage')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCancel} disabled={cancel.isPending}>
              {cancel.isPending ? '…' : t('cancelConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
