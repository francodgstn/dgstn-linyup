'use client'

/**
 * WHO CAN BOOK, AND WHAT IT COSTS — the money half of an activity, hosted by
 * the catalogue rather than by the activity dialog.
 *
 * ── WHY IT MOVED ────────────────────────────────────────────────────────────
 * These three decisions (the access tier, the newcomer trial, the drop-in
 * price) share one screen with the plan matcher, because they are the same
 * conversation: what someone is charged, and which plans change that. Split
 * across a modal and a pane, a studio answered half of it in each and could
 * never see the two halves at once — the drop-in price lived in the dialog
 * while the member rate ON that price lived in the catalogue, one scroll and
 * one modal apart (Franco, 2026-09-01).
 *
 * The dialog keeps what an activity IS: its name, kind, colour, tags, session
 * lengths, the prose, and the two switches that are not about money
 * (auto-confirm and the waitlist).
 *
 * ── ONE WRITER PER FIELD ────────────────────────────────────────────────────
 * The lesson from the course settings form, which wrote `accessRule` as a whole
 * map and silently clobbered the plan list the matcher had just saved. Two
 * components now edit one activity document, so the split is by FIELD and it is
 * absolute:
 *
 *   this form   accessRule.type, isFreeTrial, dropIn, trialEnabled,
 *               trialPriceAmount, durations
 *   the matcher accessRule.subscriptionTypeIds, memberBenefit
 *   the dialog  everything else — and it no longer names any field above
 *
 * `accessRule` is the one shared map, so this form writes `accessRule.type` as
 * a FIELD PATH and never touches the sibling id list. It cannot clobber a list
 * it cannot address.
 *
 * APPOINTMENTS HAVE NO ACCESS ARM HERE. An appointment's price is its gate and
 * it has neither a drop-in nor a trial — so it gets the SESSION LENGTHS and the
 * matcher, and none of the class controls.
 *
 * The lengths arrived on 2026-09-02, from the dialog's Details tab: an
 * appointment's price is attached to its LENGTH, so the two are one control and
 * splitting them across two tabs asked the studio to answer one question twice.
 * The dialog now renders that editor while CREATING only — see
 * `AppointmentDurationsEditor`.
 */

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { toast } from 'sonner'
import { Check, DoorOpen, Pencil, Users, X } from 'lucide-react'
import {
  ACTIVITIES_COLLECTION,
  benefitOpensDoorAt,
  canonicalClassGate,
  classAccessTierOf,
  isAppointmentActivity,
  resolveActivityAccessRule,
  type Activity,
  type ActivityAccessRule,
  type ActivityAudience,
  type SubscriptionType,
  dropInModeOf,
  resolveActivityDropIn,
  studioDropInOf,
  type DropInMode,
  type DropInPrice,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { formatCurrency } from '@/lib/format'
import { useAuth } from '@/contexts/AuthContext'
import { bookingSettingsRef, useBookingSettings } from '@/hooks/useBookingSettings'
import { refreshQueries } from '@/lib/queryRefresh'
import { useReportPaneDirty } from '@/components/offer/paneDirty'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ActivityPlanLinks } from '@/components/offer/ActivityPlanLinks'
import {
  AppointmentDurationsEditor,
  durationPriceProblem,
  toActivityDurations,
  toDurationFormValues,
  type DurationFormValue,
} from '@/components/activities/AppointmentDurationsEditor'

// ── WHO MAY BOOK, AS TWO QUESTIONS ──────────────────────────────────────────
// The old single tier answered "who books FREE" while being labelled "who can
// book", which is why "Any member" and "Specific subscriptions" read as two
// overlapping walls. They are now the two questions a studio actually has:
//
//   audience     may this person book at all?      anyone | members
//   requirePlan  must they hold one of the plans?  the tick, members-only
//
// What they PAY is neither: a linked plan makes it free, everyone else pays the
// drop-in below. See `ActivityAccessRule` in @linyup/shared.

/** Major-unit price string → number. Accepts a comma decimal separator. */
function parsePrice(raw: string): number {
  return parseFloat(raw.replace(',', '.'))
}

interface Draft {
  audience: ActivityAudience
  requirePlan: boolean
  trialEnabled: boolean
  trialPrice: string
  /** How this class answers the drop-in question — see `DropInMode`. */
  dropInMode: DropInMode
  /** 'custom' only. */
  dropInPrice: string
  /** APPOINTMENT-ONLY, and read from the STORED lengths rather than from
   *  `resolveAppointmentDurations`: the fallback 60-minute entry is what a
   *  booking gate assumes, not something the studio chose, and seeding the
   *  editor with it would have the next Save write it down as if they had. */
  durations: DurationFormValue[]
}

/**
 * The two answers, read through the GATE'S OWN translation of a stored rule
 * (`canonicalClassGate`), so the form opens showing exactly what the booking
 * path is already doing — including for a document that predates both fields.
 * The plan matcher stores the pair through the same call, so the two writers
 * of `accessRule` cannot spell one door two ways.
 */
function audienceDraftOf(
  a: Activity,
  studioDropIn: DropInPrice | null
): { audience: ActivityAudience; requirePlan: boolean } {
  return canonicalClassGate(
    resolveActivityAccessRule(a),
    resolveActivityDropIn(a, studioDropIn).enabled
  )
}

/** The stored rule a draft means — the two answers plus the display tier they
 *  imply, so `type` can never drift from them. */
function draftAccessRule(d: Pick<Draft, 'audience' | 'requirePlan'>): ActivityAccessRule {
  return {
    type: classAccessTierOf(d),
    audience: d.audience,
    requirePlan: d.requirePlan,
  }
}

function draftOf(a: Activity, studioDropIn: DropInPrice | null): Draft {
  const dropInMode = dropInModeOf(a.dropIn)
  return {
    ...audienceDraftOf(a, studioDropIn),
    trialEnabled: a.trialEnabled ?? false,
    trialPrice: a.trialPriceAmount != null ? String(a.trialPriceAmount) : '',
    dropInMode,
    dropInPrice:
      dropInMode === 'custom' && a.dropIn?.priceAmount != null ? String(a.dropIn.priceAmount) : '',
    durations: toDurationFormValues(a.durations),
  }
}

function same(a: Draft, b: Draft): boolean {
  return (
    a.audience === b.audience &&
    a.requirePlan === b.requirePlan &&
    a.trialEnabled === b.trialEnabled &&
    a.trialPrice === b.trialPrice &&
    a.dropInMode === b.dropInMode &&
    a.dropInPrice === b.dropInPrice &&
    // Compared by VALUE, not by reference — the draft is rebuilt on every
    // keystroke, so a reference check would report every appointment dirty
    // forever and arm the Save button on a form nobody touched.
    JSON.stringify(a.durations) === JSON.stringify(b.durations)
  )
}

/**
 * THE STUDIO DEFAULT, CHANGED IN PLACE. This option used to send the studio to
 * Offerings → Pricing to set or change the number — but a class's pricing tab
 * is where the question comes up, so the answer is taken here: a pencil (or
 * "Set one" while there is none), a price, a tick. It writes THE SAME FIELD the
 * Pricing page writes, the same way — `bookingSettings.dropIn` replaced whole
 * under `mergeFields`, so no stale price can survive beneath it — and
 * `syncStudioDropIn` fans the change out to every following class's mirror
 * exactly as it would from there. Only ever writes an ENABLED default: the one
 * way to switch the studio default off is still the Pricing page, because
 * doing it from inside one class's form would silently change every other
 * class that follows it.
 */
function StudioDropInDefault({
  studioDropIn,
  currency,
  canEdit,
}: {
  studioDropIn: DropInPrice | null
  currency: string
  canEdit: boolean
}) {
  const t = useTranslations('Activities')
  const { currentTeamId } = useAuth()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [price, setPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const parsed = parsePrice(price)
  const invalid = !(price.trim() !== '' && parsed >= 0.5)

  function open() {
    setPrice(studioDropIn?.priceAmount != null ? String(studioDropIn.priceAmount) : '')
    setEditing(true)
  }

  async function confirm() {
    if (!currentTeamId || invalid || saving) return
    setSaving(true)
    try {
      await setDoc(
        bookingSettingsRef(currentTeamId),
        { bookingSettings: { dropIn: { enabled: true, priceAmount: parsed } } },
        { mergeFields: ['bookingSettings.dropIn'] }
      )
      await qc.invalidateQueries({ queryKey: ['booking-settings', currentTeamId] })
      toast.success(t('dropInStudioDefaultSaved'))
      setEditing(false)
    } catch (err) {
      console.error('[drop-in default save] failed:', err)
      toast.error(err instanceof Error ? err.message : t('dropInStudioDefaultSaved'))
    } finally {
      setSaving(false)
    }
  }

  if (!canEdit) return null

  if (editing) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{currency}</span>
        <Input
          type="number"
          min={0}
          step="0.01"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void confirm()
            } else if (e.key === 'Escape') {
              setEditing(false)
            }
          }}
          placeholder={t('dropInPricePlaceholder')}
          aria-label={t('dropInStudioDefaultEdit')}
          className="h-8 w-24 text-sm"
          autoFocus
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={invalid || saving}
          onClick={() => void confirm()}
          aria-label={t('dropInStudioDefaultConfirm')}
        >
          <Check aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={saving}
          onClick={() => setEditing(false)}
          aria-label={t('dropInStudioDefaultCancel')}
        >
          <X aria-hidden />
        </Button>
        {invalid && price.trim() !== '' && (
          <span className="basis-full text-xs text-destructive">{t('dropInPriceValidation')}</span>
        )}
      </span>
    )
  }

  return studioDropIn ? (
    <button
      type="button"
      onClick={open}
      aria-label={t('dropInStudioDefaultEdit')}
      className="text-muted-foreground transition-colors hover:text-foreground"
    >
      <Pencil aria-hidden className="h-3.5 w-3.5" />
    </button>
  ) : (
    <button
      type="button"
      onClick={open}
      className="text-xs text-primary underline-offset-2 hover:underline"
    >
      {t('dropInModeStudioSetInline')}
    </button>
  )
}

export function ActivityPricingForm({
  activity,
  plans,
  currency,
  canEdit,
}: {
  /** The LIVE document from the activities query — the matcher below writes the
   *  same doc, so a snapshot would go stale under this form. */
  activity: Activity
  plans: SubscriptionType[]
  currency: string
  canEdit: boolean
}) {
  const t = useTranslations('Activities')
  const tCat = useTranslations('OfferCatalogue')
  const qc = useQueryClient()
  const invalidateSetupChecklist = useInvalidateSetupChecklist()
  // The studio's default drop-in, which a class follows unless it says
  // otherwise — the form opens with it in hand so "Studio default · CHF 25"
  // names the actual number and the matcher prices a following class by it.
  const { data: bookingSettings } = useBookingSettings()
  const studioDropIn = studioDropInOf(bookingSettings)

  const stored = draftOf(activity, studioDropIn)
  const [draft, setDraft] = useState<Draft>(stored)
  const [saving, setSaving] = useState(false)
  /** The matcher's save, handed up so this tab has ONE button — see its
   *  `saveHandle` prop. */
  const [links, setLinks] = useState<{
    run: () => Promise<void>
    dirty: boolean
    blocked: string | null
  } | null>(null)
  // Re-seed when the selection changes, or when the stored document changes
  // under us (the matcher writes it, and a save here refetches it).
  useEffect(() => {
    setDraft(draftOf(activity, studioDropIn))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id, JSON.stringify(draftOf(activity, studioDropIn))])

  const isAppointment = isAppointmentActivity(activity)
  // Read from the STORED activity, which is what the matcher below writes and
  // what the resolver will read — never from the draft, which holds lengths
  // and prices but no rules.
  const benefitOpensDoor = (minutes: number) => benefitOpensDoorAt(activity, minutes)
  // Read off the DRAFT tier, not the stored one: picking "Any member" should
  // reveal the plan table there and then, the same way the course's sell
  // switch reveals its rate columns.
  // The plan table is meaningful in EVERY state now, so it is never hidden: a
  // class anyone may book can still make holders of a plan free and charge the
  // rest, which is the ordinary "members free, visitors pay" shape.
  const noPlanEdge = false
  /**
   * THE MATCHER READS THE DRAFT TIER, not the stored one.
   *
   * Its facets come from the document it is handed, so on a class still stored
   * as `open` every column was a dash until this form had been saved — picking
   * "Any member" revealed an empty grid rather than a usable one. The PLAN IDS
   * still come from the stored activity: the matcher owns those and this form
   * does not.
   */
  /** What the DRAFT sells at the door — the studio default when the class
   *  follows it — so the matcher's rate columns light up under a price the
   *  class does not store itself. Through THE ONE READER, like every surface. */
  const draftDropIn = resolveActivityDropIn(
    {
      ...activity,
      dropIn: {
        mode: draft.dropInMode,
        enabled: draft.dropInMode === 'custom',
        ...(draft.dropInPrice ? { priceAmount: parsePrice(draft.dropInPrice) } : {}),
      },
    },
    studioDropIn
  )
  const draftActivity: Activity = isAppointment
    ? // The DRAFT lengths, for the same reason: `rateHasAPriceToApplyTo` reads
      // them, so pricing a length and then reaching for the plan table found
      // every rate column dimmed until the form had been saved once.
      { ...activity, durations: toActivityDurations(draft.durations) }
    : {
        ...activity,
        dropIn: {
          enabled: draftDropIn.enabled,
          ...(draftDropIn.priceAmount != null ? { priceAmount: draftDropIn.priceAmount } : {}),
        },
        accessRule: {
          ...draftAccessRule(draft),
          ...(resolveActivityAccessRule(activity).subscriptionTypeIds?.length
            ? { subscriptionTypeIds: resolveActivityAccessRule(activity).subscriptionTypeIds }
            : {}),
        },
      }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const dropInId = useId()
  /**
   * THE TRIAL DOOR EXISTS ONLY ON A GATED CLASS. `bookSession` opens it for a
   * guest when `accessRule.type !== 'open'` and treats it as fully inert
   * otherwise — on an open class a newcomer already books through the front
   * door (and becomes a trial contact by doing so, which is what the
   * "Open to anyone" card says). So the control is not shown there, and what
   * it governs is cleared on save rather than left standing as data no
   * surface can show or change — the same rule the trial price follows.
   */
  const openTier = classAccessTierOf(draft) === 'open'

  const dropInPriceInvalid =
    draft.dropInMode === 'custom' &&
    !(draft.dropInPrice.trim() !== '' && parsePrice(draft.dropInPrice) >= 0.5)
  const trialPriceInvalid =
    draft.trialPrice.trim() !== '' && !(parsePrice(draft.trialPrice) >= 0.5)
  // Through the editor's own predicate, so a length saved from here can never
  // be one the create dialog would have refused.
  const durationPriceInvalid = isAppointment && draft.durations.some(durationPriceProblem)
  // An appointment with no length at all falls back to one unpriced 60-minute
  // slot everywhere it is read (`resolveAppointmentDurations`). That is a
  // working state, not an error — so it is not refused here; it is simply what
  // the studio gets until they pick a length.
  const invalid = dropInPriceInvalid || trialPriceInvalid || durationPriceInvalid
  const dirty = !same(draft, stored)
  /** EITHER half being touched arms the one button. */
  const anyDirty = dirty || !!links?.dirty
  useReportPaneDirty('activity-pricing', anyDirty)

  async function save() {
    if (invalid || !anyDirty || links?.blocked) return
    setSaving(true)
    try {
      // The tier has to land before the matcher's transaction reads it — the
      // same ordering `onBeforeSave` enforced when the two had separate buttons.
      if (!dirty && links?.dirty) {
        await links.run()
        return
      }
      // AN APPOINTMENT WRITES ONLY ITS LENGTHS. The class keys below are not
      // merely irrelevant to it — `accessRule` and `dropIn` are read by nothing
      // on an appointment path, so writing them would store settings no surface
      // can show or change (see ActivityMemberBenefit's history note).
      await updateDoc(
        doc(db, ACTIVITIES_COLLECTION, activity.id),
        isAppointment
          ? { durations: toActivityDurations(draft.durations) }
          : {
              // FIELD PATHS, not the whole map: `accessRule.subscriptionTypeIds`
              // is the matcher's and must survive every save from here.
              'accessRule.audience': draft.audience,
              'accessRule.requirePlan': draft.requirePlan,
              // The display projection, kept in step so a surface that only
              // wants to say "open / members only / plan required" never
              // disagrees with the two fields above.
              'accessRule.type': draftAccessRule(draft).type,
              isFreeTrial: draft.audience === 'anyone' && !draft.requirePlan,
              // The three answers (`DropInMode`), written whole: a price is
              // stored only under 'custom', so a class that follows the studio
              // carries none and cannot go stale against the default.
              dropIn: {
                mode: draft.dropInMode,
                enabled: draft.dropInMode === 'custom',
                ...(draft.dropInMode === 'custom' && draft.dropInPrice
                  ? { priceAmount: parsePrice(draft.dropInPrice) }
                  : {}),
              },
              // Both cleared on an open tier — see `openTier`.
              trialEnabled: openTier ? false : draft.trialEnabled,
              trialPriceAmount:
                draft.trialPrice && !openTier ? parsePrice(draft.trialPrice) : null,
            }
      )
      refreshQueries(qc, ['activities'])
      // "Set a price" is a derived setup step keyed on `dropIn.enabled`.
      void invalidateSetupChecklist()
      if (links?.dirty) await links.run()
      toast.success(t('savedToast'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {!isAppointment && (
        <>
          <div className="space-y-2">
            <Label>{t('accessLabel')}</Label>
            <p className="text-xs text-muted-foreground">{t('accessHint')}</p>
            {/* TWO cards, not three. The third used to be "Specific
                subscriptions", which was the same field the plan table below
                already edits — so it asked one question twice and left the
                studio deciding which control won. */}
            <div className="grid gap-2 sm:grid-cols-2">
              {(['anyone', 'members'] as const).map((who) => {
                // A DOOR, not a padlock. `Lock` already means "you cannot have
                // this" everywhere a member sees it (shop, course player,
                // gamification), and a members-only class is not locked — the
                // studio picked an audience.
                //
                // `Users` and NOT `IdCard`, which was the first choice: the
                // catalogue already spends `IdCard` on PLANS (its rail tab and
                // its menu entry), so a card here would mean "a plan" and
                // "members" on one screen. `Users` is what the org nav already
                // calls Members, and the rail's third state — "Plan required" —
                // is the one that gets the card.
                const Icon = who === 'anyone' ? DoorOpen : Users
                const active = draft.audience === who
                return (
                  <label
                    key={who}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm transition-colors ${
                      active ? 'border-primary bg-primary/5' : 'hover:border-foreground/30'
                    } ${canEdit ? '' : 'pointer-events-none opacity-60'}`}
                  >
                    <input
                      type="radio"
                      className="mt-0.5 accent-primary"
                      checked={active}
                      onChange={() => set('audience', who)}
                      disabled={!canEdit}
                    />
                    <span className="min-w-0">
                      {/* Literal keys per branch, never a template-literal key:
                          i18n:check counts computed keys and never fails them. */}
                      <span className="flex items-center gap-1.5 font-medium">
                        <Icon
                          aria-hidden
                          className={`h-4 w-4 shrink-0 ${
                            active ? 'text-primary' : 'text-muted-foreground'
                          }`}
                        />
                        {who === 'anyone' ? t('access_open') : t('access_members')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {who === 'anyone' ? t('access_open_desc') : t('access_members_desc')}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            {/* Only under MEMBERS ONLY: a guest holds no plan by definition, so
                "anyone may book" and "a plan is required" cannot both be true.
                And it is a separate control from the table on purpose — ticking
                a plan there must never silently narrow the door. */}
            {draft.audience === 'members' && (
              <label
                className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm ${
                  canEdit ? 'cursor-pointer' : 'pointer-events-none opacity-60'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  checked={!draft.requirePlan}
                  onChange={(e) => set('requirePlan', !e.target.checked)}
                  disabled={!canEdit}
                />
                <span>
                  <span className="font-medium">{t('accessAllowWithoutPlan')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('accessAllowWithoutPlanHint')}
                  </span>
                </span>
              </label>
            )}
          </div>

          <div className="divide-y rounded-lg border">
            {/* Independent of WHICH gate is above — a members-only class and a
                plan-required one both take a newcomer's trial booking. Absent
                on an open class: see `openTier`. */}
            {!openTier && (
              <div className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 pr-4">
                    <p className="text-sm font-medium">{t('fieldTrialEnabled')}</p>
                    <p className="text-xs text-muted-foreground">{t('trialEnabledHint')}</p>
                  </div>
                  <input
                    type="checkbox"
                    className="shrink-0 accent-primary"
                    checked={draft.trialEnabled}
                    onChange={(e) => set('trialEnabled', e.target.checked)}
                    disabled={!canEdit}
                  />
                </div>
                {draft.trialEnabled && (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 pr-4">
                      <p className="text-xs font-medium">{t('trialPriceLabel')}</p>
                      <p className="text-xs text-muted-foreground">{t('trialPriceHint')}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{currency}</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={draft.trialPrice}
                        onChange={(e) => set('trialPrice', e.target.value)}
                        placeholder={t('trialPricePlaceholder')}
                        className="h-8 w-24 text-sm"
                        disabled={!canEdit}
                      />
                    </div>
                  </div>
                )}
                {trialPriceInvalid && (
                  <p className="text-xs text-destructive">{t('trialPriceValidation')}</p>
                )}
              </div>
            )}

            <div className="space-y-2 p-3">
              {/* THE SAME SHAPE AS THE TRIAL ABOVE: the tick on the right says
                  whether this class sells a drop-in at all, and only then do
                  the two ways of pricing it appear. The three answers of
                  `DropInMode` are all still written — off ⇒ 'off' (none, even
                  under a studio default), on ⇒ 'studio' (what a new class
                  starts as) until the class names its own — it is only the
                  control that stopped being three radios, because "no
                  drop-in" is a switch, not a third kind of price. */}
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 pr-4">
                  <p className="text-sm font-medium">{t('dropInLabel')}</p>
                  <p className="text-xs text-muted-foreground">{t('dropInHelp')}</p>
                </div>
                <input
                  type="checkbox"
                  className="shrink-0 accent-primary"
                  checked={draft.dropInMode !== 'off'}
                  onChange={(e) => set('dropInMode', e.target.checked ? 'studio' : 'off')}
                  disabled={!canEdit}
                />
              </div>
              {draft.dropInMode !== 'off' && (
                <div className="space-y-1.5">
                  {(['studio', 'custom'] as const).map((mode) => {
                    const active = draft.dropInMode === mode
                    const id = `${dropInId}-${mode}`
                    return (
                      // A div with id/htmlFor rather than a wrapping <label>: the
                      // studio option carries a pencil BUTTON, and a button inside
                      // a label also fires the label's activation — the radio
                      // would flip under the click.
                      <div
                        key={mode}
                        className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm ${
                          canEdit ? '' : 'pointer-events-none opacity-60'
                        }`}
                      >
                        <input
                          id={id}
                          type="radio"
                          className="accent-primary"
                          checked={active}
                          onChange={() => set('dropInMode', mode)}
                          disabled={!canEdit}
                        />
                        {/* Literal keys per branch, never a template-literal key:
                            i18n:check counts computed keys and never fails them. */}
                        {mode === 'studio' ? (
                          <>
                            <label htmlFor={id} className={canEdit ? 'cursor-pointer' : ''}>
                              {studioDropIn
                                ? t('dropInModeStudio', {
                                    amount: formatCurrency(studioDropIn.priceAmount ?? 0, currency),
                                  })
                                : t('dropInModeStudioNone')}
                            </label>
                            <StudioDropInDefault
                              studioDropIn={studioDropIn}
                              currency={currency}
                              canEdit={canEdit}
                            />
                          </>
                        ) : (
                          <>
                            <label htmlFor={id} className={canEdit ? 'cursor-pointer' : ''}>
                              {t('dropInModeCustom')}
                            </label>
                            {active && (
                              <span className="flex items-center gap-1.5">
                                <span className="text-xs text-muted-foreground">{currency}</span>
                                <Input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={draft.dropInPrice}
                                  onChange={(e) => set('dropInPrice', e.target.value)}
                                  placeholder={t('dropInPricePlaceholder')}
                                  className="h-8 w-24 text-sm"
                                  disabled={!canEdit}
                                />
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {dropInPriceInvalid && (
                <p className="text-xs text-destructive">{t('dropInPriceValidation')}</p>
              )}
            </div>
          </div>

        </>
      )}

      {/* THE LENGTHS AND WHAT EACH COSTS — first, because everything below it
          is a rule ABOUT these prices. A plan cannot be said to include or
          discount a session length that has not been chosen yet. */}
      {isAppointment && (
        <div className="rounded-lg border p-3">
          <AppointmentDurationsEditor
            value={draft.durations}
            onChange={(next) => set('durations', next)}
            currency={currency}
            canEdit={canEdit}
            benefitOpensDoor={benefitOpensDoor}
            errorFor={(i) =>
              draft.durations[i] && durationPriceProblem(draft.durations[i])
                ? t('durationPriceValidation')
                : undefined
            }
          />
        </div>
      )}

      {/* WHERE THE MATCHER WOULD BE, on a class no plan can bear on. An open
          class is free to book for everybody: nothing for a plan to open, and
          no price for one to reduce. The switch that changes that is directly
          above, which is why this sentence sits here and not on the pane. */}
      {noPlanEdge ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          {tCat('openNoPlanEdge')}
        </p>
      ) : (
        // NO RULE ABOVE THE MATCHER. The tab is one continuous answer to "who
        // can book this and what does it cost", and a line across the middle of
        // it proposed a boundary that is not there.
        <div className={isAppointment ? '' : 'pt-2'}>
        <ActivityPlanLinks
          direction="from-offering"
          offering={{
            id: activity.id,
            name: activity.name,
            collection: ACTIVITIES_COLLECTION,
            color: activity.color ?? '',
            target: { kind: 'activity', doc: draftActivity },
          }}
          offerings={[]}
          plans={plans}
          currency={currency}
          canEdit={canEdit}
          hostedInForm
          // The matcher's transaction reads the STORED activity, so an unsaved
          // tier has to land first or a tick is computed against the old one —
          // the same seam the course settings form uses.
          onBeforeSave={async () => {
            if (
              draft.audience === stored.audience &&
              draft.requirePlan === stored.requirePlan
            ) {
              return
            }
            await updateDoc(doc(db, ACTIVITIES_COLLECTION, activity.id), {
              'accessRule.audience': draft.audience,
              'accessRule.requirePlan': draft.requirePlan,
              'accessRule.type': draftAccessRule(draft).type,
              isFreeTrial: draft.audience === 'anyone' && !draft.requirePlan,
            })
            refreshQueries(qc, ['activities'])
          }}
          saveHandle={setLinks}
        />
      </div>
      )}

      {/* ONE BUTTON FOR THE TAB, at its foot, below everything it saves. */}
      {canEdit && (
        <div className="flex items-center justify-end gap-3 border-t pt-3">
          {links?.blocked ? (
            <span className="text-xs text-destructive">{links.blocked}</span>
          ) : (
            anyDirty && <span className="text-xs text-muted-foreground">{tCat('unsaved')}</span>
          )}
          <Button
            size="sm"
            disabled={!anyDirty || invalid || saving || !!links?.blocked}
            onClick={() => void save()}
          >
            {saving ? tCat('saving') : tCat('save')}
          </Button>
        </div>
      )}
    </div>
  )
}
