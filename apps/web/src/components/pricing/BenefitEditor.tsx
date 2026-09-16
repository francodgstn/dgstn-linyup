'use client'

// The ONE editor UI for a `Benefit` (@linyup/shared) — "holding one thing (a
// subscription type) changes the price of another (an appointment duration, a
// class drop-in, a course)". Extracted from the appointment-only member-benefit
// block in offer/activities/page.tsx (2026-07) when the concept generalized to
// classes (drop-in member rate) and courses (purchase-price benefit).
//
// `spend_credits` is deliberately never offered here — the resolver supports it,
// but the UI defers it (see Benefit's doc comment in @linyup/shared).

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Input } from '@/components/ui/input'
import { buttonVariants } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import { normalizeBenefit, type ActivityMemberBenefit, type Benefit } from '@linyup/shared'

export type BenefitEditorContext = 'appointment' | 'class' | 'course'

/** Effects offered per context — coverage (free/credits) is the accessRule's
 *  job on classes, so a class benefit is a price-modifying MEMBER RATE only.
 *
 *  Exported because a second surface edits the same field from the other side:
 *  the "Activities this subscription unlocks" picker in
 *  components/subscriptions/SubscriptionTypesManager.tsx writes an appointment's
 *  `memberBenefit` (UX-69). It must offer the SAME set — a shorter list there
 *  would silently rewrite an effect this editor can save (e.g. hydrate a
 *  `fixed_price` rule, then persist it as `included`). */
export const BENEFIT_CONTEXT_EFFECTS: Record<
  BenefitEditorContext,
  readonly BenefitEditorEffect[]
> = {
  appointment: ['included', 'percent_off', 'fixed_price'],
  class: ['percent_off', 'fixed_price'],
  course: ['included', 'percent_off', 'fixed_price'],
}

/** UI-only effects — `spend_credits` is never offered (see the module doc). */
export type BenefitEditorEffect = 'included' | 'percent_off' | 'fixed_price'

export interface BenefitFormValue {
  subscriptionTypeIds: string[]
  effect: BenefitEditorEffect
  /** percent_off only. Kept as a string ('' = not entered yet). */
  percent: string
  /** fixed_price only. Kept as a string ('' = not entered yet). */
  amount: string
}

export function defaultBenefitFormValue(): BenefitFormValue {
  return { subscriptionTypeIds: [], effect: 'included', percent: '', amount: '' }
}

/** Hydrates form state from a saved doc — accepts either shape (legacy
 *  appointment or the generalized `Benefit`) via `normalizeBenefit`. A
 *  `spend_credits` value (never written by this editor, but possible from
 *  older data or another writer) falls back to `included` for DISPLAY only —
 *  the editor's `context` guard corrects it further on mount if unsupported. */
export function toBenefitFormValue(
  raw: ActivityMemberBenefit | Benefit | null | undefined
): BenefitFormValue {
  const n = normalizeBenefit(raw ?? null)
  if (!n) return defaultBenefitFormValue()
  return {
    subscriptionTypeIds: n.subscriptionTypeIds,
    effect: n.effect === 'spend_credits' ? 'included' : n.effect,
    percent: n.percent != null ? String(n.percent) : '',
    amount: n.amount != null ? String(n.amount) : '',
  }
}

/** Builds the persisted payload — null (not omitted) when empty, so an EDIT can
 *  CLEAR a previously saved benefit (e.g. after unchecking every subscription
 *  type, or disabling class drop-in). */
export function toBenefitPayload(v: BenefitFormValue): Benefit | null {
  if (v.subscriptionTypeIds.length === 0) return null
  return {
    subscriptionTypeIds: v.subscriptionTypeIds,
    effect: v.effect,
    ...(v.effect === 'percent_off' ? { percent: Number(v.percent) } : {}),
    ...(v.effect === 'fixed_price' ? { amount: Number(v.amount) } : {}),
  }
}

/** 1–99, integer. No-op (valid) when the benefit is empty or not percent_off —
 *  shared by every form's zod `superRefine` so the rule lives in one place. */
export function benefitPercentInvalid(v: BenefitFormValue): boolean {
  if (v.subscriptionTypeIds.length === 0 || v.effect !== 'percent_off') return false
  const pct = Number(v.percent)
  return !(v.percent.trim() !== '' && Number.isInteger(pct) && pct >= 1 && pct <= 99)
}

/** ≥ 0.50 (Stripe's floor). No-op (valid) when the benefit is empty or not
 *  fixed_price. */
export function benefitAmountInvalid(v: BenefitFormValue): boolean {
  if (v.subscriptionTypeIds.length === 0 || v.effect !== 'fixed_price') return false
  const amt = Number(v.amount)
  return !(v.amount.trim() !== '' && Number.isFinite(amt) && amt >= 0.5)
}

export interface BenefitEditorProps {
  value: BenefitFormValue
  onChange: (value: BenefitFormValue) => void
  subscriptionTypes: Array<{ id: string; name: string }>
  context: BenefitEditorContext
  percentError?: string | null
  amountError?: string | null
}

export function BenefitEditor({
  value,
  onChange,
  subscriptionTypes,
  context,
  percentError,
  amountError,
}: BenefitEditorProps) {
  const t = useTranslations('Benefit')
  const effects = BENEFIT_CONTEXT_EFFECTS[context]

  // Correct an incompatible effect carried over from another context (e.g. the
  // activities form shares one `memberBenefit` field between the class and
  // appointment sub-forms — switching kind can leave 'included' selected on a
  // class, which class doesn't offer).
  useEffect(() => {
    if (value.subscriptionTypeIds.length > 0 && !effects.includes(value.effect)) {
      onChange({ ...value, effect: effects[0] as BenefitEditorEffect })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, value.effect, value.subscriptionTypeIds.length])

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{t('fieldLabel')}</p>
        <p className="text-xs text-muted-foreground">{t(`hint_${context}` as const)}</p>
      </div>

      <div className="space-y-1.5 rounded-md border p-3">
        {subscriptionTypes.length === 0 ? (
          /* A benefit is held BY a subscription type, so with none there is
             nothing to build one from. The sentence named the destination and
             linked nothing (UX-99) — and this editor is reached from inside the
             appointment activity form, two steps into the flow UX-92 repaired. */
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('noSubs')}</p>
            <Link
              href={'/offer/plans' as Route}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('noSubsAction')}
            </Link>
          </div>
        ) : (
          subscriptionTypes.map((s) => (
            <label key={s.id} className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={value.subscriptionTypeIds.includes(s.id)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    subscriptionTypeIds: e.target.checked
                      ? [...value.subscriptionTypeIds, s.id]
                      : value.subscriptionTypeIds.filter((id) => id !== s.id),
                  })
                }
              />
              {s.name}
            </label>
          ))
        )}
      </div>

      {value.subscriptionTypeIds.length > 0 && (
        <div className="space-y-2">
          <div className={`grid gap-2 ${effects.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {effects.map((effect) => (
              <button
                key={effect}
                type="button"
                onClick={() => onChange({ ...value, effect: effect as BenefitEditorEffect })}
                aria-pressed={value.effect === effect}
                className={`rounded-lg border p-2 text-left transition-colors ${
                  value.effect === effect ? 'border-primary bg-primary/5' : 'hover:border-foreground/30'
                }`}
              >
                <span className="block text-xs font-medium">{t(`effect_${effect}` as const)}</span>
                <span className="block text-[0.6875rem] text-muted-foreground">
                  {t(`effect_${effect}_desc` as const)}
                </span>
              </button>
            ))}
          </div>

          {value.effect === 'percent_off' && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={99}
                  value={value.percent}
                  onChange={(e) => onChange({ ...value, percent: e.target.value })}
                  placeholder="20"
                  className="h-8 w-20 text-sm"
                  aria-label={t('percentLabel')}
                />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
              {percentError && <p className="text-destructive text-xs">{percentError}</p>}
            </div>
          )}

          {value.effect === 'fixed_price' && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0.5}
                  step="0.01"
                  value={value.amount}
                  onChange={(e) => onChange({ ...value, amount: e.target.value })}
                  placeholder="0.00"
                  className="h-8 w-24 text-sm"
                  aria-label={t('amountLabel')}
                />
              </div>
              {amountError && <p className="text-destructive text-xs">{amountError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
