'use client'

// Shared "Promo code" widget (Wave 3 Phase 3) — an optional input + Apply that
// QUOTES a code through the public `previewPromoCode` callable, then hands the
// applied modifier up to the surface.
//
// TWO DELIBERATE DIVERGENCES FROM GiftCardRedeemField, which it otherwise
// mirrors:
//
// 1. IT TAKES THE TARGET. `checkGiftCard` returns a balance, and a balance is a
//    balance whatever you buy. A promo's validity is a function of
//    (code, target, contact, time), so the preview must be asked about ONE
//    purchase — copying the card's target-free signature is how you ship a
//    preview that says "valid" and a checkout that says "not for this class".
//
// 2. ITS COPY LIVES IN ITS OWN `Promo` NAMESPACE. GiftCardRedeemField binds to
//    `Shop` on every surface because gift cards are SOLD there; a promo is not a
//    shop item. The rule that matters is preserved: ONE namespace for the
//    widget, never a fork per surface.
//
// WHAT THIS WIDGET DOES NOT DO: decide whether the code actually lowers the
// price. That is Stage A's answer, and every surface already computes it once
// through `resolvePaymentOptions(snapshot, target, { promo })`. The surface
// passes the resolver's own `PromoOutcome` back in as `outcome`, and this widget
// renders the sentence for it. A widget that re-derived "did it win?" from two
// numbers would be a SECOND price computation on a page whose whole rule is that
// there is only one — which is how a breakdown ends up promising 22 while Stripe
// charges 30.
//
// THE PREVIEW IS ADVISORY ABOUT AVAILABILITY, AUTHORITATIVE ABOUT PRICE. The
// reserve transaction at pay time may still refuse (`promo_exhausted`,
// `promo_busy`, `promo_already_used`), so every mount must also handle a
// refusal when the visitor PAYS — that is what `promoCheckoutErrorMessage` is
// for, and why each surface calls it in its checkout catch.

import { useCallback, useState } from 'react'
import { type FunctionsError } from 'firebase/functions'
import { useTranslations } from 'next-intl'
import { Loader2, X } from 'lucide-react'
import type { PromoEffect } from '@linyup/shared'
import { callFunction } from '@/lib/callFunction'

/** The qualified modifier a surface feeds straight into its ONE
 *  `resolvePaymentOptions(..., { promo })` call, and forwards as `promoCode` at
 *  checkout. Deliberately the same shape the shared `PromoModifier` has. */
export interface AppliedPromo {
  code: string
  effect: PromoEffect
  percent?: number
  amount?: number
}

/** What the preview is asked about — one purchase, per rail. Mirrors the
 *  server's `PromoQuoteTarget`, whose per-rail `targetKey` derivation is what
 *  makes a retry a refresh rather than a second use. */
export type PromoPreviewTarget =
  | { kind: 'drop_in'; sessionId: string; trial?: boolean }
  | {
      kind: 'appointment'
      providerId: string
      activityId: string
      startMs: number
      durationMinutes: number
      /** A party length's size, so the preview prices every place. */
      people?: number
    }
  | { kind: 'course'; courseId: string }
  | { kind: 'product'; productId: string; variantId?: string }

/** The resolver's verdict, passed DOWN from the surface's single computation. */
export type PromoDisplayOutcome =
  | { code: string; status: 'applied' }
  | { code: string; status: 'superseded'; by: 'benefit' | 'base' }
  | { code: string; status: 'not_needed' }
  | { code: string; status: 'not_applicable' }

interface PreviewResponse {
  valid: boolean
  code?: string
  effect?: PromoEffect
  percent?: number
  amount?: number
  baseAmount?: number | null
  quotedAmount?: number | null
  outcome?: 'applied' | 'superseded' | 'not_needed'
  by?: 'benefit' | 'base'
  reason?: string
}

/** Preview refusals → the `Promo` namespace. Every reason the callable can
 *  return has a key here; anything unrecognised falls back to the generic
 *  translated `checkError` rather than surfacing the server's English. */
const PREVIEW_KEYS: Record<string, string> = {
  invalid: 'invalid',
  not_applicable: 'notApplicable',
  looks_like_gift_card: 'looksLikeGiftCard',
  audience_mismatch: 'audienceMismatch',
  currency_mismatch: 'currencyMismatch',
  exhausted: 'exhausted',
  busy: 'busy',
  already_used: 'alreadyUsed',
}

/**
 * CHECKOUT-time refusals → the `Promo` namespace, shared by every mount on all three surfaces so
 * the copy cannot fork (the `giftCardCheckoutErrorMessage` pattern).
 *
 * Every reason `reservePromoRedemption` can throw appears here, plus
 * `price_changed` — which the server now raises ONLY on a checkout that carried
 * a code (see `assertQuotedAmount`), so it belongs to this namespace rather than
 * to each surface. This mapping is the FALLBACK sentence for it; a mount that can
 * offer the new price should call `priceChangedAmount` first and say what the
 * price now is. Returns `null` for anything else, so the surface keeps its own
 * generic handling instead of rendering a server message written in the studio's
 * language.
 */
export function promoCheckoutErrorMessage(
  err: unknown,
  t: ReturnType<typeof useTranslations>
): string | null {
  const reason = ((err as FunctionsError)?.details as { reason?: string } | undefined)?.reason
  if (!reason) return null
  const key = CHECKOUT_KEYS[reason]
  return key ? t(key as Parameters<typeof t>[0]) : null
}

/**
 * THE SERVER'S OWN FIGURE, off a `price_changed` refusal — the recovery half of
 * that guard, in one place so every mount recovers identically.
 *
 * `assertQuotedAmount` refuses only when the server resolves MORE than the
 * surface rendered, and it carries the resolved amount for exactly this reason:
 * the client CANNOT re-render its way out of the refusal. It would re-derive the
 * same optimistic figure from the same optimistic snapshot and be refused again,
 * forever — a loop, not a retry. So a mount that catches this must SHOW the
 * amount and let the visitor buy at it; confirming re-sends this number as
 * `quotedAmount`, the two then agree, and the sale completes.
 *
 * Returns null for every other error (and for a refusal with no usable figure,
 * where the generic `priceChanged` sentence from `promoCheckoutErrorMessage` is
 * all there is to say).
 */
export function priceChangedAmount(err: unknown): number | null {
  const details = (err as FunctionsError)?.details as
    | { reason?: string; amount?: number }
    | undefined
  if (details?.reason !== 'price_changed') return null
  return typeof details.amount === 'number' && Number.isFinite(details.amount)
    ? details.amount
    : null
}

/**
 * THE ACCEPTED FIGURE, AND HOW LONG IT IS TRUE FOR — the storage half of
 * `priceChangedAmount`, shared so no mount can fork on its lifetime.
 *
 * The number the server hands back prices exactly ONE
 * **(target, code, identity)** triple, and it stops being true the moment any
 * one of the three moves:
 *  • **target** — the thing being bought, including whatever else prices it (a
 *    product variant, the trial-vs-drop-in door, the slot's duration);
 *  • **code** — applying or removing one, because the commonest cause of the
 *    refusal is the server declining that very code;
 *  • **identity** — who is asking. A guest who signs in mid-flow is re-quoted as
 *    a member, and the guest's figure is not hers.
 *
 * Each surface used to express whichever parts of the triple it happened to
 * think of, in its own effect: BookingForm keyed on session + door + code,
 * ShopHome on item + variant + code, AppointmentPicker on code alone. All three
 * omitted IDENTITY — the one axis that moves without the surface choosing a
 * different thing to buy — so a guest refused at 40.00 who then signed in was
 * shown, and re-sent, 40.00 on a member screen quoting 24.00.
 *
 * Two properties, both deliberate:
 *
 * 1. **The figure is READ THROUGH the scope, not cleared by an effect.** An
 *    effect clears one render too late, so the stale figure is rendered once —
 *    and on a surface whose submit is a ref-driven sticky bar, it can be
 *    submitted inside that window. A scope that no longer matches reads `null`
 *    immediately.
 * 2. **`acceptPrice` stamps the scope of the render that called it**, which is
 *    the render that submitted. So a scope change DURING the round trip retires
 *    the figure rather than stranding it on the new scope: a price quoted for
 *    the guest is never adopted by the member she became while Stripe was being
 *    asked.
 */
export function useAcceptedPrice(scope: string): {
  acceptedPrice: number | null
  acceptPrice: (amount: number) => void
} {
  const [accepted, setAccepted] = useState<{ scope: string; amount: number } | null>(null)
  const acceptPrice = useCallback((amount: number) => setAccepted({ scope, amount }), [scope])
  return {
    acceptedPrice: accepted && accepted.scope === scope ? accepted.amount : null,
    acceptPrice,
  }
}

/**
 * WHY the price moved, when the typed code is the reason — the other half of the
 * same refusal, and the reason it usually fires.
 *
 * The commonest path to `price_changed` is not a studio changing a price: it is
 * a code the surface believed applied and the server refused. `apply()` below
 * sends `{ teamId, code, target }` and NO email — the preview resolves the
 * caller from a contact session alone — so for a signed-out visitor it answers
 * as an anonymous caller and accepts a new-customers-only code. The checkout
 * then resolves that same code against the email actually typed into the guest
 * form, which may belong to a member, and refuses it. The client's quote carries
 * the discount, the server's figure does not, and the guard fires. Reporting
 * only "the price changed while you were checking out" tells that visitor
 * something untrue about what happened — the studio's price never moved.
 *
 * `details.promoRefusal` is the loader's own verdict (`PromoLoadRefusal`), and it
 * reuses the SAME copy the Apply button shows for that verdict — one sentence per
 * refusal, whether the visitor hears it at apply time or at pay time. Returns
 * null when the refusal carries no promo cause, in which case the price really
 * did move and `priceChangedTo` is the whole story.
 */
function priceChangedPromoCause(
  err: unknown,
  t: ReturnType<typeof useTranslations>
): string | null {
  const details = (err as FunctionsError)?.details as
    | { reason?: string; promoRefusal?: string }
    | undefined
  if (details?.reason !== 'price_changed' || !details.promoRefusal) return null
  const key = PREVIEW_KEYS[details.promoRefusal]
  return key ? t(key as Parameters<typeof t>[0]) : null
}

/**
 * THE recovery sentence, composed in ONE place so no recovery branch can fork on
 * it — BookingForm, ShopHome, and both of AppointmentPicker's pay paths (guest
 * and member). Which mounts exist is the table in docs/promo-codes.md, and
 * connect/commitSites.test.ts asserts that every surface rendering the field
 * goes through this helper and `useAcceptedPrice`.
 *
 * Two shapes, and which one is used is the server's answer, never the client's
 * guess:
 *  • a refused CODE — name the refusal, then state what the thing costs without
 *    it. "The price changed while you were checking out" would be false here:
 *    nothing about the studio's pricing moved;
 *  • anything else — the price genuinely moved under the tab, which is what
 *    `priceChangedTo` says.
 *
 * Both shapes end by inviting the visitor to confirm at the stated figure,
 * because the refusal is only worth raising if it can be acted on.
 */
export function priceChangedMessage(
  err: unknown,
  t: ReturnType<typeof useTranslations>,
  formattedPrice: string
): string {
  const cause = priceChangedPromoCause(err, t)
  return cause
    ? `${cause} ${t('priceWithoutCode', { price: formattedPrice })}`
    : t('priceChangedTo', { price: formattedPrice })
}

const CHECKOUT_KEYS: Record<string, string> = {
  // A code bound to somebody else, disabled, or gone: ONE sentence, because
  // "this code is not yours" would confirm the code is real to whoever guessed
  // it.
  promo_not_found: 'invalid',
  promo_inactive: 'invalid',
  promo_expired: 'expired',
  promo_not_applicable: 'notApplicable',
  promo_audience_mismatch: 'audienceMismatch',
  promo_currency_mismatch: 'currencyMismatch',
  promo_exhausted: 'exhausted',
  promo_busy: 'busy',
  promo_already_used: 'alreadyUsed',
  // The reserve found the checkout it was already backing PAID at Stripe. A
  // second discounted session for a purchase that has gone through is exactly
  // what would let one slot back two orders — so it is refused, and the visitor
  // is told the true thing: they have already paid for this.
  promo_purchase_paid: 'purchasePaid',
  price_changed: 'priceChanged',
}

/** The sentence for a code that was ACCEPTED and still changed nothing. Read
 *  from the resolver's `by`, never re-derived by the client from two numbers:
 *  "your member price is already lower" and "this code does not lower this
 *  price" are different sentences and only the resolver knows which is true. */
export function promoOutcomeMessage(
  outcome: PromoDisplayOutcome | null | undefined,
  t: ReturnType<typeof useTranslations>
): string | null {
  if (!outcome) return null
  switch (outcome.status) {
    case 'applied':
      return null
    case 'superseded':
      return outcome.by === 'benefit' ? t('supersededByBenefit') : t('supersededByBase')
    case 'not_needed':
      return t('notNeeded')
    case 'not_applicable':
      return t('notApplicable')
  }
}

interface PromoCodeFieldProps {
  teamId: string
  target: PromoPreviewTarget
  applied: AppliedPromo | null
  onApplied: (applied: AppliedPromo | null) => void
  /** The SURFACE's own resolver verdict for the applied code. */
  outcome?: PromoDisplayOutcome | null
  disabled?: boolean
  colors?: {
    textMain?: string
    textMuted?: string
    borderColor?: string
    accentColor?: string
  }
}

export function PromoCodeField({
  teamId,
  target,
  applied,
  onApplied,
  outcome,
  disabled,
  colors,
}: PromoCodeFieldProps) {
  const t = useTranslations('Promo')
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const textMain = colors?.textMain
  const textMuted = colors?.textMuted
  const borderColor = colors?.borderColor
  const accentColor = colors?.accentColor

  async function apply() {
    const trimmed = code.trim()
    if (!trimmed || checking) return
    setChecking(true)
    setError(null)
    try {
      const fn = callFunction<
        { teamId: string; code: string; target: PromoPreviewTarget },
        PreviewResponse
      >('previewPromoCode')
      const res = await fn({ teamId, code: trimmed, target })
      const data = res.data
      if (!data?.valid) {
        const key = data?.reason ? PREVIEW_KEYS[data.reason] : undefined
        setError(t((key ?? 'checkError') as Parameters<typeof t>[0]))
        return
      }
      // Accepted — even when it turns out not to lower the price. The surface
      // resolves the real outcome from its own single computation and the
      // explanatory line renders below the chip; a valid code is never shown as
      // an error.
      onApplied({
        code: data.code ?? trimmed.toUpperCase(),
        effect: data.effect ?? 'percent_off',
        ...(typeof data.percent === 'number' ? { percent: data.percent } : {}),
        ...(typeof data.amount === 'number' ? { amount: data.amount } : {}),
      })
      setCode('')
    } catch {
      setError(t('checkError'))
    } finally {
      setChecking(false)
    }
  }

  if (applied) {
    const note = promoOutcomeMessage(outcome, t)
    return (
      <div className="space-y-1">
        <div
          className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
          style={borderColor ? { borderColor, color: textMain } : undefined}
        >
          <span className="min-w-0 truncate">{t('applied', { code: applied.code })}</span>
          <button
            type="button"
            onClick={() => onApplied(null)}
            disabled={disabled}
            aria-label={t('remove')}
            className="shrink-0 disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" style={{ color: textMuted }} />
          </button>
        </div>
        {note && (
          <p className="text-xs" style={{ color: textMuted }}>
            {note}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium" style={{ color: textMain }}>
        {t('label')}{' '}
        <span className="font-normal" style={{ color: textMuted }}>
          {t('optional')}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={code}
          disabled={disabled || checking}
          onChange={(e) => {
            setCode(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
          placeholder={t('placeholder')}
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          style={borderColor ? { borderColor, color: textMain } : undefined}
        />
        <button
          type="button"
          onClick={apply}
          disabled={disabled || checking || !code.trim()}
          className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={accentColor ? { borderColor: accentColor, color: accentColor } : { borderColor }}
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : t('apply')}
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
