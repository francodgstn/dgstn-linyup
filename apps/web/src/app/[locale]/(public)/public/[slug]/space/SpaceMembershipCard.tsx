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
// the plan list (`held_plans`) lives; when it will not load we do not know what this
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
import { heldMemberships } from '@linyup/shared'
import type { ActiveSubscriptionSummary } from '@linyup/shared'
import { useSpaceTheme } from './useSpaceTheme'
import { useSpaceContact } from './useSpaceContact'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicFormat } from '../usePublicFormat'

/** One row of the member's membership list, built from one held plan
 *  (`heldMemberships`) — the `ActiveSubscriptionSummary` fields this card
 *  reads, plus one of its own. */
type ShownSubscription = Partial<
  Pick<
    ActiveSubscriptionSummary,
    'subscription_type_id' | 'subscription_type_name' | 'recurrence' | 'amount' | 'cancels_at_ms' | 'cancelling'
  >
> & {
  /** End of a one-off grant ("2 months included") — the member's own answer to
   *  "until when", which otherwise only the studio could see. */
  until?: number | null
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

  // EVERY MEMBERSHIP SHE HOLDS, from the plan list (docs/multi-plan-holdings.md
  // §5): Stripe billing and every plan given or bought another way, each
  // shown while it still COVERS her (`holdingIsCurrent`, the comparison the
  // booking gate makes), so a membership that has run out is not shown as
  // one on the very screen she opens to check. Credit packs have their own
  // section. It used to read the Stripe mirror, and the single legacy slot
  // only when there was no Stripe plan at all, so a second plan was invisible.
  const shownSubs: ShownSubscription[] = heldMemberships(contact).map((p) => {
    const cancelling = p.status === 'cancelling'
    return {
      subscription_type_id: p.subscription_type_id,
      subscription_type_name: p.subscription_type_name,
      recurrence: p.recurrence,
      amount: p.amount ?? undefined,
      cancelling,
      cancels_at_ms: cancelling ? (p.ends_at_ms ?? undefined) : undefined,
      // A given or bought plan with an end of its own ("2 months included").
      until: p.source === 'grant' ? p.ends_at_ms : null,
    }
  })
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
                    who wrote it, and it could not reach here anyway — the plan
                    list carries a status and a date, never the record. */}
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
