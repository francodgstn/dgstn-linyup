'use client'

import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useSaveBarSection } from '@/components/forms/SaveBar'
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteField,
  serverTimestamp
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, SUBSCRIPTION_TYPES_SUBCOLLECTION } from '@linyup/shared'
import type { SubscriptionType } from '@linyup/shared'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { MoreOptions } from '@/components/forms/MoreOptions'
import { Globe } from 'lucide-react'

/**
 * THE SUBSCRIPTION-TYPE EDITOR, as a component rather than a fixture of the
 * manager that lists them.
 *
 * It lived inside `SubscriptionTypesManager`, so the only way to edit a plan was
 * to be on the page that renders that list — the catalogue, which is where a
 * studio actually reasons about what a plan opens, could offer nothing but a
 * link away (Franco, 2026-08-31: "move activities/subscriptions popup modals
 * into the catalogue page, so catalogue now becomes the core offer editing").
 *
 * NOTHING ABOUT THE FORM CHANGED in the move. Its schema, its price row, its
 * intro-offer row and its defaults are here with it because nothing else used
 * them; the manager keeps its list, its reorder and its delete. Both surfaces
 * mount the same component, so there is one plan form in the product.
 */


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
const optionalNonNegativeAmount = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : v),
  z.coerce.number().min(0).optional()
)


const subTypeSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  source: z.enum(['internal', 'aggregator']).default('internal'),
  active: z.boolean().optional(),
  public: z.boolean().optional(),
  checkout_contact_mode: z.enum(['off', 'minimal', 'full']).optional(),
  // Aggregator-only: what the partner pays per attended visit.
  payoutPerVisit: optionalNonNegativeAmount,
})
type SubTypeData = z.infer<typeof subTypeSchema>

/**
 * The values a COPY starts from. Everything that describes the offer is carried
 * over; everything that is an identity or a promise to the public is not:
 *
 *  • `public` → false. A half-edited copy must not land on the pricing page.
 *  • every price gets a NEW id (they are client-generated uuids, referenced by
 *    member subscriptions and by payment rows).
 *  • no `id` / `order` / `created_at` — the create path below mints those, the
 *    same way it does for a brand-new type.
 *
 * The intro offer needs no remapping here any more: it rides ON its price row,
 * so a re-issued price id carries its own offer with it. The id-map dance this
 * used to do — and the "drop the offer if the price it named was not copied"
 * case it had to handle — was a cost of storing the offer away from its price.
 *
 * There is no Stripe object on a subscription type (prices are minted at
 * checkout from these figures), so nothing Stripe-shaped can be inherited here.
 */
function duplicateDefaults(source: SubscriptionType, copyName: string): SubTypeData {
  const base = emptyDefaults(source)
  return {
    ...base,
    name: copyName,
    public: false,
  }
}

function emptyDefaults(editing: SubscriptionType | null): SubTypeData {
  // Whichever shape the stored plan uses — the per-price list or the legacy
  // single offer — read through the one normaliser, keyed by price id.
  return {
    name: editing?.name ?? '',
    description: editing?.description ?? '',
    source: editing?.source ?? 'internal',
    active: editing?.active ?? true,
    // New subscription types default to visible on the public pricing page;
    // existing ones keep whatever was saved.
    public: editing ? (editing.public ?? false) : true,
    checkout_contact_mode: editing?.checkout_contact_mode ?? 'minimal',
    payoutPerVisit: editing?.payoutPerVisit,
  }
}

// Linking an activity to a subscription is NOT done here any more. It lives in
// /manage/offer, which edits the same edge from either side through the one
// writer in @linyup/shared (`activityPlanEdgeUpdate`). This editor used to own a
// second copy of where that edge is stored — and the copies disagreed: it read
// only `accessRule`, so every appointment benefit looked unlinked, and an
// unlinked-looking tick got wiped on the next save (UX-69).

/**
 * A number field that keeps its UNIT visible while you type in it.
 *
 * The placeholder is not a label: it disappears at the first keystroke, and a
 * price row full of bare numbers ("2", "10", "1") cannot be read back at all.
 * The amount field has always carried its currency this way — this is the same
 * device, applied to the fields that were relying on a placeholder to explain
 * themselves. `aria-label` still carries the full name for screen readers, since
 * the suffix is an abbreviation.
 */

/**
 * One price's intro offer ("first 3 months at 29, then the full price").
 *
 * Rendered INSIDE the price row, and only for a recurring price — a one-off or
 * per-class charge has no "then the full price" to return to, so there is
 * nothing to offer rather than a control to disable.
 */

export function SubTypeDialog({
  open,
  onOpenChange,
  teamId,
  editing,
  duplicating,
  currency,
  nextOrder,
  onSaved,
  inline = false,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  editing: SubscriptionType | null
  /** The type a NEW one is being copied from — `editing` stays null so the
   *  submit takes the CREATE branch and nothing exists until it is saved. */
  duplicating: SubscriptionType | null
  currency: string
  /** Order assigned to a newly created type so it appends to the end. */
  nextOrder: number
  onSaved: () => void
  /** Render the FORM ONLY, with no dialog around it — see the same prop on
   *  `ActivityDialog` for why the catalogue's pane needs this and why the form
   *  is not extracted into its own component to provide it. */
  inline?: boolean
}) {
  const t = useTranslations('TeamSettings')
  const tCommon = useTranslations('Common')
  const tCat = useTranslations('OfferCatalogue')

  const initialValues = () =>
    duplicating
      ? duplicateDefaults(duplicating, tCommon('copyName', { name: duplicating.name }))
      : emptyDefaults(editing)

  // Read ONCE per mount — this component remounts on every target change (every
  // call site keys it on `editing`/`duplicating`'s id), so this is never stale.
  // UX-108: the disclosure it feeds must open BY ITSELF whenever a stored plan
  // already holds a value nobody would type by accident — a partner source, or
  // a checkout-contact mode other than the default.
  const initial = initialValues()
  const dialogMoreOptionsDefaultOpen =
    initial.source === 'aggregator' ||
    (!!initial.public && (initial.checkout_contact_mode ?? 'minimal') !== 'minimal')

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isSubmitting, isDirty },
  } = useForm<SubTypeData>({
    resolver: zodResolver(subTypeSchema),
    defaultValues: initial,
  })

  useEffect(() => {
    if (open) {
      reset(initialValues())
    }
  // `initialValues` is a fresh closure each render; listing it as a dependency
  // would reset the form continuously.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, duplicating, reset])

  const source = watch('source')
  const active = watch('active') ?? true
  const isPublic = watch('public') ?? false
  const contactMode = watch('checkout_contact_mode') ?? 'minimal'

  /** Resolves `true` once written. A failure is toasted HERE: the save bar
   *  that calls this in the catalogue pane cannot say what went wrong. */
  async function onSubmit(data: SubTypeData): Promise<boolean> {
    const payload = {
      name: data.name,
      description: data.description || null,
      source: data.source,
      active: data.active ?? true,
      public: data.public ?? false,
      checkout_contact_mode: data.checkout_contact_mode ?? 'minimal',
      // ── THE MONEY IS NOT THIS FORM'S ──────────────────────────────────
      // `prices`, `introOffers` and `limits` belong to PlanPricingForm in the
      // catalogue. This payload must not NAME them: it holds an older copy of
      // every one, and writing that copy back is exactly how the course
      // settings form un-linked plans for a week.
      // Payout per visit: aggregator types only.
      ...(data.source === 'aggregator' && typeof data.payoutPerVisit === 'number'
        ? { payoutPerVisit: data.payoutPerVisit }
        : editing?.payoutPerVisit !== undefined
          ? { payoutPerVisit: deleteField() }
          : {}),
    }
    try {
      if (editing) {
        await updateDoc(
          doc(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION, editing.id),
          payload
        )
      } else {
        await addDoc(
          collection(db, TEAMS_COLLECTION, teamId, SUBSCRIPTION_TYPES_SUBCOLLECTION),
          {
            ...payload,
            order: nextOrder,
            created_at: serverTimestamp(),
          }
        )
        // NOTHING is linked here. What a plan opens is the edge editor's, and it
        // needs an id to write against — which is why the dialog shows "save
        // first" until this create has run. Reopening the plan is the next step,
        // not a fallback.
      }
    } catch (err) {
      console.error('[plans] save failed:', err)
      toast.error(t('saveError'))
      return false
    }
    // Inline, the written values are the new baseline, so the tab is clean
    // again before the refetch lands.
    if (inline) reset(data)
    onSaved()
    onOpenChange(false)
    return true
  }

  // THE PANE'S DETAILS TAB SAVES FROM THE FLOATING BAR. Only an inline edit
  // registers; the dialog keeps its own footer.
  const { inSaveBar } = useSaveBarSection('plan-details', {
    dirty: inline && !!editing && isDirty,
    // Validation runs on save; a refused save shows the field errors and
    // leaves the bar up.
    valid: true,
    save: () =>
      new Promise<boolean>((resolve) => {
        void handleSubmit(
          async (data) => resolve(await onSubmit(data)),
          () => resolve(false)
        )()
      }),
    reset: () => reset(initialValues()),
  })

  const fields = (
    <>
          <div className="space-y-1">
            <Label>{t('fieldSubTypeName')}</Label>
            <Input {...register('name')} placeholder="e.g. Monthly pass, Fitpass" />
          </div>
          <div className="space-y-1">
            <Label>{t('fieldSubTypeDesc')}</Label>
            <Textarea
              {...register('description')}
              rows={2}
              placeholder="Optional context — e.g. Unlimited access, valid for the whole month"
              className="resize-none"
            />
          </div>
          <div className="flex items-center justify-between py-1">
            <div className="space-y-0.5">
              <Label>{t('subTypeActive')}</Label>
              <p className="text-xs text-muted-foreground">{t('subTypeActiveDesc')}</p>
            </div>
            <Switch checked={active} onCheckedChange={(v) => setValue('active', v)} />
          </div>

          <div className="flex items-center justify-between py-1">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                {t('subTypePublic')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('subTypePublicDesc')}</p>
            </div>
            <Switch checked={isPublic} onCheckedChange={(v) => setValue('public', v)} />
          </div>

          {/* UX-108: a partner source, its payout and the checkout contact mode
              are the RARE path — most studios sell their own plans and never
              touch these. Collapsed by default; opens itself the moment a
              stored plan already holds a non-default answer (computed once at
              mount from the record being edited, above), so nothing a studio
              already configured is ever hidden from it. */}
          <MoreOptions
            label={t('subTypeMoreOptionsLabel')}
            hint={t('subTypeMoreOptionsHint')}
            defaultOpen={dialogMoreOptionsDefaultOpen}
          >
            <div className="space-y-1.5">
              <Label>{t('fieldSubTypeSource')}</Label>
              <div className="flex gap-2">
                {(['internal', 'aggregator'] as const).map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setValue('source', val)}
                    className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors text-left ${
                      source === val
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:border-foreground/30'
                    }`}
                  >
                    <p className="font-medium">
                      {t(val === 'internal' ? 'subTypeSourceInternal' : 'subTypeSourceAggregator')}
                    </p>
                    <p className="text-xs font-normal mt-0.5 text-muted-foreground">
                      {val === 'internal'
                        ? t('subTypeSourceInternalDesc')
                        : t('subTypeSourceAggregatorDesc')}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {source === 'aggregator' && (
              <div className="space-y-1">
                <Label>{t('subTypePayoutPerVisit')}</Label>
                <div className="relative max-w-[200px]">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    {...register('payoutPerVisit')}
                    className="pr-12"
                    placeholder="0.00"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                    {currency}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{t('subTypePayoutPerVisitDesc')}</p>
              </div>
            )}

            {isPublic && (
              <div className="space-y-1.5">
                <Label>{t('subTypeCheckoutContact')}</Label>
                {/* Selectable option cards — the same shape the activity editor's
                    "who can book" uses, and for the same reason: each option's
                    explanation belongs INSIDE the box it explains. These three
                    used to be bare pills with all three explanations concatenated
                    into one sentence underneath, which the reader had to map back
                    to the buttons by position — and which no translator could keep
                    in the button order, being a single string. */}
                <div className="grid gap-2 lg:grid-cols-3">
                  {(['off', 'minimal', 'full'] as const).map((val) => (
                    <label
                      key={val}
                      className={`flex items-start gap-2 cursor-pointer text-sm rounded-lg border p-2.5 transition-colors ${
                        contactMode === val ? 'border-primary bg-primary/5' : 'hover:border-foreground/30'
                      }`}
                    >
                      <input
                        type="radio"
                        className="mt-0.5 accent-primary"
                        checked={contactMode === val}
                        onChange={() => setValue('checkout_contact_mode', val)}
                      />
                      <span>
                        <span className="font-medium">
                          {t(`subTypeContactMode_${val}` as Parameters<typeof t>[0])}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`subTypeContactMode_${val}_desc` as Parameters<typeof t>[0])}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </MoreOptions>

          {/* Pricing (optional) — kept secondary so the simple flow stays one-field */}


          {/* WHAT THIS PLAN OPENS is edited in the catalogue, beside the
              prices that make it worth opening — see
              components/subscriptions/PlanPricingForm.tsx. The control lived
              here for two releases; it moved out with the pricing rather than
              being deleted, so there is still exactly ONE writer of the edge
              and it is still `ActivityPlanLinks`. */}

          {/* AUTOMATIONS ARE NOT A FIELD OF THIS FORM. They are other records
              that happen to reference this plan, and they save themselves —
              sitting under a Save button that does not write them said
              otherwise. The catalogue gives them their own tab; the dialog
              omits them, because a plan being created has none to show
              (Franco, 2026-09-02). */}
    </>
  )

  // ONE LABEL, ONE SIZE, on every tab — the same words the pricing tab uses.
  const save = (
    <Button type="submit" size={inline ? 'sm' : undefined} disabled={isSubmitting}>
      {isSubmitting ? (inline ? tCat('saving') : t('saving')) : inline ? tCat('save') : t('save')}
    </Button>
  )

  if (inline) {
    return (
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {fields}
        {!inSaveBar && <div className="flex justify-end border-t pt-3">{save}</div>}
      </form>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('editSubscriptionType')
              : duplicating
                ? tCommon('duplicate')
                : t('addSubscriptionType')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4 py-2">
            {fields}
          </DialogBody>

          <DialogFooter>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {save}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
