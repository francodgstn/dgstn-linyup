'use client'

/**
 * WHAT A PLAN COSTS, AND HOW MUCH IT BUYS — hosted by the catalogue, beside the
 * activities it opens.
 *
 * ── WHY IT MOVED ────────────────────────────────────────────────────────────
 * The same move the activity's pricing made, for the same reason: the price
 * rows, the intro offer on each of them and the usage limit are what a studio
 * is deciding when it looks at a plan next to the things that plan unlocks.
 * Split across a modal and a pane, half the answer was always on the other
 * screen (Franco, 2026-09-01).
 *
 * The dialog keeps what a plan IS: its name, description, source, whether it is
 * active and public, and what checkout asks for.
 *
 * ── ONE WRITER PER FIELD ────────────────────────────────────────────────────
 * Two components now edit one subscription_types document, which is the shape
 * that produced the course-settings clobber. The split is by field:
 *
 *   this form   prices, introOffers (+ the legacy introOffer, deleted), limits
 *   the matcher the activity edge — accessRule / memberBenefit on ACTIVITIES,
 *               never on this document
 *   the dialog  name, description, source, active, public,
 *               checkout_contact_mode, payoutPerVisit
 *
 * No field appears twice, so neither save can overwrite the other's work.
 *
 * ── THE INTRO OFFER RULES CAME ACROSS UNCHANGED ─────────────────────────────
 * `introOfferSupport` / `introOfferProblem` (@linyup/shared) still decide what
 * is offerable and what is sound, and the save is still REFUSED while any row
 * is unsound — an unsellable offer is worse than none, because
 * `resolveIntroOffer` returns null for it and the public card would advertise
 * nothing while the studio believed it had launched a promotion.
 */

import { forwardRef, useEffect, useState } from 'react'
import {
  useForm,
  useFieldArray,
  type UseFormRegister,
  type UseFormSetValue,
} from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, updateDoc, deleteField } from 'firebase/firestore'
import { toast } from 'sonner'
import { Plus, Trash2, ChevronUp, ChevronDown, Pencil } from 'lucide-react'
import {
  TEAMS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  introOfferSupport,
  INTRO_OFFER_MAX_PERIODS,
  introOfferProblem,
  isRecurringRecurrence,
  introOffersOf,
  resolveUsageLimit,
  type SubscriptionType,
  type SubscriptionPrice,
  type SubscriptionIntroOffer,
  type IntroOfferSupport,
  type IntroOfferProblem,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { formatCurrency } from '@/lib/format'
import { useReportPaneDirty } from '@/components/offer/paneDirty'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { FormSection } from '@/components/ui/form-section'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const RECURRENCES = [
  'per_class',
  'one_time',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annual',
] as const

// Empty-string-tolerant numeric fields. An `<input type="number">` left blank
// yields `''`, and `z.coerce.number()` turns that into 0 — which `.positive()`
// then rejects, so the form refuses to save and says nothing about why. That is
// not hypothetical: it made an UNLIMITED credit pack (the normal case — leave
// the box empty) impossible to save at all.
//
// ZERO IS TREATED THE SAME WAY, and for the same reason: on every field this
// guards — credits, months included, purchase cap, usage limit, intro periods —
// zero and blank mean the identical thing ("none" / "no limit"). A stored 0 from
// a seed or an older document would otherwise reproduce the very bug above on a
// form the studio never typed a zero into.
const optionalPositiveInt = z.preprocess(
  (v) => (v === '' || v === undefined || v === null || Number(v) === 0 ? undefined : v),
  z.coerce.number().int().positive().optional()
)
const optionalNonNegativeAmount = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : v),
  z.coerce.number().min(0).optional()
)

const priceSchema = z.object({
  id: z.string(),
  amount: z.coerce.number().positive(),
  recurrence: z.enum(RECURRENCES),
  // Months of access granted by a one_time price ("2 months included"). On a
  // credit price, this is the pack's validity window instead.
  included_months: optionalPositiveInt,
  // Credit pack (one_time only): the purchase grants this many lesson credits.
  // BLANK MEANS UNLIMITED, which is why it must tolerate an empty string.
  credits: optionalPositiveInt,
  // How many times one contact may buy this price. Blank = unlimited.
  maxPurchasesPerContact: optionalPositiveInt,
  // This price's own intro offer ("first 3 months at 29, then the full price").
  // Per PRICE, not per plan: a plan's monthly and annual price are different
  // offers and a studio prices openers on both.
  introEnabled: z.boolean().optional(),
  introPeriods: optionalPositiveInt,
  introAmount: optionalNonNegativeAmount,
  label: z.string().max(40).optional(),
  active: z.boolean().optional(),
})


const SuffixInput = forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input> & { suffix: string }
>(function SuffixInput({ suffix, className, ...props }, ref) {
  return (
    <div className={cn('relative', className)}>
      {/* The right padding must clear the suffix, which is why the suffix is
          measured in the same place it is drawn rather than guessed at. */}
      <Input ref={ref} {...props} className="pr-[4.5rem] w-full" />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
        {suffix}
      </span>
    </div>
  )
})

/**
 * One price's intro offer ("first 3 months at 29, then the full price").
 *
 * Rendered INSIDE the price row, and only for a recurring price — a one-off or
 * per-class charge has no "then the full price" to return to, so there is
 * nothing to offer rather than a control to disable.
 */
function IntroOfferRow({
  index,
  state,
  currency,
  showError,
  register,
  setValue,
}: {
  index: number
  state: {
    eligible: boolean
    support: IntroOfferSupport
    enabled: boolean
    problem: IntroOfferProblem | null
  }
  currency: string
  showError: boolean
  register: UseFormRegister<PricingData>
  setValue: UseFormSetValue<PricingData>
}) {
  const t = useTranslations('TeamSettings')
  if (!state.eligible) return null

  return (
    <div className="border-t pt-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="accent-primary"
          checked={state.enabled}
          onChange={(e) =>
            setValue(`prices.${index}.introEnabled`, e.target.checked, { shouldDirty: true })
          }
        />
        {t('subTypeIntro')}
      </label>
      {state.enabled && (
        <div className="mt-2 space-y-1.5 pl-5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('subTypeIntroAmount')}</Label>
              <div className="relative w-[140px]">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  {...register(`prices.${index}.introAmount`)}
                  className="h-8 pr-12 text-sm"
                  placeholder="0.00"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                  {currency}
                </span>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('subTypeIntroPeriods')}</Label>
              <Input
                type="number"
                step="1"
                min="1"
                max={INTRO_OFFER_MAX_PERIODS}
                // Locked to 1 on a weekly/fortnightly price — the note below
                // says why, rather than leaving a disabled control unexplained.
                disabled={state.support === 'first_only'}
                {...register(`prices.${index}.introPeriods`)}
                className="h-8 w-[110px] text-sm"
                placeholder="3"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('subTypeIntroFreeHint')}</p>
          {state.support === 'first_only' && (
            <p className="text-xs text-amber-600">{t('subTypeIntroWeeklyLimit')}</p>
          )}
          {showError && state.problem && (
            <p className="text-xs text-destructive">
              {/* `max` is passed for every reason, not just the one that uses
                  it — next-intl throws on a MISSING placeholder and ignores a
                  spare one, so the safe direction is to always supply it. */}
              {t(`subTypeIntroErr_${state.problem}` as Parameters<typeof t>[0], {
                max: INTRO_OFFER_MAX_PERIODS,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const pricingSchema = z.object({
  prices: z.array(priceSchema).default([]),
  limitEnabled: z.boolean().optional(),
  limitCount: optionalPositiveInt,
  limitPer: z.enum(['day', 'week', 'month']).optional(),
})
type PricingData = z.infer<typeof pricingSchema>

function defaultsOf(plan: SubscriptionType): PricingData {
  const limit = resolveUsageLimit(plan)
  const introByPrice = new Map(introOffersOf(plan).map((o) => [o.priceId, o]))
  return {
    prices: (plan.prices ?? []).map((p) => {
      const offer = introByPrice.get(p.id)
      return {
        id: p.id,
        amount: p.amount,
        recurrence: p.recurrence,
        label: p.label ?? '',
        active: p.active ?? true,
        included_months: p.included_months,
        credits: p.credits,
        maxPurchasesPerContact: p.maxPurchasesPerContact,
        introEnabled: !!offer,
        introPeriods: offer?.periods,
        introAmount: offer?.amount,
      }
    }),
    limitEnabled: !!limit,
    limitCount: limit?.count,
    // NEVER `limit?.per` ALONE. The Select below falls back to 'week' for
    // DISPLAY, so a plan with no limit yet showed "a week" over a form value of
    // `undefined` — and the save condition needs all three, so enabling the
    // limit, typing a count and leaving the period on the period it was already
    // showing wrote NOTHING. The prices in the same update saved, which is what
    // made it read as "the limit is not persisted" rather than as a form that
    // never held a period (Franco, staging, 2026-09-02).
    limitPer: limit?.per ?? 'week',
  }
}

export function PlanPricingForm({
  plan,
  teamId,
  currency,
  canEdit,
  links,
}: {
  /** The LIVE document from the plans query. */
  plan: SubscriptionType
  teamId: string
  currency: string
  canEdit: boolean
  /**
   * The activity matcher, rendered inside this form so the tab has ONE Save.
   *
   * A RENDER PROP rather than an element to clone: cloning would inject props
   * the element's type does not declare, which typechecks only by widening it
   * to `any` — and the whole point of the handle is that the host knows exactly
   * what it is receiving.
   */
  links?: (props: {
    hostedInForm: true
    saveHandle: (h: { run: () => Promise<void>; dirty: boolean; blocked: string | null }) => void
  }) => React.ReactNode
}) {
  const t = useTranslations('TeamSettings')
  const tCat = useTranslations('OfferCatalogue')
  const tc = useTranslations('Contacts')
  const tCommon = useTranslations('Common')
  const qc = useQueryClient()
  const [showIntroError, setShowIntroError] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Read by default; typing is a deliberate step. */
  const [editing, setEditing] = useState(false)
  // Read straight off the STORED plan — the read view shows what is saved, not
  // what a draft would become.
  const limit = resolveUsageLimit(plan)
  const introByPrice = new Map(introOffersOf(plan).map((o) => [o.priceId, o]))
  const [linksHandle, setLinksHandle] = useState<{
    run: () => Promise<void>
    dirty: boolean
    blocked: string | null
  } | null>(null)

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
    formState: { isDirty },
  } = useForm<PricingData>({
    resolver: zodResolver(pricingSchema),
    defaultValues: defaultsOf(plan),
  })
  const { fields, append, remove, move } = useFieldArray({ control, name: 'prices' })

  // Re-seed when the selection changes. Keyed on the id, never the object: the
  // plans query returns a fresh one on every refetch, and re-running on those
  // would wipe a price the studio has typed and not yet saved.
  useEffect(() => {
    reset(defaultsOf(plan))
    setShowIntroError(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, reset])

  const watchedPrices = watch('prices') ?? []
  const limitEnabled = watch('limitEnabled') ?? false
  const limitPer = watch('limitPer') ?? 'week'

  /** The offer typed into one price row, resolved against that row's own price:
   *  what Stripe can express for it, the draft, and the shared verdict. */
  const introRowState = (i: number) => {
    const p = watchedPrices[i]
    const recurrence = p?.recurrence
    const eligible = !!p && p.active !== false && isRecurringRecurrence(recurrence)
    const support = eligible ? introOfferSupport(recurrence) : 'none'
    const enabled = eligible && (p?.introEnabled ?? false)
    // NUMBERS, not the strings the form holds: an `<input type="number">`
    // registered without `valueAsNumber` yields a STRING, and zod's coercion
    // only runs at validation.
    const periods = support === 'first_only' ? 1 : Number(p?.introPeriods ?? 1) || 1
    const amountRaw = p?.introAmount as unknown
    // A BLANK field is not zero. `Number('')` is 0, which would quietly turn "I
    // haven't typed the price yet" into "the first months are free".
    const amount =
      amountRaw === '' || amountRaw === undefined || amountRaw === null ? NaN : Number(amountRaw)
    const draft: SubscriptionIntroOffer | null = enabled
      ? { priceId: p!.id, periods, amount }
      : null
    const problem = draft
      ? introOfferProblem(draft, { amount: Number(p!.amount), recurrence: p!.recurrence })
      : null
    return { eligible, support, enabled, draft, problem }
  }

  const introDrafts = watchedPrices
    .map((_, i) => introRowState(i))
    .filter((s) => s.draft && !s.problem)
    .map((s) => s.draft!)
  const hasIntroProblem = watchedPrices.some((_, i) => introRowState(i).problem)

  async function onSubmit(data: PricingData) {
    // Only the matcher touched? Run it and stop — there is nothing of this
    // form's to write, and writing it anyway would stamp `updated_at` for no
    // reason.
    //
    // WHICH IS WHY EVERY `setValue` HERE PASSES `shouldDirty`. React Hook Form
    // does not mark a field dirty on a bare `setValue`, so a control that is not
    // `register`ed — the recurrence select, the active switch, the usage-limit
    // toggle and period — left `isDirty` false, and a studio that touched one of
    // those AND the plan table fell down this branch and had its change dropped
    // without a word.
    if (!isDirty && linksHandle?.dirty) {
      setSaving(true)
      try {
        await linksHandle.run()
      } finally {
        setSaving(false)
      }
      return
    }
    // Refuse the save and name the rule on the row that broke it.
    if (hasIntroProblem) {
      setShowIntroError(true)
      return
    }
    setSaving(true)
    try {
      const prices = (data.prices ?? []).map((p) => {
        const entry: SubscriptionPrice = {
          id: p.id,
          amount: p.amount,
          recurrence: p.recurrence,
          active: p.active ?? true,
        }
        if (p.label?.trim()) entry.label = p.label.trim()
        if (p.recurrence === 'one_time' && p.included_months) {
          entry.included_months = p.included_months
        }
        // Credit packs are one_time only; omit credits: 0/undefined.
        if (p.recurrence === 'one_time' && p.credits) entry.credits = p.credits
        // A purchase cap governs one-time prices only — `resolvePlanPurchaseCap`
        // ignores it anywhere else, so writing it there would be inert data.
        if (p.recurrence === 'one_time' && p.maxPurchasesPerContact) {
          entry.maxPurchasesPerContact = p.maxPurchasesPerContact
        }
        return entry
      })
      // Usage limit: written when enabled with a valid count/period, cleared
      // when disabled. Computed ONCE, because the re-seed below has to read the
      // same answer the write did — `defaultsOf` given the stale `plan` put the
      // OLD limit back into the form the moment the new one landed.
      const limits =
        data.limitEnabled && data.limitCount && data.limitPer
          ? [{ count: data.limitCount, per: data.limitPer }]
          : null
      await updateDoc(doc(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION, plan.id), {
        prices,
        ...(limits ? { limits } : plan.limits?.length ? { limits: deleteField() } : {}),
        // Intro offers: the sound ones, one per price; the key is cleared when
        // none remain. The LEGACY single-offer field is deleted in the same
        // update — this write is where a document migrates forward, so the two
        // shapes can never both stand and `introOffersOf` never has to arbitrate.
        ...(introDrafts.length > 0
          ? { introOffers: introDrafts }
          : plan.introOffers?.length
            ? { introOffers: deleteField() }
            : {}),
        ...(plan.introOffer ? { introOffer: deleteField() } : {}),
      })
      await qc.invalidateQueries({ queryKey: ['subscription-types', teamId] })
      // Re-seed from WHAT WAS WRITTEN, not from the prop — the plans query has
      // only just been invalidated, so `plan` is still the pre-save document.
      reset(
        defaultsOf({
          ...plan,
          prices,
          limits: limits ?? undefined,
          introOffers: introDrafts.length > 0 ? introDrafts : undefined,
          introOffer: undefined,
        })
      )
      if (linksHandle?.dirty) await linksHandle.run()
      // Back to reading — the change is made, and staying in a form of inputs
      // says it is not.
      setEditing(false)
      toast.success(t('saved'))
    } finally {
      setSaving(false)
    }
  }

  const anyDirty = isDirty || !!linksHandle?.dirty
  useReportPaneDirty('plan-pricing', anyDirty)

  /** The matcher alone, from the read view where no form surrounds it. */
  async function runLinksOnly() {
    if (!linksHandle?.dirty) return
    setSaving(true)
    try {
      await linksHandle.run()
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/*
       * TWO MODES, because the two jobs are not the same job.
       *
       * Reading a plan — "what does this cost, what does it include" — is the
       * common one and wants a sentence per price. Changing one is rarer and wants
       * every control. Rendering the edit form always meant the common job was
       * done through a stack of inputs, selects and outlined boxes that exist for
       * the rare one (Franco, 2026-09-02).
       *
       * The cost is a click before a change, which is why the read view is not a
       * summary that hides things: every price, every intro offer and the usage
       * limit are all on it. Nothing is behind the button except the ABILITY TO
       * TYPE.
       */}
      {editing ? (
        <fieldset disabled={!canEdit} className="space-y-4">
          <FormSection
            title={t('subTypePricing')}
            description={t('subTypePricingDesc')}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  append({
                    id: crypto.randomUUID(),
                    amount: 0,
                    recurrence: 'monthly',
                    label: '',
                    active: true,
                  })
                }
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('subTypeAddPrice')}
              </Button>
            }
          >
            {fields.length > 0 && (
              <div className="space-y-2 pt-1">
                {fields.map((field, i) => (
                  <div key={field.id} className="rounded-md border bg-card p-2.5 space-y-2">
                    {/* WRAPS, and the amount field may SHRINK. This row is an
                        amount, a recurrence select (130px) and sometimes a
                        second 130px input — a min-content width the dialog
                        cannot always give it. `DialogBody` is `overflow-y-auto`,
                        and CSS promotes overflow-x to `auto` alongside it, so a
                        child one pixel too wide put a horizontal scrollbar under
                        the whole form. Fixed by letting the row wrap and the
                        flexible child shrink — never by clipping the body,
                        which would hide a control instead of moving it. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative min-w-[8rem] flex-1">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          {...register(`prices.${i}.amount`)}
                          className="pr-12"
                          placeholder="0.00"
                        />
                        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                          {currency}
                        </span>
                      </div>
                      <Select
                        value={watch(`prices.${i}.recurrence`)}
                        onValueChange={(v) =>
                          setValue(
                            `prices.${i}.recurrence`,
                            v as (typeof RECURRENCES)[number],
                            { shouldDirty: true }
                          )
                        }
                      >
                        <SelectTrigger className="w-[130px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {/* NO NEW "PER CLASS" PRICE (UX-104). It is charged once
                              and never ends, and a held non-credit price covers
                              every linked class — so "10-class card, per class"
                              sold unlimited access for life. A pack is one-time
                              plus a number of classes. A price already stored
                              with it keeps its label so the form can show it. */}
                          {RECURRENCES.filter(
                            (r) => r !== 'per_class' || watch(`prices.${i}.recurrence`) === 'per_class'
                          ).map((r) => (
                            <SelectItem key={r} value={r}>
                              {tc(`recurrence_${r}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {/* THE UNIT STAYS ON SCREEN once a value is typed. These
                          used to carry their meaning in the PLACEHOLDER, which
                          vanishes at the first keystroke and leaves a bare
                          number nobody can read back — is "2" two months, two
                          credits, or two of something else? Same suffix
                          treatment as the currency on the amount field beside
                          it, so the row reads as a sentence either way. */}
                      {watch(`prices.${i}.recurrence`) === 'one_time' && (
                        <SuffixInput
                          suffix={t('subTypeIncludedMonthsSuffix')}
                          type="number"
                          step="1"
                          min="1"
                          className="w-[150px]"
                          aria-label={t('subTypeIncludedMonths')}
                          {...register(`prices.${i}.included_months`)}
                        />
                      )}
                    </div>
                    {watch(`prices.${i}.recurrence`) === 'one_time' && (
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                        <div className="space-y-1">
                          <SuffixInput
                            suffix={t('subTypeCreditsSuffix')}
                            type="number"
                            step="1"
                            min="1"
                            className="w-[170px] h-8 text-sm"
                            aria-label={t('subTypeCreditsPlaceholder')}
                            {...register(`prices.${i}.credits`)}
                          />
                          <p className="text-xs text-muted-foreground">{t('subTypeCreditsHelp')}</p>
                        </div>
                        {/* How many times ONE person may buy this — the "our
                            2-month intro is once per customer" rule. Blank =
                            unlimited, which is why it is a plain optional
                            field and not a switch with a number behind it. */}
                        <div className="space-y-1">
                          <SuffixInput
                            suffix={t('subTypeMaxPurchasesSuffix')}
                            type="number"
                            step="1"
                            min="1"
                            className="w-[170px] h-8 text-sm"
                            placeholder={t('subTypeMaxPurchasesUnlimited')}
                            aria-label={t('subTypeMaxPurchases')}
                            {...register(`prices.${i}.maxPurchasesPerContact`)}
                          />
                          <p className="text-xs text-muted-foreground">
                            {t('subTypeMaxPurchasesHelp')}
                          </p>
                        </div>
                      </div>
                    )}
                    {/* This price's own intro offer. It sits INSIDE the row
                        because it is a fact about this price — a plan may open
                        its monthly and its annual price differently, and when
                        the offer lived at plan level only one of them could
                        have one. */}
                    <IntroOfferRow
                      index={i}
                      state={introRowState(i)}
                      currency={currency}
                      showError={showIntroError}
                      register={register}
                      setValue={setValue}
                    />
                    <div className="flex items-center gap-2">
                      <Input
                        {...register(`prices.${i}.label`)}
                        placeholder={t('subTypePriceLabelPlaceholder')}
                        className="flex-1 h-8 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => move(i, i - 1)}
                        disabled={i === 0}
                        className="p-1 rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                        aria-label={t('subTypePriceMoveUp')}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, i + 1)}
                        disabled={i === fields.length - 1}
                        className="p-1 rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                        aria-label={t('subTypePriceMoveDown')}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <Switch
                        checked={watch(`prices.${i}.active`) ?? true}
                        onCheckedChange={(v) => setValue(`prices.${i}.active`, v, { shouldDirty: true })}
                      />
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                        aria-label={t('subTypePriceRemove')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </FormSection>
  
          {/* Usage limit — caps CLASS bookings covered by this subscription
              per calendar day/week/month. Once spent, the drop-in price still
              applies (member rate); credits and appointments are unaffected. */}
          <FormSection
            title={t('subTypeUsageLimit')}
            description={t('subTypeUsageLimitDesc')}
            action={
              <Switch
                checked={limitEnabled}
                onCheckedChange={(v) => setValue('limitEnabled', v, { shouldDirty: true })}
              />
            }
          >
            {limitEnabled && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  step="1"
                  min="1"
                  {...register('limitCount')}
                  className="w-24"
                  placeholder="3"
                />
                <Select
                  value={limitPer}
                  onValueChange={(v) =>
                    setValue('limitPer', v as 'day' | 'week' | 'month', { shouldDirty: true })
                  }
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">{t('subTypeLimitPeriodDay')}</SelectItem>
                    <SelectItem value="week">{t('subTypeLimitPeriodWeek')}</SelectItem>
                    <SelectItem value="month">{t('subTypeLimitPeriodMonth')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </FormSection>

        {/* ONE BUTTON THAT FLIPS. In the read view it says "Edit prices"; here
            it is the same control saying "Save prices", and it closes the
            editor on success. Two buttons in two places for the two halves of
            one toggle made the way back something to hunt for (Franco,
            2026-09-02).

            It saves the PRICES. The plan table below keeps its own Save — the
            labels say which is which, so neither can be mistaken for the
            other's scope. */}
        {canEdit && (
          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" size="sm" disabled={saving || hasIntroProblem}>
              {saving ? tCat('saving') : tCat('savePrices')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                reset(defaultsOf(plan))
                setEditing(false)
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        )}
        </fieldset>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            {(plan.prices ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('subTypeNoPrices')}</p>
            ) : (
              (plan.prices ?? []).map((price) => {
                const offer = introByPrice.get(price.id)
                return (
                  <div key={price.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{formatCurrency(price.amount, currency)}</span>
                    <span className="text-muted-foreground">
                      {tc(`recurrence_${price.recurrence}` as 'recurrence_monthly')}
                    </span>
                    {price.label && (
                      <span className="text-muted-foreground">· {price.label}</span>
                    )}
                    {price.active === false && (
                      <span className="text-xs text-amber-600">· {t('subTypeInactive')}</span>
                    )}
                    {!!price.credits && (
                      <span className="text-xs text-muted-foreground">
                        · {t('subTypeCreditsBadge', { count: price.credits })}
                      </span>
                    )}
                    {offer && (
                      <span className="text-xs text-muted-foreground">
                        · {t('subTypeIntroSummary', {
                          amount: formatCurrency(offer.amount, currency),
                          periods: offer.periods,
                        })}
                      </span>
                    )}
                  </div>
                )
              })
            )}
          </div>
  
          <p className="text-sm text-muted-foreground">
            {limit
              ? t('subTypeLimitSummary', { count: limit.count, per: limit.per })
              : t('subTypeNoLimit')}
          </p>
  
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {tCat('editPrices')}
            </Button>
          )}
        </div>
      )}

      {/* No rule above the matcher — see ActivityPricingForm. */}
      {links ? (
        <div className="pt-2">{links({ hostedInForm: true, saveHandle: setLinksHandle })}</div>
      ) : null}

      {/* THE PLAN TABLE'S OWN SAVE, below the table it saves. The prices
          above carry their own flip button, so this row appears only when the
          table is the thing holding an edit. */}
      {canEdit && linksHandle?.dirty && (
        <div className="flex items-center justify-end gap-3 border-t pt-3">
          {linksHandle.blocked ? (
            <span className="text-xs text-destructive">{linksHandle.blocked}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{tCat('unsaved')}</span>
          )}
          <Button type="submit" size="sm" disabled={saving || !!linksHandle.blocked}>
            {saving ? tCat('saving') : tCat('save')}
          </Button>
        </div>
      )}
    </form>
  )
}
