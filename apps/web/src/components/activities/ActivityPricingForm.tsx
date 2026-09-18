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
import { deleteField, doc, updateDoc } from 'firebase/firestore'
import { toast } from 'sonner'
import {
  ACTIVITIES_COLLECTION,
  benefitOpensDoorAt,
  classAccessFacts,
  classAccessRuleFor,
  isAppointmentActivity,
  normalizeBenefit,
  resolveActivityAccessRule,
  type Activity,
  type ActivityAccessRule,
  type ActivityDropIn,
  type SubscriptionType,
  dropInModeOf,
  resolveActivityDropIn,
  studioDropInOf,
  type DropInMode,
  type DropInPrice,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { formatCurrency } from '@/lib/format'
import { useBookingSettings } from '@/hooks/useBookingSettings'
import { refreshQueries } from '@/lib/queryRefresh'
import { useReportPaneDirty } from '@/components/offer/paneDirty'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FormSection, FormSections, SettingRow, SettingRows } from '@/components/offer/FormLayout'
import { MoreOptions } from '@/components/forms/MoreOptions'
import { StudioDropInButton } from '@/components/offer/StudioDropInDialog'
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
  /** The ONE access question left: the club case, under More options. Who may
   *  book otherwise follows from the plans and the drop-in price
   *  (docs/class-access-derived.md). */
  signupRequired: boolean
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

/** The `dropIn` field a draft means — written here once, and read by everything
 *  that asks what the draft would do (the matcher's columns, the summary, the
 *  save). A price rides only under 'custom', as it is stored. */
function draftDropInField(d: Pick<Draft, 'dropInMode' | 'dropInPrice'>): ActivityDropIn {
  return {
    mode: d.dropInMode,
    ...(d.dropInMode === 'custom' && d.dropInPrice
      ? { priceAmount: parsePrice(d.dropInPrice) }
      : {}),
  }
}

function draftOf(a: Activity, studioDropIn: DropInPrice | null): Draft {
  const dropInMode = dropInModeOf(a.dropIn)
  return {
    // Read through THE ONE READER, so the switch opens showing the wall the
    // booking path is already enforcing — on a class stored the old way too.
    signupRequired: classAccessFacts(a, studioDropIn).signupRequired,
    trialEnabled: a.trialEnabled ?? false,
    trialPrice: a.trialPriceAmount != null ? String(a.trialPriceAmount) : '',
    dropInMode,
    dropInPrice:
      dropInMode === 'custom' && a.dropIn?.priceAmount != null ? String(a.dropIn.priceAmount) : '',
    durations: toDurationFormValues(a.durations),
  }
}

/** The access rule a draft would STORE — the plans from the document (the
 *  matcher owns them), the door from the draft, the wall from its one switch. */
function storedRuleFor(
  d: Draft,
  a: Activity,
  studioDropIn: DropInPrice | null
): ActivityAccessRule {
  const facts = classAccessFacts(
    { type: a.type, accessRule: resolveActivityAccessRule(a), dropIn: draftDropInField(d) },
    studioDropIn
  )
  return classAccessRuleFor({
    signupRequired: d.signupRequired,
    includedPlanIds: facts.includedPlanIds,
  })
}

function same(a: Draft, b: Draft): boolean {
  return (
    a.signupRequired === b.signupRequired &&
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
    { ...activity, dropIn: draftDropInField(draft) },
    studioDropIn
  )
  const draftActivity: Activity = isAppointment
    ? // The DRAFT lengths, for the same reason: `rateHasAPriceToApplyTo` reads
      // them, so pricing a length and then reaching for the plan table found
      // every rate column dimmed until the form had been saved once.
      { ...activity, durations: toActivityDurations(draft.durations) }
    : {
        ...activity,
        // ALREADY RESOLVED, so it says so: 'custom' carries the price, 'off' none.
        // Without a mode an unpriced draft reads as 'studio' and the matcher
        // would resolve the default back in under a class set to "no drop-in".
        dropIn: draftDropIn.enabled
          ? { mode: 'custom', enabled: true, priceAmount: draftDropIn.priceAmount }
          : { mode: 'off', enabled: false },
        // DERIVED, like the save's: the matcher must see the door this form
        // is holding, not the one the document was stored with.
        accessRule: storedRuleFor(draft, activity, studioDropIn),
      }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const dropInId = useId()
  const rowId = useId()

  /**
   * WHAT THE DRAFT WOULD MEAN IF SAVED — the same answer the booking path will
   * give, asked of the draft rather than of the stored document so the sentence
   * below moves with the switch the studio is holding.
   *
   * The PLAN IDS come from the stored activity: the matcher owns them and
   * writes them itself, and its ticks are saved in the same click as this form.
   */
  const draftFacts = classAccessFacts(
    { type: activity.type, accessRule: resolveActivityAccessRule(activity), dropIn: draftDropInField(draft) },
    studioDropIn
  )
  const includedPlanNames = draftFacts.includedPlanIds
    .map((id) => plans.find((pl) => pl.id === id)?.name)
    .filter((n): n is string => !!n)
  const ratedPlanNames = (normalizeBenefit(activity.memberBenefit)?.subscriptionTypeIds ?? [])
    .map((id) => plans.find((pl) => pl.id === id)?.name)
    .filter((n): n is string => !!n)
  const doorPrice =
    draftFacts.dropIn.enabled && draftFacts.dropIn.priceAmount != null
      ? formatCurrency(draftFacts.dropIn.priceAmount, currency)
      : null
  // ONE SENTENCE, built from the facts in the order a studio reads them: who is
  // already covered, what everybody else pays, then the newcomer's exception.
  const summaryParts = [
    includedPlanNames.length ? t('summaryIncluded', { names: includedPlanNames.join(', ') }) : null,
    ratedPlanNames.length && doorPrice
      ? t('summaryMemberPrice', { names: ratedPlanNames.join(', ') })
      : null,
    draftFacts.free
      ? draftFacts.signupRequired
        ? t('summaryFreeMembers')
        : t('summaryFreeAnyone')
      : doorPrice
        ? draftFacts.signupRequired
          ? t('summaryMembersPay', { price: doorPrice })
          : t('summaryAnyonePays', { price: doorPrice })
        : t('summaryPlanHoldersOnly'),
    draftFacts.trialAvailable && draft.trialEnabled
      ? draft.trialPrice.trim() !== ''
        ? t('summaryTrialPriced', { price: formatCurrency(parsePrice(draft.trialPrice), currency) })
        : t('summaryTrialFree')
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  // Each part is written to sit mid-sentence; the first one opens it.
  const summarySentence = summaryParts.charAt(0).toUpperCase() + summaryParts.slice(1)

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

  /** What the pair and the tier become, derived exactly as the booking path
   *  will read them back. Both writers of `accessRule` go through this call. */
  const storedRule = storedRuleFor(draft, activity, studioDropIn)

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
              // is the matcher's and must survive every save from here. The
              // pair and the display tier are DERIVED — from the plans the
              // matcher stores and the door this form sets — so nothing here
              // asks the studio who may book (docs/class-access-derived.md).
              'accessRule.audience': storedRule.audience,
              // The legacy projections go on the first save — "plan required" is
              // derived on every read now (docs/class-access-derived.md).
              'accessRule.requirePlan': deleteField(),
              'accessRule.type': deleteField(),
              isFreeTrial: deleteField(),
              // The three answers (`DropInMode`), written whole: a price is
              // stored only under 'custom', so a class that follows the studio
              // carries none and cannot go stale against the default.
              dropIn: {
                mode: draft.dropInMode,
                ...(draft.dropInMode === 'custom' && draft.dropInPrice
                  ? { priceAmount: parsePrice(draft.dropInPrice) }
                  : {}),
              },
              // Both cleared where the door grants nothing — a class free to
              // anyone (`trialAvailable`), which is also the one state
              // `bookSession` keeps the trial door inert in.
              trialEnabled: draftFacts.trialAvailable ? draft.trialEnabled : false,
              trialPriceAmount:
                draft.trialPrice && draftFacts.trialAvailable
                  ? parsePrice(draft.trialPrice)
                  : null,
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
        <FormSections>
          {/* WHO CAN BOOK, SAID RATHER THAN ASKED (docs/class-access-derived.md).
              The studio answers the plans, the drop-in and the trial; the door
              follows from them, so this line is the only place the answer
              appears — and it is read-only. */}
          <FormSection>
            <p className="text-xs text-muted-foreground">{t('accessLabel')}</p>
            <p className="text-sm">{summarySentence}</p>
          </FormSection>

          <FormSection>
            <SettingRows>
              {/* THE SAME SHAPE AS THE TRIAL ABOVE: the switch on the right says
                  whether this class sells a drop-in at all, and only then do
                  the two ways of pricing it appear. The three answers of
                  `DropInMode` are all still written — off ⇒ 'off' (none, even
                  under a studio default), on ⇒ 'studio' (what a new class
                  starts as) until the class names its own — it is only the
                  control that stopped being three radios, because "no
                  drop-in" is a switch, not a third kind of price. */}
              <SettingRow
                htmlFor={`${rowId}-dropin`}
                label={t('dropInLabel')}
                hint={t('dropInHelp')}
                disabled={!canEdit}
                control={
                  <Switch
                    id={`${rowId}-dropin`}
                    checked={draft.dropInMode !== 'off'}
                    onCheckedChange={(on) => set('dropInMode', on ? 'studio' : 'off')}
                    disabled={!canEdit}
                  />
                }
              >
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
                            {/* The SAME dialog the Offerings header opens — one
                                editor of the usual price, reached from where the
                                question comes up (decision 29). */}
                            {canEdit && <StudioDropInButton currency={currency} variant="link" />}
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
              </SettingRow>
            </SettingRows>
          </FormSection>
        </FormSections>
      )}

      {/* THE LENGTHS AND WHAT EACH COSTS — first, because everything below it
          is a rule ABOUT these prices. A plan cannot be said to include or
          discount a session length that has not been chosen yet. */}
      {isAppointment && (
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
      )}

      {/* NO RULE ABOVE THE MATCHER. The tab is one continuous answer to "who
          can book this and what does it cost", and a line across the middle of
          it proposed a boundary that is not there. */}
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
            const current = storedRuleFor(stored, activity, studioDropIn)
            if (
              storedRule.audience === current.audience
            ) {
              return
            }
            await updateDoc(doc(db, ACTIVITIES_COLLECTION, activity.id), {
              'accessRule.audience': storedRule.audience,
              // The legacy projections go on the first save — "plan required" is
              // derived on every read now (docs/class-access-derived.md).
              'accessRule.requirePlan': deleteField(),
              'accessRule.type': deleteField(),
              isFreeTrial: deleteField(),
            })
            refreshQueries(qc, ['activities'])
          }}
          saveHandle={setLinks}
        />
      </div>

      {/* THE TRIAL AND THE ONE REMAINING QUESTION, below the prices they are
          about. A newcomer's first class is an exception to what everybody else
          pays, so it reads after that price rather than before it, and the
          sign-up wall — the club case, which most studios never touch — sits
          under More options (Franco, 2026-09-17). */}
      {!isAppointment && (
        <FormSections>
          <FormSection>
            <SettingRows>
              {/* Independent of WHICH gate is above — a members-only class and a
                  plan-required one both take a newcomer's trial booking. Absent
                  on an open class: see `openTier`. */}
              {draftFacts.trialAvailable && (
                <SettingRow
                  htmlFor={`${rowId}-trial`}
                  label={t('fieldTrialEnabled')}
                  hint={t('trialEnabledHint')}
                  disabled={!canEdit}
                  control={
                    <Switch
                      id={`${rowId}-trial`}
                      checked={draft.trialEnabled}
                      onCheckedChange={(on) => set('trialEnabled', on)}
                      disabled={!canEdit}
                    />
                  }
                >
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
                </SettingRow>
              )}
            </SettingRows>
          </FormSection>
          <FormSection>
            <MoreOptions
              label={t('accessMoreOptionsLabel')}
              hint={t('accessMoreOptionsHint')}
              defaultOpen={draft.signupRequired}
            >
              <SettingRows>
                <SettingRow
                  htmlFor={`${rowId}-signup`}
                  label={t('accessSignupOnly')}
                  hint={t('accessSignupOnlyHint')}
                  disabled={!canEdit}
                  control={
                    <Switch
                      id={`${rowId}-signup`}
                      checked={draft.signupRequired}
                      onCheckedChange={(on) => set('signupRequired', on)}
                      disabled={!canEdit}
                    />
                  }
                />
              </SettingRows>
            </MoreOptions>
          </FormSection>
        </FormSections>
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
