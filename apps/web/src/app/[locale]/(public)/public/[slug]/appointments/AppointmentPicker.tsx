'use client'

import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { type FunctionsError } from 'firebase/functions'
import {
  resolvePaymentOptions,
  appointmentPriceRange,
  resolveBookingContactFields,
  resolveDurationBenefit,
  heldSubscriptionTypeIds,
  parseDateKey,
  parseDocId,
  parsePositiveInt,
  type ActivityMemberBenefit,
  type ActivityDurationBenefit,
  type Benefit,
  type BookingContactField,
  type PublicFrom,
  type RegionalFormatter,
} from '@linyup/shared'
import {
  PromoCodeField,
  priceChangedAmount,
  priceChangedMessage,
  promoCheckoutErrorMessage,
  useAcceptedPrice,
  type AppliedPromo,
} from '@/components/booking/PromoCodeField'
import { clientPaymentSnapshot } from '@/lib/paymentSnapshot'
import { useRouter } from '@/i18n/navigation'
import { publicHrefLocalized, returnHref } from '@/lib/publicRoutes'
import { useBookingFlowUrl } from '@/components/booking/flow/useBookingFlowUrl'
import { usePublicTeam } from '../PublicTeamProvider'
import { formatCurrency } from '@/lib/format'
import { priceRangeLabel } from '@/lib/priceRange'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryErrorState } from '@/components/ui/query-error'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { FlowShell } from '@/components/booking/FlowShell'
import { OfferCard } from '@/components/booking/catalogue/OfferCard'
import { useBookingChrome, useExitFlow } from '@/components/booking/BookingChrome'
import { toDateKey } from '@/components/booking/MiniCalendar'
import { AppointmentWhen } from '@/components/booking/when/AppointmentWhen'
import {
  SlotBookingForm,
  errorDetails,
  type BookArgs,
  type BookScreen,
  type CheckoutExtras,
} from '@/components/booking/appointment/SlotBookingForm'
import type {
  AvailActivity,
  AvailCoach,
  AvailDuration,
} from '@/components/booking/when/availability'
import {
  GuestDetailsForm,
  type GuestDetailsFormHandle,
  type GuestDetailsValues,
} from '@/components/booking/GuestDetailsForm'
import { ReturningSignIn, type ContactData } from '@/components/booking/ReturningSignIn'
import { StickyBar } from '@/components/booking/StickyBar'
import { BackButton } from '@/components/booking/BackButton'
import { WaiverStep } from '@/components/booking/WaiverStep'
import { BookingTerms, resolveCancellationPolicy } from '@/components/booking/BookingTerms'
import { useWaiverGate } from '@/hooks/useWaiverGate'
import {
  waiverErrorMessage,
  type WaiverAcceptancePayload,
  type WaiverCallerIdentity,
} from '@/lib/waiver'
import {
  GUEST,
  bodyIdentity,
  callerKey,
  emailOf,
  heldFrom,
  heldOf,
  resolveBookingCaller,
  waiverIdentity,
  type BookingCallBody,
  type BookingCaller,
  type VerifiedCaller,
} from '@/components/booking/identity/bookingCaller'
import { usePublicContactAuth } from '../PublicContactAuthProvider'
import { usePublicContactRecord } from '../usePublicContactRecord'
import { CalendarClock, MapPin, Video, Clock, User, Check, ChevronRight, Tag } from 'lucide-react'
import { usePublicFormat } from '../usePublicFormat'
import { callFunction } from '@/lib/callFunction'

// ─── types ────────────────────────────────────────────────────────────────────
// The listAvailability contract itself lives in components/booking/when/
// availability, beside the step that renders it and shared with the merged
// front door. What stays here is what this funnel makes of it.

// What a picked time carries into the in-page booking step. Pricing here is
// DISPLAY/ROUTING only — bookAppointment / createAppointmentCheckout always
// re-resolve server-side.
interface WindowBooking {
  providerId: string
  providerName: string | null
  activityId: string
  activityName: string
  startMs: number
  durationMinutes: number
  placeName: string | null
  location: string | null
  onlineUrl: string | null
  priceAmount: number | null
  benefitOnly: boolean
  memberBenefit: ActivityMemberBenefit | Benefit | null
  /** Carried to the booking step so the terms are on the screen that commits. */
  cancellationPolicy: string | null
  contactFields: BookingContactField[] | null
}

// The booking form is now an in-page step (not a modal), so it joins the funnel.
type PickerStep = 'coach' | 'activity' | 'time' | 'book'


// ─── WHO IS BOOKING ──────────────────────────────────────────────────────────
// The three kinds of caller, the server's own precedence between them, what a
// member holds, and what each kind puts in a call body, all live in
// components/booking/identity/bookingCaller and are shared with the class
// funnel. The booking rail itself is
// components/booking/appointment/SlotBookingForm, shared for the same reason.



// ─── helpers ──────────────────────────────────────────────────────────────────

const fmtDateFull = (fmt: RegionalFormatter, ms: number) =>
  fmt.custom(ms, { weekday: 'long', day: 'numeric', month: 'long' })
const fmtTime = (fmt: RegionalFormatter, ms: number) => fmt.time(ms)

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60),
    m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// "CHF 45–85" when every duration is priced and prices differ, "from CHF 45"
// when only some are, the plain price when they agree, and null when nothing is
// priced (no chip). The three-way reading lived HERE alone until the shared
// module took it over; every other surface rendered the middle case whether or
// not it was true. See `lib/priceRange.ts`.
function activityPriceRangeLabel(
  activity: AvailActivity,
  currency: string,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string | null {
  const range = appointmentPriceRange(activity.durations)
  if (!range) return null
  return priceRangeLabel(range, {
    money: (amount) => formatCurrency(amount, currency, locale),
    from: (price) => t('priceFrom', { price }),
    range: (min, max) => `${min}–${max}`,
  })
}

// A duration is "for sale" when it has a base price AND is sold individually —
// a free length is free for anyone regardless of `memberBenefit` (the shared
// resolver returns `covered` before ever looking at it), and a benefit_only one
// has no individual price at all, only a leftover number that must never be
// quoted (UX-70).
function durationIsPriced(d: { priceAmount: number | null; benefitOnly?: boolean }): boolean {
  return d.benefitOnly !== true && typeof d.priceAmount === 'number'
}


// ─── in-page booking step ───────────────────────────────────────────────────
// Guest fields + returning-member sign-in are the SHARED components also used by
// the class BookingForm (components/booking/). Rendered IN THE PAGE (inside
// FlowShell), not a modal — same as the class 'details'/'returning' steps.
// Only the money-specific bits (price display, the sign-in offer, the member
// confirmation) stay local here. The guest screen's submit is driven from the
// parent's sticky bar via `guestFormRef` (sr-only <form> submit) — exactly the
// class BookingForm mechanism; the parent learns which screen is showing (to
// gate the Confirm button) through `onScreenChange`.
//
// WHICH SCREEN A VISITOR SEES IS A FUNCTION OF `caller`, not of a step they
// chose: a recognised contact never sees the guest form or the sign-in offer,
// because the server would ignore both.

// ─── funnel building blocks ─────────────────────────────────────────────────────

function EmptyState({ icon: Icon, text, hint }: { icon: typeof CalendarClock; text: string; hint?: string }) {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <Icon className="h-8 w-8 mx-auto mb-3 opacity-40" />
      <p className="font-medium">{text}</p>
      {hint && <p className="text-sm mt-1">{hint}</p>}
    </div>
  )
}

// Step 1 — pick a coach.
function CoachCard({ coach, onSelect }: { coach: AvailCoach; onSelect: () => void }) {
  const t = useTranslations('AppointmentBooking')
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <User className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm truncate">{coach.providerName || t('unnamedCoach')}</p>
          <p className="text-xs text-muted-foreground truncate">
            {coach.activities.map((a) => a.activityName).join(' · ')}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
    </button>
  )
}

// Step 2 — pick an activity offered by that coach. Skipped entirely when a
// `?activity=` deep link is active (the server-side activityId filter means
// every coach in the response offers exactly that one activity).
function ActivityCard({
  activity,
  currency,
  locale,
  onSelect,
}: {
  activity: AvailActivity
  currency: string
  locale: string
  onSelect: () => void
}) {
  const t = useTranslations('AppointmentBooking')
  const durations = activity.durations.map((d) => d.minutes)
  const durationLabel =
    durations.length > 1
      ? `${fmtDuration(Math.min(...durations))} – ${fmtDuration(Math.max(...durations))}`
      : fmtDuration(durations[0] ?? 60)
  return (
    <OfferCard
      name={activity.activityName}
      priceChip={activityPriceRangeLabel(activity, currency, locale, t)}
      onSelect={onSelect}
      meta={
        <>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {durationLabel}
          </span>
          {/* The place first, it is what distinguishes two cards for the same
              offer, then the studio's own note on top of it. */}
          {activity.placeName && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {activity.placeName}
            </span>
          )}
          {activity.location && (
            <span className="flex items-center gap-1">
              {activity.placeName ? null : <MapPin className="h-3 w-3" />}
              {activity.location}
            </span>
          )}
          {activity.onlineUrl && (
            <span className="flex items-center gap-1">
              <Video className="h-3 w-3" />
              {t('onlineSession')}
            </span>
          )}
        </>
      }
    />
  )
}

// Step 3 — duration (only if the activity offers more than one) → day → time.
// Same layout as the class BookingForm's 'sessions' step: MiniCalendar LEFT,
// time slots (with duration chips above them) RIGHT — see BookingForm.tsx.
/**
 * A booking is identified by exactly four fields — provider, activity, start,
 * duration (the same key `SlotBookingForm` uses). Everything else on
 * `WindowBooking` is denormalized from the loaded availability, so the object is
 * always rebuildable and never needs serializing into the URL.
 */
function buildWindowBooking(
  coach: AvailCoach,
  activity: AvailActivity,
  startMs: number,
  durationMinutes: number
): WindowBooking {
  const chosen =
    activity.durations.find((d) => d.minutes === durationMinutes) ?? activity.durations[0] ?? null
  return {
    providerId: coach.providerId,
    providerName: coach.providerName,
    activityId: activity.activityId,
    activityName: activity.activityName,
    startMs,
    durationMinutes: chosen?.minutes ?? durationMinutes,
    placeName: activity.placeName,
    location: activity.location,
    onlineUrl: activity.onlineUrl,
    priceAmount: chosen?.priceAmount ?? null,
    benefitOnly: chosen?.benefitOnly === true,
    // THE ONE READER, resolved for the CHOSEN length. Everything downstream —
    // the quote, the "sign in for the member price" line, the checkout — reads
    // this single already-resolved value, so no surface below can pick a
    // different length's rule than the one being booked.
    memberBenefit: resolveDurationBenefit(
      activity,
      chosen?.minutes ?? durationMinutes
    ),
    cancellationPolicy: activity.cancellationPolicy,
    contactFields: activity.contactFields,
  }
}

// Duration + day are OWNED BY THE PARENT, not this component. They used to live
// here, which meant leaving the `time` step destroyed them — so Back from the
// booking step, or a history restore, silently reset the visitor's choices. They
// are also two of the four fields that identify a booking, so the URL needs them.
// ─── main component ───────────────────────────────────────────────────────────
// Coach-first funnel: coach → activity → duration (only if >1) → day → time →
// book. Wrapped in FlowShell so it wears the same team top bar, content width
// and branded footer as the class BookingForm, and the booking step renders
// in-page (not a modal) with the shared bottom summary bar. A `?activity=` deep
// link preselects that offering: coaches are pre-filtered server-side, and when
// exactly one coach offers it the coach step is skipped entirely.

export default function AppointmentPicker({
  slug,
  presetActivityId,
  presetProviderId,
  presetDate,
  from,
  disableStepUrl,
}: {
  slug: string
  presetActivityId?: string
  /**
   * `?provider=` / `?date=` — set when the visitor clicked a specific
   * availability window, which already identifies the coach and the day. Without
   * them the picker would ask them to choose again what they just clicked.
   */
  presetProviderId?: string
  presetDate?: string
  /** `?from=` — which surface to return to. See `returnHref`. */
  from?: PublicFrom
  /**
   * Suppress this flow's own history writes — set by an overlay host, which owns
   * the address bar while the panel is open. See BookingForm for the same prop.
   */
  disableStepUrl?: boolean
}) {
  const t = useTranslations('AppointmentBooking')
  const tPublic = useTranslations('PublicBooking')
  const locale = useLocale()
  const fmt = usePublicFormat()
  // 'page' unless an overlay host wraps this flow — see BookingChrome.
  const chrome = useBookingChrome()
  const router = useRouter()
  const { teamId, team } = usePublicTeam()
  const currency = team.default_currency ?? 'CHF'
  const teamName = team.name || ''
  const accentColor = team.bioLinkAccentColor ?? null
  const showBranding = team.showBranding === true

  const [coaches, setCoaches] = useState<AvailCoach[]>([])
  // Whether this studio can be paid ONLINE, answered by the server with the
  // listing rather than guessed from the presence of a price. False until the
  // load says otherwise — the safe direction is the ordinary paid door.
  const [settleAtStudio, setSettleAtStudio] = useState(false)
  const [loading, setLoading] = useState(true)
  // Tracked separately from `coaches` — a failed load must never be mistaken for
  // the genuine "this coach has no open times" empty state (a coach would read
  // that as a misconfiguration; a client would just leave).
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // `email` is null when the booking was made on a contact session that carries
  // no address — the confirmation still went out, we just cannot name where.
  const [confirmed, setConfirmed] = useState<{ email: string | null } | null>(null)
  const [windowBooking, setWindowBooking] = useState<WindowBooking | null>(null)
  const [step, setStep] = useState<PickerStep>('coach')
  const [selectedCoach, setSelectedCoach] = useState<AvailCoach | null>(null)
  const [selectedActivity, setSelectedActivity] = useState<AvailActivity | null>(null)
  // Lifted out of TimePicker: leaving the `time` step used to destroy them, so
  // Back from the booking step reset the visitor's duration and day. They are
  // also part of a booking's identity, so history restore needs them here.
  const [duration, setDuration] = useState<number | null>(null)
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null)

  // In-page booking step ↔ sticky bar wiring (mirrors the class BookingForm):
  // the sticky bar's Confirm fires the guest form's sr-only submit, and only
  // shows on the guest screen — the booking form reports its screen up here.
  const [bookScreen, setBookScreen] = useState<BookScreen>('guest')
  const [bookSubmitting, setBookSubmitting] = useState(false)
  const guestFormRef = useRef<GuestDetailsFormHandle>(null)

  // Where leaving the flow goes. `?from=` names the surface the visitor arrived
  // from; absent/dead → the team's default surface, resolved HERE rather than by
  // bouncing through the team root's client redirect. Declared with the other
  // hooks — the `confirmed` early return below would otherwise skip it.
  const backTo = useMemo(() => returnHref(team, slug, from), [team, slug, from])
  // Closes the panel, or navigates the page — see useExitFlow.
  const exitFlow = useExitFlow()

  // DERIVED, not stored: "the coach step was skipped because exactly one coach
  // offers the preselected activity". As one-shot state it survived a history
  // restore with a stale value and mislabelled the time step's Back button.
  // The coach step was never shown when the visitor arrived naming a coach,
  // or when there is only one to choose from.
  const skippedCoachStep = !!presetActivityId && (!!presetProviderId || coaches.length === 1)
  // WAS THE ACTIVITY STEP SHOWN? Derived, never stored, a remembered "I skipped
  // it" survives a history restore with a stale value and mislabels Back, which
  // is a bug this file has already had once.
  //
  // In preset mode the step is skipped only when there is nothing to choose, and
  // an offer taught at several places is several entries sharing one activity
  // id, so it IS shown there, and Back has somewhere to go.
  const activityStepShown = !presetActivityId || (selectedCoach?.activities.length ?? 0) > 1

  // The activity's first duration is the default until the visitor picks one.
  // Derived rather than seeded into state, so switching activity can't leave a
  // duration the new activity doesn't offer.
  const effectiveDuration =
    duration != null && selectedActivity?.durations.some((d) => d.minutes === duration)
      ? duration
      : (selectedActivity?.durations[0]?.minutes ?? 60)

  // ── Step ↔ URL ────────────────────────────────────────────────────────────
  // The decision is `useBookingFlowUrl`'s, shared with the class flow.
  // `bookScreen` is deliberately NOT synced — it's an internal sub-state of the
  // `book` step with its own back affordance, and pushing it would make Back
  // behave differently between the two flows. This funnel names no terminal
  // step: its confirmation is a screen inside `book`, not a step of its own.
  const stepQuery: Record<string, string | number | undefined> =
    step === 'coach'
      ? {}
      : step === 'activity'
        ? { provider: selectedCoach?.providerId }
        : {
            provider: selectedCoach?.providerId,
            activity: selectedActivity?.activityId,
            place: selectedActivity?.placeId ?? undefined,
            duration: effectiveDuration,
            date: selectedDateKey ?? undefined,
            ...(step === 'book' && windowBooking ? { start: windowBooking.startMs } : {}),
          }

  // Nothing below sets the URL by hand: the step and its query decide it.
  useBookingFlowUrl({
    step,
    query: stepQuery,
    ready: !loading,
    disabled: disableStepUrl,
    sticky: { from, activity: presetActivityId },
    onRestore: (params) => {
      // popstate hands back whatever is in the address bar — parse it like any
      // inbound param, not as trusted state we wrote ourselves.
      const providerId = parseDocId(params.get('provider'))
      const coach = providerId ? coaches.find((c) => c.providerId === providerId) : null
      if (!coach) {
        setWindowBooking(null)
        // Back to the flow's ENTRY step, which isn't always `coach`: a preset
        // activity with a single coach never showed one, so re-enter at `time`
        // exactly as a fresh load would, rather than on a step the visitor has
        // never seen.
        const only = skippedCoachStep ? coaches[0] : null
        if (only && only.activities.length === 1) {
          setSelectedCoach(only)
          setSelectedActivity(only.activities[0])
          setStep('time')
          return
        }
        // Several entries for the preset offer: one per place. Re-enter at the
        // step that asks, rather than picking a place for the visitor.
        if (only && only.activities.length > 1) {
          setSelectedCoach(only)
          setSelectedActivity(null)
          setStep('activity')
          return
        }
        setSelectedCoach(null)
        setSelectedActivity(null)
        setStep('coach')
        return
      }
      setSelectedCoach(coach)

      // ONE ACTIVITY ID CAN NAME SEVERAL ENTRIES: one per place. `place`
      // picks between them; without it (an old link, or an offer taught at one
      // place) the first entry for that activity is the right answer, which is
      // exactly what this resolved to before places were a dimension.
      const activityId = parseDocId(params.get('activity'))
      const placeId = parseDocId(params.get('place'))
      const forActivity = activityId
        ? coach.activities.filter((a) => a.activityId === activityId)
        : []
      const activity =
        (placeId ? forActivity.find((a) => a.placeId === placeId) : undefined) ?? forActivity[0]
      if (!activity) {
        setSelectedActivity(null)
        setWindowBooking(null)
        setStep('activity')
        return
      }
      setSelectedActivity(activity)

      // Only durations this activity actually offers — a crafted `?duration=`
      // must not reach the booking callable as a length the studio never priced.
      const mins = parsePositiveInt(params.get('duration'), 24 * 60)
      if (mins && activity.durations.some((d) => d.minutes === mins)) setDuration(mins)
      const day = parseDateKey(params.get('date'))
      if (day) setSelectedDateKey(day)

      // windowBooking is fully derivable from {provider, activity, start,
      // duration} — the same four fields SlotBookingForm already keys on — so
      // rebuild it instead of putting a denormalized object in the URL.
      // The start must be a real free slot, not merely a number: otherwise a
      // crafted link could put an arbitrary time in front of the visitor.
      const startMs = parsePositiveInt(params.get('start'))
      const isRealSlot =
        !!startMs &&
        !!mins &&
        activity.days.some((d) => (d.slotsByDuration[String(mins)] ?? []).includes(startMs))
      const restoredBooking = isRealSlot ? buildWindowBooking(coach, activity, startMs, mins) : null
      setWindowBooking(restoredBooking)
      setBookScreen('guest')
      setStep(restoredBooking ? 'book' : 'time')
    },
  })


  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const availFn = callFunction<
          { teamId: string; days?: number; activityId?: string },
          { coaches: AvailCoach[]; settleAtStudio?: boolean }
        >('listAvailability')
        const res = await availFn({
          teamId,
          days: 60,
          ...(presetActivityId ? { activityId: presetActivityId } : {}),
        })
        if (!alive) return
        const list = res.data.coaches ?? []
        setCoaches(list)
        setSettleAtStudio(res.data.settleAtStudio === true)
        // Deep-link continuity: exactly one coach offers the preselected
        // activity — land straight on duration/day/time, no coach (or activity)
        // step shown. Decided here (not a separate effect) so there's no flash
        // of the coach-list step first.
        // A clicked availability window names the coach: land on their times
        // directly, whether or not they're the team's only provider.
        const presetCoach = presetProviderId
          ? list.find((c) => c.providerId === presetProviderId)
          : list.length === 1
            ? list[0]
            : null
        if (presetActivityId && presetCoach) {
          // ONE ENTRY, OR ASK. An offer taught at several places arrives as
          // several entries sharing this id, and skipping the step would pick a
          // place on the visitor's behalf and never say which, so the step is
          // skipped only when there is nothing to choose.
          const matching = presetCoach.activities.filter((a) => a.activityId === presetActivityId)
          const activity = matching.length === 1 ? matching[0] : null
          if (activity) {
            setSelectedCoach(presetCoach)
            setSelectedActivity(activity)
            if (presetDate) setSelectedDateKey(presetDate)
            setStep('time')
          } else if (matching.length > 1) {
            setSelectedCoach(presetCoach)
            setStep('activity')
          }
        }
      } catch (err) {
        if (!alive) return
        // The visitor gets QueryErrorState below; the developer gets this. Two
        // separate obligations — this surface had the first and not the second.
        reportPublicLoadFailure('appointments/availability', err)
        setCoaches([])
        setLoadError(errorDetails(err).message ?? null)
      } finally {
        if (alive) setLoading(false)
      }
    }
    if (teamId) load()
    else setLoading(false)
    return () => { alive = false }
  }, [teamId, presetActivityId, presetProviderId, presetDate, reloadNonce])

  function retryLoad() {
    setReloadNonce((n) => n + 1)
  }

  // ── Confirmation — wrapped in FlowShell so the team top bar persists,
  // matching the class flow's confirmed step. ──
  if (confirmed) {
    return (
      <FlowShell teamName={teamName} slug={slug} accentColor={accentColor} showBranding={showBranding} backTo={backTo}>
        <div className="py-6 space-y-6">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <Check className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{t('confirmedTitle')}</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {confirmed.email
                  ? t('confirmedMessage', { email: confirmed.email })
                  : t('confirmedMessageNoAddress')}
              </p>
            </div>
          </div>
        </div>
      </FlowShell>
    )
  }

  function selectCoach(c: AvailCoach) {
    setSelectedCoach(c)
    // Preset mode: the activityId filter guarantees this coach offers exactly
    // the one activity — no need to make the visitor pick it again.
    if (presetActivityId && c.activities.length === 1) {
      setSelectedActivity(c.activities[0])
      setStep('time')
    } else {
      setSelectedActivity(null)
      setStep('activity')
    }
  }
  function selectActivity(a: AvailActivity) {
    setSelectedActivity(a)
    setStep('time')
  }
  function backToCoaches() {
    setStep('coach')
    setSelectedCoach(null)
    setSelectedActivity(null)
  }
  function backToActivities() {
    setStep('activity')
    setSelectedActivity(null)
  }
  // Back from the time step goes to whichever step WAS shown, in order: the
  // activity step when there was a choice to make (the normal funnel, or a
  // preset offer taught at several places), then the coach step, and out of the
  // flow entirely when neither was ever on screen (a single-coach deep link).
  function backFromTime() {
    if (activityStepShown) {
      backToActivities()
      return
    }
    if (skippedCoachStep) {
      // No step to go back to — leave the flow, to wherever the visitor came
      // from rather than the team root's default surface. In a panel that means
      // CLOSE: the page behind it is already that surface, and in the embed it
      // is frame-denied, so navigating there would blank the panel.
      exitFlow(backTo.href)
      return
    }
    backToCoaches()
  }
  // Back from the booking step returns to the time picker to re-pick a slot.
  function backFromBook() {
    setStep('time')
    setBookScreen('guest')
  }
  const timeBackLabel = activityStepShown
    ? t('backToActivities')
    : skippedCoachStep
      ? t('back')
      : t('backToCoaches')

  const hasCoaches = coaches.length > 0
  // The bottom summary bar rides along once an activity is chosen — on the time
  // picker (activity only) and the booking step (activity + slot + Confirm),
  // mirroring the class flow (sessions/details). The Confirm shows only on the
  // booking step's guest screen.
  const showBar = !!selectedActivity && (step === 'time' || step === 'book')

  return (
    <>
      <FlowShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        wide={step === 'time'}
        showBranding={showBranding}
        backTo={backTo}
        overlayTitle={selectedActivity?.activityName}
        bar={
          showBar && selectedActivity ? (
            <StickyBar
              title={selectedActivity.activityName}
              providerLabel={
                selectedCoach?.providerName
                  ? tPublic('withInstructor', { name: selectedCoach.providerName })
                  : null
              }
              dateTimeLabel={
                step === 'book' && windowBooking
                  ? `${fmtDateFull(fmt, windowBooking.startMs)} · ${fmtTime(fmt, windowBooking.startMs)}–${fmtTime(fmt, windowBooking.startMs + windowBooking.durationMinutes * 60_000)}`
                  : null
              }
              location={
                step === 'book'
                  ? ([windowBooking?.placeName, windowBooking?.location]
                      .filter(Boolean)
                      .join(' · ') || null)
                  : null
              }
              accentColor={accentColor}
              position={chrome.kind === 'overlay' ? 'container' : 'viewport'}
              showConfirm={step === 'book' && bookScreen === 'guest'}
              submitting={bookSubmitting}
              confirmLabel={tPublic('ctaConfirm')}
              submittingLabel={tPublic('ctaBooking')}
              onConfirm={() => guestFormRef.current?.submit()}
            />
          ) : null
        }
      >
        {step === 'coach' && (
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        )}

        {loading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        )}

        {!loading && !teamId && <EmptyState icon={CalendarClock} text={t('teamNotFound')} />}

        {!loading && teamId && loadError && (
          <QueryErrorState onRetry={retryLoad} title={t('scheduleLoadError')} detail={loadError} />
        )}

        {!loading && teamId && !loadError && !hasCoaches && (
          <EmptyState icon={CalendarClock} text={t('noCoaches')} hint={t('noCoachesHint')} />
        )}

        {!loading && teamId && !loadError && hasCoaches && step === 'coach' && (
          <section className="space-y-3">
            {coaches.map((c) => (
              <CoachCard key={c.providerId} coach={c} onSelect={() => selectCoach(c)} />
            ))}
          </section>
        )}

        {!loading && teamId && step === 'activity' && selectedCoach && (
          <section className="space-y-3">
            <BackButton label={t('backToCoaches')} onClick={backToCoaches} />
            <h2 className="text-sm font-semibold">{selectedCoach.providerName || t('unnamedCoach')}</h2>
            {selectedCoach.activities.length === 0 ? (
              <EmptyState icon={CalendarClock} text={t('noCoaches')} hint={t('noCoachesHint')} />
            ) : (
              selectedCoach.activities.map((a) => (
                <ActivityCard
                  // ONE ACTIVITY ID NAMES SEVERAL ENTRIES, one per place, so
                  // the id alone is not a key: two cards for the same offer at
                  // two places shared it, and React reuses a node it believes
                  // is the same one.
                  key={`${a.activityId}:${a.placeId ?? ''}`}
                  activity={a}
                  currency={currency}
                  locale={locale}
                  onSelect={() => selectActivity(a)}
                />
              ))
            )}
          </section>
        )}

        {!loading && teamId && step === 'time' && selectedCoach && selectedActivity && (
          <section className="space-y-4">
            <BackButton label={timeBackLabel} onClick={backFromTime} />
            <AppointmentWhen
              coach={selectedCoach}
              activity={selectedActivity}
              currency={currency}
              locale={locale}
              fmt={fmt}
              t={t}
              tPublic={tPublic}
              formatDuration={fmtDuration}
              duration={effectiveDuration}
              onDurationChange={setDuration}
              selectedDateKey={selectedDateKey}
              onDateChange={setSelectedDateKey}
              onPick={(startMs, duration) => {
                setWindowBooking(
                  buildWindowBooking(selectedCoach, selectedActivity, startMs, duration.minutes)
                )
                setStep('book')
              }}
            />
          </section>
        )}

        {!loading && teamId && step === 'book' && selectedCoach && selectedActivity && windowBooking && (
          <section className="space-y-4">
            <SlotBookingForm
              key={`${windowBooking.providerId}-${windowBooking.activityId}-${windowBooking.startMs}-${windowBooking.durationMinutes}`}
              teamId={teamId}
              guestFormRef={guestFormRef}
              onScreenChange={setBookScreen}
              onSubmittingChange={setBookSubmitting}
              accentColor={accentColor}
              hasAnyPrice={durationIsPriced(windowBooking)}
              settleAtStudio={settleAtStudio}
              benefitOnly={windowBooking.benefitOnly}
              shopHref={publicHrefLocalized(locale, slug, 'shop', {
                tab: 'subscriptions',
                from: 'booking',
              })}
              priceAmount={windowBooking.priceAmount}
              memberBenefit={windowBooking.memberBenefit}
              cancellationPolicy={windowBooking.cancellationPolicy}
              activityContactFields={windowBooking.contactFields}
              durationMinutes={windowBooking.durationMinutes}
              providerId={windowBooking.providerId}
              activityId={windowBooking.activityId}
              startMs={windowBooking.startMs}
              currency={currency}
              locale={locale}
              backLabel={t('back')}
              onExit={backFromBook}
              book={(args) =>
                callFunction('bookAppointment')({
                  teamId,
                  providerId: windowBooking.providerId,
                  activityId: windowBooking.activityId,
                  startMs: windowBooking.startMs,
                  durationMinutes: windowBooking.durationMinutes,
                  ...args,
                }).then(() => undefined)
              }
              checkout={(args) =>
                callFunction<Record<string, unknown>, { url?: string; amount?: number }>(
                  'createAppointmentCheckout'
                )({
                  teamId,
                  providerId: windowBooking.providerId,
                  activityId: windowBooking.activityId,
                  startMs: windowBooking.startMs,
                  durationMinutes: windowBooking.durationMinutes,
                  slug,
                  locale,
                  origin: typeof window !== 'undefined' ? window.location.origin : undefined,
                  ...args,
                }).then((res) => res.data)
              }
              onBooked={(email) => { setWindowBooking(null); setConfirmed({ email }) }}
            />
          </section>
        )}
      </FlowShell>
    </>
  )
}
