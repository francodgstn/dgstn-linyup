'use client'

import { useId, useState, useRef, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { toast } from 'sonner'
import { collection, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from '@/lib/firebase'
import { refreshQueries } from '@/lib/queryRefresh'
import { useAuth } from '@/contexts/AuthContext'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { FormSection, FormSections, SettingRow, SettingRows } from '@/components/offer/FormLayout'
import { Button, buttonVariants } from '@/components/ui/button'
import { ACTIVITIES_COLLECTION, resolveAutoConfirm } from '@linyup/shared'
import { resolveBookingContactFields } from '@linyup/shared'
import { benefitOpensDoorAt } from '@linyup/shared'
import { MAX_ACTIVITY_TAGS, normalizeActivityTags, normalizeBookingQuestions } from '@linyup/shared'
import type { Activity, ActivityType, SaasPlan, FormField, BookingContactField } from '@linyup/shared'

// Session lengths and their prices are ONE control and they live on Access &
// pricing now — this dialog renders the editor only while CREATING, where the
// pane's tabs do not exist yet. See the module doc there.
import {
  AppointmentDurationsEditor,
  parsePriceInput,
  toActivityDurations,
  toDurationFormValues,
} from '@/components/activities/AppointmentDurationsEditor'
import { BookingQuestionsEditor } from '@/components/activities/BookingQuestionsEditor'
import { ActivityTagsEditor } from '@/components/activities/ActivityTagsEditor'
import { BookingContactFieldsEditor } from '@/components/booking/BookingContactFieldsEditor'
import { useBookingSettings } from '@/hooks/useBookingSettings'
import { usePlan } from '@/hooks/usePlan'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import { usePlanName } from '@/hooks/usePlanName'
import { ColorPicker, DEFAULT_ACCENT } from '@/components/ui/color-picker'
import { ImageIcon, X } from 'lucide-react'
/**
 * THE ACTIVITY EDITOR, as a component rather than a page fixture.
 *
 * It lived inside `offer/activities/page.tsx`, which meant the ONLY way to edit
 * an activity was to be on that page — the catalogue, which is where a studio
 * actually reasons about what it sells, could offer nothing but a link away
 * (Franco, 2026-08-31: "move activities/subscriptions popup modals into the
 * catalogue page, so catalogue now becomes the core offer editing").
 *
 * NOTHING ABOUT THE FORM CHANGED in the move. Its schema, its duration helpers
 * and its slug are here with it because nothing else used them; the activities
 * page keeps its list, its card and its archive dialog. Both pages now mount the
 * same component, so there is one activity form in the product and a change to
 * it lands in both places at once.
 */

/** The waitlist's plan gate, mirroring the server side of it
 *  (`requirePlan(teamId, 'coach')` in joinWaitlist). One constant, because a
 *  toggle a tenant can set and a queue that then refuses every join is worse
 *  than no toggle at all. */
const WAITLIST_MIN_PLAN: SaasPlan = 'coach'

function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// The one member-benefit rule for the whole activity — see `Benefit` in
// @linyup/shared. Appointments: applies to every priced duration. Classes:
// applies to the drop-in price (a member rate), only while drop-in is
// enabled. Form value type, hydration/payload helpers and validation now live
// in the shared `BenefitEditor` (components/pricing/), used by both the
// appointment and class sub-forms below.

// ─── constants ────────────────────────────────────────────────────────────────

const ACTIVITY_TYPES: ActivityType[] = ['class', 'appointment']

// ─── schema ───────────────────────────────────────────────────────────────────

// Wrapped in a factory so the ≥0.5 price-floor message can be translated — the
// rest of the messages here are pre-existing tech debt (hardcoded English),
// unrelated to this change, left as-is.
function createActivitySchema(t: ReturnType<typeof useTranslations>, creating: boolean) {
  return z.object({
    name: z.string().min(1, 'Required').max(80),
    description: z.string().max(500).optional(),
    prerequisites: z.string().max(300).optional(),
    confirmationInstructions: z.string().max(2000).optional(),
    meetingPoint: z.string().max(200).optional(),
    whatsIncluded: z.string().max(1000).optional(),
    whatsNotIncluded: z.string().max(1000).optional(),
    faq: z.string().max(2000).optional(),
    cancellationPolicy: z.string().max(2000).optional(),
    // Book-form questions (shared FormField schema). Validated loosely here —
    // the editor constrains type/count, and blank-labelled rows are dropped on
    // save rather than blocking it.
    bookingQuestions: z.array(z.any()),
    contactFields: z.array(z.object({ key: z.string(), required: z.boolean().optional() })),
    type: z.enum(['class', 'appointment'] as const).default('class'),
    // Free-text display labels for the public booking cards. They replaced a
    // four-value `level` enum that no public surface ever rendered — a studio
    // grades its classes in its own words, or not at all.
    tags: z.array(z.string()).max(MAX_ACTIVITY_TAGS),
    color: z.string().optional(),
    // CLASS-ONLY paid-access gate (supersedes the legacy isFreeTrial toggle;
    // 'open' === free trial). Appointments dropped this entirely — the price is
    // Drop-in / pay-per-class: an uncovered contact may pay this to book a single
    // session. CLASS-ONLY.
    // CLASS-ONLY: independent of accessTier — a gated class still takes a
    // newcomer's trial booking when this is on.
    // CLASS-ONLY: reduced trial price, kept as a string in form state ('' = free
    // trial, today's behaviour). A number reduces the trial to that price
    // instead of the class's normal price.
    // CLASS-ONLY: a full session offers a queue instead of a dead end. This is
    // the ONLY place the flag lives — sessions carry no copy of it, so turning
    // it on here reaches every session of the activity, past and future, with
    // no fan-out and nothing to backfill.
    waitlistEnabled: z.boolean(),
    // Does a booking for this activity confirm itself, or wait on studio review?
    // Not implied by `type` — shown for classes and appointments alike.
    autoConfirm: z.boolean(),
    // APPOINTMENT-ONLY: the session lengths clients choose from, each with its
    // own optional base price. Kept as strings in form state ('' = no price
    // yet) — see toDurationFormValues / toActivityDurations for the conversion
    // to/from the persisted shape.
    durations: z.array(
      z.object({
        minutes: z.number(),
        price: z.string(),
        mode: z.enum(['free', 'priced', 'benefit_only'] as const),
      })
    ),
  }).superRefine((d, ctx) => {
    // ASKED ON A CREATE ONLY, because the control is only rendered on a create.
    // On an edit the lengths belong to Access & pricing, and a legacy
    // appointment stored with none would otherwise fail Save here against a
    // field that is nowhere on screen — a dead form with no way to diagnose it,
    // which is precisely what the rest of this schema is written to avoid.
    if (creating && d.type === 'appointment' && d.durations.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['durations'], message: t('durationsRequiredValidation') })
    }
    d.durations.forEach((dur, i) => {
      // 'priced' with nothing in the box is the one state the stored shape
      // cannot distinguish from free — so it is refused here rather than saved
      // as an accidentally-free one-to-one.
      if (dur.mode === 'priced' && !(parsePriceInput(dur.price) >= 0.5)) {
        ctx.addIssue({ code: 'custom', path: ['durations', i, 'price'], message: t('durationPriceValidation') })
      }
      if (dur.mode !== 'priced' && dur.price.trim() !== '' && !(parsePriceInput(dur.price) >= 0.5)) {
        ctx.addIssue({ code: 'custom', path: ['durations', i, 'price'], message: t('durationPriceValidation') })
      }
    })
  })
}

type ActivityFormData = z.infer<ReturnType<typeof createActivitySchema>>

// ─── dialog ───────────────────────────────────────────────────────────────────

export function ActivityDialog({
  open,
  onClose,
  teamId,
  userId,
  editing,
  duplicating,
  nextOrder,
  currency,
  onCreated,
  inline = false,
  section,
}: {
  open: boolean
  onClose: () => void
  teamId: string
  userId: string
  /**
   * The LIVE document, re-read from the activities query on every render — not
   * the snapshot taken when the dialog opened. The plan editor below writes
   * `accessRule` on this same document while the form is open, so a stale
   * snapshot here would have this form's Save write the pre-edit allow-list
   * back over it (see `kindSpecificPayload`).
   */
  editing: Activity | null
  /**
   * The activity a NEW one is being copied from. `editing` stays null, so the
   * submit takes the CREATE branch below and every identity field is minted
   * there exactly as it is for a blank activity: a fresh doc id, a slug derived
   * from the "(copy)" name (so it can't collide with the original's), this
   * team, this author, a new `order` at the end of the list. Only the
   * CONFIGURATION is carried over — which is the whole cost being saved.
   */
  duplicating: Activity | null
  /** Order assigned to a newly created activity so it appends to the end. */
  nextOrder: number
  /** Team's billing currency (ISO code), shown next to duration price inputs. */
  currency: string
  /**
   * Called with the new id after a CREATE, before `onClose`.
   *
   * A brand-new activity has no price, no tier and no plans, and this form no
   * longer asks for any of them — so the host selects it in the catalogue,
   * where those controls now live. Without this the studio would save a class
   * and then have to go and find it to finish the job (Franco, 2026-09-01).
   */
  onCreated?: (activityId: string) => void
  /**
   * Render the FORM ONLY, with no dialog around it.
   *
   * The catalogue's pane shows this under a "Details" tab beside the pricing
   * one, because a pane full of editable fields plus a button labelled "Edit"
   * told a studio the visible fields were not editing — which was false, and
   * the button gave no hint of what it hid (Franco, 2026-09-02).
   *
   * The form is not extracted into its own component for this: it is ~500 lines
   * of hooks over one `useForm`, and splitting them from the JSX they serve
   * would buy a boundary nobody crosses. `open` is ignored inline; there is no
   * dialog to open. Creating and duplicating still use the dialog — those are
   * "make a new thing", which is what a modal is for.
   */
  inline?: boolean
  /** Which group of fields to render when `inline`. Omitted renders both,
   *  which is what the dialog does — creating asks for everything at once. */
  section?: 'details' | 'booking'
}) {
  const t = useTranslations('Activities')
  const tCommon = useTranslations('Common')
  const tCat = useTranslations('OfferCatalogue')
  const qc = useQueryClient()
  // A saved activity can move TWO derived setup steps: "add an activity" on its
  // existence, and "set a price" on `dropIn.enabled`. Beside the list
  // invalidation, never instead of it — they are different queries.
  const invalidateSetupChecklist = useInvalidateSetupChecklist()
  // The waitlist is a paid-tier feature, and THIS is where its flag is written —
  // the activity doc is a client write, so the gate has to sit on the control
  // itself (the same shape every other plan-gated toggle uses). `joinWaitlist`
  // carries the matching server-side requirePlan, so the queue can never open
  // below the tier even if the flag were set some other way.
  const { isAtLeast } = usePlan()
  const planName = usePlanName()
  const waitlistAllowed = isAtLeast(WAITLIST_MIN_PLAN)
  // TWO different questions, deliberately not fused. `waitlistAllowed` is "may
  // this studio have queues at all" (plan). `waitlistOffered` is "does this
  // studio use them" — a team-level switch in Settings → Booking, off by
  // default, so a new studio never meets the concept while setting up its first
  // class. Most will never want a queue; the ones who do go looking.
  //
  // It hides the CONTROL, not the feature: an activity keeps whatever flag it
  // already had, and anyone already in a queue keeps their place. Same shape as
  // the plan carry-through below.
  //
  // Read from THE booking-settings store (teams/{id}/public_profile —
  // useBookingSettings), never the team doc: the mirror that used to hold it was
  // owner-only, so a manager's save never reached it (UX-6).
  const { data: bookingSettings } = useBookingSettings(teamId)
  const { team } = useAuth()
  const { isInstalled } = useInstalledPlugins()
  const waitlistOffered = bookingSettings?.waitlistEnabled === true
  // What the studio already asks for on EVERY booking — shown here as
  // "already collected" rather than as an unticked row, because this list adds
  // to the team default and never replaces it.
  const teamContactFieldKeys = useMemo(
    () => resolveBookingContactFields(bookingSettings, null).map((f) => f.key),
    [bookingSettings]
  )
  const customFieldDefinitions = useMemo(
    () => (isInstalled('custom-fields') ? team?.custom_field_definitions ?? [] : []),
    [isInstalled, team?.custom_field_definitions]
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rowId = useId()
  // Does the mounted plan editor hold ticks it has not written yet? It reports
  // this upward because THIS form's Save writes the same document and carries
  // the STORED plan list through — so pressing it would discard them.
  const [imageFile, setImageFile] = useState<File | null>(null)
  // A copy keeps the cover image: `image_url` is a download URL for a file that
  // outlives the source (activities are ARCHIVED, never deleted), and a new
  // upload on either side writes under its own activity id.
  const [imagePreview, setImagePreview] = useState<string | null>(
    (editing ?? duplicating)?.image_url ?? null
  )
  const activitySchema = useMemo(() => createActivitySchema(t, !editing), [t, editing])

  // ONE seed for the form's starting values: the activity being edited, or the
  // one being copied. `editing` alone still decides which BRANCH of onSubmit
  // runs — a duplicate is a create, and must go down the create path.
  const seed = editing ?? duplicating

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ActivityFormData>({
    resolver: zodResolver(activitySchema),
    defaultValues: seed
      ? {
          name: duplicating ? tCommon('copyName', { name: seed.name }) : seed.name,
          description: seed.description ?? '',
          prerequisites: seed.prerequisites ?? '',
          confirmationInstructions: seed.confirmationInstructions ?? '',
          meetingPoint: seed.meetingPoint ?? '',
          whatsIncluded: seed.whatsIncluded ?? '',
          whatsNotIncluded: seed.whatsNotIncluded ?? '',
          faq: seed.faq ?? '',
          cancellationPolicy: seed.cancellationPolicy ?? '',
          bookingQuestions: seed.bookingQuestions ?? [],
          contactFields: seed.contactFields ?? [],
          type: (seed.type ?? 'class') as ActivityType,
          // NORMALISED on the way IN, not just on the way out. A stored array
          // longer than the cap (a seed, an older client, a future cap change)
          // would otherwise fail the schema on every submit — and a form whose
          // Save silently does nothing, with the offending field nowhere on
          // screen, is a dead form with no way to diagnose it.
          tags: normalizeActivityTags(seed.tags ?? []),
          color: seed.color ?? '',
          waitlistEnabled: seed.waitlistEnabled ?? false,
          durations: toDurationFormValues(seed.durations),
          autoConfirm: resolveAutoConfirm(seed),
        }
      : {
          name: '', description: '', prerequisites: '', confirmationInstructions: '',
          meetingPoint: '', whatsIncluded: '', whatsNotIncluded: '', faq: '', cancellationPolicy: '',
          bookingQuestions: [],
          contactFields: [],
          type: 'class' as ActivityType, tags: [],
          // Defaults for a NEW activity. 'members' rather than 'open': a studio
          // sells memberships, so a class its members can book is the ordinary
          // case, and 'open' means free for anyone (resolvePaymentOptions
          // short-circuits it to `covered`) — the wrong thing to land on by
          // accident. A newcomer can still be let in via "Free trial for
          // newcomers" below, which is what makes 'members' safe as a default.
          color: DEFAULT_ACCENT,
          waitlistEnabled: false,
          durations: [],
          // TRUE for a new activity of either kind — the same answer
          // `resolveAutoConfirm` gives a stored doc that never set the field,
          // so the form's starting point and the booking path agree.
          autoConfirm: true,
        },
  })
  const type = watch('type')
  const waitlistEnabled = watch('waitlistEnabled')
  const durations = watch('durations') || []
  // Can a 'benefit_only' length actually be opened by anything? Only an
  // INCLUDED benefit is a way in — a percentage off a price that does not exist
  // opens nothing (the resolver refuses it; see the appointment arm).
  // Read from the SAVED activity, not the form: the rule moved to the catalogue,
  // so this dialog can only report what is stored. A duration whose only way in
  // is a benefit therefore answers against the same document the resolver will.
  const benefitOpensDoor = (minutes: number) => !!seed && benefitOpensDoorAt(seed, minutes)

  // Does the activity being EDITED already carry anything from the "More
  // options" tail? If so the disclosure opens showing it — a field the studio
  // filled in and then cannot find is worse than the long form this replaces.

  // There is deliberately NO re-defaulting of `autoConfirm` on a type flip any
  // more: the default no longer depends on the kind (`resolveAutoConfirm` is
  // on for both), so a flip has nothing to re-derive, and resetting the switch
  // on an existing activity would silently undo a studio's explicit choice.

  // Inline quick-create: "create or link a subscription to this activity" without
  // leaving the form. Writes a minimal type (pricing is configured later in the
  // subscriptions manager) and auto-checks it in the allow-list above.

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  function clearImage() {
    setImageFile(null)
    setImagePreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function uploadImage(activityId: string): Promise<string | null> {
    if (!imageFile) return null
    const ext = imageFile.name.split('.').pop() ?? 'jpg'
    const storageRef = ref(storage, `teams/${teamId}/activities/${activityId}/cover.${ext}`)
    await uploadBytes(storageRef, imageFile)
    return getDownloadURL(storageRef)
  }

  // Fields common to both kinds.
  function sharedPayload(data: ActivityFormData) {
    return {
      name: data.name,
      description: data.description ?? '',
      prerequisites: data.prerequisites ?? '',
      confirmationInstructions: data.confirmationInstructions ?? '',
      meetingPoint: data.meetingPoint ?? '',
      whatsIncluded: data.whatsIncluded ?? '',
      whatsNotIncluded: data.whatsNotIncluded ?? '',
      faq: data.faq ?? '',
      cancellationPolicy: data.cancellationPolicy ?? '',
      // Through the shared normaliser, which drops half-written rows and — the
      // part that was a live crash — writes each key out instead of spreading
      // the editor's object, whose `options` can be an own key holding
      // `undefined`. Firestore refuses that value and the whole save dies.
      bookingQuestions: normalizeBookingQuestions(data.bookingQuestions as FormField[]),
      // EXTENDS the team-wide list, never replaces it — so a row already asked
      // for team-wide is not stored again here (the resolver would dedupe it
      // anyway; not storing it means the activity does not silently pin a
      // choice the studio later changes team-wide).
      contactFields: (data.contactFields ?? []).filter(
        (f: BookingContactField) => !teamContactFieldKeys.includes(f.key)
      ),
      type: data.type,
      tags: normalizeActivityTags(data.tags),
      color: data.color ?? '',
      autoConfirm: data.autoConfirm,
    }
  }

  // Appointments dropped accessRule/isFreeTrial/dropIn/trialEnabled entirely —
  // the price is the only gate (see ActivityMemberBenefit's history note). We
  // simply don't write those class-only keys for an appointment: `accessRule`
  // still exists on the doc type (classes use it) but appointment booking
  // paths ignore it everywhere, so leaving a stale value from a prior "class"
  // save untouched is harmless. `durations` IS cleared (null) on a class save
  // (appointment-only). `memberBenefit` is now a CLASS field too (the drop-in
  // member rate) — kept while drop-in is enabled, cleared when it isn't (a
  // benefit with no priced drop-in to modify is inert data the UI can't show).
  function kindSpecificPayload(data: ActivityFormData): Record<string, unknown> {
    if (data.type === 'appointment') {
      // `durations` MOVED to ActivityPricingForm, and an edit here names it for
      // the same reason it names no other money field: this form is seeded once
      // when the pane mounts, so writing it back would clobber lengths set on
      // Access & pricing in the meantime. A CREATE still seeds them — there is
      // no other writer yet, and an appointment with no length is invalid.
      return editing ? {} : { durations: toActivityDurations(data.durations) }
    }
    const base: Record<string, unknown> = {
      // Below the tier the stored value is carried through untouched rather than
      // read off a locked control: the gate stops a queue being OPENED, it does
      // not quietly strip one an activity already had (see WAITLIST_MIN_PLAN).
      // Carried through whenever the control was not rendered — below the plan
      // tier, or with the studio-level switch off.
      waitlistEnabled:
        waitlistAllowed && (waitlistOffered || editing?.waitlistEnabled === true)
          ? data.waitlistEnabled
          : (editing?.waitlistEnabled ?? false),
      durations: null,
    }
    // ── THE MONEY FIELDS ARE NOT THIS FORM'S ──────────────────────────────
    //
    // `accessRule`, `dropIn`, `trialEnabled`, `trialPriceAmount` and
    // `memberBenefit` belong to ActivityPricingForm and the plan matcher, both
    // in the catalogue. An EDIT here names none of them — that is the whole
    // point of the split, and naming one would clobber a decision made on the
    // other screen (the course settings form did exactly that, and un-linked
    // plans for a week).
    if (editing) return base

    // A CREATE is different: the document does not exist yet, so there is no
    // other writer to lose a race with, and something has to seed these. A COPY
    // carries the original's — pricing is configuration like everything else,
    // and a duplicate that silently lost its price would be worse than one that
    // kept it. A blank activity starts on the tier the cards used to default to.
    return {
      ...base,
      accessRule: duplicating?.accessRule ?? { type: 'members' as const },
      isFreeTrial: duplicating?.isFreeTrial ?? false,
      // A new class FOLLOWS THE STUDIO DEFAULT (`DropInMode`) — it names a
      // price only when a studio changes it to.
      dropIn: duplicating?.dropIn ?? { mode: 'studio' as const, enabled: false },
      trialEnabled: duplicating?.trialEnabled ?? false,
      trialPriceAmount: duplicating?.trialPriceAmount ?? null,
      memberBenefit: duplicating?.memberBenefit ?? null,
    }
  }

  async function onSubmit(data: ActivityFormData) {
    // The "gated to subscriptions with nobody on the list" check that used to
    // sit here is gone with the tier control. It is not lost: the catalogue
    // reports it as `gated_empty_allowlist`, continuously and beside the
    // matcher that fixes it, rather than only at the moment of a save.
    if (editing) {
      // EDIT: the image upload (when there's a new file) runs BEFORE the
      // write, so a throw anywhere in this block means updateDoc never ran —
      // nothing was persisted. One generic message is correct here, and
      // leaving the dialog open with the data intact is the right move: a
      // retry re-attempts the same, still-unsaved, edit.
      try {
        const updates: Record<string, unknown> = {
          ...sharedPayload(data),
          ...kindSpecificPayload(data),
        }
        if (imageFile) {
          const url = await uploadImage(editing.id)
          if (url) updates.image_url = url
        } else if (imagePreview === null && editing.image_url) {
          updates.image_url = null
        }
        await updateDoc(doc(db, ACTIVITIES_COLLECTION, editing.id), updates)
        refreshQueries(qc, ['activities'])
        void invalidateSetupChecklist()
        toast.success(t('savedToast'))
        onClose()
      } catch (err) {
        // LOGGED, because the toast cannot be. A studio reporting "it wouldn't
        // save" is reporting the only thing this surface tells them, and a bare
        // `catch {}` threw away the one fact that would have identified the
        // cause. The message stays generic; the console does not.
        console.error('[activities] save failed:', err)
        toast.error(t('saveErrorToast'))
      }
      return
    }

    // CREATE: addDoc runs BEFORE the image upload, so a failed upload leaves
    // a REAL activity behind with no cover image — a partial success, not a
    // failure. A generic "couldn't save" here would be actively wrong: the
    // manager retries, and the retry creates a second, duplicate activity
    // (this reproduced on a fresh account — Storage denied the upload while
    // the Firestore write went through). So the doc write and the image step
    // get their own try/catch, and each failure gets the message that
    // matches what's actually true on the server.
    let newRef: Awaited<ReturnType<typeof addDoc>> | null = null
    try {
      newRef = await addDoc(collection(db, ACTIVITIES_COLLECTION), {
        ...sharedPayload(data),
        ...kindSpecificPayload(data),
        slug: slugify(data.name),
        teamId,
        createdBy: userId,
        isActive: true,
        order: nextOrder,
        created_at: serverTimestamp(),
      })
    } catch (err) {
      // Nothing exists yet — keep the dialog open with the data, retry is correct.
      console.error('[activities] create failed:', err)
      toast.error(t('saveErrorToast'))
      return
    }

    // The activity document exists from here on. Never leave the dialog open
    // in a way that resubmits this same form — that is what creates the
    // duplicate.
    if (imageFile) {
      try {
        const url = await uploadImage(newRef.id)
        if (url) await updateDoc(newRef, { image_url: url })
      } catch (err) {
        console.error('[activities] cover upload failed:', err)
        refreshQueries(qc, ['activities'])
        void invalidateSetupChecklist()
        toast.error(t('createdImageErrorToast'))
        onCreated?.(newRef.id)
        onClose()
        return
      }
    }

    refreshQueries(qc, ['activities'])
    void invalidateSetupChecklist()
    toast.success(t('createdToast'))
    onCreated?.(newRef.id)
    onClose()
  }

  /**
   * THREE GROUPS, NOT TWO — and the boundary is what a studio is deciding.
   *
   * "Booking & pricing" was the wrong name for the first tab the moment the
   * second one also held booking fields: the queue, the review step and every
   * word shown to somebody about to book all lived under "Details" (Franco,
   * 2026-09-02). So:
   *
   *   Access & pricing  who may book and what it costs — in the catalogue pane
   *   Details           what the thing IS: name, kind, session lengths, cover,
   *                     description, colour, tags
   *   Booking           everything that happens AROUND a booking — whether it
   *                     confirms itself, whether a full session queues, and the
   *                     prose and questions a visitor meets on the way in
   *
   * Session lengths sit in Details rather than Booking because a duration is
   * part of what an appointment IS, not a rule about booking it — the same
   * reason they never moved to the pricing form.
   *
   * The DIALOG renders both groups, because creating asks for everything at
   * once; the pane renders one per tab.
   */
  const fieldsFor = (section: 'details' | 'booking') => (
    <>
      {section === 'details' && (
        <>
          <FormSection>
          <div className="space-y-1.5">
            <Label htmlFor="act-name">{t('fieldName')}</Label>
            <Input id="act-name" {...register('name')} autoFocus />
            {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
          </div>

          {/* "Offer as" — a card switcher rather than a select, because the kind
              drives the whole form and the one-liners carry the entire
              class-vs-appointment distinction: who chooses the time. Same pattern
              as the availability form's mode toggle and the access tiers below. */}
          <div className="space-y-1.5">
            <Label>{t('fieldOfferAs')}</Label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2">
                  {ACTIVITY_TYPES.map((tp) => (
                    <button
                      key={tp}
                      type="button"
                      onClick={() => field.onChange(tp)}
                      aria-pressed={field.value === tp}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        field.value === tp
                          ? 'border-primary bg-primary/5'
                          : 'hover:border-foreground/30'
                      }`}
                    >
                      <span className="block text-sm font-medium">{t(`type_${tp}` as const)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`type_${tp}_desc` as const)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            />
            {editing && watch('type') !== (editing.type ?? 'class') && (
              <p className="text-xs text-muted-foreground">
                {t('typeChangeWarning')}
              </p>
            )}
          </div>

          {/* Metadata — cover 30% / description 70% on wide screens. The grid
              stretches both columns to the taller one (the description), and the
              cover is flex-1 inside its column so it grows to match rather than
              leaving dead space beside the textarea. */}
          <div className="grid gap-4 lg:grid-cols-[3fr_7fr]">
            <div className="flex flex-col space-y-1.5">
              <Label>{t('fieldImage')}</Label>
              {imagePreview ? (
                <div className="relative w-full flex-1 min-h-32 rounded-lg overflow-hidden border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imagePreview} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={clearImage}
                    className="absolute top-1.5 right-1.5 rounded-full bg-background/80 p-1 hover:bg-background transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex-1 min-h-32 rounded-lg border-2 border-dashed border-input hover:border-primary/50 flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ImageIcon className="h-5 w-5" />
                  <span className="text-xs">Click to upload</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                className="hidden"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="act-desc">{t('fieldDescription')}</Label>
              <textarea
                id="act-desc"
                {...register('description')}
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
              />
            </div>
          </div>
          </FormSection>

          {/* CREATE ONLY. An appointment is invalid with no length at
              all, so the create dialog has to ask — but on an EDIT the
              lengths and their prices are one control on Access & pricing,
              and asking here too would give `durations` a second writer:
              this form is seeded when the pane mounts, so a Save from
              Details would put the pre-edit lengths back over the ones just
              set next door. Exactly the clobber the field split exists to
              prevent. */}
          {type === 'appointment' && !editing && (
            <FormSection>
                  <AppointmentDurationsEditor
                    value={durations}
                    onChange={(next) => setValue('durations', next)}
                    currency={currency}
                    canEdit
                    benefitOpensDoor={benefitOpensDoor}
                    errorFor={(i) => errors.durations?.[i]?.price?.message}
                  />
                  {errors.durations?.message && (
                    <p className="text-destructive text-xs pt-2">{errors.durations.message}</p>
                  )}
            </FormSection>
          )}

          {/* APPOINTMENT-ONLY: the pointer to where the money is decided —
              the session lengths and their prices, and the one
              member-benefit rule that applies to every priced one. All of
              it is set in Offerings, beside the plans it names, because it
              is ONE rule shared by all of them and a change here would
              silently reprice the rest. */}
          {type === 'appointment' && (
            <FormSection>
              <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {editing ? t('durationsInCatalogue') : t('benefitInCatalogue')}
                  </p>
                  <Link
                    href={
                      (editing
                        ? `/manage/offer?sel=activity:${editing.id}`
                        : '/manage/offer') as Route
                    }
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('accessOpenCatalogue')}
                  </Link>
              </div>
            </FormSection>
          )}

          <FormSection>
            <SettingRows>
              <SettingRow
                htmlFor="act-color"
                label={t('fieldColor')}
                control={
              <Controller
                name="color"
                control={control}
                render={({ field }) => (
                  <ColorPicker
                    id="act-color"
                    value={field.value}
                    onChange={field.onChange}
                    aria-label={t('fieldColor')}
                  />
                )}
              />
                }
              />
            </SettingRows>
            {/* Display-only, like `prerequisites` on the Booking tab. */}
              <Controller
                name="tags"
                control={control}
                render={({ field }) => (
                  <ActivityTagsEditor
                    value={(field.value ?? []) as string[]}
                    onChange={field.onChange}
                  />
                )}
              />
          </FormSection>
        </>
      )}

      {/* NO SECTION HEADINGS. Each tab now holds a handful of fields about one
          thing, and a heading over four rows names what the tab already names
          — chrome restating its own container (Franco, 2026-09-02). And NO
          BOXES either (2026-09-12): the groups are set apart by a hairline and
          their spacing — see components/offer/FormLayout.tsx for the rule.

          WHAT IS LEFT AFTER THE MONEY MOVED OUT. The access tier, the
          newcomer trial and the drop-in price live in the catalogue beside
          the plan matcher that reprices them — see
          components/activities/ActivityPricingForm.tsx for why. What stays
          here is not about money: whether a booking confirms itself, whether
          a full session keeps a queue, and the prose a visitor meets. */}
      {section === 'booking' && (
        <>
          <FormSection>
            <SettingRows>
              {/* A field, not implied by type: either kind may require a review step. */}
              <SettingRow
                htmlFor={`${rowId}-auto`}
                label={t('fieldAutoConfirm')}
                control={
                  <Controller
                    name="autoConfirm"
                    control={control}
                    render={({ field }) => (
                      <Switch
                        id={`${rowId}-auto`}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                }
              />

              {/* CLASS-ONLY: the queue behind a full session. Independent of every
                  other door here — a members-only class, a drop-in class and an
                  open one all fill up the same way. Appointments have none: an
                  appointment session does not exist until it is booked, so
                  "this one is full" has no meaning there. */}
              {type === 'class' && (waitlistOffered || editing?.waitlistEnabled === true) && (
                <SettingRow
                  htmlFor={`${rowId}-wait`}
                  label={t('waitlistEnabledLabel')}
                  hint={t('waitlistEnabledHint')}
                  control={
                    <Controller
                      name="waitlistEnabled"
                      control={control}
                      render={({ field }) => (
                        <Switch
                          id={`${rowId}-wait`}
                          checked={!!field.value}
                          onCheckedChange={field.onChange}
                          disabled={!waitlistAllowed}
                        />
                      )}
                    />
                  }
                >
                  {/* The plan gate, on the control that writes the flag. */}
                  {!waitlistAllowed && (
                    <p className="text-xs text-muted-foreground">
                      {t('waitlistRequiresPlan', { plan: planName(WAITLIST_MIN_PLAN) })}
                    </p>
                  )}
                  {/* Not a validation error: the limit lives on each SESSION, not
                      here, so the form cannot know whether any of them has one. */}
                  {waitlistAllowed && waitlistEnabled && (
                    <p className="text-xs text-muted-foreground">{t('waitlistRequiresCapacity')}</p>
                  )}
                </SettingRow>
              )}
            </SettingRows>
          </FormSection>

          {/* THE SHORT CONTROL FIRST, THEN THE FORM, THEN THE PROSE — and the
              prose runs FULL WIDTH, one field per row. Two columns halved every
              textarea, so six paragraphs of public copy were written in boxes
              narrower than the sentences going into them (Franco, 2026-09-02). */}
          <FormSection>
<div className="space-y-1.5">
              <Label htmlFor="act-meeting-point">{t('fieldMeetingPoint')}</Label>
              <Input
                id="act-meeting-point"
                {...register('meetingPoint')}
                placeholder={t('meetingPointPlaceholder')}
              />
            </div>

            <Controller
              control={control}
              name="bookingQuestions"
              render={({ field }) => (
                <BookingQuestionsEditor
                  value={(field.value ?? []) as FormField[]}
                  onChange={field.onChange}
                />
              )}
            />

            <Controller
              control={control}
              name="contactFields"
              render={({ field }) => (
                <BookingContactFieldsEditor
                  value={(field.value ?? []) as BookingContactField[]}
                  onChange={field.onChange}
                  definitions={customFieldDefinitions}
                  extendsTeamDefault
                  inheritedKeys={teamContactFieldKeys}
                  customFieldsInstalled={isInstalled('custom-fields')}
                />
              )}
            />
          </FormSection>

          <FormSection>
<div className="space-y-1.5">
              <Label htmlFor="act-prereq">{t('fieldPrerequisites')}</Label>
              <textarea
                id="act-prereq"
                {...register('prerequisites')}
                rows={3}
                placeholder={t('prerequisitesPlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-none"
              />
              <p className="text-xs text-muted-foreground">{t('prerequisitesHelp')}</p>
            </div>
<div className="space-y-1.5">
              <Label htmlFor="act-confirm-instructions">{t('fieldConfirmationInstructions')}</Label>
              <textarea
                id="act-confirm-instructions"
                {...register('confirmationInstructions')}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y"
              />
              <p className="text-xs text-muted-foreground">{t('confirmationInstructionsHelp')}</p>
            </div>
<div className="space-y-1.5">
              <Label htmlFor="act-whats-included">{t('fieldWhatsIncluded')}</Label>
              <textarea
                id="act-whats-included"
                {...register('whatsIncluded')}
                rows={3}
                placeholder={t('whatsIncludedPlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y"
              />
              <p className="text-xs text-muted-foreground">{t('whatsIncludedHelp')}</p>
            </div>
<div className="space-y-1.5">
              <Label htmlFor="act-whats-not-included">{t('fieldWhatsNotIncluded')}</Label>
              <textarea
                id="act-whats-not-included"
                {...register('whatsNotIncluded')}
                rows={3}
                placeholder={t('whatsIncludedPlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y"
              />
            </div>
<div className="space-y-1.5">
              <Label htmlFor="act-faq">{t('fieldFaq')}</Label>
              <textarea
                id="act-faq"
                {...register('faq')}
                rows={4}
                placeholder={t('faqPlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y"
              />
            </div>
<div className="space-y-1.5">
              <Label htmlFor="act-cancellation-policy">{t('fieldCancellationPolicy')}</Label>
              <textarea
                id="act-cancellation-policy"
                {...register('cancellationPolicy')}
                rows={3}
                placeholder={t('cancellationPolicyPlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 resize-y"
              />
              <p className="text-xs text-muted-foreground">{t('cancellationPolicyHelp')}</p>
            </div>
          </FormSection>
        </>
      )}
    </>
  )

  // ONE `FormSections` per host: the pane shows one tab, the dialog both, and
  // the hairlines between the groups run through the whole of either.
  const fields = section ? (
    <FormSections>{fieldsFor(section)}</FormSections>
  ) : (
    <FormSections>
      {fieldsFor('details')}
      {fieldsFor('booking')}
    </FormSections>
  )

  // ONE LABEL, ONE SIZE, on every tab — the pricing tab's button says the same
  // word, so a studio moving between them is pressing the same control.
  // The DIALOG keeps its own wording: there, "Create activity" is the outcome.
  const submit = (
    <Button type="submit" size={inline ? 'sm' : undefined} disabled={isSubmitting}>
      {inline
        ? isSubmitting
          ? tCat('saving')
          : tCat('save')
        : isSubmitting
          ? t('saving')
          : editing
            ? t('saveChanges')
            : t('createActivity')}
    </Button>
  )

  if (inline) {
    return (
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {fields}
        <div className="flex justify-end border-t pt-3">{submit}</div>
      </form>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o: boolean) => { if (!o) onClose() }}>
      {/* Field-rich form — give it room on bigger screens. The fields scroll
          inside DialogBody so Save stays pinned; see THE SCROLL RULE in
          components/ui/dialog.tsx. */}
      <DialogContent className="sm:max-w-lg lg:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('editActivity') : duplicating ? tCommon('duplicate') : t('newActivity')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4 py-2">
            {fields}
          </DialogBody>
          {/* The warning that stood here — "the plan editor has unsaved ticks
              and this Save will lose them" — went with the plan editor itself.
              This form no longer writes any field that editor writes, so its
              Save cannot lose anything of theirs. */}
          <DialogFooter>{submit}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── activity card ────────────────────────────────────────────────────────────

// The money chips this list adds are derived in `lib/activityTerms.ts`
// (`activityMoneyChipLabels`) — the catalogue's detail pane shows the same facts
// and reads the same function, so the two cannot disagree about, say, whether a
// benefit chip names its plan. The access badges below are separate and stay
// here: they are what a row says about who may book, not about money.
