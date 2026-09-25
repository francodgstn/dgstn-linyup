'use client'

// ─── PLANS: ONE CARD PER THING THE CONTACT HOLDS ─────────────────────────────
//
// docs/multi-plan-holdings.md §5, "Current segment — one Plans list". The
// Current segment used to show three separate boxes: a "Subscription" box that
// read the legacy single plan slot, a credits box, and a Stripe billing list.
// A member on two Stripe memberships read "Subscription: Starter" in the first
// box and "Elite · Starter" in the third, and nothing said which was true.
//
// Now there is one list, read from the plan-list mirror (`held_plans`, through
// `currentHeldPlans`, the one "held now" comparison), and a plan and the billing
// that pays for it are ONE card: the card leads with the plan, then its billing,
// and its menu acts on that holding alone. A Stripe card freezes, resumes or
// cancels THAT subscription; a grant card changes or ends THAT grant; a credit
// pack card grants more. Nothing here cancels billing the reader did not name.
//
// The mirror is written by a trigger AFTER a change lands, and the contact is
// read once rather than listened to, so every action re-reads the contact now
// and again a few seconds later (`refreshSoon`).

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { Ban, CalendarX, Ellipsis, Pencil, Play, Plus, Snowflake, Ticket } from 'lucide-react'
import { toast } from 'sonner'
import { currentHeldPlans, subscriptionIsCancelling } from '@linyup/shared'
import type { Contact, HeldPlan, MemberSubscription } from '@linyup/shared'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { formatCurrency } from '@/lib/format'
import { callFunction } from '@/lib/callFunction'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  useCancelMemberSubscription,
  useContactMemberSubscriptions,
  usePauseMemberSubscription,
  useResumeMemberSubscription,
} from '@/components/contacts/MemberSubscriptionsSection'
import { SubscriptionCancellationNote } from '@/components/payments/SubscriptionCancellationNote'

const LIVE_STRIPE = ['active', 'trialing', 'past_due', 'paused']

/** The status chip, only when the status is NOT the normal one. */
const STATUS_TONE: Partial<Record<HeldPlan['status'], string>> = {
  trialing: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  past_due: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  paused: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
}

export function PlansList({
  contact,
  teamId,
  currency,
  onAddPlan,
  onChangePlan,
  onGrantCredits,
}: {
  contact: Contact
  teamId: string
  currency: string
  onAddPlan: () => void
  onChangePlan: (plan: HeldPlan) => void
  onGrantCredits: () => void
}) {
  const t = useTranslations('Contacts')
  const tPay = useTranslations('PaymentsDashboard')
  const fmt = useTeamFormat()
  const qc = useQueryClient()
  const { data: subs = [], isLoading } = useContactMemberSubscriptions(teamId, contact.id)
  const pause = usePauseMemberSubscription(teamId, contact.id)
  const resume = useResumeMemberSubscription(teamId, contact.id)
  const cancel = useCancelMemberSubscription(teamId, contact.id)

  const [freezeTarget, setFreezeTarget] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const [endTarget, setEndTarget] = useState<HeldPlan | null>(null)
  const [ending, setEnding] = useState(false)

  const plans = useMemo(() => currentHeldPlans(contact), [contact])
  const subByRef = useMemo(() => {
    const m = new Map<string, MemberSubscription & { id: string }>()
    for (const s of subs) {
      if (s.subscriptionId) m.set(s.subscriptionId, s)
      m.set(s.id, s)
    }
    return m
  }, [subs])
  // Billing that has ENDED keeps its cancellation record in view (when, and
  // why), which is what a studio reviewing a lapsed member asks first.
  const ended = subs.filter(
    (s) => !!s.subscriptionId && !s.duplicate && !LIVE_STRIPE.includes(s.status as string)
  )

  const date = (ms: number | null | undefined) =>
    ms ? fmt.custom(ms, { day: 'numeric', month: 'short', year: 'numeric' }) : null

  function refreshSoon() {
    const run = () => {
      qc.invalidateQueries({ queryKey: ['contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['subscription-history', contact.id] })
    }
    run()
    setTimeout(run, 2500)
    setTimeout(run, 6000)
  }

  async function endGrant(plan: HeldPlan) {
    setEnding(true)
    try {
      const fn = callFunction<{ contactId: string; grantId: string }, { ended: string[] }>(
        'endPlan'
      )
      await fn({ contactId: contact.id, grantId: plan.ref })
      refreshSoon()
      setEndTarget(null)
    } catch (err) {
      console.error('[contact] end plan failed:', err)
      toast.error(t('endPlanError'))
    } finally {
      setEnding(false)
    }
  }

  function sourceLabel(plan: HeldPlan): string {
    if (plan.source === 'stripe') return t('planSource_stripe')
    if (plan.source === 'credits') return t('planSource_credits')
    return t(`planSource_${plan.grant_source ?? 'staff'}` as Parameters<typeof t>[0])
  }

  /** The billing line under the name: what it costs, then when it next moves. */
  function detailLine(plan: HeldPlan, sub?: MemberSubscription): string[] {
    const parts: string[] = []
    if (plan.source === 'credits') {
      parts.push(t('creditsRemaining', { count: plan.credits_remaining ?? 0 }))
      const exp = date(plan.ends_at_ms)
      if (exp) parts.push(t('creditsExpiresOn', { date: exp }))
      return parts
    }
    if (plan.amount != null) {
      parts.push(
        plan.recurrence
          ? `${formatCurrency(plan.amount, currency)} · ${t(`recurrence_${plan.recurrence}` as Parameters<typeof t>[0])}`
          : formatCurrency(plan.amount, currency)
      )
    } else if (plan.recurrence) {
      parts.push(t(`recurrence_${plan.recurrence}` as Parameters<typeof t>[0]))
    }
    const cancelling = plan.status === 'cancelling' || (sub ? subscriptionIsCancelling(sub) : false)
    if (plan.source === 'stripe' && !cancelling && plan.next_charge_at_ms && !sub?.pause_collection) {
      parts.push(t('planNextCharge', { date: date(plan.next_charge_at_ms)! }))
    } else if (!cancelling && plan.ends_at_ms) {
      parts.push(t('planEndsOn', { date: date(plan.ends_at_ms)! }))
    }
    return parts
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('plansHeading')}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onGrantCredits}>
            <Ticket className="mr-1.5 h-4 w-4" />
            {t('grantCredits')}
          </Button>
          <Button size="sm" onClick={onAddPlan}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('addPlan')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : plans.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noPlans')}
        </div>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {plans.map((plan) => {
            const sub = plan.source === 'stripe' ? subByRef.get(plan.ref) : undefined
            const paused = plan.status === 'paused' || !!sub?.pause_collection
            const cancelling =
              plan.status === 'cancelling' || (sub ? subscriptionIsCancelling(sub) : false)
            const endsOn = cancelling ? date(plan.ends_at_ms) : null
            const tone = STATUS_TONE[paused ? 'paused' : plan.status]
            const stripeId = sub?.id ?? plan.ref
            const canFreeze =
              plan.source === 'stripe' &&
              !paused &&
              (plan.status === 'active' || plan.status === 'trialing')
            const canCancel = plan.source === 'stripe' && !cancelling
            // A billing that is already winding down has nothing left to do
            // here, and an empty menu is worse than no menu.
            const hasActions =
              plan.source !== 'stripe' || canFreeze || paused || canCancel
            return (
              <div key={`${plan.source}-${plan.ref}`} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="truncate text-sm font-medium">
                      {plan.subscription_type_name ?? t('subscriptionHeadingCard')}
                    </p>
                    <span className="text-xs text-muted-foreground">{sourceLabel(plan)}</span>
                    {tone && (
                      <Badge variant="secondary" className={`text-xs ${tone}`}>
                        {tPay(
                          `subStatus_${paused ? 'paused' : plan.status}` as Parameters<typeof tPay>[0]
                        )}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {detailLine(plan, sub).join(' · ')}
                  </p>
                  {cancelling && (
                    <p className="mt-0.5 text-xs text-amber-600">
                      {endsOn ? tPay('subCancelsOn', { date: endsOn }) : tPay('subCancelsAtPeriodEnd')}
                    </p>
                  )}
                  {sub && <SubscriptionCancellationNote subscription={sub} audience="studio" />}
                </div>

                {hasActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t('planActions')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Ellipsis className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {plan.source === 'grant' && (
                      <>
                        <DropdownMenuItem onClick={() => onChangePlan(plan)}>
                          <Pencil className="h-3.5 w-3.5" />
                          {t('changePlan')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setEndTarget(plan)}
                          className="text-destructive focus:text-destructive"
                        >
                          <CalendarX className="h-3.5 w-3.5" />
                          {t('endPlan')}
                        </DropdownMenuItem>
                      </>
                    )}
                    {plan.source === 'credits' && (
                      <DropdownMenuItem onClick={onGrantCredits}>
                        <Ticket className="h-3.5 w-3.5" />
                        {t('grantCredits')}
                      </DropdownMenuItem>
                    )}
                    {plan.source === 'stripe' && (
                      <>
                        {canFreeze && (
                          <DropdownMenuItem onClick={() => setFreezeTarget(stripeId)}>
                            <Snowflake className="h-3.5 w-3.5" />
                            {tPay('freezeBilling')}
                          </DropdownMenuItem>
                        )}
                        {paused && (
                          <DropdownMenuItem
                            onClick={() => resume.mutate(stripeId, { onSuccess: refreshSoon })}
                          >
                            <Play className="h-3.5 w-3.5" />
                            {tPay('resumeBilling')}
                          </DropdownMenuItem>
                        )}
                        {canCancel && (
                          <>
                            {(canFreeze || paused) && <DropdownMenuSeparator />}
                            <DropdownMenuItem
                              onClick={() => setCancelTarget(stripeId)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Ban className="h-3.5 w-3.5" />
                              {tPay('cancelBilling')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                )}
              </div>
            )
          })}
        </div>
      )}

      {ended.length > 0 && (
        <div className="pt-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('endedBillingHeading')}</p>
          <div className="divide-y rounded-xl border">
            {ended.map((s) => (
              <div key={s.id} className="px-4 py-2.5">
                <p className="text-sm text-muted-foreground">
                  {s.subscriptionTypeName ?? s.subscriptionId}
                </p>
                <SubscriptionCancellationNote subscription={s} audience="studio" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Freeze: reversible, so a light confirm. */}
      <AlertDialog open={freezeTarget !== null} onOpenChange={(o) => !o && setFreezeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPay('freezeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tPay('freezeConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tPay('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (freezeTarget) pause.mutate(freezeTarget, { onSuccess: refreshSoon })
                setFreezeTarget(null)
              }}
              disabled={pause.isPending}
            >
              {tPay('freezeConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel billing: its own dialog, never the freeze one with another verb. */}
      <AlertDialog open={cancelTarget !== null} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPay('cancelBillingConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tPay('cancelBillingConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tPay('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelTarget) cancel.mutate(cancelTarget, { onSuccess: refreshSoon })
                setCancelTarget(null)
              }}
              disabled={cancel.isPending}
            >
              {tPay('cancelBillingConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* End a grant: it moves no money, and says so. */}
      <AlertDialog open={endTarget !== null} onOpenChange={(o) => !o && setEndTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('endPlanConfirmTitle', {
                name: endTarget?.subscription_type_name ?? t('subscriptionHeadingCard'),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('endPlanConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => endTarget && void endGrant(endTarget)}
              disabled={ending}
            >
              {t('endPlan')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
