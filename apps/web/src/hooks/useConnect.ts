'use client'

// Client hooks for the Stripe Connect feature (member → studio payments).
// All writes go through Cloud Functions; reads of the payment list come straight
// from Firestore (function-written, rules allow manager/owner reads).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { httpsCallable } from 'firebase/functions'
import { Timestamp, collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import { db, functions } from '@/lib/firebase'
import { usePaymentMutationErrorToast } from './usePaymentErrorToast'
import {
  detectByoStripeDoubleRecording,
  type ByoStripeDoubleRecordingSignal,
  MEMBER_PAYMENTS_SUBCOLLECTION,
  MEMBER_SUBSCRIPTIONS_SUBCOLLECTION,
  PARTNER_VISITS_SUBCOLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type ConnectAccountStatus,
  type ConnectOnboardingModel,
  type ExternalPayment,
  type MemberPayment,
  type MemberPaymentEffectsReversal,
  type MemberSubscription,
  type PartnerVisit,
  type PaymentLineItem,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
} from '@linyup/shared'

/** The browser origin to send to checkout/onboarding callables so Stripe returns
 * here (localhost in dev) instead of the env-configured hosting URL. */
function clientOrigin(): string | undefined {
  return typeof window !== 'undefined' ? window.location.origin : undefined
}

export interface ConnectStatusResult {
  connected: boolean
  accountId?: string
  model?: ConnectOnboardingModel
  status?: ConnectAccountStatus
  charges_enabled?: boolean
  payouts_enabled?: boolean
  details_submitted?: boolean
  capabilities?: Record<string, string>
  requirements_currently_due?: string[]
  /** Linyup takes no platform fee from this studio — resolved server-side. */
  feeWaived?: boolean
}

/** Live account status (refreshes from Stripe). Only call when the feature flag is on. */
export function useConnectStatus(teamId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['connect-status', teamId],
    enabled: !!teamId && enabled,
    queryFn: async (): Promise<ConnectStatusResult> => {
      const fn = httpsCallable<{ teamId: string }, ConnectStatusResult>(functions, 'getConnectStatus')
      return (await fn({ teamId: teamId! })).data
    },
  })
}

export function useStartConnectOnboarding() {
  const onError = usePaymentMutationErrorToast()
  return useMutation({
    // No `model`: onboarding produces one kind of account, so the caller has
    // nothing to choose. See the note on ConnectOnboardingModel in @linyup/shared.
    mutationFn: async (vars: { teamId: string; locale?: string }) => {
      const fn = httpsCallable<
        { teamId: string; locale?: string; origin?: string },
        { accountId: string; model: ConnectOnboardingModel; url: string }
      >(functions, 'startConnectOnboarding')
      return (await fn({ ...vars, origin: clientOrigin() })).data
    },
    onError,
  })
}

/**
 * Unlink the team's Stripe account so a different one can be onboarded.
 *
 * Invalidates the STATUS query rather than mutating it: the callable is the
 * authority on what the team now has, and the card's whole shape is derived
 * from it.
 */
export function useDisconnectConnectAccount() {
  const qc = useQueryClient()
  const onError = usePaymentMutationErrorToast()
  return useMutation({
    mutationFn: async (vars: { teamId: string }) => {
      const fn = httpsCallable<{ teamId: string }, { ok: boolean; disconnected: boolean }>(
        functions,
        'disconnectConnectAccount'
      )
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['connect-status', vars.teamId] })
      qc.invalidateQueries({ queryKey: ['team', vars.teamId] })
    },
    onError,
  })
}

export function useCreateMembershipPayment() {
  const onError = usePaymentMutationErrorToast()
  return useMutation({
    mutationFn: async (vars: {
      teamId: string
      subscriptionTypeId: string
      priceId: string
      contactId?: string
      customerEmail?: string
      locale?: string
    }) => {
      const fn = httpsCallable<
        typeof vars & { origin?: string },
        { url: string; sessionId: string; recurring: boolean }
      >(functions, 'createMembershipPayment')
      return (await fn({ ...vars, origin: clientOrigin() })).data
    },
    onError,
  })
}

/** True when the team has any BYO payment gateway (Payrexx / Stripe-BYO)
 * configured — used to surface the Payments nav even without Stripe Connect. */
export function useHasByoGateway(teamId: string | null) {
  return useQuery({
    queryKey: ['has-byo-gateway', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<boolean> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, TEAM_INTEGRATIONS_SUBCOLLECTION),
          where('type', '==', 'payment_gateway'),
          limit(1)
        )
      )
      return !snap.empty
    },
  })
}

/**
 * Payments are an EVENT LOG, so they are read through a WINDOW.
 *
 * ── WHY A WINDOW AND NOT JUST A BIGGER LIMIT ────────────────────────────────
 * The page's search box filters the rows already loaded. With a bare `limit`
 * that made the search a liar at scale: a studio taking daily payments searches
 * for a member, the match is 400 rows back, and the screen says "No payments" —
 * which reads as "that payment does not exist" rather than "not in what I
 * fetched". A window is honest because the UI can NAME it ("the last 3
 * months") and offer to widen it, which a limit cannot: nobody can be told
 * "your match is past row 50".
 *
 * `sinceMs` is a single-field range on the same field the query already orders
 * by, so it needs no composite index.
 *
 * The subscriptions list is deliberately NOT windowed — see
 * `useMemberSubscriptions` for why a roster and a log want opposite treatment.
 */
export function useMemberPayments(
  teamId: string | null,
  pageLimit = 50,
  sinceMs: number | null = null
) {
  return useQuery({
    queryKey: ['member-payments', teamId, pageLimit, sinceMs],
    enabled: !!teamId,
    queryFn: async (): Promise<MemberPayment[]> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, MEMBER_PAYMENTS_SUBCOLLECTION),
          ...(sinceMs !== null
            ? [where('created_at', '>=', Timestamp.fromMillis(sinceMs))]
            : []),
          orderBy('created_at', 'desc'),
          limit(pageLimit)
        )
      )
      return snap.docs.map((d) => d.data() as MemberPayment)
    },
  })
}

/**
 * Every member subscription on the team.
 *
 * NO PAGE LIMIT, deliberately — it had a hard `limit(50)` and no "load more",
 * so a studio with 60 memberships saw 50 of them and nothing on the screen said
 * so. Silent truncation on a money surface is the worst of the three ways this
 * could be wrong.
 *
 * Unbounded is safe here in a way it would NOT be for payments, and the
 * difference is what each collection IS. A subscription list is a ROSTER: one
 * row per member holding a plan, bounded by headcount, and a membership sold
 * two years ago is still live today so there is no honest window to cut it at.
 * Payments are an EVENT LOG that only grows, which is why that side is time
 * bounded instead.
 *
 * Cancelled subscriptions accumulate, so this is headcount plus churn rather
 * than headcount alone. If it ever becomes a problem the fix is a status filter
 * in the query, not a bare limit that hides rows without saying which.
 */
export function useMemberSubscriptions(teamId: string | null) {
  return useQuery({
    queryKey: ['member-subscriptions', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<MemberSubscription[]> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, MEMBER_SUBSCRIPTIONS_SUBCOLLECTION),
          orderBy('created_at', 'desc')
        )
      )
      return snap.docs.map((d) => d.data() as MemberSubscription)
    },
  })
}


export function useRefundMemberPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: {
      teamId: string
      paymentIntentId: string
      amount?: number
      reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer'
    }) => {
      const fn = httpsCallable<
        typeof vars,
        {
          refundId: string
          status: string | null
          /** What happened to the ACCESS the payment bought. `state: 'failed'`
           *  means the money went back and the entitlement did not — the caller
           *  must surface it, because nothing else will. */
          reversal: MemberPaymentEffectsReversal | null
        }
      >(functions, 'refundMemberPayment')
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ['member-payments', vars.teamId] }),
  })
}

/** BYO ledger (Payrexx / Stripe-BYO) for the team — function-written, rules allow
 * manager/owner reads. Includes unassigned payments (no contact matched). */
export function usePaymentEvents(
  teamId: string | null,
  pageLimit = 100,
  sinceMs: number | null = null
) {
  return useQuery({
    queryKey: ['payment-events', teamId, pageLimit, sinceMs],
    enabled: !!teamId,
    queryFn: async (): Promise<Array<ExternalPayment & { id: string }>> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, PAYMENT_EVENTS_SUBCOLLECTION),
          // The BYO rail orders by its own timestamp; same single-field range.
          ...(sinceMs !== null
            ? [where('processed_at', '>=', Timestamp.fromMillis(sinceMs))]
            : []),
          orderBy('processed_at', 'desc'),
          limit(pageLimit)
        )
      )
      return snap.docs.map((d) => ({ ...(d.data() as ExternalPayment), id: d.id }))
    },
  })
}

/**
 * Is the team's BYO Stripe endpoint delivering BOTH event families — i.e. is it
 * recording every recurring payment twice?
 *
 * A READING, never a repair. `raw_status` on a recorded row is the literal
 * Stripe event type that wrote it, so this is a stored fact rather than a
 * guess; the resolver (`detectByoStripeDoubleRecording`, shared + unit-tested)
 * counts families and deliberately never pairs two rows as "the same money".
 * See docs/open-defects.md → "A BYO studio can double-count its own recurring
 * revenue" for why merging them is refused rather than unimplemented.
 *
 * Same shape of read as `usePaymentEvents` (one ordered page, no composite
 * index), under its own key so the two never fight over a cache entry.
 */
export function useByoStripeDoubleRecording(teamId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['byo-stripe-double-recording', teamId],
    enabled: !!teamId && enabled,
    queryFn: async (): Promise<ByoStripeDoubleRecordingSignal> => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, PAYMENT_EVENTS_SUBCOLLECTION),
          orderBy('processed_at', 'desc'),
          limit(200)
        )
      )
      return detectByoStripeDoubleRecording(
        snap.docs.map((d) => {
          const row = d.data() as ExternalPayment
          const at = row.processed_at as { toDate?: () => Date } | null | undefined
          return {
            gateway: row.gateway,
            raw_status: row.raw_status,
            processedAtMs: at?.toDate?.().getTime() ?? null,
          }
        })
      )
    },
  })
}

/** A single contact's payments across both rails (Connect member_payments +
 * BYO payment_events). Filtered by id only (no orderBy → no composite index);
 * the caller sorts client-side. */
export function useContactPayments(teamId: string | null, contactId: string | null) {
  return useQuery({
    queryKey: ['contact-payments', teamId, contactId],
    enabled: !!teamId && !!contactId,
    queryFn: async (): Promise<{
      payments: MemberPayment[]
      events: Array<ExternalPayment & { id: string }>
    }> => {
      const [connectSnap, byoSnap] = await Promise.all([
        getDocs(
          query(
            collection(db, TEAMS_COLLECTION, teamId!, MEMBER_PAYMENTS_SUBCOLLECTION),
            where('contactId', '==', contactId!)
          )
        ),
        getDocs(
          query(
            collection(db, TEAMS_COLLECTION, teamId!, PAYMENT_EVENTS_SUBCOLLECTION),
            where('contact_id', '==', contactId!)
          )
        ),
      ])
      return {
        payments: connectSnap.docs.map((d) => d.data() as MemberPayment),
        events: byoSnap.docs.map((d) => ({ ...(d.data() as ExternalPayment), id: d.id })),
      }
    },
  })
}

/** Reasons `updatePaymentRecord` refuses that the CALLER is expected to render —
 *  a rule the manager can act on, not a failure. The generic money-error toast
 *  would bury each of them under "Something went wrong". */
const REASSIGN_REFUSALS: Record<string, 'reassignConsumedPack' | 'reassignVoided' | 'reassignFailed'> =
  {
    consumed_pack_reassign: 'reassignConsumedPack',
    payment_voided: 'reassignVoided',
    reassign_reversal_failed: 'reassignFailed',
    reassign_apply_failed: 'reassignFailed',
  }

/** (Re)assign the contact, edit the comment, and/or set the line-item on a
 * Connect or BYO payment. */
export function useUpdatePaymentRecord() {
  const qc = useQueryClient()
  const t = useTranslations('PaymentsDashboard')
  const onPaymentError = usePaymentMutationErrorToast()
  return useMutation({
    mutationFn: async (vars: {
      teamId: string
      source: 'connect' | 'byo'
      paymentId: string
      contactId?: string | null
      comment?: string | null
      lineItem?: PaymentLineItem | null
      // Tell the buyer what they now hold (UX-80). Omitted ⇒ no mail.
      sendReceipt?: boolean
    }) => {
      const fn = httpsCallable<typeof vars, { ok: boolean; contactId: string | null }>(
        functions,
        'updatePaymentRecord'
      )
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['member-payments', vars.teamId] })
      qc.invalidateQueries({ queryKey: ['payment-events', vars.teamId] })
      qc.invalidateQueries({ queryKey: ['contact-payments'] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
    },
    onError: (err: unknown) => {
      const details = (err as { details?: { reason?: string; unitsConsumed?: number } }).details
      const key = details?.reason ? REASSIGN_REFUSALS[details.reason] : undefined
      if (key) {
        toast.error(t(key, { used: details?.unitsConsumed ?? 0 }))
        return
      }
      onPaymentError(err)
    },
  })
}

/** Void a manual payment record ("this was recorded by mistake"). Takes back
 *  what the record gave; moves no money. Manual rows only — enforced server-side
 *  because the gateway rails' rows describe money we do not control. */
export function useVoidManualPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { teamId: string; paymentId: string; reason?: string | null }) => {
      const fn = httpsCallable<
        typeof vars,
        {
          ok: boolean
          /** What was taken back, or null when the row was unassigned. */
          reversal: {
            subscription: string
            credits: string
            creditsRevoked: number
            course: string
          } | null
        }
      >(functions, 'voidManualPayment')
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['payment-events', vars.teamId] })
      qc.invalidateQueries({ queryKey: ['contact-payments'] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
      qc.invalidateQueries({ queryKey: ['dashboard-monthly-revenue', vars.teamId] })
    },
  })
}

/** Current-month partner (aggregator) visit payout ledger — reporting only
 * (teams/{teamId}/partner_visits). Filtered by created_at only (no composite
 * index); status is filtered client-side. */
export function usePartnerVisits(teamId: string | null) {
  return useQuery({
    queryKey: ['partner-visits', teamId],
    enabled: !!teamId,
    queryFn: async (): Promise<PartnerVisit[]> => {
      const startOfMonth = new Date()
      startOfMonth.setDate(1)
      startOfMonth.setHours(0, 0, 0, 0)
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, PARTNER_VISITS_SUBCOLLECTION),
          where('created_at', '>=', startOfMonth),
          orderBy('created_at', 'desc'),
          limit(200)
        )
      )
      return snap.docs.map((d) => d.data() as PartnerVisit)
    },
  })
}

/** Record a manual cash / bank-transfer payment into the unified ledger. */
export function useRecordManualPayment() {
  const qc = useQueryClient()
  const onError = usePaymentMutationErrorToast()
  return useMutation({
    mutationFn: async (vars: {
      teamId: string
      contactId?: string | null
      amount: number
      currency?: string
      occurredAt?: number
      paymentMode?: string
      lineItem?: PaymentLineItem | null
      comment?: string | null
      // Minted once per dialog opening, so a double-click writes ONE payment row
      // (the server creates the doc under this key) and therefore mails once.
      idempotencyKey?: string
      // Tell the buyer what they now hold (UX-80). Omitted ⇒ no mail.
      sendReceipt?: boolean
    }) => {
      const fn = httpsCallable<typeof vars, { id: string; duplicate?: boolean }>(
        functions,
        'recordManualPayment'
      )
      return (await fn(vars)).data
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['payment-events', vars.teamId] })
      qc.invalidateQueries({ queryKey: ['contact-payments'] })
      qc.invalidateQueries({ queryKey: ['contacts'] })
    },
    onError,
  })
}
