'use client'

import { useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { formatCurrency } from '@/lib/format'
import { CreditCard, Receipt, ExternalLink, Loader2 } from 'lucide-react'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import SpaceSignInWall from '../SpaceSignInWall'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { usePublicTeam } from '../../PublicTeamProvider'
import { useSpacePayments } from '../useSpacePayments'
import { usePublicFormat } from '../../usePublicFormat'

/** What "this money did not arrive" actually looks like on a payment row.
 *  'refunded' and 'partially_refunded' are deliberately absent: the money DID
 *  arrive and was then returned, which is the row below. */
const FAILED_PAYMENT_STATUSES = new Set(['failed', 'canceled', 'requires_payment_method'])

export default function PaymentsHome() {
  const t = useTranslations('Space')
  const locale = useLocale()
  const { slug, isAuthenticated } = useSpaceAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const { team } = usePublicTeam()
  const currency = team?.default_currency ?? 'CHF'
  // A failed MONEY read must never render as "No payments yet": that tells
  // somebody who paid that there is no record of it.
  const { data, isLoading, isError, error, refetch } = useSpacePayments()
  const [portalLoading, setPortalLoading] = useState(false)

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  if (!isAuthenticated) {
    return <SpaceSignInWall prompt={t('accountSignInPrompt')} />
  }

  async function openBillingPortal() {
    setPortalLoading(true)
    try {
      const fn = httpsCallable<{ slug: string; locale: string; origin: string }, { url: string }>(
        functions,
        'createContactBillingPortalSession'
      )
      const res = await fn({ slug, locale, origin: window.location.origin })
      if (res.data?.url) window.location.href = res.data.url
      else setPortalLoading(false)
    } catch (err: unknown) {
      // Portal not configured / no customer — leave the button and stop the
      // spinner. Silent to the visitor by design, but never silent in the log:
      // a button that does nothing on click has to be diagnosable.
      reportPublicLoadFailure('space/billing-portal', err)
      setPortalLoading(false)
    }
  }

  const payments = data?.payments ?? []

  return (
    <div className="mt-6 space-y-4">
      {/* Manage billing in Stripe — only for contacts with a Stripe customer */}
      {data?.billingAvailable && (
        <button
          type="button"
          onClick={openBillingPortal}
          disabled={portalLoading}
          className="flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-60"
          style={{ background: `${accent}14`, color: textMain }}
        >
          <CreditCard className="h-4 w-4" style={{ color: accent }} />
          <span className="flex-1 text-left">{t('manageBilling')}</span>
          {portalLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: textMuted }} />
          ) : (
            <ExternalLink className="h-4 w-4" style={{ color: textMuted }} />
          )}
        </button>
      )}

      {/* Payment history */}
      <section className="rounded-2xl p-4" style={cardStyle}>
        <div className="flex items-center gap-2 mb-3">
          <Receipt className="h-4 w-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
            {t('paymentsTitle')}
          </h2>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <div
              className="h-6 w-6 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: accent, borderTopColor: 'transparent' }}
            />
          </div>
        ) : isError ? (
          <QueryErrorState
            onRetry={() => void refetch()}
            title={t('paymentsLoadFailed')}
            detail={loadFailureDetail(error)}
            theme={{ textMain, textMuted, accent, border: cardBorder }}
          />
        ) : payments.length === 0 ? (
          <p className="text-sm py-4" style={{ color: textMuted }}>{t('paymentsEmpty')}</p>
        ) : (
          <ul className="divide-y" style={{ borderColor: cardBorder }}>
            {payments.map((p) => {
              // A REFUND IS NOT A FAILURE, and this line used to say it was.
              // `failed` was `status !== 'succeeded'`, and the webhook writes
              // 'refunded' / 'partially_refunded' onto a payment it reverses —
              // so every refunded row rendered struck through under the word
              // "failed", and the refunded branch below was unreachable for a
              // FULL refund. The member was told a payment they had been given
              // back had failed.
              //
              // Named states, not a negation: a status this surface does not
              // know about must not be reported as a failure on the strength of
              // not being one of ours.
              const refunded = p.refundedAmount > 0
              const failed = FAILED_PAYMENT_STATUSES.has(p.status)
              return (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: textMain }}>{p.label}</p>
                    <p className="text-xs" style={{ color: textMuted }}>
                      {p.createdAt ? fmt.date(p.createdAt) : '—'}
                      {p.promoCode ? ` · ${t('paymentPromoCode', { code: p.promoCode })}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className="text-sm font-medium"
                      style={{ color: textMain, textDecoration: failed ? 'line-through' : undefined }}
                    >
                      {formatCurrency(p.amount / 100, currency)}
                    </p>
                    {failed ? (
                      <p className="text-[11px]" style={{ color: '#dc2626' }}>{t('paymentFailed')}</p>
                    ) : refunded ? (
                      <p className="text-[11px]" style={{ color: textMuted }}>
                        {t('paymentRefunded', { amount: formatCurrency(p.refundedAmount / 100, currency) })}
                      </p>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
