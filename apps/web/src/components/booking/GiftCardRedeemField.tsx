'use client'

// Shared "Gift card code" redeem widget (E3) — an optional input + Apply button
// that previews a code's balance via the public `checkGiftCard` callable, then
// hands the applied { code, balance, currency } up to the caller. The caller is
// responsible for passing `giftCardCode` to whichever one-off checkout it calls
// (createProductCheckout / createCourseCheckout / createDropInCheckout) and for
// handling that callable's own gift-card errors (not-found / gift_card_unusable)
// — see `giftCardCheckoutErrorMessage` below, shared by every call site so the
// copy stays consistent.
//
// Used by ShopHome (product/course buy modal) and BookingForm (drop-in step).
// Styling defaults to plain Tailwind; branded public surfaces (ShopHome, which
// paints itself from the team's bio-link palette) can override via `colors`.
//
// All copy lives under the `Shop` i18n namespace (gift cards are sold there) —
// this component always resolves its own strings from `Shop`, and
// `giftCardCheckoutErrorMessage` below expects a translator BOUND TO `Shop` too
// (BookingForm already keeps one around as `tShop`, reused for the same reason
// membership recurrence labels are). Keeps the gift-card copy in one place
// instead of duplicating it per surface namespace.

import { useState } from 'react'
import { type FunctionsError } from 'firebase/functions'
import { useTranslations } from 'next-intl'
import { Loader2, X } from 'lucide-react'
import { formatCurrency } from '@/lib/format'
import { callFunction } from '@/lib/callFunction'

export interface AppliedGiftCard {
  code: string
  balance: number
  currency: string
}

interface CheckGiftCardResponse {
  valid: boolean
  balance: number
  currency: string | null
}

interface GiftCardRedeemFieldProps {
  teamId: string
  locale: string
  applied: AppliedGiftCard | null
  onApplied: (applied: AppliedGiftCard | null) => void
  disabled?: boolean
  colors?: {
    textMain?: string
    textMuted?: string
    borderColor?: string
    accentColor?: string
  }
}

/** Shared error → copy mapping for the CHECKOUT callables' gift-card failures
 *  (as opposed to the preview check above, which never throws). */
export function giftCardCheckoutErrorMessage(
  err: unknown,
  t: ReturnType<typeof useTranslations>
): string | null {
  const fnErr = err as FunctionsError
  if (fnErr?.code === 'functions/not-found') return t('giftCardNotFound')
  const reason = (fnErr?.details as { reason?: string } | undefined)?.reason
  if (fnErr?.code === 'functions/failed-precondition' && reason === 'gift_card_unusable') {
    return t('giftCardUnusable')
  }
  return null
}

export function GiftCardRedeemField({
  teamId,
  locale,
  applied,
  onApplied,
  disabled,
  colors,
}: GiftCardRedeemFieldProps) {
  const t = useTranslations('Shop')
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
      const fn = callFunction<{ teamId: string; code: string }, CheckGiftCardResponse>(
        'checkGiftCard'
      )
      const res = await fn({ teamId, code: trimmed })
      if (!res.data?.valid || res.data.balance <= 0) {
        setError(t('giftCardUnusable'))
        return
      }
      onApplied({
        code: trimmed.toUpperCase(),
        balance: res.data.balance,
        currency: res.data.currency ?? 'CHF',
      })
      setCode('')
    } catch {
      setError(t('giftCardCheckError'))
    } finally {
      setChecking(false)
    }
  }

  if (applied) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
        style={borderColor ? { borderColor, color: textMain } : undefined}
      >
        <span className="min-w-0 truncate">
          {t('giftCardApplied', {
            code: applied.code,
            amount: formatCurrency(applied.balance, applied.currency, locale),
          })}
        </span>
        <button
          type="button"
          onClick={() => onApplied(null)}
          disabled={disabled}
          aria-label={t('giftCardRemove')}
          className="shrink-0 disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" style={{ color: textMuted }} />
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium" style={{ color: textMain }}>
        {t('giftCardLabel')}{' '}
        <span className="font-normal" style={{ color: textMuted }}>
          {t('giftCardOptional')}
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
          placeholder={t('giftCardPlaceholder')}
          className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          style={borderColor ? { borderColor, color: textMain } : undefined}
        />
        <button
          type="button"
          onClick={apply}
          disabled={disabled || checking || !code.trim()}
          className="shrink-0 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
          style={
            accentColor
              ? { borderColor: accentColor, color: accentColor }
              : { borderColor }
          }
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : t('giftCardApply')}
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
