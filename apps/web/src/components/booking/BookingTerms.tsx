'use client'

// The cancellation terms and the no-show fee, rendered at the moment of
// commitment — on the booking screen, above the button, on every public rail
// that puts somebody in a session.
//
// WHY IT EXISTS. Both facts were already stored, already authored by the studio,
// and already sent: `cancellationPolicyBox` appends the policy to the booking
// CONFIRMATION email, and the no-show fee arrives as its own email with a
// payment link. Both land AFTER the decision they should have informed. The
// class flow did show the policy, but inside a collapsed `<details>` on the
// session-picking step — one step and one click away from the button, which is
// the same as not showing it.
//
// TWO FIELDS, ONE BLOCK:
//
//  · `cancellationPolicy` — free prose, from `Activity.cancellationPolicy` with
//    a fallback to `TeamPublicProfile.bookingCancellationPolicy`. NOTHING
//    ENFORCES IT. `cancelBooking` has no window, no late-cancel fee and no
//    refund arithmetic; the text is the studio's word, honored by the studio.
//    So it is rendered verbatim, as the studio's statement, and this component
//    adds no sentence of its own about what happens if you cancel late.
//
//  · `noShowPolicy` — the one that DOES cost money automatically, which is why
//    it is stated separately in our words rather than left to the prose. The
//    chain is real and unattended: `markNoShowBookings` (daily) flips an
//    un-checked-in `fromBioLink` booking to 'no_show'; `onBookingWrite` calls
//    `processNoShowStrike`; at the threshold a `PolicyFee` is created and
//    emailed. Every public rail here books with `fromBioLink: true`, so the
//    person reading this is exactly the population it fires on.
//
// WHAT THE COPY MAY NOT SAY. v1 deliberately never charges a saved card
// (`policyFees.ts`: "the fee is ALWAYS an emailed payment link"), and the fee is
// per THRESHOLD reached, never per incident. Copy implying an automatic charge
// would be a promise the code does not keep — worse than the silence it
// replaces. Hence `noShowFeeNote`, which says the fee is emailed, not charged.
//
// A STUDIO THAT HAS WRITTEN NOTHING SEES NOTHING. Both inputs empty ⇒ this
// renders null. An empty terms box is worse than no box: it manufactures a
// formality where the studio made none.

import { useTranslations } from 'next-intl'
import { ShieldCheck } from 'lucide-react'
import { formatCurrency } from '@/lib/format'

export interface BookingTermsProps {
  /** Already resolved: activity override → team default. Falsy ⇒ omitted. */
  cancellationPolicy?: string | null
  /** From TeamPublicProfile.noShowPolicy. Null/absent ⇒ the policy is off. */
  noShowPolicy?: { feeAmount: number; threshold: number } | null
  currency: string
  locale: string
  className?: string
}

/** Resolves the effective policy text the way the confirmation email does:
 *  the activity's own wording wins, the team-wide default is the fallback. */
export function resolveCancellationPolicy(
  activityPolicy: string | null | undefined,
  teamPolicy: string | null | undefined
): string | null {
  return activityPolicy?.trim() || teamPolicy?.trim() || null
}

export function BookingTerms({
  cancellationPolicy,
  noShowPolicy,
  currency,
  locale,
  className,
}: BookingTermsProps) {
  const t = useTranslations('BookingTerms')

  const policy = cancellationPolicy?.trim() || null
  // Defensive on both numbers rather than trusting the mirror: a fee of 0 or a
  // threshold below 1 is a policy that cannot fire, and quoting one would be the
  // same defect in the other direction.
  const fee =
    noShowPolicy && noShowPolicy.feeAmount > 0 && noShowPolicy.threshold >= 1
      ? noShowPolicy
      : null

  if (!policy && !fee) return null

  return (
    <div className={`rounded-xl border bg-muted/30 p-4 ${className ?? ''}`}>
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-2 text-sm">
          <p className="font-medium">{t('title')}</p>

          {policy && (
            <p className="whitespace-pre-line text-muted-foreground">{policy}</p>
          )}

          {fee && (
            <div className="space-y-1">
              <p className="text-muted-foreground">
                {fee.threshold === 1
                  ? t('noShowFeeOnce', {
                      fee: formatCurrency(fee.feeAmount, currency, locale),
                    })
                  : t('noShowFeeAfter', {
                      count: fee.threshold,
                      fee: formatCurrency(fee.feeAmount, currency, locale),
                    })}
              </p>
              {/* The mechanism, because the alternative reading — "they have my
                  card, this comes off it" — is the one a payment form invites
                  and the one the code does not implement. */}
              <p className="text-xs text-muted-foreground">{t('noShowFeeNote')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
