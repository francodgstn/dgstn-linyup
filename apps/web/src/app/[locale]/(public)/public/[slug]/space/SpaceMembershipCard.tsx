'use client'

// The member's own membership — subscriptions + affiliation — rendered from ONE
// implementation on both surfaces that show it (Space Home and Account), the
// same way `SpaceWaiverCard` is one component with two variants.
//
// WHY IT IS SHARED. It was written twice, and the two copies had already
// diverged in the direction that matters: Account learned to say "ends on
// {date}" when a membership is cancelling, Home never did. So a member who
// cancelled in the billing portal opened her portal home and saw a plain,
// live-looking membership — the one screen most likely to be checked after
// cancelling was the one screen that did not acknowledge it. A second copy of a
// display rule is a second answer to "am I still a member", and this one was
// already wrong.
//
// `variant` controls DENSITY, never facts:
//   'summary' (Home)    — no price column, plus the empty-state shop CTA.
//   'full'    (Account) — the amounts too; Account is where the detail lives.
//
// A FAILED READ IS NOT AN EMPTY MEMBERSHIP. `contacts/{id}` is where
// `active_subscriptions` lives; when it will not load we do not know what this
// person holds, and "You have no active membership" is a claim about a paying
// customer's account. Hence the error state, on both surfaces.

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { CreditCard, BadgeCheck } from 'lucide-react'
import { formatCurrency } from '@/lib/format'
import { QueryErrorState } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { loadFailureDetail } from '@/lib/publicQueryError'
import { planGrantIsCurrent } from '@linyup/shared'
import type { ActiveSubscriptionSummary } from '@linyup/shared'
import { useSpaceTheme } from './useSpaceTheme'
import { useSpaceContact } from './useSpaceContact'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicFormat } from '../usePublicFormat'

/** One row of the member's membership list — the fields of the shared
 *  `ActiveSubscriptionSummary` this card reads (every one optional, because the
 *  legacy single-field fallback below cannot fill them all), plus one of its
 *  own. A real summary IS one of these; no cast. */
type ShownSubscription = Partial<
  Pick<
    ActiveSubscriptionSummary,
    'subscription_type_id' | 'subscription_type_name' | 'recurrence' | 'amount' | 'cancels_at_ms' | 'cancelling'
  >
> & {
  /** End of a one-off grant ("2 months included") — the member's own answer to
   *  "until when", which otherwise only the studio could see. */
  until?: { toDate(): Date } | null
}

interface Props {
  variant: 'summary' | 'full'
  /** Space slug — only needed by the 'summary' variant's empty-state CTA. */
  slug?: string
  /** Whether the studio actually sells subscriptions (world-readable signal).
   *  No CTA is offered when there is nothing to buy. */
  hasSubscriptionsForSale?: boolean
}

export function SpaceMembershipCard({ variant, slug, hasSubscriptionsForSale }: Props) {
  const t = useTranslations('Space')
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const { team } = usePublicTeam()
  const currency = team?.default_currency ?? 'CHF'
  const { data: contact, isPending, isError, error, refetch } = useSpaceContact()

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  const subs: ShownSubscription[] = contact?.active_subscriptions ?? []
  // The flat grant, shown only while it still COVERS her — the same
  // `planGrantIsCurrent` comparison the booking gate makes. A member whose "2
  // months included" has run out must not be told she is still a member by the
  // very screen she opens to check.
  const legacy: ShownSubscription[] =
    !subs.length && contact?.subscription_type_id && planGrantIsCurrent(contact)
      ? [
          {
            subscription_type_id: contact.subscription_type_id,
            subscription_type_name: contact.subscription_type_name ?? null,
            recurrence: contact.subscription_recurrence ?? null,
            cancelling: false,
            // The date she has left, so "until when" needs no support ticket.
            until: contact.subscription_expires_at ?? null,
          },
        ]
      : []
  const shownSubs = subs.length ? subs : legacy
  const aff = contact?.affiliation_summary
  const hasMembership = shownSubs.length > 0 || aff?.has_active === true

  return (
    <section className="rounded-2xl p-4" style={cardStyle}>
      <div className="flex items-center gap-2 mb-3">
        <CreditCard className="h-4 w-4" style={{ color: accent }} />
        <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
          {t('membershipTitle')}
        </h2>
      </div>

      {isError ? (
        <QueryErrorState
          onRetry={() => void refetch()}
          title={t('membershipLoadFailed')}
          detail={loadFailureDetail(error)}
          theme={{ textMain, textMuted, accent, border: cardBorder }}
        />
      ) : isPending ? (
        <Skeleton className="h-5 w-40" />
      ) : !hasMembership ? (
        <div>
          <p className="text-sm" style={{ color: textMuted }}>{t('membershipNone')}</p>
          {variant === 'summary' && hasSubscriptionsForSale && slug && (
            <Link
              href={`/public/${slug}/shop?tab=subscriptions` as Route}
              className="mt-2 inline-block text-sm font-medium hover:underline"
              style={{ color: accent }}
            >
              {t('membershipNoneCta')} →
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {shownSubs.map((s, i) => (
            <div key={s.subscription_type_id ?? i} className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium" style={{ color: textMain }}>
                {s.subscription_type_name ?? t('membershipActive')}
                {s.recurrence ? <span style={{ color: textMuted }}> · {s.recurrence}</span> : null}
                {/* A membership that has been cancelled but still runs is a THIRD
                    STATE — the member keeps training until this date. THE DATE
                    ONLY: the rest of the cancellation record (reason, survey,
                    comment) is the studio's to read, not read back to the member
                    who wrote it, and it could not reach here anyway —
                    `active_subscriptions` mirrors LIVE subscriptions only. */}
                {typeof s.cancels_at_ms === 'number' ? (
                  <span className="block text-xs font-normal" style={{ color: '#b45309' }}>
                    {t('membershipEndsOn', {
                      date: fmt.date(s.cancels_at_ms),
                    })}
                  </span>
                ) : s.cancelling ? (
                  // WITHOUT the date, when that is all we have: a subscription
                  // doc predating the Dahlia field migration is cancelling with
                  // no date stored anywhere, and keying this line on the date
                  // alone showed that member nothing.
                  <span className="block text-xs font-normal" style={{ color: '#b45309' }}>
                    {t('membershipEndsAtPeriodEnd')}
                  </span>
                ) : s.until ? (
                  // A one-off grant ("2 months included") runs out on its own
                  // date. Not amber like a cancellation — nothing is going
                  // wrong, this is simply what she bought.
                  <span className="block text-xs font-normal" style={{ color: textMuted }}>
                    {t('membershipUntil', { date: fmt.date(s.until) })}
                  </span>
                ) : null}
              </span>
              {variant === 'full' && typeof s.amount === 'number' && (
                <span className="text-sm" style={{ color: textMuted }}>
                  {formatCurrency(s.amount, currency)}
                </span>
              )}
            </div>
          ))}
          {aff?.has_active && (
            <div className="flex items-center gap-1.5 text-sm" style={{ color: textMain }}>
              <BadgeCheck className="h-4 w-4" style={{ color: '#16a34a' }} />
              {t('affiliationActive')}
              {aff.types?.length ? <span style={{ color: textMuted }}> · {aff.types.join(', ')}</span> : null}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
