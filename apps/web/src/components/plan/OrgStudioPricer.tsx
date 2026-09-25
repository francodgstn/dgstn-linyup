'use client'

/**
 * THE ORGANIZATION TIER'S PRICE IS A RATE, so the card states the rate.
 *
 * Every other tier is a scalar — CHF 9, CHF 35 — and the card renders it. This
 * one is CHF 25 PER STUDIO, which is a complete answer on its own: multiply by
 * however many studios you have.
 *
 * ── IT USED TO DO THE MULTIPLICATION FOR YOU, AND THAT WAS CLUTTER ──────────
 * The first version carried a studio-count stepper and a live total. It worked,
 * and it was the wrong thing on a comparison card: the total it computed is one
 * multiplication the reader can do faster than they can operate a stepper, so
 * the control took up the card's quietest space to tell them something they
 * already knew (Franco, 2026-08-28). The rate says it all; the stepper only
 * dressed it up.
 *
 * ── THE RATE IS FLAT, SO NEVER "FROM" ───────────────────────────────────────
 * "From CHF 25" describes a price that climbs with size. This one does not: no
 * base fee, no tiers, no volume discount, the tenth studio costs what the second
 * did. The tier was published as "From CHF 103" while it carried a base fee, and
 * `orgPriceFrom()` was deleted rather than renamed so the framing cannot come
 * back by habit.
 *
 * ── ABOVE TEN IS A FOURTH STATE, NOT A HIDDEN PLAN ──────────────────────────
 * Past ten studios the number is quoted rather than listed — and that is the
 * easiest thing here to get wrong, because the shape everyone reaches for is
 * "Enterprise · Contact sales", which is precisely what this product positions
 * against. The landing page's own subtitle says so: "No 'request a demo to see
 * pricing'".
 *
 * So it is one line on this card, phrased as a QUESTION rather than a plan name,
 * and the answer keeps the model visible: same rate, quick quote. It is the same
 * tier one step further along, which is why it lives here instead of in a card
 * of its own.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ORG_MAX_LISTED_STUDIOS, ORG_MIN_STUDIOS, ORG_PER_STUDIO } from '@linyup/shared'

export function OrgStudioPricer({ className }: { className?: string }) {
  const t = useTranslations('Pricing')
  const [showQuote, setShowQuote] = useState(false)

  return (
    <div className={className}>
      {/* THE RATE, at the weight the other cards give their price — this tier
          has to read as comparable at a glance, not as a special case. */}
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold">CHF {ORG_PER_STUDIO.monthly}</span>
        <span className="text-xs text-muted-foreground">{t('perStudioMonth')}</span>
      </div>

      {/* THE FLOOR. The tier does not exist below two studios, and the rate
          alone does not say so — somebody with one studio would otherwise price
          themselves at CHF 25 and be wrong about which tier they are on. */}
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t('orgMinStudios', { count: ORG_MIN_STUDIOS })}
      </p>

      {/* Reserved height so revealing the answer cannot resize the card and
          shove the button below it under the cursor. */}
      <div className="mt-2 min-h-[2.5rem]">
        <button
          type="button"
          onClick={() => setShowQuote((v) => !v)}
          aria-expanded={showQuote}
          className="text-xs text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
        >
          {t('orgMoreThan', { count: ORG_MAX_LISTED_STUDIOS })}
        </button>
        {showQuote && (
          <p className="mt-1 text-xs text-muted-foreground">{t('orgQuoteNote')}</p>
        )}
      </div>
    </div>
  )
}
