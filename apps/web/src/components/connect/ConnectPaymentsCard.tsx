'use client'

// Settings → Payments: Stripe Connect onboarding + status (member → studio).
// Renders nothing until an operator flips the per-team feature flag
// (teams/{teamId}.payments.connectEnabled) — the feature ships dark.

import { useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  Unlink,
} from 'lucide-react'
import { connectRequirementKinds, takeRatePercent } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { usePlan } from '@/hooks/usePlan'
import {
  useConnectStatus,
  useStartConnectOnboarding,
  useDisconnectConnectAccount,
} from '@/hooks/useConnect'
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
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'

export function ConnectPaymentsCard({
  teamId,
  embedded = false,
}: {
  teamId: string
  /** Inside a settings section that already carries the title: no card and no
   *  title of its own, just the status badge and the content. */
  embedded?: boolean
}) {
  const t = useTranslations('ConnectPayments')
  const locale = useLocale()
  const { team } = useAuth()
  const { plan } = usePlan()

  // Self-serve: owners can set up payments by default. An operator can disable a
  // team by setting payments.connectEnabled === false (kill-switch).
  const notDisabled = team?.payments?.connectEnabled !== false
  const { data: status, isLoading, refetch, isRefetching } = useConnectStatus(teamId, notDisabled)
  const start = useStartConnectOnboarding()
  const disconnect = useDisconnectConnectAccount()
  const [disconnectOpen, setDisconnectOpen] = useState(false)

  if (!notDisabled) return null

  // A COMPED STUDIO IS TOLD THE TRUTH, which is not "0%" — a zero percentage
  // still reads as a rate that could change. The waiver comes from the server
  // (it may be inherited from the studio's organization) rather than being
  // re-derived here, so this surface cannot disagree with what is charged.
  const feeWaived = status?.feeWaived === true
  // The same goes for a NEGOTIATED rate, which the browser cannot derive at all.
  // Nothing is shown while the status loads, so an agreed rate never flashes the
  // published one first; the plan is the fallback only once the server has not
  // answered with a rate (an error, or a functions deploy that predates it).
  const feePct = feeWaived
    ? null
    : (status?.feePercent ?? (isLoading || !plan ? null : takeRatePercent(plan)))
  const feeAgreed = status?.feeSource === 'team_rate' || status?.feeSource === 'org_rate'
  // `feeExpiresAtMs` is the first instant the rate no longer applies, so the last
  // day it DOES apply is the millisecond before.
  const feeAgreedUntil =
    feeAgreed && status?.feeExpiresAtMs
      ? new Date(status.feeExpiresAtMs - 1).toLocaleDateString(locale, { dateStyle: 'medium' })
      : null

  async function beginOnboarding() {
    const res = await start.mutateAsync({ teamId, locale })
    if (res?.url) window.location.href = res.url
  }

  const isEnabled = status?.status === 'enabled'
  const needsSetup =
    status?.connected && (status.status === 'pending' || status.status === 'restricted')
  const requirementKinds = connectRequirementKinds(status?.requirements_currently_due)

  const Shell = embedded ? EmbeddedShell : CardShell
  return (
    <Shell>
      <Shell.Content>
      <div className="flex items-center justify-between">
        {embedded ? (
          <span />
        ) : (
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">{t('title')}</p>
          </div>
        )}
        {isEnabled ? (
          <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            {t('statusEnabled')}
          </Badge>
        ) : needsSetup ? (
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            <AlertCircle className="h-3 w-3 mr-1" />
            {t('statusIncomplete')}
          </Badge>
        ) : null}
      </div>

      {/* The `description` key is deliberately NOT rendered: it said "collect
          memberships, drop-ins and shop payments … money goes to your own
          Stripe account", which is the first two bullets below in weaker words.
          Kept in the locale files rather than deleted — four files, one lane. */}

      {/* ── WHAT THIS BUYS, AGAINST THE ALTERNATIVE BELOW IT ──────────────────
          The record-only rail further down the page can do none of these — it
          matches a contact and stops. Stating them here turns a page with two
          similar-looking Stripe options into a choice with a reason, and each
          line is deliberately the mirror of one of that rail's stated limits.

          Shown only BEFORE setup: once an account is live these are facts
          about the product, not a case to make, and a permanent sales list on
          a settings page is noise. */}
      {!status?.connected && !isLoading && (
        <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('benefitsTitle')}
        </p>
        <ul className="space-y-1.5 text-sm">
          {(['benefitCheckout', 'benefitLinked', 'benefitRefunds', 'benefitRenewals'] as const).map(
            (key) => (
              <li key={key} className="flex gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-500" />
                <span className="text-muted-foreground">{t(key)}</span>
              </li>
            )
          )}
        </ul>
        </div>
      )}

      {/* ── WHAT A PAYMENT ACTUALLY COSTS ─────────────────────────────────────
          Two fees, and only one of them is ours — a studio reading "Linyup's
          fee is 2%" alone will budget for 2% and be wrong. Stripe's cut depends
          on the payment method (card, TWINT, SEPA, and by region), so it is
          named and linked rather than quoted: a number printed here would go
          stale silently and be believed.

          The refund line is the same fact the payments table's breakdown states
          per row: our fee comes back, Stripe's does not. Better learned here,
          when choosing, than on the row where it already happened.

          "What you pay", answering "What you get" above it — the two headings
          are a pair, and the cost belongs beside the case for paying it. */}
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p className="font-medium uppercase tracking-wide">{t('feesTitle')}</p>
        {/* Bulleted like the list above it, but with a NEUTRAL marker — a green
            tick on "you pay the Stripe fee on a refund" would read as a perk. */}
        <ul className="space-y-1">
          {feeWaived ? (
            <FeeLine>{t('feeNoneNote')}</FeeLine>
          ) : (
            feePct != null && (
              <FeeLine>
                {feeAgreedUntil
                  ? t('feeAgreedUntilNote', { pct: feePct, date: feeAgreedUntil })
                  : feeAgreed
                    ? t('feeAgreedNote', { pct: feePct })
                    : t('feeNote', { pct: feePct })}
              </FeeLine>
            )
          )}
          <FeeLine>
            {t.rich('feeStripeNote', {
              link: (chunks) => (
                // UNLOCALISED on purpose. Stripe 307s this to
                // /{lang}-{country}/… using the browser's Accept-Language AND
                // the visitor's IP, so all four of our locales resolve and a
                // studio outside Switzerland sees ITS OWN country's fees.
                // Pinning /en-ch/… would show every visitor Swiss pricing in
                // English. The local-payment-methods page rather than /pricing
                // because the sentence beside it is about the fee varying BY
                // METHOD — and in CH that means TWINT, which /pricing omits.
                <a
                  href="https://stripe.com/pricing/local-payment-methods"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {chunks}
                </a>
              ),
            })}
          </FeeLine>
          <FeeLine>{t('feeRefundNote')}</FeeLine>
        </ul>
      </div>

      <Separator />

      {isLoading ? (
        <Skeleton className="h-20 rounded" />
      ) : !status?.connected ? (
        // ── Not connected — start onboarding ─────────────────────────────────────
        // Deliberately ONE path, no picker. The picker offered "use my existing
        // Stripe account", which onboarding cannot do (see the note on
        // MODEL_DASHBOARD in functions/utils/connect/client.ts) — and its other
        // option built the identical account, so there was nothing left to choose.
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('setupNote')}</p>
          <Button onClick={() => beginOnboarding()} disabled={start.isPending}>
            {start.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4 mr-1" />
            )}
            {t('startSetup')}
          </Button>
        </div>
      ) : isEnabled ? (
        // ── Fully onboarded ──────────────────────────────────────────────────────
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{t('readyBody')}</p>
          <div className="flex flex-wrap gap-2">
            <CapabilityBadge ok={status.charges_enabled} label={t('chargesEnabled')} />
            <CapabilityBadge ok={status.payouts_enabled} label={t('payoutsEnabled')} />
          </div>
        </div>
      ) : (
        // ── Onboarding incomplete — finish setup ─────────────────────────────────
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('incompleteBody')}</p>
          {/* Stripe's raw requirement names (`external_account`,
              `identity.individual.verification.document`) mean nothing to an
              owner. The ONE mapping groups them into plain-language kinds and
              collapses anything it does not recognize into a single generic
              line — the raw string is never shown. Stripe's own form names the
              exact fields, which is why "Finish setup" stays the way to act. */}
          {requirementKinds.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('requirementsTitle')}
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {requirementKinds.map((kind) => (
                  <FeeLine key={kind}>{t(`requirement.${kind}`)}</FeeLine>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{t('requirementsHint')}</p>
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={() => beginOnboarding()} disabled={start.isPending}>
              {start.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4 mr-1" />
              )}
              {t('finishSetup')}
            </Button>
            <Button variant="outline" onClick={() => refetch()} disabled={isRefetching}>
              {isRefetching && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t('refreshStatus')}
            </Button>
          </div>
        </div>
      )}

      {/* ── A WAY BACK OUT ────────────────────────────────────────────────────
          Onboarding reuses the stored account id forever, so a studio that
          started under the wrong Stripe login was permanently pointed at it:
          "Start setup" walked them back into the same account every time, and
          nothing here could name a different one. Found on the prod canary of
          2026-08-23.

          Quiet, at the bottom, below a rule: it is a real need but a rare one,
          and it is refused server-side while any member subscription is still
          live — canceling those is a decision about somebody's membership, not
          a step in changing a login. */}
      {status?.connected && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('disconnectNote')}</p>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDisconnectOpen(true)}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Unlink className="h-4 w-4 mr-1" />
              )}
              {t('disconnectAction')}
            </Button>
          </div>
        </>
      )}
      </Shell.Content>

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('disconnectConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('disconnectConfirmDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('disconnectCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                disconnect.mutate({ teamId })
                setDisconnectOpen(false)
              }}
            >
              {t('disconnectAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  )
}

// The two frames the block can sit in. Embedded, the settings section draws
// the heading and the hairlines, and a card here would be a box inside a list.
function CardShell({ children }: { children: React.ReactNode }) {
  return <Card>{children}</Card>
}
CardShell.Content = function CardShellContent({ children }: { children: React.ReactNode }) {
  return <CardContent className="space-y-4 pt-6">{children}</CardContent>
}
function EmbeddedShell({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}
EmbeddedShell.Content = function EmbeddedShellContent({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 py-4">{children}</div>
}

/** One bulleted line. Shared by the fee list and, by the same marker, by the
 *  external-provider limits on the settings page — a page that showed two
 *  different bullet glyphs for two lists of plain facts read as an accident. */
function FeeLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden className="select-none leading-5">
        •
      </span>
      <span>{children}</span>
    </li>
  )
}

function CapabilityBadge({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <Badge variant={ok ? 'secondary' : 'outline'} className="font-normal">
      {ok ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <AlertCircle className="h-3 w-3 mr-1" />}
      {label}
    </Badge>
  )
}
