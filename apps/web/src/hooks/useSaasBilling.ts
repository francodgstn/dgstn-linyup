'use client'

// Linyup's OWN billing — the studio paying Linyup (plan checkout, cancel,
// reactivate, billing portal). This is NOT `useConnect.ts`: that file is the
// member → studio Connect rail, and the `failed-precondition` reasons its error
// mapper names ("Payment account setup is not complete", "No payment account")
// belong to a studio's Stripe Connect account and can never be thrown here.
//
// UX-5 (correction note, 2026-08-17). These four callables were raw inline
// `httpsCallable` calls in settings/billing/page.tsx, each of which caught its
// error, `console.error`d it and returned. The button un-spun, the page did not
// change, and **a cancel that failed looked exactly like a cancel that
// succeeded** until the next reload. They live here now so the error handling
// sits on the mutation DEFINITION — one place, inherited by any future caller.
//
// UX-73 (2026-08-17). The org billing page at (auth)/org/[orgId]/billing was the
// second caller, and it needed two things this file did not have, both added
// rather than forked:
//  • `invalidateKeys` — an org's SaasSubscription doc (the same
//    saas_subscriptions/{id} document) is cached by OrgProvider under
//    ['org-subscription', orgId], not ['saas-subscription', teamId]. Without it
//    a successful cancel toasted and left the badge saying "active".
//  • `scope` — the two messages that NAME the payer ("Only the team owner…",
//    "…for this team") are wrong one floor up, where the payer is an
//    organisation and its admin.
// The org's own checkout is a different callable with different arguments
// (`createOrgCheckoutSession`), so it gets its own mutation below — sharing the
// error mapper, which is the part that was worth sharing.
//
// UX-75 (2026-08-17). `scope` now also picks the CALLABLE, not just the copy.
// The team callables guard with `hasTeamRole(uid, teamId, 'owner')` — a read of
// `teams/{teamId}/team_members/{uid}` — so putting an ORG id through them was
// refused `permission-denied` every time: an org's admins live at
// `organizations/{orgId}/org_members/{uid}`, and an org admin who owns no team
// could not cancel, reactivate or open the portal at all. The server grew a
// second rail (`cancelOrgSubscription`, `reactivateOrgSubscription`,
// `getOrgBillingPortalUrl`, `getOrgInvoices`) with the org guard, and this hook
// dispatches on `scope`. Note the argument names below: the mutation takes `id`
// because the value is a team id or an org id depending on the scope, and
// calling it `teamId` while it held an org id is exactly how UX-75 hid.
//
// Reasons are matched on the callable's CODE, not on its message substring:
// packages/functions/src/saas-billing/index.ts distinguishes its refusals by
// code (`resource-exhausted` for the 3-per-hour checkout limit,
// `permission-denied` for a non-owner, `not-found` for a missing subscription
// doc, `failed-precondition` for a doc with no Stripe id), and the messages are
// English server strings we would only have to re-translate.

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { SaasPlan } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

/** Where to send an owner whose subscription doc is missing its Stripe ids —
 *  the one refusal the server itself answers with "contact support". */
const SUPPORT_MAILTO = 'mailto:hello@linyup.com?subject=Billing%20help'

type SaasBillingAction = 'checkout' | 'cancel' | 'reactivate' | 'portal'

/** Who is paying — a team (Settings → Billing) or an organisation
 *  (org/{orgId}/billing). Only the copy that NAMES the payer differs. */
export type SaasBillingScope = 'team' | 'org'

/** Options every id-taking mutation here accepts. */
export interface SaasBillingOptions {
  scope?: SaasBillingScope
  /** Query keys to invalidate on success, derived from the id the mutation was
   *  called with. Defaults to the team rail's ['saas-subscription', id]; the org
   *  page passes ['org-subscription', id] (OrgProvider's key for the same doc). */
  invalidateKeys?: (id: string) => QueryKey[]
}

function defaultInvalidateKeys(id: string): QueryKey[] {
  return [['saas-subscription', id]]
}

/**
 * The callable for `action` on this scope, plus the payload key its rail names
 * the id with. Two rails, one dispatch point — the alternative was a `scope`
 * that changed the wording of a refusal while still sending the call somewhere
 * that could only refuse it.
 */
function billingCall(
  scope: SaasBillingScope,
  team: string,
  org: string
): { name: string; key: 'teamId' | 'orgId' } {
  return scope === 'org' ? { name: org, key: 'orgId' } : { name: team, key: 'teamId' }
}

/** Per-action fallback: names what did NOT happen, so "it failed" and "it worked"
 *  can never look the same again. */
const FAILED_KEY: Record<SaasBillingAction, string> = {
  checkout: 'errorCheckout',
  cancel: 'errorCancel',
  reactivate: 'errorReactivate',
  portal: 'errorPortal',
}

/** The callable's error code without the SDK's `functions/` prefix ('' if none —
 *  e.g. the local URL guards below, which are plain Errors). */
function callableCode(err: unknown): string {
  const raw = (err as { code?: unknown } | null)?.code
  return typeof raw === 'string' ? raw.replace(/^functions\//, '') : ''
}

/**
 * Sibling of `usePaymentErrorToast` (Connect), deliberately not a reuse of it:
 * that hook maps two Connect-only messages and always attaches a
 * "Go to Settings → Payments" action — which on this page would send an owner
 * whose *Linyup* subscription failed to cancel into their *members'* payment
 * settings. Same shape, different rail, different next step.
 */
export function useSaasBillingErrorToast(
  action: SaasBillingAction,
  scope: SaasBillingScope = 'team'
) {
  const t = useTranslations('SaasBilling')

  return (err: unknown) => {
    const code = callableCode(err)

    // 'failed-precondition' is the only one the server itself answers with
    // "contact support" (the subscription doc exists but carries no Stripe
    // subscription/customer id) — so it is the only one that gets the action.
    if (code === 'failed-precondition') {
      toast.error(t('errorContactSupport'), {
        action: {
          label: t('contactSupport'),
          onClick: () => {
            window.location.href = SUPPORT_MAILTO
          },
        },
      })
      return
    }

    // The two refusals that name the PAYER read differently one floor up: an org
    // admin is not a team owner, and the missing doc belongs to an organisation.
    const org = scope === 'org'
    const key =
      code === 'permission-denied'
        ? org
          ? 'errorOrgAdminOnly'
          : 'errorOwnerOnly'
        : code === 'unauthenticated'
          ? 'errorSignedOut'
          : code === 'resource-exhausted'
            ? 'errorRateLimited'
            : code === 'not-found'
              ? org
                ? 'errorNoOrgSubscription'
                : 'errorNoSubscription'
              : FAILED_KEY[action]

    toast.error(t(key))
  }
}

/**
 * Plan checkout. Resolves by NAVIGATING to Stripe, so the caller's button stays
 * pending until the page unloads; every failure — including a checkout URL that
 * is not Stripe's — lands on the toast instead of a silent no-op.
 *
 * `locale` is passed so the server builds its success/cancel return URLs in the
 * owner's own language (it defaults to 'en' when absent).
 */
export function useCreateSaasCheckoutSession() {
  const onError = useSaasBillingErrorToast('checkout')
  const locale = useLocale()

  return useMutation({
    mutationFn: async ({ teamId, plan }: { teamId: string; plan: SaasPlan }) => {
      const fn = callFunction<{ teamId: string; plan: string; locale?: string }, { url: string }>(
        'createCheckoutSession'
      )
      const url = (await fn({ teamId, plan, locale })).data.url
      if (
        !url.startsWith('https://checkout.stripe.com/') &&
        !url.startsWith('https://billing.stripe.com/')
      ) {
        throw new Error('Unexpected checkout URL')
      }
      window.location.href = url
      return url
    },
    onError,
  })
}

/** `id` is a team id under scope 'team' and an org id under scope 'org'. */
export function useCancelSaasSubscription(options: SaasBillingOptions = {}) {
  const onError = useSaasBillingErrorToast('cancel', options.scope)
  const t = useTranslations('SaasBilling')
  const queryClient = useQueryClient()
  const invalidateKeys = options.invalidateKeys ?? defaultInvalidateKeys
  const scope = options.scope ?? 'team'

  return useMutation({
    mutationFn: async (id: string) => {
      const { name, key } = billingCall(scope, 'cancelSaasSubscription', 'cancelOrgSubscription')
      const fn = callFunction<Record<string, string>>(name)
      await fn({ [key]: id })
    },
    onSuccess: async (_data, id) => {
      toast.success(t('cancelSuccess'))
      await Promise.all(
        invalidateKeys(id).map((queryKey) => queryClient.invalidateQueries({ queryKey }))
      )
    },
    onError,
  })
}

/** `id` is a team id under scope 'team' and an org id under scope 'org'. */
export function useReactivateSaasSubscription(options: SaasBillingOptions = {}) {
  const onError = useSaasBillingErrorToast('reactivate', options.scope)
  const t = useTranslations('SaasBilling')
  const queryClient = useQueryClient()
  const invalidateKeys = options.invalidateKeys ?? defaultInvalidateKeys
  const scope = options.scope ?? 'team'

  return useMutation({
    mutationFn: async (id: string) => {
      const { name, key } = billingCall(
        scope,
        'reactivateSaasSubscription',
        'reactivateOrgSubscription'
      )
      const fn = callFunction<Record<string, string>>(name)
      await fn({ [key]: id })
    },
    onSuccess: async (_data, id) => {
      toast.success(t('reactivateSuccess'))
      await Promise.all(
        invalidateKeys(id).map((queryKey) => queryClient.invalidateQueries({ queryKey }))
      )
    },
    onError,
  })
}

/**
 * Organisation plan checkout — a DIFFERENT callable from
 * `useCreateSaasCheckoutSession` (no plan: an org has exactly one; `orgId`, not
 * `teamId`; and it takes the caller's `origin` so a local dev checkout returns to
 * localhost). Shares the error mapper and the not-Stripe URL guard, which is the
 * part that was worth sharing.
 */
export function useCreateOrgCheckoutSession() {
  const onError = useSaasBillingErrorToast('checkout', 'org')
  const locale = useLocale()

  return useMutation({
    mutationFn: async (orgId: string) => {
      const fn = callFunction<
        { orgId: string; locale: string; origin?: string },
        { url: string }
      >('createOrgCheckoutSession')
      const url = (await fn({ orgId, locale, origin: window.location.origin })).data.url
      if (
        !url.startsWith('https://checkout.stripe.com/') &&
        !url.startsWith('https://billing.stripe.com/')
      ) {
        throw new Error('Unexpected checkout URL')
      }
      window.location.href = url
      return url
    },
    onError,
  })
}

/**
 * Stripe billing portal (update payment method). Navigates on success.
 * `id` is a team id under scope 'team' and an org id under scope 'org'.
 */
export function useOpenBillingPortal(options: SaasBillingOptions = {}) {
  const onError = useSaasBillingErrorToast('portal', options.scope)
  const scope = options.scope ?? 'team'

  return useMutation({
    mutationFn: async ({ id, returnUrl }: { id: string; returnUrl: string }) => {
      const { name, key } = billingCall(scope, 'getBillingPortalUrl', 'getOrgBillingPortalUrl')
      const fn = callFunction<Record<string, string>, { url: string }>(name)
      const url = (await fn({ [key]: id, returnUrl })).data.url
      if (!url.startsWith('https://billing.stripe.com/')) throw new Error('Unexpected portal URL')
      window.location.href = url
      return url
    },
    onError,
  })
}
