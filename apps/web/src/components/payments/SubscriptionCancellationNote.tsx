'use client'

// The cancellation RECORD — the line that says when a subscription was cancelled
// and why, beneath whichever "cancels on {date}" line the surrounding surface
// already shows.
//
// ── Why this is one component in its own namespace ──────────────────────────────
// Three surfaces need it (a studio looking at a member's membership, a studio
// looking at its own Linyup subscription, and an org owner looking at theirs) and
// they live in three different message namespaces. Copying eleven reason/feedback
// keys into three namespaces would mean three translations of the same sentence
// drifting apart, so the copy lives in ONE namespace — `SubscriptionCancellation`
// — which this component reads directly. The surrounding surfaces keep their own
// phrasing for the date line, because "Cancels on" and "Access until" are
// genuinely different sentences.
//
// ── The `audience` distinction is not decoration ────────────────────────────────
// Stripe's churn survey (`feedback`, `comment`) is written BY the subscriber. A
// studio reading a member's membership should see it — that is the whole point of
// storing it. A studio reading its OWN subscription should not: quoting somebody's
// cancellation note back at them is not information, it is an echo. So
// `audience='self'` shows the reason (which can be "payment failed", something
// they need to act on) and nothing they authored themselves.

import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { subscriptionCancellation, type SubscriptionLifecycleFields } from '@linyup/shared'

/**
 * Reasons that mean something went WRONG rather than somebody chose to leave.
 * These get the warning colour, on the argument that "cancelled by the member" is
 * news and "the card was declined" is a task.
 */
const ACTIONABLE_REASONS = new Set(['payment_failed', 'payment_disputed'])

export function SubscriptionCancellationNote({
  subscription,
  audience,
  className,
}: {
  subscription: SubscriptionLifecycleFields | null | undefined
  /** `'studio'` — someone else's subscription. `'self'` — the viewer's own. */
  audience: 'studio' | 'self'
  className?: string
}) {
  const t = useTranslations('SubscriptionCancellation')
  const fmt = useTeamFormat()
  const record = subscriptionCancellation(subscription)
  // Null covers both "renewing normally" and "reactivated", so a stale field left
  // on the doc cannot put a dead cancellation on screen.
  if (!record) return null

  const showSurvey = audience === 'studio'
  const parts: string[] = []
  if (record.requestedAt) {
    const ms =
      typeof record.requestedAt.toMillis === 'function'
        ? record.requestedAt.toMillis()
        : record.requestedAt.seconds * 1000
    parts.push(
      t('requestedOn', {
        date: fmt.custom(ms, { day: 'numeric', month: 'short', year: 'numeric' }),
      })
    )
  }
  if (record.reason) parts.push(t(`reason_${record.reason}`))
  if (showSurvey && record.feedback) parts.push(t(`feedback_${record.feedback}`))

  const comment = showSurvey ? record.comment : null
  if (!parts.length && !comment) return null

  const urgent = record.reason ? ACTIONABLE_REASONS.has(record.reason) : false

  return (
    <div className={className}>
      {parts.length > 0 && (
        <p className={`text-xs ${urgent ? 'text-amber-600' : 'text-muted-foreground'}`}>
          {parts.join(' · ')}
        </p>
      )}
      {/* Member-authored free text. Rendered as a plain string in a text node —
          never as markup, and never parsed for anything. */}
      {comment && <p className="text-xs italic text-muted-foreground">“{comment}”</p>}
    </div>
  )
}
