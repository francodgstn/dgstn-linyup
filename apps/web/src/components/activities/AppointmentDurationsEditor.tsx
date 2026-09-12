'use client'

/**
 * SESSION LENGTHS AND WHAT EACH ONE COSTS — one editor, two hosts.
 *
 * ── WHY IT IS A COMPONENT AND NOT A BLOCK IN A FORM ─────────────────────────
 * The price of an appointment is attached to its LENGTH: a coach does not sell
 * "a session", they sell thirty minutes or ninety. So the lengths and their
 * prices are one control, and it belongs on Access & pricing with every other
 * money decision (Franco, staging, 2026-09-02). It used to sit under Details,
 * on the reasoning that a duration is part of what an appointment IS — true of
 * the length, false of the price beside it, and the pair cannot be split
 * without asking the studio to answer one question on two tabs.
 *
 * It still has to exist in the CREATE dialog, because an appointment is invalid
 * with no length at all and the pane's tabs do not exist yet at that point. Two
 * hosts, therefore one component: a second copy is how the two would come to
 * offer different sale modes.
 *
 * ── WHO WRITES `durations` ──────────────────────────────────────────────────
 * `ActivityPricingForm` on an EDIT; `ActivityDialog` on a CREATE only. The
 * dialog names the field nowhere else, for the same reason it names no other
 * money field — see its `kindSpecificPayload`.
 */

import { useTranslations } from 'next-intl'
import {
  resolveDurationSale,
  type ActivityDuration,
  type DurationSaleMode,
} from '@linyup/shared'
import { Input } from '@/components/ui/input'
import { formatDuration } from '@/components/sessions/SessionFormDialog'

export const APPOINTMENT_DURATION_PRESETS = [15, 30, 45, 60, 90, 120]

// The form keeps price as a STRING per duration ('' unambiguously means "no
// price yet"), vs. the persisted shape's `priceAmount: number | null`. The two
// helpers below convert between them: `toDurationFormValues` hydrates from a
// saved activity, `toActivityDurations` builds the payload on submit.
//
// History: durations also carried a per-duration × per-subscription-type
// `subscriptionPricing` matrix until 2026-07; member benefit is now ONE rule
// per activity — see `ActivityDuration`'s doc comment in @linyup/shared.

export interface DurationFormValue {
  minutes: number
  price: string
  /** THE FORM holds the tri-state explicitly, the DOCUMENT does not (see
   *  `ActivityDuration` in @linyup/shared): "priced with the box still empty"
   *  and "free" are the same stored bytes but different intentions, and only a
   *  stored mode can tell the validator which one the coach meant. */
  mode: DurationSaleMode
}

export function toDurationFormValues(
  durations?: ActivityDuration[] | null
): DurationFormValue[] {
  return (durations ?? []).map((d) => {
    const sale = resolveDurationSale(d)
    return {
      minutes: d.minutes,
      price: sale.priceAmount != null ? String(sale.priceAmount) : '',
      mode: sale.mode,
    }
  })
}

/**
 * A price typed by a human, as a number.
 *
 * `Number('10,00')` is NaN, and a comma is the decimal separator on a Swiss,
 * German, French and Italian keyboard — which is every locale this product
 * ships in. Typing the price the way the studio's own currency is written made
 * the field fail validation with a message about a minimum, which is not what
 * was wrong.
 *
 * Used by BOTH the validation and the payload, deliberately: two parsers is how
 * a form validates one number and stores a different one.
 */
export function parsePriceInput(text: string): number {
  return Number(String(text).trim().replace(',', '.'))
}

export function toActivityDurations(durations: DurationFormValue[]): ActivityDuration[] {
  return [...durations]
    .sort((a, b) => a.minutes - b.minutes)
    .map((d) => ({
      minutes: d.minutes,
      // A price is written ONLY in 'priced' mode, so switching a length to
      // "only with a plan" (or back to free) cannot leave a sellable number
      // behind it.
      priceAmount: d.mode === 'priced' && d.price.trim() !== '' ? parsePriceInput(d.price) : null,
      ...(d.mode === 'benefit_only' ? { benefitOnly: true } : {}),
    }))
}

/** Toggle a preset length on or off, keeping the list sorted. */
export function toggleDurationValue(
  durations: DurationFormValue[],
  minutes: number
): DurationFormValue[] {
  return durations.some((d) => d.minutes === minutes)
    ? durations.filter((d) => d.minutes !== minutes)
    : [...durations, { minutes, price: '', mode: 'free' as DurationSaleMode }].sort(
        (a, b) => a.minutes - b.minutes
      )
}

/** Switch a length between the three ways it can be sold. Changing mode always
 *  clears the price box: a number left behind a "free" or "only with a plan"
 *  choice is the exact ambiguity this control exists to remove. */
export function setDurationMode(
  durations: DurationFormValue[],
  minutes: number,
  mode: DurationSaleMode
): DurationFormValue[] {
  return durations.map((d) =>
    d.minutes === minutes ? { ...d, mode, price: mode === 'priced' ? d.price : '' } : d
  )
}

export function setDurationPrice(
  durations: DurationFormValue[],
  minutes: number,
  price: string
): DurationFormValue[] {
  return durations.map((d) => (d.minutes === minutes ? { ...d, price } : d))
}

/** Is this row's price unusable? The SAME rule both hosts enforce — 'priced'
 *  with nothing in the box is the one state the stored shape cannot tell apart
 *  from free, and Stripe's floor is 0.50 — so a length saved from the pane can
 *  never be one the create dialog would have refused. */
export function durationPriceProblem(d: DurationFormValue): boolean {
  if (d.mode === 'priced') return !(parsePriceInput(d.price) >= 0.5)
  // A stale number left behind a mode switch is not written (see
  // `toActivityDurations`), but it is still refused rather than silently
  // dropped: the studio typed it and should be told it is going nowhere.
  return d.price.trim() !== '' && !(parsePriceInput(d.price) >= 0.5)
}

export function AppointmentDurationsEditor({
  value,
  onChange,
  currency,
  canEdit,
  benefitOpensDoor,
  errorFor,
}: {
  value: DurationFormValue[]
  onChange: (next: DurationFormValue[]) => void
  currency: string
  canEdit: boolean
  /** ASKED PER LENGTH, because the member rule is per length: a coach who
   *  includes 60 min in a pack and leaves 90 min unlinked has one bookable
   *  length and one dead one, and a single answer would call both fine or both
   *  broken. See `benefitOpensDoorAt`. */
  benefitOpensDoor: (minutes: number) => boolean
  /** The host's own validation message for one row, when it has one. */
  errorFor?: (index: number) => string | undefined
}) {
  const t = useTranslations('Activities')
  const modes: Array<{ value: DurationSaleMode; label: string }> = [
    // Literal keys, never `t(\`durationMode_${m}\`)`: i18n:check counts
    // computed keys and never fails them.
    { value: 'free', label: t('durationModeFree') },
    { value: 'priced', label: t('durationModePriced') },
    { value: 'benefit_only', label: t('durationModeBenefitOnly') },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('fieldDurationsMinutes')}</p>
          <p className="text-xs text-muted-foreground">{t('durationsMinutesHint')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {APPOINTMENT_DURATION_PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              disabled={!canEdit}
              onClick={() => onChange(toggleDurationValue(value, d))}
              className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                value.some((x) => x.minutes === d)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-border hover:border-foreground'
              } ${canEdit ? '' : 'pointer-events-none opacity-60'}`}
            >
              {formatDuration(d)}
            </button>
          ))}
        </div>
      </div>

      {/* One sub-row per SELECTED length — the coach sells TIME, so how it is
          sold is per-length, not one flat activity price. THREE modes, because
          an empty price used to mean two things at once (UX-70): free for
          anyone · priced · not sold individually, i.e. only through the member
          benefit below. There is still no access rule on an appointment — the
          third mode says only that there is no individual price to quote. */}
      {value.length > 0 && (
        // Rows, not cards: one hairline between lengths and no fill behind
        // them — a border here carried no state, see offer/FormLayout.tsx.
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('durationPriceHint')}</p>
          <div className="divide-y">
          {[...value]
            .sort((a, b) => a.minutes - b.minutes)
            .map((d) => {
              const idx = value.findIndex((x) => x.minutes === d.minutes)
              const priceError = errorFor?.(idx)
              return (
                <div key={d.minutes} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{formatDuration(d.minutes)}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {modes.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => onChange(setDurationMode(value, d.minutes, m.value))}
                          aria-pressed={d.mode === m.value}
                          className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                            d.mode === m.value
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background text-muted-foreground border-border hover:border-foreground'
                          } ${canEdit ? '' : 'pointer-events-none opacity-60'}`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {d.mode === 'priced' && (
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground">{currency}</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={d.price}
                        disabled={!canEdit}
                        onChange={(e) =>
                          onChange(setDurationPrice(value, d.minutes, e.target.value))
                        }
                        placeholder="0.00"
                        className="h-8 w-24 text-sm"
                        aria-label={t('durationPriceLabel', {
                          duration: formatDuration(d.minutes),
                        })}
                      />
                    </div>
                  )}
                  {/* A pack-only length with nothing that covers it is bookable
                      by NOBODY — said here, where it is authored, as well as on
                      the pricing health page. */}
                  {d.mode === 'benefit_only' && (
                    <p
                      className={`text-xs ${
                        benefitOpensDoor(d.minutes)
                          ? 'text-muted-foreground'
                          : 'text-destructive'
                      }`}
                    >
                      {benefitOpensDoor(d.minutes)
                        ? t('durationBenefitOnlyHint')
                        : t('durationBenefitOnlyNoWayIn')}
                    </p>
                  )}
                  {priceError && <p className="text-destructive text-xs">{priceError}</p>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
