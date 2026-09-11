'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import type { Route } from 'next'
import {
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  doc,
  getDoc,
  getDocs,
  Timestamp,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import {
  resolveActivityAccessRule,
  compareActivities,
  activityRequiresSubscription,
  planGiftCardRedemption,
  resolvePaymentOptions,
  resolveBookingContactFields,
  type BookingContactField,
  type ActivityAccessRule,
  type ActivityMemberBenefit,
  type Benefit,
  type PublicFrom,
  type FormField,
  parseDateKey,
  parseDocId,
} from '@linyup/shared'
import { FieldInput, isFieldAnswered } from '@/components/forms/FieldInput'
import { publicHref, publicHrefLocalized, returnHref } from '@/lib/publicRoutes'
import { useStepUrl } from '@/hooks/useStepUrl'
import { clientPaymentSnapshot } from '@/lib/paymentSnapshot'
import { resolveActivityPricingDisplay, type SubLookup } from '@/lib/activityTerms'
import { formatCurrency } from '@/lib/format'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowUpRight } from 'lucide-react'
import { Link, useRouter } from '@/i18n/navigation'
import { BioLinkButton } from '../BioLinkShell'
import { FlowShell } from '@/components/booking/FlowShell'
import { useBookingChrome, useExitFlow } from '@/components/booking/BookingChrome'
import { usePublicTeam } from '../PublicTeamProvider'
import { usePublicContactAuth } from '../PublicContactAuthProvider'
import { MiniCalendar } from '@/components/booking/MiniCalendar'
import {
  GuestDetailsForm,
  type GuestDetailsFormHandle,
  type GuestDetailsValues,
} from '@/components/booking/GuestDetailsForm'
import {
  ReturningSignIn,
  type ContactData,
} from '@/components/booking/ReturningSignIn'
import { StickyBar, activityGradient } from '@/components/booking/StickyBar'
import { BackButton } from '@/components/booking/BackButton'
import { WaiverStep } from '@/components/booking/WaiverStep'
import { BookingTerms, resolveCancellationPolicy } from '@/components/booking/BookingTerms'
import { useWaiverGate } from '@/hooks/useWaiverGate'
import { waiverErrorMessage } from '@/lib/waiver'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import {
  GiftCardRedeemField,
  giftCardCheckoutErrorMessage,
  type AppliedGiftCard,
} from '@/components/booking/GiftCardRedeemField'
import {
  PromoCodeField,
  priceChangedAmount,
  priceChangedMessage,
  promoCheckoutErrorMessage,
  useAcceptedPrice,
  type AppliedPromo,
} from '@/components/booking/PromoCodeField'

// ─── types ───────────────────────────────────────────────────────────────────

interface ActivityProfile {
  id: string
  name: string
  slug: string
  /** Session category — 'appointment' activities route to the appointment flow. */
  activityType?: string
  description?: string
  image?: string | null
  color?: string
  /** Free-text display labels the studio put on the activity — shown as chips
   *  beside the type chip. Display-only; nothing here is a filter or a gate. */
  tags?: string[]
  isFreeTrial?: boolean
  order?: number
  accessRule?: ActivityAccessRule
  dropIn?: { enabled: boolean; priceAmount?: number }
  /** CLASS-ONLY: a gated class still accepts a newcomer's free trial booking. */
  trialEnabled?: boolean
  /** CLASS-ONLY: reduced trial price (major units). Absent/null ⇒ the trial is
   *  FREE (today's behaviour); a number ⇒ the trial costs that instead. */
  trialPriceAmount?: number | null
  /** CLASS-ONLY: a full session offers a queue instead of a dead end. The flag
   *  lives on the ACTIVITY mirror only — sessions deliberately carry no copy of
   *  it (see Session.waitlist_count), so this is the single thing that decides
   *  whether a full slot is clickable. */
  waitlistEnabled?: boolean
  /** APPOINTMENT-ONLY: priced duration menu (member pricing stripped). */
  durations?: Array<{ minutes: number; priceAmount: number | null }>
  /** The one member-benefit rule, mirrored verbatim — appointments (every
   *  priced duration) and classes (the drop-in price). Accepts the legacy
   *  appointment shape or the generalized `Benefit`. */
  memberBenefit?: ActivityMemberBenefit | Benefit
  prerequisites?: string
  meetingPoint?: string
  whatsIncluded?: string
  whatsNotIncluded?: string
  faq?: string
  cancellationPolicy?: string
  /** Per-activity book-form questions (shared FormField schema). */
  bookingQuestions?: FormField[]
  /** Per-activity CONTACT fields, which EXTEND the team-wide list. Questions
   *  are about the booking; these are about the person. */
  contactFields?: BookingContactField[]
}

interface SessionProfile {
  id: string
  teamId: string
  activityId?: string
  activityName?: string
  activitySlug?: string
  activityColor?: string
  activityImage?: string | null
  activityIsFreeTrial?: boolean
  start: Timestamp
  end: Timestamp
  location?: string
  providerName?: string
  locationAddress?: string
  locationMapsUrl?: string
  allowBooking: boolean
  bookingMandatory?: boolean
  max_participants?: number
  bookings_count?: number
  /** How many people are already queueing. An aggregate — the queue itself is
   *  never public. */
  waitlist_count?: number
  headline?: string
}

// MatchedContact / ContactData now live in components/booking/ReturningSignIn
// (ContactData imported above; MatchedContact is an internal detail of that
// component, not needed here).

type Step =
  | 'activities'
  | 'sessions'
  | 'who'
  | 'returning'
  // A CONTACT WHO IS ALREADY SIGNED IN. Neither 'who' nor 'returning' is a
  // question you may ask them: one offers to treat a member as a newcomer, the
  // other asks a signed-in person to fetch an emailed code to prove they are
  // themselves. Both were asked, and a member with a valid subscription hit the
  // OTP wall every time — the class-side twin of the appointment-picker defect
  // fixed on 2026-08-16 (docs/open-defects.md).
  //
  // The server never needed the code: `bookSession` and `createDropInCheckout`
  // both read the caller off the contact-session token and say so in as many
  // words ("a signed-in app never has to type an emailed code to book something
  // it's already authenticated for"). This step is the surface catching up with
  // that. It stays a chooser in one respect — "book for someone else" leads to
  // 'who'/'returning', because the code path is exactly how a parent books for
  // a child (see buildContactSession's login-email allow-list).
  | 'member'
  | 'details'
  // The consent step. NON-TERMINAL on purpose (unlike 'confirmed'/'waitlisted'):
  // Back into it must be safe, and booking a second class from the same mounted
  // flow with the same intentId has to succeed — the ledger reads its own
  // acceptance ref and skips the create, so a repeat is one row, not an aborted
  // commit.
  //
  // It is a STEP rather than a block inside 'details' because two of this file's
  // three terminal submits never render 'details' at all: `nextStepAfterSession`
  // routes a gated class with no guest door to 'returning', and `onVerified`
  // then books directly. A block inside the details form would be silently
  // skipped on exactly that path.
  | 'waiver'
  | 'confirmed'
  // A full class with a queue behind it. 'waitlist' collects what joining needs
  // (nothing, for a signed-in contact); 'waitlisted' is its terminal
  // confirmation — the sibling of 'confirmed', and terminal for the same reason:
  // Back must never re-enter it and submit a second join.
  | 'waitlist'
  | 'waitlisted'

/**
 * Why a `?session=` / `?date=` deep link couldn't be honoured. The visitor is
 * degraded to the nearest useful step and told why — never silently dumped on
 * the blank activity picker, which is the whole reason deep links exist.
 */
type DeepLinkNotice = 'past' | 'full' | 'gone' | 'dateEmpty' | 'closed'

// ─── helpers ─────────────────────────────────────────────────────────────────

function toDateKey(ts: Timestamp): string {
  const d = ts.toDate()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateKeyToDate(key: string): Date {
  return new Date(key + 'T00:00:00')
}

function formatDate(ts: Timestamp, locale?: string): string {
  return ts.toDate().toLocaleDateString(locale ?? [], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function formatDateFull(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}

function formatTime(ts: Timestamp): string {
  return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function sessionDuration(
  start: Timestamp,
  end: Timestamp,
  t: ReturnType<typeof useTranslations>
): string {
  const mins = Math.round((end.toDate().getTime() - start.toDate().getTime()) / 60000)
  if (mins < 60) return t('durationMinutes', { mins })
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? t('durationHoursMinutes', { h, m }) : t('durationHours', { h })
}

// activityGradient now lives in components/booking/StickyBar (shared with the
// appointment picker) — imported above and reused by the activity cards below.

/** Drop-in (pay-per-class) price for a gated class, else null.
 *
 *  `paymentsEnabled` is TeamPublicProfile.payments_enabled — whether the studio
 *  has a chargeable Stripe Connect account at all. A drop-in is nothing but a
 *  price, so with no way to take it there is no door: `createDropInCheckout`
 *  calls requireChargeableAccount and refuses every one of these (UX-33).
 *  Suppressing it here leaves the class exactly as gated as it was — the
 *  members' own door is unaffected. */
function dropInPriceOf(
  a: ActivityProfile | null | undefined,
  paymentsEnabled: boolean
): number | null {
  if (!paymentsEnabled) return null
  if (!a || a.isFreeTrial !== false) return null
  if (!a.dropIn?.enabled) return null
  return typeof a.dropIn.priceAmount === 'number' ? a.dropIn.priceAmount : null
}

/** Is the newcomer's trial door open? A FREE trial always is — being unable to
 *  charge is not the same as being closed. A PRICED trial
 *  (Activity.trialPriceAmount) is charged through the same drop-in checkout, so
 *  it closes with the till: it must not be advertised, and it must certainly
 *  not silently become free. */
function trialDoorOpen(
  a: ActivityProfile | null | undefined,
  paymentsEnabled: boolean
): boolean {
  if (a?.trialEnabled !== true) return false
  return paymentsEnabled || typeof a.trialPriceAmount !== 'number'
}

/**
 * Which step follows picking a session. A signed-in contact goes straight to
 * 'member' — there is nothing to ask them. Otherwise: members-only → sign in
 * ('returning'); but if the class has a guest door — drop-in (pay per class) or
 * a trial for newcomers — the visitor gets the chooser ('who') instead.
 *
 * The ONLY place this rule lives. Both the session click handler and the
 * `?session=` deep-link resolver call it, or the click path and the link path
 * silently diverge.
 */
function nextStepAfterSession(
  a: ActivityProfile | null | undefined,
  paymentsEnabled: boolean,
  signedIn: boolean
): Step {
  // A KNOWN CALLER SKIPS BOTH DOORS. 'who' and 'returning' exist to work out
  // who is booking; a contact session has already answered that.
  if (signedIn) return 'member'
  const gated = a?.isFreeTrial === false
  const canGuest = dropInPriceOf(a, paymentsEnabled) != null || trialDoorOpen(a, paymentsEnabled)
  return gated && !canGuest ? 'returning' : 'who'
}

/** A session is bookable only while it's upcoming, has a free seat, and (if the
 *  studio set one) is still before the online booking cutoff. Client-side
 *  mirror of the server's authoritative check (isPastBookingCutoff, bookSession
 *  / createDropInCheckout) — never trust this alone.
 *
 *  ORDER MATTERS: 'closed' is tested BEFORE 'full', so a class that is both
 *  reports 'closed' and is filtered out of the list entirely. A full class past
 *  the cutoff must not advertise its queue — the promoter cannot offer from it
 *  either (the claim window is clamped by the same cutoff), so the chip would
 *  invite people into a line that can never move. */
function sessionBlockReason(
  s: SessionProfile,
  cutoffMinutes?: number
): DeepLinkNotice | null {
  if (s.allowBooking !== true) return 'gone'
  if (s.start.toDate().getTime() <= Date.now()) return 'past'
  if (cutoffMinutes && cutoffMinutes > 0 && Date.now() >= s.start.toDate().getTime() - cutoffMinutes * 60_000)
    return 'closed'
  if (typeof s.max_participants === 'number' && (s.bookings_count ?? 0) >= s.max_participants)
    return 'full'
  return null
}

/** A full-but-still-open class whose activity runs a queue. The one condition
 *  that turns a dead end into the waitlist step — everywhere it can be reached
 *  from (the slot list, the `?session=` deep link). */
function offersWaitlist(
  blocked: DeepLinkNotice | null,
  a: ActivityProfile | null | undefined
): boolean {
  return blocked === 'full' && a?.waitlistEnabled === true
}

// ─── props ────────────────────────────────────────────────────────────────────

interface Props {
  slug: string
  /** `/booking/{activitySlug}` path form. Inbound alias only — never pushed. */
  preSelectedActivitySlug?: string
  initialDate?: string
  /** `?session=` — highest precedence: lands on the "who's booking" step. */
  initialSession?: string
  /** `?activity=` — activity ID (the form the cancellation/rebook emails send). */
  initialActivityId?: string
  /** `?referral=` — carried through to `bookSession({ referralCode })`. */
  referral?: string
  /** `?from=` — which surface to return to. See `returnHref`. */
  from?: PublicFrom
  /**
   * Suppress this flow's own history writes. Set by an overlay host, which owns
   * the address bar while the panel is open — two writers would fight, and Back
   * would take two presses to close the overlay.
   */
  disableStepUrl?: boolean
  /**
   * Open directly on the confirmation step for this session — the visitor has
   * just returned from a successful Stripe payment. Only ever set from a
   * verified payment result, never from a URL: see lib/bookingReturn.ts.
   */
  confirmedSessionId?: string
}

// MiniCalendar and StickyBar now live in components/booking/ (shared with the
// appointment picker) — imported at the top of this file.

// ─── component ───────────────────────────────────────────────────────────────

export default function BookingForm({
  slug,
  preSelectedActivitySlug,
  initialDate,
  initialSession,
  initialActivityId,
  referral,
  from,
  disableStepUrl,
  confirmedSessionId,
}: Props) {
  // Team already resolved once by the parent PublicTeamProvider (the layout).
  const { teamId, team } = usePublicTeam()
  // Can this studio actually BE PAID? Mirrored onto the public profile by
  // syncTeamPublicProfile from the very fields requireChargeableAccount
  // enforces, because a public surface may not read teams/. Absent ⇒ false: a
  // profile written before the field existed advertises no priced door until
  // its next sync, which is the safe direction. Everything free here is
  // untouched — see dropInPriceOf / trialDoorOpen.
  const paymentsEnabled = team.payments_enabled === true
  // The team-root sign-in bar's session — a contact may already be signed in
  // from another surface (Space/Shop). Used ONLY to preview the drop-in
  // member rate here; checkout/booking always re-resolve authoritatively
  // server-side (the callable trusts its own session token, not this).
  const { contact, isAuthenticated } = usePublicContactAuth()
  // 'page' unless an overlay host wraps this flow — see BookingChrome.
  const chrome = useBookingChrome()
  // Closes the panel, or navigates the page — see useExitFlow.
  const exitFlow = useExitFlow()
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('PublicBooking')
  const tShop = useTranslations('Shop')
  // The promo widget's own namespace — a promo is not a shop item, and the copy
  // is shared by every mount of PromoCodeField rather than forked per surface.
  // (Which mounts those are is in docs/promo-codes.md → "The mounts", and only
  // there; connect/commitSites.test.ts asserts the tally against the source.)
  const tPromo = useTranslations('Promo')
  // The public waiver namespace — one key per server refusal reason, shared with
  // every other surface that can hit one.
  const tWaiver = useTranslations('Waiver')
  const tSurfaces = useTranslations('PublicSurfaceLinks')
  const teamName = team.name || ''
  const accentColor = team.bioLinkAccentColor ?? null
  const bookingSettings = team.bookingSettings
  const showBranding = team.showBranding === true
  const currency = team.default_currency ?? 'CHF'

  // Subscription plans (id → name + price label) for the activity cards' access
  // lines ("Included with Premium — CHF 89 / month"). Same source the shop reads:
  // the team public_profile's aggregator, already on `team` via PublicTeamProvider.
  const subLookup = useMemo<SubLookup>(() => {
    const plans =
      (team as { aggregator_subscription_types?: Array<{ id: string; name: string; prices?: Array<{ amount: number; recurrence: string }> }> })
        .aggregator_subscription_types ?? []
    const byId = new Map(plans.map((p) => [p.id, p]))
    return (id: string) => {
      const p = byId.get(id)
      if (!p) return null
      const price = p.prices?.[0]
      let priceLabel: string | null = null
      if (price) {
        const key = `recurrence.${price.recurrence}`
        const suffix = tShop.has(key as Parameters<typeof tShop.has>[0])
          ? ` ${tShop(key as Parameters<typeof tShop>[0])}`
          : ''
        priceLabel = `${formatCurrency(price.amount, currency, locale)}${suffix}`
      }
      return { id: p.id, name: p.name, priceLabel }
    }
  }, [team, currency, locale, tShop])

  const bookingWindowMonths = bookingSettings?.windowMonths ?? 2
  const showPhone = bookingSettings?.showPhone !== false
  const showDesc = bookingSettings?.showActivityDescription !== false
  // `!== false`, matching the settings form's default: absent means SHOWN. The
  // two must agree — the admin toggle reading one way and the public form the
  // other is a field a studio believes is on and visitors never see.
  const showFitnessApp = bookingSettings?.showFitnessAppField !== false
  // The partner apps this studio actually accepts — its own active
  // `source: 'aggregator'` subscription types, mirrored onto the public profile
  // by `resolveTeamPartnerApps` (see its header for every sync that writes the
  // field). The question is asked with the studio's own vocabulary and is not
  // asked at all when the studio has named none.
  //
  // THIS MIRROR IS ALSO WHAT THE SERVER VALIDATES AGAINST — `bookSession` reads
  // the same document (booking/contactFields.ts `loadTeamPartnerAppNames`)
  // rather than re-querying the live collection, precisely so that what is
  // offered here and what is accepted there cannot drift apart and drop a
  // visitor's answer with no error.
  const partnerApps = useMemo(() => team.partner_apps ?? [], [team.partner_apps])
  const askFitnessApp = showFitnessApp && partnerApps.length > 0

  // Data loading
  const [activities, setActivities] = useState<ActivityProfile[]>([])
  const [sessions, setSessions] = useState<SessionProfile[]>([])
  const [loadingData, setLoadingData] = useState(true)

  // Flow state
  const [step, setStep] = useState<Step>('activities')
  const [selectedActivity, setSelectedActivity] = useState<ActivityProfile | null>(null)
  const [selectedSession, setSelectedSession] = useState<SessionProfile | null>(null)
  // Which guest door the visitor chose on the "who" step. A gated class can now
  // offer BOTH doors at once (trialEnabled + drop-in), and they submit
  // differently: 'trial' books free via bookSession (the backend admits gated
  // trial guests), 'dropin' pays via checkout. Null = not chosen (open classes
  // only ever have the free path, so null behaves like 'trial').
  const [guestPath, setGuestPath] = useState<'trial' | 'dropin' | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  // Why an inbound deep link couldn't be honoured verbatim (see DeepLinkNotice).
  const [deepLinkNotice, setDeepLinkNotice] = useState<DeepLinkNotice | null>(null)
  // `applyEntry` may pick the date itself (from the deep-linked session). Set once
  // it has, so the default-date effect below doesn't immediately overwrite it.
  const entryResolvedRef = useRef(false)

  // Confirmation
  const [confirmedSession, setConfirmedSession] = useState<SessionProfile | null>(null)
  // Short human-readable code from bookSession's return value — only the FREE
  // path returns it synchronously (a paid booking confirms later via the
  // Stripe webhook, off this request), so absent is expected there.
  const [bookingReference, setBookingReference] = useState<string | null>(null)
  const [bookingError, setBookingError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // The place in the queue joinWaitlist just returned. Its presence is what
  // makes 'waitlisted' terminal for the step↔URL restore guard, exactly like
  // `confirmedSession` is for 'confirmed'.
  const [waitlistJoined, setWaitlistJoined] = useState<{
    position: number
    entryToken: string
  } | null>(null)

  // Optional gift-card redemption — only meaningful on a paying booking (drop-in
  // or priced trial). Reset whenever the guest door changes.
  const [giftCardApplied, setGiftCardApplied] = useState<AppliedGiftCard | null>(null)

  // Optional promo code — a Stage A price MODIFIER, so unlike the gift card it
  // goes INTO the price computation below rather than being deducted after it.
  const [promoApplied, setPromoApplied] = useState<AppliedPromo | null>(null)

  // ── The recovery half of the `price_changed` guard ────────────────────────
  // The server's own figure, once it has refused this surface's quote and the
  // breakdown has been redrawn at it. It is BOTH what the breakdown renders and
  // what the next submit sends back as `quotedAmount` — which is what makes the
  // refusal cost one extra, informed confirmation instead of looping (the form
  // would otherwise re-derive the same optimistic figure and be refused again).
  //
  // AN ACCEPTED FIGURE BELONGS TO ONE (target, code, IDENTITY) — the rule lives
  // in `useAcceptedPrice`, shared with the shop and the appointment picker.
  // Here the TARGET is the session AND the door (`guestPath`: the trial door and
  // the drop-in door are different prices for the same seat); the IDENTITY is
  // the public contact session, which the sign-in bar can change under this form
  // at any moment — `dropInQuote` re-quotes on it, so the accepted figure has to
  // retire with it or the breakdown would show a member one number and submit
  // another.
  const { acceptedPrice, acceptPrice } = useAcceptedPrice(
    [
      selectedSession?.id ?? '',
      guestPath ?? '',
      promoApplied?.code ?? '',
      isAuthenticated ? (contact?.id ?? 'auth') : 'guest',
      contact?.subscription_type_id ?? '',
    ].join('|')
  )

  // Answers to the activity's book-form questions, keyed by FormField.id. The
  // server re-narrows these to the activity's own questions before storing
  // (sanitizeBookingAnswers) — this map is convenience, not trust.
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [answersError, setAnswersError] = useState<string | null>(null)
  // The terms this flow commits somebody to, resolved ONCE the way the
  // confirmation email resolves them (activity override → team default) and
  // rendered by `withBar` on every terminal-submit step. Deriving it here rather
  // than per step is the point: this file's submits are spread across several
  // steps, and a per-step copy is how one of them silently loses it.
  const effectiveCancellationPolicy = resolveCancellationPolicy(
    selectedActivity?.cancellationPolicy,
    team.bookingCancellationPolicy
  )

  const bookingQuestions = selectedActivity?.bookingQuestions ?? []

  // TWO different things, deliberately side by side. A booking QUESTION is
  // about this booking ("any injuries today?") and is stored on the booking; a
  // contact FIELD is about the person ("date of birth") and is stored on the
  // contact, so it is asked once and never again. The list is the team's
  // extended by this activity's — the resolver is the one that decides, here
  // and on the server both.
  const contactFields = resolveBookingContactFields(
    bookingSettings,
    selectedActivity?.contactFields ?? null
  )

  /** Every required question answered? Gates submit on both booking paths. */
  function missingRequiredAnswer(): boolean {
    return bookingQuestions.some((q) => q.required && !isFieldAnswered(q, answers[q.id]))
  }

  // Ref to trigger the shared guest-details form's submit from the sticky bar
  // (the Confirm button lives outside the <form> element).
  const guestFormRef = useRef<GuestDetailsFormHandle>(null)

  // ── The waiver gate ───────────────────────────────────────────────────────
  // Inert unless the team's public mirror lists a required waiver, so every
  // tenant on the day this ships pays zero extra round-trips on this path.
  //
  // `activityId` is passed because this rail always resolves one: an
  // activity-scoped waiver that the step could not see would be enforced by the
  // server and invisible here, which is a refusal with no step behind it.
  const waiverGate = useWaiverGate({
    teamId,
    requiredWaivers: team.required_waivers,
    activityId: selectedActivity?.id ?? null,
  })
  // The submit the consent step is standing in front of. Stashed rather than
  // re-derived, because the returning-member path has no form to re-read: its
  // identity is a contact id and a verification code that were resolved once.
  const [pendingSubmit, setPendingSubmit] = useState<
    | { kind: 'guest'; values: GuestDetailsValues }
    | { kind: 'returning'; contactId: string; verificationCodeId: string; contactData: ContactData }
    | { kind: 'member' }
    | null
  >(null)

  // Load activities + sessions for the resolved team
  useEffect(() => {
    async function loadData() {
      try {
        const windowMonths = bookingSettings?.windowMonths ?? 2

        // Load activities
        const actQ = query(
          collectionGroup(db, 'public_profile'),
          where('teamId', '==', teamId),
          where('type', '==', 'activity')
        )
        const actSnap = await getDocs(actQ)
        const actList: ActivityProfile[] = actSnap.docs
          .map((d) => {
            const data = d.data()
            return {
              id: d.id,
              name: data.name || '',
              slug: data.slug || '',
              activityType: data.activityType ?? undefined,
              description: data.description ?? undefined,
              image: data.image_url ?? null,
              color: data.color ?? undefined,
              tags: Array.isArray(data.tags) ? (data.tags as string[]) : undefined,
              isFreeTrial: data.isFreeTrial ?? false,
              order: typeof data.order === 'number' ? data.order : undefined,
              accessRule: data.accessRule ?? undefined,
              dropIn: data.dropIn ?? undefined,
              trialEnabled: data.trialEnabled === true,
              trialPriceAmount: typeof data.trialPriceAmount === 'number' ? data.trialPriceAmount : null,
              waitlistEnabled: data.waitlistEnabled === true,
              durations: Array.isArray(data.durations) ? data.durations : undefined,
              memberBenefit: data.memberBenefit ?? undefined,
              prerequisites: data.prerequisites ?? undefined,
              meetingPoint: data.meetingPoint ?? undefined,
              whatsIncluded: data.whatsIncluded ?? undefined,
              whatsNotIncluded: data.whatsNotIncluded ?? undefined,
              faq: data.faq ?? undefined,
              cancellationPolicy: data.cancellationPolicy ?? undefined,
              bookingQuestions: Array.isArray(data.bookingQuestions)
                ? (data.bookingQuestions as FormField[])
                : undefined,
              contactFields: Array.isArray(data.contactFields)
                ? (data.contactFields as BookingContactField[])
                : undefined,
            }
          })
          .sort(compareActivities)
        setActivities(actList)

        // Load sessions
        const windowEnd = new Date()
        windowEnd.setDate(windowEnd.getDate() + windowMonths * 30)

        const sessQ = query(
          collectionGroup(db, 'public_profile'),
          where('teamId', '==', teamId),
          where('type', '==', 'session'),
          where('allowBooking', '==', true),
          where('start', '>=', Timestamp.now()),
          orderBy('start', 'asc'),
          // A real studio with several daily classes easily exceeds 100 upcoming
          // sessions across a multi-month booking window; the calendar still
          // paginates by day, this just caps how many are fetched up front.
          limit(200)
        )
        const sessSnap = await getDocs(sessQ)
        const sessList: SessionProfile[] = sessSnap.docs
          .map((d) => ({ ...d.data(), id: d.id }) as SessionProfile)
          .filter((s) => s.start && s.end && s.start.toDate() <= windowEnd)
        setSessions(sessList)

        // Determine initial step / auto-select from the inbound deep link.
        if ((await applyEntry(actList, sessList)) === 'navigated') return
      } catch (err) {
        console.error('Error loading booking data', err)
      } finally {
        setLoadingData(false)
      }
    }
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  /**
   * Resolve the inbound deep link to a starting step, in precedence order:
   *   ?session=  >  ?activity=  >  /booking/{activitySlug}  >  single activity  >  picker
   *
   * A `?session=` that can't be honoured (past, full, unpublished) DEGRADES to
   * that activity's date list with a notice — it never falls through to the blank
   * picker, which is the failure this whole contract exists to prevent.
   *
   * Returns 'navigated' when it hands the visitor over to the appointment flow,
   * so the caller stops (a router.replace does not halt the surrounding function).
   */
  async function applyEntry(
    actList: ActivityProfile[],
    sessList: SessionProfile[]
  ): Promise<'navigated' | 'applied'> {
    const findActivityFor = (s: SessionProfile) =>
      actList.find((a) => a.id === s.activityId || (!!s.activitySlug && a.slug === s.activitySlug)) ??
      null

    // ── Returning from a successful payment ──────────────────────────────────
    // Straight to the confirmation, no re-booking. The session must still
    // resolve; if it doesn't, fall through and the normal funnel applies.
    if (confirmedSessionId) {
      const paid = sessList.find((s) => s.id === confirmedSessionId)
      if (paid) {
        setSelectedActivity(findActivityFor(paid))
        setSelectedSession(paid)
        setConfirmedSession(paid)
        entryResolvedRef.current = true
        setStep('confirmed')
        return 'applied'
      }
    }

    // ── ?session= ────────────────────────────────────────────────────────────
    if (initialSession) {
      // The list query is capped (`limit(200)`) and starts at now, so a session
      // linked from the website's schedule — which lists from Monday of the
      // current week — may be absent. The per-session public_profile is
      // world-readable and its doc id IS the session id, so one read resolves it.
      let target = sessList.find((s) => s.id === initialSession) ?? null
      if (!target) {
        try {
          const snap = await getDoc(
            doc(db, 'sessions', initialSession, 'public_profile', initialSession)
          )
          const data = snap.data()
          // Never trust a session id from the URL to belong to this tenant.
          if (data && data.type === 'session' && data.teamId === teamId) {
            target = { ...data, id: snap.id } as SessionProfile
          }
        } catch (err: unknown) {
          // Unreadable → treated as gone below. The DEGRADATION is acceptable
          // (the visitor lands on the activity's next available times and can
          // still book) but the SILENCE was not: a rules or index change that
          // breaks every deep link from a reminder email would look exactly like
          // people clicking stale links.
          reportPublicLoadFailure('booking/deep-link-session', err)
        }
      }

      const activity = target ? findActivityFor(target) : null
      const blocked = target ? sessionBlockReason(target, bookingSettings?.cutoffMinutes) : 'gone'

      if (target && activity && !blocked) {
        setSelectedActivity(activity)
        setSelectedSession(target)
        setSelectedDate(toDateKey(target.start))
        entryResolvedRef.current = true
        setStep(nextStepAfterSession(activity, paymentsEnabled, isAuthenticated))
        return 'applied'
      }

      // A link to a class that filled up while the mail sat in an inbox — the
      // exact moment the queue exists for. It lands on the join step rather than
      // degrading to the date list with a "that one is full" notice.
      if (target && activity && offersWaitlist(blocked, activity)) {
        setSelectedActivity(activity)
        setSelectedSession(target)
        setSelectedDate(toDateKey(target.start))
        entryResolvedRef.current = true
        setStep('waitlist')
        return 'applied'
      }

      setDeepLinkNotice(blocked ?? 'gone')
      // Degrade: keep the activity, but deliberately do NOT pin the linked day.
      // The notice promises "the next available times", and the linked day is by
      // definition the one that's past/full — pinning it would show an empty
      // list under that promise. Leaving the date unset lets the default-date
      // effect land on the nearest day that actually has sessions.
      if (activity) {
        setSelectedActivity(activity)
        setStep('sessions')
        return 'applied'
      }
      // Otherwise fall through to the activity-level branches below.
    }

    // ── ?activity= (id) ──────────────────────────────────────────────────────
    // The form sendBookingCancelled / updateSession have been emailing all along.
    if (initialActivityId) {
      const matched = actList.find((a) => a.id === initialActivityId)
      if (matched?.activityType === 'appointment') {
        goToAppointments(matched.id)
        return 'navigated'
      }
      if (matched) {
        setSelectedActivity(matched)
        setStep('sessions')
        return 'applied'
      }
    }

    // ── /booking/{activitySlug} path form ────────────────────────────────────
    if (preSelectedActivitySlug) {
      const matched = actList.find((a) => a.slug === preSelectedActivitySlug)
      if (matched?.activityType === 'appointment') {
        // Appointments have their own booking flow (per-coach slot picker) — the
        // class calendar can't render their slots, so hand the visitor over. The
        // activity id carries over so the picker preselects the same offering
        // instead of forgetting what was clicked.
        goToAppointments(matched.id)
        return 'navigated'
      }
      if (matched) {
        setSelectedActivity(matched)
        setStep('sessions')
        return 'applied'
      }
    }

    // ── Defaults ─────────────────────────────────────────────────────────────
    // Date-first: straight to the day picker with NO activity pinned, so the
    // slot list shows every activity running on the chosen day. (Checked before
    // the single-activity shortcut — with one activity the two are equivalent,
    // and pinning it would hide nothing but costs the row its name label.)
    //
    // BOTH DEFAULTS HAVE TO ASK THE APPOINTMENT QUESTION the two deep-link
    // branches above already ask. An appointment has no pre-scheduled sessions
    // — nothing exists until it is booked — so landing on the class day picker
    // with an appointment selected shows an empty list forever. That is what a
    // studio meant when it said "bookable hours are not displayed even though
    // the setting is on": the setting was fine, the visitor never reached the
    // picker that renders those hours.
    const everyActivityIsAppointment =
      actList.length > 0 && actList.every((a) => a.activityType === 'appointment')

    if (everyActivityIsAppointment && actList.length === 1) {
      // The single-appointment studio — a coach selling 1:1s, which is the
      // whole shape of the coach plan. Straight to the picker.
      goToAppointments(actList[0].id)
      return 'navigated'
    }
    if (isDateFirst && !everyActivityIsAppointment) {
      setSelectedActivity(null)
      setStep('sessions')
    } else if (everyActivityIsAppointment) {
      // Date-first has nothing to offer when there are no classes at all, so
      // show the cards instead of an empty day. (A MIXED studio on date-first
      // still cannot reach its appointments from here — the day picker only
      // knows class sessions. That needs a design call, not a patch: see
      // docs/open-defects.md.)
      setStep('activities')
    } else if (actList.length === 1) {
      if (actList[0].activityType === 'appointment') {
        goToAppointments(actList[0].id)
        return 'navigated'
      }
      setSelectedActivity(actList[0])
      setStep('sessions')
    } else {
      setStep('activities')
    }
    return 'applied'
  }

  /**
   * DATE-FIRST flow (`BookingSettings.flowType`): the visitor picks a DAY first
   * and sees every activity running that day, instead of picking an activity
   * and then a day. It reuses the same 'sessions' step with NO activity
   * selected — `activitySessions` already returns everything in that state and
   * the slot rows already label themselves with `activityName`. The activity is
   * resolved from whichever session gets clicked.
   *
   * A deep link that names one activity (`/booking/{slug}`, `?activity=`,
   * `?session=`) still pins it — the visitor asked for that activity
   * specifically, so the studio's browse preference doesn't apply.
   */
  const isDateFirst =
    bookingSettings?.flowType === 'date-first' && !preSelectedActivitySlug && !initialActivityId

  /** The loaded activity a session belongs to (by id, else by slug). */
  const findActivityForSession = (s: SessionProfile) =>
    activities.find(
      (a) => a.id === s.activityId || (!!s.activitySlug && a.slug === s.activitySlug)
    ) ?? null

  // Sessions filtered by selected activity
  const activitySessions = useMemo(() => {
    if (!selectedActivity) return sessions
    return sessions.filter(
      (s) => s.activityId === selectedActivity.id || s.activitySlug === selectedActivity.slug
    )
  }, [sessions, selectedActivity])

  const availableDates: string[] = useMemo(
    () => Array.from(new Set(activitySessions.map((s) => toDateKey(s.start)))).sort(),
    [activitySessions]
  )

  const maxDateKey = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + bookingWindowMonths * 30)
    return toDateKey(Timestamp.fromDate(d))
  }, [bookingWindowMonths])

  // Set default selected date. `applyEntry` may already have picked one from a
  // deep-linked session — don't clobber it (this effect also runs on the very
  // transition applyEntry causes).
  useEffect(() => {
    if (availableDates.length === 0) return
    if (entryResolvedRef.current) {
      entryResolvedRef.current = false
      return
    }
    if (initialDate && !availableDates.includes(initialDate)) {
      // The linked day has no sessions for this activity — land on the nearest
      // one that does, and say so rather than silently showing a different day.
      setDeepLinkNotice('dateEmpty')
    }
    const candidate =
      initialDate && availableDates.includes(initialDate) ? initialDate : availableDates[0]
    setSelectedDate(candidate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedActivity?.id, sessions.length])

  const cutoffMinutes = bookingSettings?.cutoffMinutes
  const filteredSessions = useMemo(
    () =>
      (selectedDate
        ? activitySessions.filter((s) => toDateKey(s.start) === selectedDate)
        : activitySessions
      ).filter((s) => sessionBlockReason(s, cutoffMinutes) !== 'closed'),
    [selectedDate, activitySessions, cutoffMinutes]
  )

  // Drop-in (pay-per-class): a gated class where the studio lets uncovered contacts
  // pay a per-class fee to book. Members who are covered still book free via sign-in.
  const selectedDropInPrice = dropInPriceOf(selectedActivity, paymentsEnabled)
  const dropInAvailable = selectedDropInPrice != null
  // The newcomer's door, decided in ONE place so the chooser, the Back target
  // and the deep-link resolver cannot disagree about whether it exists.
  const trialAvailable = trialDoorOpen(selectedActivity, paymentsEnabled)

  // Member rate preview on the drop-in price — a signed-in contact (from the
  // team-root sign-in bar) whose held subscription earns a benefit sees the
  // reduced price with the base struck through, BEFORE they even reach
  // checkout. DISPLAY only: createDropInCheckout re-resolves authoritatively
  // from its own session, never from this. Today's public contact session
  // only carries one primary `subscription_type_id` — same simplification
  // ShopHome's held union uses.
  //
  // ONE COMPUTATION FOR THIS SURFACE. The member rate, the promo discount and
  // the subtotal the gift card draws against all come out of this single
  // `resolvePaymentOptions` result — never two independent calls. Two
  // independent computations do not become mutually exclusive by assertion: a
  // member holding a 20% benefit who applies a 25% code would otherwise see
  // 40 / −8 / −10 / 22 while Stripe charged 30.
  const dropInQuote = useMemo(() => {
    if (!selectedActivity || !dropInAvailable) return null
    const rule = resolveActivityAccessRule(selectedActivity)
    const heldSubscriptionTypeIds = contact?.subscription_type_id ? [contact.subscription_type_id] : []
    const snapshot = clientPaymentSnapshot({ authenticated: isAuthenticated, heldSubscriptionTypeIds })
    const result = resolvePaymentOptions(
      snapshot,
      {
        kind: 'drop_in',
        accessRule: rule,
        dropIn: selectedActivity.dropIn,
        benefit: selectedActivity.memberBenefit,
      },
      promoApplied ? { promo: promoApplied } : undefined
    )
    const pay = result.options[0]
    if (pay?.type !== 'pay') return null
    return { pay, promo: result.promo ?? null }
  }, [selectedActivity, dropInAvailable, contact, isAuthenticated, promoApplied])

  // The member rate as the catalogue card renders it (base struck through). Read
  // OFF the one result above — `appliedBenefit` and `appliedPromo` are mutually
  // exclusive there by construction, so this is null the moment a code wins.
  const dropInMemberPrice = useMemo(() => {
    const pay = dropInQuote?.pay
    if (!pay?.appliedBenefit) return null
    return { amount: pay.amount, base: pay.appliedBenefit.baseAmount }
  }, [dropInQuote])

  // CAN THE SIGNED-IN MEMBER JUST BOOK? The same question `onVerified` asks
  // after an OTP, asked from the session instead — and through the same shared
  // resolver, so the 'member' step and the returning path can never disagree
  // about who is covered. DISPLAY only: `bookSession` re-resolves from its own
  // snapshot and stays authoritative.
  const memberAccess = useMemo(() => {
    if (!isAuthenticated || !selectedActivity) return null
    const accessRule = resolveActivityAccessRule(selectedActivity)
    const heldSubscriptionTypeIds = contact?.subscription_type_id
      ? [contact.subscription_type_id]
      : []
    const snapshot = clientPaymentSnapshot({ authenticated: true, heldSubscriptionTypeIds })
    const { denial } = resolvePaymentOptions(snapshot, { kind: 'class_booking', accessRule })
    return { covered: !denial }
  }, [isAuthenticated, selectedActivity, contact])

  // Gated class with drop-in enabled → pay-per-class. NOT when the visitor
  // explicitly took the free-trial door — a trial newcomer must never be
  // charged unless the trial itself is priced (isPricedTrial); bookSession
  // admits gated trial guests (Activity.trialEnabled) for free otherwise.
  const isPricedTrial =
    guestPath === 'trial' && typeof selectedActivity?.trialPriceAmount === 'number'
  const willCharge = (dropInAvailable && guestPath !== 'trial') || isPricedTrial

  // ── Guest booking ─────────────────────────────────────────────────────────

  const onSubmitGuest = async (values: GuestDetailsValues) => {
    if (!selectedSession || !teamId) return
    // Required book-form questions gate the submit — the server would accept the
    // booking without them (they're studio preference, not a data contract), so
    // enforcing here is the only place it happens.
    if (missingRequiredAnswer()) {
      setAnswersError(t('errorAnswerRequired'))
      return
    }
    setAnswersError(null)
    setIsSubmitting(true)
    setBookingError(null)

    // THE GUEST DOOR — free and paid both leave through here. (This file's other
    // terminal submit is `onVerified`; the queue join is deliberately not one.
    // The census that owns that list is `waivers/surfaces.test.ts`, which
    // re-derives it from the source.)
    //
    // The consent step goes BEFORE the call and not after the refusal:
    // `createDropInCheckout` would refuse above its contact write and cost
    // nothing, but `bookSession` has already marked the verification code used
    // by the time it gates, and unwinding to the email step is capped per hour.
    if (
      !(await waiverGate.ensure({
        email: values.email,
        firstname: values.firstname,
        lastname: values.lastname,
      }))
    ) {
      setPendingSubmit({ kind: 'guest', values })
      setStep('waiver')
      setIsSubmitting(false)
      return
    }
    const waiverAcceptances = waiverGate.acceptances

    // Shared checkout call — drop-in (pay-per-class) and priced-trial bookings
    // both redirect to Stripe Checkout; `trial: true` charges the activity's
    // TRIAL price instead of the drop-in price (`createDropInCheckout`'s
    // `trial` input). Also reused defensively from the catch block below when
    // the server reports `payment_required` for what the client thought was free.
    // Returns the raw response so the caller can also detect the gift-card
    // FULL-COVER shape ({ url: null, paidWithGiftCard: true }).
    const checkout = async (trial: boolean) => {
      const fn = httpsCallable<
        Record<string, unknown>,
        { url?: string | null; paidWithGiftCard?: boolean }
      >(functions, 'createDropInCheckout')
      const res = await fn({
        teamId,
        sessionId: selectedSession!.id,
        contactDetails: {
          firstname: values.firstname,
          lastname: values.lastname,
          email: values.email,
          phone: showPhone ? values.phone || null : null,
        },
        ...(values.contactFieldAnswers
          ? { contactFieldAnswers: values.contactFieldAnswers }
          : {}),
        slug,
        locale,
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
        ...(trial ? { trial: true } : {}),
        // A promo never rides the TRIAL door — the server refuses it there too,
        // but sending it would be a request that can only be reported back as a
        // refusal on the one surface a newcomer sees first.
        //
        // THE PRICE THIS SURFACE RENDERED rides WITH the code and only with it.
        // A code is what turns the figure into a promise (a "Code X" discount
        // row, a struck-through base); without one it is an optimistic render
        // from a snapshot documented as partial, and asserting it would refuse
        // ordinary bookings the server prices differently for good reason (an
        // exhausted credit pack, a subscription that lapsed since page load).
        // Disagreement is refused as `price_changed` carrying the new figure,
        // which the catch below renders and offers.
        ...(!trial && promoApplied
          ? {
              promoCode: promoApplied.code,
              ...(acceptedPrice !== null
                ? { quotedAmount: acceptedPrice }
                : dropInQuote
                  ? { quotedAmount: dropInQuote.pay.amount }
                  : {}),
            }
          : {}),
        ...(giftCardApplied ? { giftCardCode: giftCardApplied.code } : {}),
        // The ticks from the consent step, straight back as the server issued
        // them. Recorded before Stripe and NOT conditional on payment: they read
        // the text and ticked, and that is true whether or not the card clears.
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
        // Carried into the PENDING booking doc the checkout creates, so the
        // answers survive the Stripe round-trip without a client re-submit.
        ...(Object.keys(answers).length ? { questionAnswers: answers } : {}),
      })
      return res.data
    }

    try {
      if (willCharge) {
        const result = await checkout(isPricedTrial)
        if (result.paidWithGiftCard) {
          setConfirmedSession(selectedSession)
          setStep('confirmed')
          return
        }
        if (result.url) {
          leaveFlowTo(result.url)
          return
        }
        throw new Error(t('errorCheckoutFailed'))
      }

      const bookSessionFn = httpsCallable<Record<string, unknown>, { bookingReference?: string }>(
        functions,
        'bookSession'
      )
      const bookRes = await bookSessionFn({
        teamId,
        sessionId: selectedSession.id,
        contactDetails: {
          firstname: values.firstname,
          lastname: values.lastname,
          email: values.email,
          phone: showPhone ? values.phone || null : null,
          // Only when the question was actually asked. The server narrows it
          // again against the team's own partner-app names before it reaches
          // the contact (booking/contactFields.ts), so this is a courtesy,
          // never the check.
          aggregatorApp: askFitnessApp ? values.aggregatorApp || null : null,
        },
        ...(values.contactFieldAnswers
          ? { contactFieldAnswers: values.contactFieldAnswers }
          : {}),
        // Free path only — createDropInCheckout takes no referral code, which is
        // right: a referral link invites a newcomer to their first free booking.
        ...(referral ? { referralCode: referral } : {}),
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
        ...(Object.keys(answers).length ? { questionAnswers: answers } : {}),
      })
      setBookingReference(bookRes.data.bookingReference ?? null)
      setConfirmedSession(selectedSession)
      setStep('confirmed')
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: { reason?: string } }
      const reason = e.details?.reason
      // RECOVERY, before anything else: the server has told us what this class
      // really costs. Redraw the breakdown at that figure and say so — the next
      // Confirm sends it back as the quote and the booking completes. Without
      // this the form re-derives the same optimistic number and is refused
      // again, which is a lost booking wearing a safety feature's badge.
      // The sentence is composed by `priceChangedMessage`, because on this rail
      // the guest form's email reaches the server only at checkout: a
      // new-customers-only code that previewed fine for an anonymous visitor is
      // refused HERE, and "the price changed" would be a lie about why.
      const serverPrice = priceChangedAmount(err)
      if (serverPrice !== null) {
        acceptPrice(serverPrice)
        setBookingError(
          priceChangedMessage(err, tPromo, formatCurrency(serverPrice, currency, locale))
        )
        return
      }
      // A WAIVER refusal is a step, not a message: the requirement moved under
      // the visitor (a `require_resign` publish, a revocation, a policy flipped
      // on between page load and submit). Re-resolve and re-present rather than
      // printing a sentence with nothing behind it — and the refusal is thrown
      // above the contact write on every rail here, so it costs nothing.
      //
      // `recover` and not `reset` + `ensure`: the refusal is also proof that the
      // team's public mirror may be stale-EMPTY, in which case `ensure` returns
      // "clear" from its `!applies` line and the sentence prints with nothing
      // behind it — which is the dead end this branch exists to prevent.
      const waiverMsg = waiverErrorMessage(err, tWaiver)
      if (waiverMsg) {
        if (
          await waiverGate.recover(err, {
            email: values.email,
            firstname: values.firstname,
            lastname: values.lastname,
          })
        ) {
          setPendingSubmit({ kind: 'guest', values })
          setStep('waiver')
          return
        }
        setBookingError(waiverMsg)
        return
      }
      const giftMsg = giftCardApplied ? giftCardCheckoutErrorMessage(err, tShop) : null
      // PAY-TIME promo refusals. The preview is advisory about availability —
      // the reserve transaction is the authority and may refuse a code that
      // previewed fine (exhausted, busy, already used, disabled mid-checkout) —
      // so every mount handles a refusal here, not only at apply time.
      const promoMsg = promoCheckoutErrorMessage(err, tPromo)
      if (giftMsg) {
        setBookingError(giftMsg)
      } else if (promoMsg) {
        setBookingError(promoMsg)
      } else if (reason === 'trial_used') {
        setBookingError(t('errorTrialUsed'))
      } else if (reason === 'payment_required') {
        // Defensive: the server determined this booking requires payment even
        // though the client took the free path (e.g. a stale/mismatched trial
        // price) — recover by sending the guest straight to checkout instead of
        // leaving them at a dead end.
        try {
          const result = await checkout(true)
          if (result.paidWithGiftCard) {
            setConfirmedSession(selectedSession)
            setStep('confirmed')
            return
          }
          if (result.url) {
            leaveFlowTo(result.url)
            return
          }
        } catch {
          // fall through to the generic checkout-failed message below
        }
        setBookingError(t('errorCheckoutFailed'))
      } else if (e.code === 'already-exists') {
        setBookingError(t('errorAlreadyRegistered'))
      } else {
        setBookingError(e.message || t('errorGeneric'))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── Waitlist ──────────────────────────────────────────────────────────────

  /**
   * Take a place in the queue for a full class.
   *
   * `values` is null for a signed-in contact: `joinWaitlist` identifies the
   * caller from the contact-session token alone and ignores any details in the
   * body, so sending them would be theatre. Deliberately NOT resolving money or
   * access here — a prospective member's subscription may start before the class
   * runs, so the badge above the form is a warning and the claim is the gate.
   */
  const onJoinWaitlist = async (values: GuestDetailsValues | null) => {
    if (!selectedSession || !teamId) return
    if (missingRequiredAnswer()) {
      setAnswersError(t('errorAnswerRequired'))
      return
    }
    setAnswersError(null)
    setIsSubmitting(true)
    setBookingError(null)
    try {
      const fn = httpsCallable<Record<string, unknown>, { position: number; entryToken: string }>(
        functions,
        'joinWaitlist'
      )
      const res = await fn({
        teamId,
        sessionId: selectedSession.id,
        ...(values
          ? {
              contactDetails: {
                firstname: values.firstname,
                lastname: values.lastname,
                email: values.email,
                phone: showPhone ? values.phone || null : null,
              },
            }
          : {}),
        // Captured at JOIN so the claim never re-asks them — the promoter copies
        // them onto the booking hold it writes.
        ...(Object.keys(answers).length ? { questionAnswers: answers } : {}),
      })
      setWaitlistJoined(res.data)
      setStep('waitlisted')
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: { reason?: string } }
      const reason = e.details?.reason
      if (reason === 'already_waiting' || e.code === 'already-exists') {
        setBookingError(t('waitlistAlreadyWaiting'))
      } else if (reason === 'already_booked') {
        setBookingError(t('waitlistAlreadyBooked'))
      } else if (reason === 'seat_available') {
        // Not really a failure: the class we showed as full has room. The
        // mirror's `bookings_count` was stale (an abandoned checkout hold that
        // lapsed and nothing had recounted yet); the server has now healed it,
        // but this page is holding the copy it loaded, so the slot row would
        // still render disabled. Patch the one number the server just told us
        // about so the row becomes clickable and the message is actionable.
        setSessions((prev) =>
          prev.map((s) =>
            s.id === selectedSession.id && typeof s.max_participants === 'number'
              ? { ...s, bookings_count: Math.max(s.max_participants - 1, 0) }
              : s
          )
        )
        setBookingError(t('waitlistSeatAvailable'))
      } else if (reason === 'email_required') {
        // Signed in, but the profile carries no address the offer could reach —
        // and the claim link travels by mail only.
        setBookingError(t('waitlistEmailRequired'))
      } else if (reason === 'waitlist_full') {
        setBookingError(t('waitlistFullQueue'))
      } else if (reason === 'waitlist_disabled') {
        setBookingError(t('waitlistUnavailable'))
      } else if (reason === 'plan_required' || reason === 'plan_inactive') {
        // The studio's own plan does not carry the queue (or its subscription
        // has lapsed). That is between the studio and us, and NONE of it may
        // reach this page: `requirePlan`'s message is English upgrade/billing
        // prose written for the coach, and rendering it here would put a
        // tenant's internal state on a visitor's screen — untranslated, and as a
        // dead end where the chip promised a queue. All the visitor can act on
        // is that this class has no queue to join.
        setBookingError(t('waitlistUnavailableNow'))
      } else {
        setBookingError(e.message || t('errorGeneric'))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── Returning member — post-verify (class-specific: subscription coverage
  // check, then book). ReturningSignIn owns the email→code→select steps
  // themselves; this only runs once a contact is confirmed. Throwing here
  // surfaces the error on ReturningSignIn's current step, matching the
  // original inline behaviour. ──────────────────────────────────────────────

  async function onVerified({
    contactId,
    verificationCodeId,
    contactData,
  }: {
    contactId: string
    verificationCodeId: string
    contactData: ContactData
  }) {
    if (!selectedSession) return
    // Personalised gate warning: the identified contact holds no subscription the
    // activity accepts — tell them in their language instead of surfacing
    // bookSession's raw permission error. Skipped when drop-in is offered so the
    // contact can back out to the guest pay-per-class path (bookSession itself has
    // no drop-in handling and would still reject them here). A subscription-gated
    // activity with an EMPTY allow-list (misconfig) also skips this and falls
    // through to the server error. bookSession stays authoritative either way.
    // Same resolver the server uses (@linyup/shared) decides "covered" —
    // mechanical swap of the intersection check, same gating conditions.
    const accessRule = selectedActivity ? resolveActivityAccessRule(selectedActivity) : null
    const required = accessRule ? activityRequiresSubscription(accessRule) : null
    if (required?.length && contactData.held_subscription_type_ids && !dropInAvailable) {
      const snapshot = clientPaymentSnapshot({
        authenticated: true,
        heldSubscriptionTypeIds: contactData.held_subscription_type_ids,
      })
      const { denial } = resolvePaymentOptions(snapshot, { kind: 'class_booking', accessRule: accessRule! })
      if (denial) {
        throw new Error(t('errorNoSubscriptionForActivity'))
      }
    }
    // THE RETURNING-MEMBER DOOR, AND THE ONE MOST EASILY MISSED — a member on a
    // gated class NEVER renders `details`, so anything hung off the guest form
    // is not on this path at all.
    //
    // The step goes here, between verification and the call, because
    // `bookSession` marks the verification code used long before it gates. The
    // callable never re-checks `used`, so re-calling it with the same codeId
    // still works — but a surface that unwound to the email step would hit
    // `verifyBookingCode`, which does refuse a used code, against a
    // three-per-hour re-request budget. The refusal is the floor, not the plan.
    if (
      !(await waiverGate.ensure({
        authenticatedContactId: contactId,
        verificationCodeId,
        email: contactData.email,
      }))
    ) {
      setPendingSubmit({ kind: 'returning', contactId, verificationCodeId, contactData })
      setStep('waiver')
      return
    }
    const waiverAcceptances = waiverGate.acceptances

    const bookSessionFn = httpsCallable<Record<string, unknown>, { bookingReference?: string }>(
      functions,
      'bookSession'
    )
    try {
      const bookRes = await bookSessionFn({
        teamId,
        sessionId: selectedSession.id,
        authenticatedContactId: contactId,
        verificationCodeId,
        ...(referral ? { referralCode: referral } : {}),
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
      })
      setBookingReference(bookRes.data.bookingReference ?? null)
      setConfirmedSession(selectedSession)
      setStep('confirmed')
    } catch (err) {
      // The requirement moved between the step and the call. Re-present rather
      // than throwing a sentence onto the sign-in screen with no way forward —
      // this member has already spent their code, and the step is the only exit.
      // `recover` forces the resolve even when the public mirror lists nothing,
      // which is precisely when this member would otherwise be stranded.
      const waiverMsg = waiverErrorMessage(err, tWaiver)
      if (!waiverMsg) throw err
      if (
        await waiverGate.recover(err, {
          authenticatedContactId: contactId,
          verificationCodeId,
          email: contactData.email,
        })
      ) {
        setPendingSubmit({ kind: 'returning', contactId, verificationCodeId, contactData })
        setStep('waiver')
        return
      }
      throw new Error(waiverMsg)
    }
  }

  // ── The signed-in member's booking ────────────────────────────────────────
  //
  // The THIRD terminal submit in this file, and the shortest, because a contact
  // session carries everything the other two have to collect: `bookSession`
  // reads the caller off the token, so no contactId, no verification code and
  // no contactDetails are sent — sending a contactId would be refused anyway
  // (it demands a code alongside it, deliberately).
  //
  // A member who is NOT covered never reaches this: the step routes them into
  // 'details', which owns the one paid path (promo, gift card, price
  // breakdown, the server's `price_changed` renegotiation). A second checkout
  // call built here is exactly the duplication this file keeps warning about.
  async function onSubmitMember() {
    if (!selectedSession || !teamId) return
    if (missingRequiredAnswer()) {
      setAnswersError(t('errorAnswerRequired'))
      return
    }
    setAnswersError(null)
    setIsSubmitting(true)
    setBookingError(null)
    try {
      // No identity arguments: the gate resolves a contact session as its
      // FIRST proof (waivers/caller.ts), which is the same person the booking
      // will be made for.
      if (!(await waiverGate.ensure({ email: contact?.email ?? undefined }))) {
        setPendingSubmit({ kind: 'member' })
        setStep('waiver')
        return
      }
      const waiverAcceptances = waiverGate.acceptances
      const bookSessionFn = httpsCallable<Record<string, unknown>, { bookingReference?: string }>(
        functions,
        'bookSession'
      )
      const res = await bookSessionFn({
        teamId,
        sessionId: selectedSession.id,
        ...(Object.keys(answers).length ? { questionAnswers: answers } : {}),
        ...(referral ? { referralCode: referral } : {}),
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
      })
      setBookingReference(res.data.bookingReference ?? null)
      setConfirmedSession(selectedSession)
      setStep('confirmed')
    } catch (err) {
      // The requirement moved between the step and the call — re-present it.
      // Cheap here in a way it is not on the returning path: nothing has been
      // spent, so the member can simply be shown the consent step and continue.
      if (
        waiverErrorMessage(err, tWaiver) &&
        (await waiverGate.recover(err, { email: contact?.email ?? undefined }))
      ) {
        setPendingSubmit({ kind: 'member' })
        setStep('waiver')
        return
      }
      const e = err as { message?: string }
      setBookingError(waiverErrorMessage(err, tWaiver) || e.message || t('errorGeneric'))
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * Leave the consent step by finishing what it interrupted.
   *
   * It re-enters the SAME function — `onSubmitGuest` or `onVerified` — rather
   * than duplicating either call site. That is the whole reason the step stashes
   * its submit instead of the surface growing a third booking path: two places
   * that build a `bookSession` payload is how one of them ends up without the
   * acceptances.
   */
  async function resumePendingSubmit() {
    const pending = pendingSubmit
    if (!pending) return
    if (pending.kind === 'guest') {
      await onSubmitGuest(pending.values)
      return
    }
    if (pending.kind === 'member') {
      await onSubmitMember()
      return
    }
    setIsSubmitting(true)
    setBookingError(null)
    try {
      await onVerified(pending)
    } catch (err) {
      const e = err as { message?: string }
      setBookingError(e.message || t('errorGeneric'))
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /**
   * Leave the flow for a different URL (Stripe checkout, the appointment picker).
   * As a page this is a normal navigation; in an overlay the panel must close
   * first so it isn't left sitting over the page mid-navigation.
   *
   * Not for "back out of the flow" — that's `backTo` / `chrome.onClose`.
   */
  /**
   * Hand over to the APPOINTMENT funnel for this activity.
   *
   * In an overlay the host swaps the panel's contents in place — bouncing the
   * visitor to a full page mid-flow is jarring when picking an appointment off
   * the activity list is, to them, just the next step. As a page it navigates.
   */
  function goToAppointments(activityId: string) {
    if (chrome.switchToAppointments) {
      chrome.switchToAppointments(activityId)
      return
    }
    router.push(publicHref(slug, 'appointments', { activity: activityId, from }))
  }

  function leaveFlowTo(href: string) {
    if (chrome.kind === 'overlay') chrome.navigate(href)
    else router.push(href as Route)
  }

  /**
   * The way out of a terminal step ("To the website"). A render helper, not a
   * component — it holds no state and must not remount the rest of the footer.
   *
   * As a page it is a real link. In a panel it is a button that CLOSES: the
   * surface it names is the page behind the panel, already loaded — and in the
   * embed it is a frame-denied app page, so following it would replace a
   * confirmed booking with a blank box.
   */
  function exitToSurface() {
    const className =
      'block w-full py-2 text-center text-sm text-muted-foreground transition-colors hover:text-foreground'
    const label = t('toSurface', { name: tSurfaces(backTo.surface) })
    if (chrome.kind === 'overlay')
      return (
        <button type="button" onClick={() => exitFlow(backTo.href)} className={className}>
          {label}
        </button>
      )
    return (
      <Link href={backTo.href} className={className}>
        {label}
      </Link>
    )
  }

  // Where leaving the flow goes. `?from=` names the surface the visitor arrived
  // from; absent/dead → the team's default surface, resolved HERE rather than by
  // bouncing through the team root's client redirect.
  const backTo = useMemo(() => returnHref(team, slug, from), [team, slug, from])

  // ── Step ↔ URL ────────────────────────────────────────────────────────────
  //
  // One effect owns the whole mapping, rather than a push at each transition —
  // there are eight places the step changes, and a push forgotten at any one of
  // them silently breaks Back for that branch only.

  const stepUrl = useStepUrl({
    disabled: disableStepUrl,
    sticky: { from, referral },
    onRestore: (params) => {
      // Terminal guard: after a successful booking — or after joining a queue —
      // Back must NOT re-enter `details`/`waitlist` with a live session, which
      // would let the visitor submit the same thing twice. Leave the flow instead.
      if (confirmedSession || waitlistJoined) {
        router.push(backTo.href)
        return
      }

      // popstate hands back whatever is in the address bar, which the visitor (or
      // a link they were sent) can have edited — parse it like any inbound param.
      const sessionId = parseDocId(params.get('session'))
      const restored = sessionId ? sessions.find((s) => s.id === sessionId) : null
      // Everything is re-derived from the loaded arrays by id — the step state
      // holds whole denormalized objects, which must never go in the URL.
      const activity = restored
        ? (activities.find(
            (a) => a.id === restored.activityId || (!!restored.activitySlug && a.slug === restored.activitySlug)
          ) ?? null)
        : null

      if (restored && activity) {
        const sub = params.get('step')
        setSelectedActivity(activity)
        setSelectedSession(restored)
        setSelectedDate(toDateKey(restored.start))
        entryResolvedRef.current = true
        if (sub === 'details') {
          // guestPath is the one piece that isn't derivable, hence `path=`.
          const path = params.get('path')
          setGuestPath(path === 'trial' || path === 'dropin' ? path : null)
          setStep('details')
        } else if (sub === 'waitlist') {
          // Re-derived, not trusted: the class may have freed a seat since, in
          // which case the queue step no longer applies and the normal funnel
          // does.
          const blocked = sessionBlockReason(restored, bookingSettings?.cutoffMinutes)
          setStep(offersWaitlist(blocked, activity) ? 'waitlist' : nextStepAfterSession(activity, paymentsEnabled, isAuthenticated))
        } else if (sub === 'returning') {
          setStep('returning')
        } else {
          // `step=waiver` lands here DELIBERATELY. The consent step has no state
          // a URL can carry — its ticks and the submit it is standing in front
          // of are in memory — so restoring it from a pasted or forward-
          // navigated link would render a Confirm with nothing behind it. The
          // visitor re-enters the funnel and reaches it again in one step.
          setStep(nextStepAfterSession(activity, paymentsEnabled, isAuthenticated))
        }
        return
      }

      const activityId = parseDocId(params.get('activity'))
      const matched = activityId ? activities.find((a) => a.id === activityId) : null
      if (matched) {
        setSelectedActivity(matched)
        setSelectedSession(null)
        setGuestPath(null)
        const day = parseDateKey(params.get('date'))
        if (day) {
          setSelectedDate(day)
          entryResolvedRef.current = true
        }
        setStep('sessions')
        return
      }

      // Back to the flow's entry step.
      setSelectedSession(null)
      setGuestPath(null)
      if (isDateFirst) {
        setSelectedActivity(null)
        // The day IS the state in date-first — restoring the step without it
        // would silently bounce the visitor back to the first available day.
        const day = parseDateKey(params.get('date'))
        if (day) {
          setSelectedDate(day)
          entryResolvedRef.current = true
        }
        setStep('sessions')
      } else if (preSelectedActivitySlug || activities.length === 1) {
        setStep('sessions')
      } else {
        setSelectedActivity(null)
        setStep('activities')
      }
    },
  })

  // The canonical query for the current step. All steps stay on ONE pathname:
  // pushing `/booking/{activitySlug}` would turn popstate into a real route
  // transition, remounting the wizard and refetching everything.
  const stepQuery: Record<string, string | undefined> =
    step === 'activities'
      ? {}
      : step === 'sessions'
        ? { activity: selectedActivity?.id, date: selectedDate ?? undefined }
        : step === 'confirmed'
          ? { booked: confirmedSession?.id }
          : step === 'waitlisted'
            ? { waitlisted: selectedSession?.id }
            : {
                session: selectedSession?.id,
                step: step === 'who' ? undefined : step,
                path: step === 'details' ? (guestPath ?? undefined) : undefined,
              }

  const syncedQueryRef = useRef<string | null>(null)
  const prevStepRef = useRef<Step | null>(null)
  const seenRestoreRef = useRef(0)
  useEffect(() => {
    if (loadingData) return
    const key = JSON.stringify(stepQuery)
    // This run is a restore's own re-render — the URL is already what popstate
    // gave us. Record the state and write nothing.
    if (stepUrl.restoreCount() !== seenRestoreRef.current) {
      seenRestoreRef.current = stepUrl.restoreCount()
      syncedQueryRef.current = key
      prevStepRef.current = step
      return
    }
    if (syncedQueryRef.current === key) return
    const isFirst = syncedQueryRef.current === null
    const stepChanged = prevStepRef.current !== step
    syncedQueryRef.current = key
    prevStepRef.current = step
    // Push only on a real step transition. Refinements within a step (paging the
    // calendar to another day) rewrite instead, or Back would walk day by day
    // before it ever left the step. The two terminal steps also rewrite — see
    // the guard above.
    if (isFirst || !stepChanged || step === 'confirmed' || step === 'waitlisted')
      stepUrl.replace(stepQuery)
    else stepUrl.push(stepQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedActivity?.id, selectedSession?.id, selectedDate, guestPath, loadingData])

  function backFromSessions() {
    // `isDateFirst` has no activity step in front of it either — the day picker
    // IS the entry step there.
    if (isDateFirst || preSelectedActivitySlug || initialActivityId || activities.length === 1) {
      // No activity step to go back to — leave the flow altogether.
      exitFlow(backTo.href)
    } else {
      setStep('activities')
    }
  }

  /**
   * Return to the slot list. In date-first the activity was inferred from the
   * clicked session, not chosen — so going back must un-pin it, or the visitor
   * lands on a list silently filtered to one activity they never picked.
   */
  function backToSessions() {
    if (isDateFirst) setSelectedActivity(null)
    setStep('sessions')
  }

  function resetToStart() {
    setSelectedSession(null)
    setBookingError(null)
    // Book-another starts a fresh consent resolution: the next class may be a
    // different activity with a different scoped waiver, and carrying the old
    // answer forward would submit a tick for a document that was never shown.
    setPendingSubmit(null)
    waiverGate.reset()
    // Must clear, or the step↔URL restore guard keeps treating the flow as
    // terminal and ejects the visitor on their next Back.
    setConfirmedSession(null)
    setBookingReference(null)
    setWaitlistJoined(null)
    if (isDateFirst) {
      // Book-another returns to the full day list, not to the activity the
      // previous booking happened to be for.
      setSelectedActivity(null)
      setStep('sessions')
    } else if (preSelectedActivitySlug || activities.length === 1) {
      setStep('sessions')
    } else {
      setStep('activities')
    }
  }

  // BackButton now lives in components/booking/BackButton (shared with the
  // appointment picker) — imported above; call sites pass label={t('back')}.

  // ─── Sticky bar: shown on all non-activity, non-confirmed steps ───────────

  const showBar =
    selectedActivity && step !== 'activities' && step !== 'confirmed' && step !== 'waitlisted'

  // Does the signed-in member's Confirm book a seat, or does it hand over to the
  // paid door? Derived once: the bar's button and the step's own copy must
  // never answer this differently.
  const memberCanBookFree = memberAccess?.covered === true

  // WHERE THE TERMS BELONG. Every step that can end in a seat — the guest form,
  // the returning-member sign-in (whose `onVerified` books straight through),
  // the consent interrupt, and the queue join — gets them, and no step that
  // cannot does. Kept as ONE list beside `showConfirm` rather than pasted into
  // each render branch — and deliberately NOT reusing `showConfirm`, which is a
  // different question: it asks which steps submit FROM THE BAR, and 'returning'
  // submits from inside ReturningSignIn instead. Two questions, two lists, both
  // stated where they are read.
  //
  // 'waitlist' is in: joining the queue is how you end up holding a seat you can
  // then no-show, and the claim window is measured in minutes — after the offer
  // email is not a moment to be reading the fee for the first time.
  const showTerms =
    step === 'details' ||
    step === 'returning' ||
    step === 'member' ||
    step === 'waiver' ||
    step === 'waitlist'

  const termsBlock = showTerms ? (
    <BookingTerms
      cancellationPolicy={effectiveCancellationPolicy}
      noShowPolicy={team.noShowPolicy}
      currency={currency}
      locale={locale}
    />
  ) : null

  function withBar(content: React.ReactNode, wide?: boolean) {
    return (
      <FlowShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        wide={wide}
        showBranding={showBranding}
        backTo={backTo}
        overlayTitle={selectedActivity?.name}
        bar={
          showBar && selectedActivity ? (
            <StickyBar
              title={selectedActivity.name}
              imageUrl={selectedActivity.image}
              providerLabel={
                selectedSession?.providerName
                  ? t('withInstructor', { name: selectedSession.providerName })
                  : null
              }
              dateTimeLabel={
                selectedSession
                  ? `${formatDate(selectedSession.start)} · ${formatTime(selectedSession.start)}–${formatTime(selectedSession.end)}`
                  : null
              }
              location={selectedSession?.location ?? null}
              accentColor={accentColor}
              position={chrome.kind === 'overlay' ? 'container' : 'viewport'}
              // The queue step and the consent step submit from the same bar as
              // the booking step — one Confirm control, three verbs, so the
              // visitor never has to hunt for a different button in the same
              // layout.
              showConfirm={
                step === 'details' ||
                step === 'waitlist' ||
                step === 'waiver' ||
                (step === 'member' && memberCanBookFree)
              }
              submitting={isSubmitting}
              // Greyed, not hidden, until every outstanding waiver is satisfied
              // by what the visitor did here — the tick, plus the "who is
              // signing" choice on a waiver flagged for minors.
              confirmDisabled={step === 'waiver' && !waiverGate.ready}
              confirmLabel={step === 'waitlist' ? t('waitlistJoinCta') : t('ctaConfirm')}
              submittingLabel={step === 'waitlist' ? t('waitlistCtaJoining') : t('ctaBooking')}
              onConfirm={() =>
                step === 'waiver'
                  ? // Re-enters the SAME submit the step interrupted. `ensure()`
                    // is cleared by the local ticks on this second pass, so the
                    // rail is called with the acceptances attached.
                    resumePendingSubmit()
                  : step === 'member'
                    ? // Same reason as the queue join below: nothing to collect,
                      // because the token names the person.
                      onSubmitMember()
                    : step === 'waitlist' && isAuthenticated
                      ? // A signed-in contact has no form to submit — their identity
                        // comes from the session token the callable verifies.
                        onJoinWaitlist(null)
                      : guestFormRef.current?.submit()
              }
            />
          ) : null
        }
      >
        {content}
        {termsBlock}
      </FlowShell>
    )
  }

  // Rendered on BOTH the activities and sessions steps: a link whose session is
  // gone degrades all the way to the picker, and landing there unexplained is
  // exactly the "blank picker" failure this contract exists to prevent.
  const deepLinkBanner = deepLinkNotice ? (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      <p className="flex-1">{t(`deepLinkNotice.${deepLinkNotice}`)}</p>
      <button
        type="button"
        onClick={() => setDeepLinkNotice(null)}
        aria-label={t('dismiss')}
        className="shrink-0 font-semibold transition-opacity hover:opacity-70"
      >
        ×
      </button>
    </div>
  ) : null

  // Per-activity book-form questions. Rendered ABOVE the identity form on both
  // the booking and the queue step, so the sticky Confirm still submits last —
  // the questions are about the booking, the fields below are about the person.
  // Shared because the queue captures them at JOIN: the promoter copies them
  // onto the claim hold, and the claim never asks again.
  const bookingQuestionsBlock =
    bookingQuestions.length > 0 ? (
      <div className="space-y-4 rounded-xl border bg-card p-4">
        {bookingQuestions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            {/* A checkbox renders its own inline label. */}
            {q.type !== 'checkbox' && (
              <label className="text-sm font-medium">
                {q.label}
                {q.required && <span className="ml-0.5 text-destructive">*</span>}
              </label>
            )}
            <FieldInput
              field={q}
              value={answers[q.id]}
              disabled={isSubmitting}
              onChange={(v) => {
                setAnswers((prev) => ({ ...prev, [q.id]: v }))
                setAnswersError(null)
              }}
            />
          </div>
        ))}
        {answersError && <p className="text-sm text-destructive">{answersError}</p>}
      </div>
    ) : null

  // ─── Loading ──────────────────────────────────────────────────────────────

  if (loadingData) {
    return (
      <FlowShell teamName={teamName} slug={slug} accentColor={null} showBranding={showBranding}>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      </FlowShell>
    )
  }

  // ─── Step: Activity selection ─────────────────────────────────────────────

  if (step === 'activities') {
    return (
      <FlowShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
        backTo={backTo}
      >
        <div>
          <h1 className="text-2xl font-bold">{t('titleBookSession')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('chooseActivitySubtitle')}</p>
        </div>

        {deepLinkBanner}

        {activities.length === 0 && (
          <div className="rounded-xl border bg-muted/30 p-8 text-center">
            <p className="text-muted-foreground text-sm">{t('noActivitiesAvailable')}</p>
          </div>
        )}

        <div className="space-y-3">
          {activities.map((a) => {
            // Appointment activities book through their own flow (per-coach slot
            // picker on /appointments) — the card stays enabled and hands over.
            const isAppointment = a.activityType === 'appointment'
            const hasSessions =
              isAppointment ||
              sessions.some((s) => s.activityId === a.id || s.activitySlug === a.slug)
            const bg = a.image
              ? `url("${a.image}")`
              : a.color
                ? `linear-gradient(135deg, ${a.color}cc, ${a.color}88)`
                : activityGradient(a.name)
            return (
              <button
                key={a.id}
                onClick={() => {
                  if (!hasSessions) return
                  if (isAppointment) {
                    goToAppointments(a.id)
                    return
                  }
                  setSelectedActivity(a)
                  setStep('sessions')
                }}
                disabled={!hasSessions}
                className="w-full text-left rounded-xl border bg-card hover:border-primary hover:bg-primary/5 transition-colors flex items-stretch overflow-hidden min-h-24 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {/* Thumbnail — square (1:1) for typical items via w-24 + item min-h-24 */}
                <div
                  className="w-24 shrink-0 bg-muted"
                  style={{
                    background: bg,
                    backgroundSize: a.image ? 'cover' : '100% 100%',
                    backgroundPosition: 'center',
                  }}
                />
                {/* Content */}
                <div className="flex-1 p-4 min-w-0">
                  {(() => {
                    // Structured commercial display (locked with the user): the ONLY
                    // things shown are two chips — Free trial + the type (Class /
                    // Appointment) — and NAMED pricing lines: "Included with {sub} —
                    // {price}" per granting subscription, "Discount with {sub} — {%}"
                    // per appointment-discount subscription, the drop-in price, and
                    // an appointment's direct price. No generic "Subscription
                    // required" gate badge and no generic "Included": where a plan
                    // is the key it is named, with its price. The 'members' tier
                    // below is the one line with no plan in it — because none is
                    // required there.
                    const d = resolveActivityPricingDisplay({ ...a, type: a.activityType }, subLookup)
                    const lines: string[] = []
                    // 'members' tier — the DEFAULT for every new class — used to
                    // render NO access line at all. It gets one now, and it names
                    // the gate that is actually enforced: being signed up with
                    // this studio, which costs nothing. No plan, no price: the
                    // true answer to "what am I supposed to buy?" here is
                    // nothing, and a subscription price would send this visitor
                    // to the shop for something they don't need to book.
                    if (d.signedUpOnly) lines.push(t('signedUpOnlyLine'))
                    // 'subscription' tier whose plans this surface cannot name
                    // (not public, or the rule lists none). Naming nothing is
                    // what made the card look OPEN — the gate gets its own
                    // sentence, distinct from the free 'members' one above.
                    if (d.planRequired) lines.push(t('planRequiredLine'))
                    for (const s of d.includedWith)
                      lines.push(
                        s.priceLabel
                          ? t('includedWithSubPriced', { name: s.name, price: s.priceLabel })
                          : t('includedWithSub', { name: s.name })
                      )
                    for (const s of d.discountWith)
                      lines.push(t('discountWithSub', { name: s.name, percent: s.percent }))
                    // Priced doors are advertised only when one of them could
                    // actually be walked through (UX-33). The membership lines
                    // above stay: "included with X" states how access works,
                    // it is not a checkout this page can open.
                    if (d.dropInAmount != null && paymentsEnabled)
                      lines.push(t('badgeDropInPrice', { price: formatCurrency(d.dropInAmount, currency, locale) }))
                    if (d.appointmentPrice && paymentsEnabled)
                      lines.push(
                        d.appointmentPrice.min === d.appointmentPrice.max
                          ? t('badgeFromPrice', { price: formatCurrency(d.appointmentPrice.min, currency, locale) })
                          : t('badgePriceRange', {
                              min: formatCurrency(d.appointmentPrice.min, currency, locale),
                              max: formatCurrency(d.appointmentPrice.max, currency, locale),
                            })
                      )
                    return (
                      <>
                        <div className="flex items-start gap-1.5 flex-wrap">
                          <p className="font-semibold text-sm leading-tight">{a.name}</p>
                          {/* Type chip — Class or Appointment (always present) */}
                          <span className="rounded-full bg-muted text-muted-foreground text-xs px-2 py-0.5 font-medium">
                            {d.type === 'appointment' ? t('badgeAppointment') : t('chipClass')}
                          </span>
                          {/* Trial — free (the one positive/free signal) or priced */}
                          {d.trial && (
                            <span className="rounded-full bg-green-100 text-green-700 text-xs px-2 py-0.5 font-medium">
                              {d.trial.priceAmount != null
                                ? t('badgeTrialPriced', {
                                    price: formatCurrency(d.trial.priceAmount, currency, locale),
                                  })
                                : t('badgeFreeTrial')}
                            </span>
                          )}
                          {!hasSessions && (
                            <span className="rounded-full bg-muted text-muted-foreground text-xs px-2 py-0.5">
                              {t('badgeNoOpenSessions')}
                            </span>
                          )}
                          {/* The studio's own words about the class ("Beginner
                              friendly", "Gi") — LAST in the row, after every
                              chip that says something about booking it. */}
                          {a.tags?.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-muted text-muted-foreground text-xs px-2 py-0.5"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                        {showDesc && a.description && (
                          <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
                            {a.description}
                          </p>
                        )}
                        {a.prerequisites && (
                          <p className="text-xs text-amber-700 mt-1.5">
                            <span className="font-medium">{t('prerequisitesLabel')}</span>{' '}
                            {a.prerequisites}
                          </p>
                        )}
                        {/* Pricing last, set apart from the prose above it: each way
                            to pay is its own row with a hairline between, so a card
                            offering three of them reads as a list rather than a
                            paragraph of prices. */}
                        {lines.length > 0 && (
                          <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
                            {lines.map((line, i) => (
                              <p key={i} className="py-1.5 text-xs text-muted-foreground">
                                {line}
                              </p>
                            ))}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
                {hasSessions && (
                  <div className="flex items-center pr-4 text-muted-foreground">
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </FlowShell>
    )
  }

  // ─── Step: Session selection (calendar + time slots) ─────────────────────

  if (step === 'sessions') {
    return withBar(
      <>
        <div>
          <BackButton label={t('back')} onClick={backFromSessions} />
          <h1 className="text-2xl font-bold">
            {selectedActivity ? selectedActivity.name : t('titleSessionsFallback')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('pickDateTimeSubtitle')}</p>
        </div>

        {deepLinkBanner}

        {selectedActivity?.prerequisites && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">{t('prerequisitesLabel')}</span>{' '}
            {selectedActivity.prerequisites}
          </div>
        )}

        {selectedActivity?.meetingPoint && (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{t('meetingPointLabel')}</span>{' '}
            {selectedActivity.meetingPoint}
          </p>
        )}

        {/* The browse-time disclosure. It keeps the policy for the visitor who
            wants it EARLY; it is no longer the only place they can read it,
            which is what made a collapsed `<details>` on a step before the
            button the wrong home for a term of sale. It resolves nothing of its
            own any more — one fallback order, computed once above. */}
        {(() => {
          const hasDetail =
            selectedActivity &&
            (selectedActivity.whatsIncluded ||
              selectedActivity.whatsNotIncluded ||
              selectedActivity.faq ||
              effectiveCancellationPolicy)
          if (!hasDetail) return null
          return (
            <details className="rounded-xl border bg-card">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
                {t('activityDetailToggle')}
              </summary>
              <div className="space-y-3 border-t px-4 py-3 text-sm text-muted-foreground">
                {selectedActivity!.whatsIncluded && (
                  <div>
                    <p className="font-medium text-foreground">{t('whatsIncludedLabel')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {selectedActivity!.whatsIncluded
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((line, i) => <li key={i}>{line}</li>)}
                    </ul>
                  </div>
                )}
                {selectedActivity!.whatsNotIncluded && (
                  <div>
                    <p className="font-medium text-foreground">{t('whatsNotIncludedLabel')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {selectedActivity!.whatsNotIncluded
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((line, i) => <li key={i}>{line}</li>)}
                    </ul>
                  </div>
                )}
                {selectedActivity!.faq && (
                  <div>
                    <p className="font-medium text-foreground">{t('faqLabel')}</p>
                    <p className="mt-1 whitespace-pre-line">{selectedActivity!.faq}</p>
                  </div>
                )}
                {effectiveCancellationPolicy && (
                  <div>
                    <p className="font-medium text-foreground">{t('cancellationPolicyLabel')}</p>
                    <p className="mt-1 whitespace-pre-line">{effectiveCancellationPolicy}</p>
                  </div>
                )}
              </div>
            </details>
          )
        })()}

        {availableDates.length === 0 ? (
          <div className="rounded-xl border bg-muted/30 p-8 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noSessionsAvailable')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8 items-start">
            {/* Calendar */}
            <div className="bg-card border rounded-xl p-4">
              <MiniCalendar
                availableDates={availableDates}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
                maxDateKey={maxDateKey}
              />
            </div>

            {/* Time slots */}
            <div>
              {selectedDate && (
                <p className="text-sm font-medium mb-3 text-muted-foreground">
                  {formatDateFull(dateKeyToDate(selectedDate))}
                </p>
              )}

              {filteredSessions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">{t('noSessionsOnDate')}</p>
              ) : (
                <div className="space-y-2">
                  {filteredSessions.map((s) => {
                    // A full slot is still rendered (only 'closed' is filtered
                    // out) — it is either the queue's front door or, without
                    // one, an honest "no seats" row. What it must never be
                    // again is a clickable row that dead-ends on a server throw.
                    const rowActivity = selectedActivity ?? findActivityForSession(s)
                    const blocked = sessionBlockReason(s, cutoffMinutes)
                    const waitlistable = offersWaitlist(blocked, rowActivity)
                    const isFull = blocked === 'full'
                    return (
                    <button
                      key={s.id}
                      disabled={isFull && !waitlistable}
                      onClick={() => {
                        // Date-first browses with no activity pinned, so the
                        // clicked session is what names it. Everything
                        // downstream (access gate, pricing, sticky bar) reads
                        // `selectedActivity`, so resolve it here rather than
                        // letting those fall back to null.
                        const activity = rowActivity
                        if (!selectedActivity && activity) setSelectedActivity(activity)
                        setSelectedSession(s)
                        setGuestPath(null)
                        setGiftCardApplied(null)
                        // A code is quoted against ONE purchase (the reservation
                        // key embeds the session), so picking a different class
                        // must not carry the previous quote across.
                        setPromoApplied(null)
                        setDeepLinkNotice(null)
                        setBookingError(null)
                        setStep(waitlistable ? 'waitlist' : nextStepAfterSession(activity, paymentsEnabled, isAuthenticated))
                      }}
                      className="w-full text-left rounded-xl border bg-card p-3.5 hover:border-primary hover:bg-primary/5 transition-colors flex items-stretch gap-3 group disabled:pointer-events-none disabled:opacity-60"
                    >
                      <div
                        className="w-1 rounded-full shrink-0"
                        style={{ background: s.activityColor || 'var(--primary)' }}
                      />
                      <div className="flex-1 min-w-0">
                        {!selectedActivity && s.activityName && (
                          <p className="text-xs font-medium text-muted-foreground mb-0.5">
                            {s.activityName}
                          </p>
                        )}
                        <p className="font-semibold text-sm">
                          {formatTime(s.start)} – {formatTime(s.end)}
                        </p>
                        {s.headline && (
                          <p className="text-xs text-amber-700 mt-0.5">{s.headline}</p>
                        )}
                        <div className="flex flex-wrap gap-x-3 mt-0.5">
                          {s.providerName && (
                            <p className="text-xs text-muted-foreground">{s.providerName}</p>
                          )}
                          {s.location && (
                            <p className="text-xs text-muted-foreground">{s.location}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isFull && (
                          <span className="text-xs rounded-full px-2 py-0.5 bg-muted text-muted-foreground font-medium">
                            {t('waitlistBadgeFull')}
                          </span>
                        )}
                        {waitlistable && (
                          <span className="text-xs rounded-full px-2 py-0.5 bg-amber-100 text-amber-800 font-medium">
                            {t('waitlistJoinCta')}
                          </span>
                        )}
                        {s.bookingMandatory && !isFull && (
                          <span className="text-xs rounded-full px-2 py-0.5 bg-primary/10 text-primary font-medium">
                            {t('bookingRequired')}
                          </span>
                        )}
                        <span className="text-xs bg-muted rounded-full px-2 py-0.5 text-muted-foreground">
                          {sessionDuration(s.start, s.end, t)}
                        </span>
                        <svg
                          className="h-4 w-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </>,
      true // wide layout
    )
  }

  // ─── Step: Who? ───────────────────────────────────────────────────────────

  if (step === 'who' && selectedSession) {
    const isMembersOnly = selectedActivity?.isFreeTrial === false
    const trialPriceLabel =
      typeof selectedActivity?.trialPriceAmount === 'number'
        ? formatCurrency(selectedActivity.trialPriceAmount, currency, locale)
        : null
    return withBar(
      <>
        <div>
          <BackButton label={t('back')} onClick={backToSessions} />
          <h1 className="text-2xl font-bold">{t('titleWhosBooking')}</h1>
        </div>

        <div className="space-y-3">
          {(!isMembersOnly || trialAvailable) && (
            <button
              onClick={() => { setGuestPath('trial'); setStep('details') }}
              className="w-full text-left rounded-xl border bg-card p-4 hover:border-primary hover:bg-primary/5 transition-colors group flex items-center gap-3"
            >
              <div className="flex-1">
                <p className="font-semibold text-sm">{t('firstTimeTitle')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {trialPriceLabel
                    ? t('firstTimeSubtitlePriced', { price: trialPriceLabel })
                    : t('firstTimeSubtitle')}
                </p>
              </div>
              <svg
                className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          {isMembersOnly && dropInAvailable && (
            <button
              onClick={() => { setGuestPath('dropin'); setStep('details') }}
              className="w-full text-left rounded-xl border bg-card p-4 hover:border-primary hover:bg-primary/5 transition-colors group flex items-center gap-3"
            >
              <div className="flex-1">
                <p className="font-semibold text-sm">{t('dropInTitle')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {dropInMemberPrice ? (
                    <>
                      <span className="mr-1.5 line-through">
                        {formatCurrency(dropInMemberPrice.base, currency, locale)}
                      </span>
                      {t('dropInSubtitleMember', {
                        price: formatCurrency(dropInMemberPrice.amount, currency, locale),
                      })}
                    </>
                  ) : (
                    t('dropInSubtitle', { price: formatCurrency(selectedDropInPrice ?? 0, currency, locale) })
                  )}
                </p>
              </div>
              <svg
                className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setStep('returning')}
            className="w-full text-left rounded-xl border bg-card p-4 hover:border-primary hover:bg-primary/5 transition-colors group flex items-center gap-3"
          >
            <div className="flex-1">
              <p className="font-semibold text-sm">{t('returningTitle')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('returningSubtitle')}
              </p>
            </div>
            <svg
              className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </>
    )
  }

  // ─── Step: Member — a signed-in contact, confirming ──────────────────────
  //
  // One screen, three outcomes, and the copy names which one this is rather
  // than leaving the member to work it out from whether a button is there:
  //   covered            → Confirm, from the sticky bar, books the seat free
  //   not covered + door → hands over to 'details', which owns the paid path
  //   not covered, no door → the refusal, in words, with the way in named
  //
  // "Book for someone else" is not decoration. `bookSession`'s OTP path exists
  // precisely so a parent can book for a child on their own signed-in device,
  // and routing every signed-in visitor past 'who' would have quietly removed
  // that.

  if (step === 'member' && selectedSession && contact) {
    const covered = memberCanBookFree
    const payable = !covered && dropInAvailable
    const someoneElseStep: Step =
      selectedActivity?.isFreeTrial === false && !dropInAvailable && !trialAvailable
        ? 'returning'
        : 'who'

    return withBar(
      <>
        <div>
          <BackButton label={t('back')} onClick={backToSessions} />
          <h1 className="text-2xl font-bold">{t('memberTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('memberSubtitle', { name: contact.firstname || contact.email || '' })}
          </p>
        </div>

        <div className="rounded-xl border bg-card p-4 space-y-1">
          <p className="text-sm font-medium">
            {contact.firstname} {contact.lastname}
          </p>
          <p className="text-sm text-muted-foreground">
            {covered
              ? t('memberCovered')
              : payable
                ? t('memberPayable', {
                    price: formatCurrency(
                      dropInQuote?.pay.amount ?? selectedDropInPrice ?? 0,
                      currency,
                      locale
                    ),
                  })
                : t('errorNoSubscriptionForActivity')}
          </p>
        </div>

        {covered && bookingQuestionsBlock}

        {payable && (
          <button
            onClick={() => {
              setGuestPath('dropin')
              setStep('details')
            }}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            style={accentColor ? { backgroundColor: accentColor } : undefined}
          >
            {t('memberContinueToPayment')}
          </button>
        )}

        {bookingError && <p className="text-sm text-destructive">{bookingError}</p>}
        {answersError && <p className="text-sm text-destructive">{answersError}</p>}

        <button
          onClick={() => setStep(someoneElseStep)}
          className="w-full rounded-xl border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-primary hover:bg-primary/5"
        >
          <span className="font-semibold">{t('memberSomeoneElseTitle')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('memberSomeoneElseSubtitle')}
          </span>
        </button>
      </>
    )
  }

  // ─── Step: Returning — email → code → (optional) contact select ──────────
  // ReturningSignIn owns all three internal steps; class-specific post-verify
  // logic (subscription coverage check, then bookSession) lives in onVerified
  // above.

  if (step === 'returning' && selectedSession) {
    const isMembersOnly = selectedActivity?.isFreeTrial === false
    // Back goes to wherever the visitor came from: gated classes with a guest
    // door (drop-in or trial) DID pass through the 'who' chooser.
    const hadWhoStep = !isMembersOnly || dropInAvailable || trialAvailable

    // A members-only class with no guest door sends a NEWCOMER straight here.
    // "Welcome back" is the wrong thing to tell them: it names no reason, offers
    // no way in, and reads as a dead end to exactly the lead we want to convert.
    // Explain the gate, name what actually unlocks it, and open that door.
    // `isMembersOnly` covers BOTH gated tiers (isFreeTrial is false for either),
    // and the two need OPPOSITE doors — which is the whole point of splitting on
    // `signedUpOnly` here:
    //  · 'members'      → the gate is being SIGNED UP, which is free. Point at
    //                     the signup surface. Naming a plan (let alone a price)
    //                     would sell this visitor something they don't need.
    //  · 'subscription' → the named plans ARE the key. Point at the shop, with
    //                     prices. Unchanged.
    const gatedDisplay = isMembersOnly
      ? resolveActivityPricingDisplay(
          { ...selectedActivity, type: selectedActivity?.activityType },
          subLookup
        )
      : null
    const signedUpOnly = gatedDisplay?.signedUpOnly === true
    // Empty for a 'members' class by construction (see ActivityPricingDisplay).
    const gatedPlans = gatedDisplay?.includedWith ?? []
    // One plan → deep-link it; several → the subscriptions tab.
    const shopHref = publicHrefLocalized(
      locale,
      slug,
      'shop',
      gatedPlans.length === 1
        ? { type: gatedPlans[0].id, from: 'booking' }
        : { tab: 'subscriptions', from: 'booking' }
    )
    const signupHref = publicHrefLocalized(locale, slug, 'signup', { from: 'booking' })

    const accessIntro = signedUpOnly ? (
      <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">{t('accessSignUpBody')}</p>
        {/* New tab, same reason as the shop link below: signing up is a detour,
            and losing the class they'd already picked loses the booking. */}
        <a
          href={signupHref}
          target="_blank"
          rel="noopener noreferrer"
          style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t('accessSignUpCta')}
          <ArrowUpRight className="h-4 w-4" />
        </a>
      </div>
    ) : isMembersOnly ? (
      <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
        {gatedPlans.length > 0 && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('accessIncludedWith')}
            </p>
            <ul className="mt-2 space-y-1.5">
              {gatedPlans.map((plan) => (
                <li key={plan.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{plan.name}</span>
                  {plan.priceLabel && (
                    <span className="shrink-0 text-muted-foreground">{plan.priceLabel}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* New tab on purpose: buying is a detour, and losing the class they'd
            already picked is the fastest way to lose the booking. */}
        <a
          href={shopHref}
          target="_blank"
          rel="noopener noreferrer"
          style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t('accessSeeSubscriptions')}
          <ArrowUpRight className="h-4 w-4" />
        </a>
      </div>
    ) : null

    return withBar(
      <ReturningSignIn
        teamId={teamId}
        onVerified={onVerified}
        onBack={() => (hadWhoStep ? setStep('who') : backToSessions())}
        accentColor={accentColor}
        noAccountMessage={
          // "Contact your coach to join" is a dead end on the 'members' tier —
          // this visitor can join themselves, for free, from the button above.
          signedUpOnly
            ? t('errorNoAccountSignUp')
            : isMembersOnly
              ? t('errorNoAccountMembersOnly')
              : t('errorNoAccountGeneral')
        }
        title={isMembersOnly ? t('accessTitle') : undefined}
        subtitle={
          signedUpOnly
            ? t('accessSubtitleSignUp', { activity: selectedActivity?.name ?? '' })
            : isMembersOnly
              ? t('accessSubtitle', { activity: selectedActivity?.name ?? '' })
              : undefined
        }
        intro={accessIntro}
      />
    )
  }

  // ─── Step: Consent ────────────────────────────────────────────────────────
  // Reached from BOTH terminal submits and rendered identically for each, which
  // is the point: the guest path and the returning-member path collect the same
  // signature under the same wording, and the record cannot depend on which door
  // somebody came through.
  //
  // NON-TERMINAL: Back is safe. The submit it interrupted is held in memory, so
  // going back and returning re-enters it — and booking a second class from the
  // same mounted flow reuses the same `intentId`, which the ledger collapses to
  // one row rather than aborting the commit.
  if (step === 'waiver' && selectedSession) {
    return withBar(
      <>
        <BackButton
          label={t('back')}
          onClick={() => {
            waiverGate.dismiss()
            setStep(pendingSubmit?.kind === 'returning' ? 'returning' : 'details')
          }}
        />
        <WaiverStep gate={waiverGate} teamName={teamName} disabled={isSubmitting} />
        {bookingError && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {bookingError}
          </div>
        )}
      </>
    )
  }

  // ─── Step: New guest — contact details ───────────────────────────────────

  if (step === 'details' && selectedSession) {
    return withBar(
      <>
        <div>
          <BackButton label={t('back')} onClick={() => setStep('who')} />
          <h1 className="text-2xl font-bold">{t('yourDetailsTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('detailsSubtitle')}
          </p>
        </div>

        {/* Promo code — the MODIFIER, above the tender in the UI as in the
            arithmetic.

            The gate is `willCharge && !isPricedTrial`, not bare `willCharge`:
            `willCharge` is true on the PRICED-TRIAL door, which is the one door
            a promo can never apply to (a paid trial is already an acquisition
            price, enforced once per person). Rendering the field there would
            show it to the one visitor it is guaranteed to fail — a newcomer on
            the acquisition surface, told "this code does not apply" while the
            same person taking the dearer drop-in door gets the discount. */}
        {willCharge && !isPricedTrial && selectedSession && (
          <PromoCodeField
            teamId={teamId}
            target={{ kind: 'drop_in', sessionId: selectedSession.id }}
            applied={promoApplied}
            onApplied={setPromoApplied}
            outcome={dropInQuote?.promo ?? null}
            disabled={isSubmitting}
          />
        )}

        {/* Gift card redemption — only meaningful on a paying booking (drop-in
            or priced trial); a free trial/booking has nothing to redeem against. */}
        {willCharge && (
          <GiftCardRedeemField
            teamId={teamId}
            locale={locale}
            applied={giftCardApplied}
            onApplied={setGiftCardApplied}
            disabled={isSubmitting}
          />
        )}

        {/* Live price breakdown — display only; createDropInCheckout /
            bookSession re-resolve the charge authoritatively server-side. */}
        {willCharge && (() => {
          // Once the server has refused our quote and told us the real figure,
          // IT is the breakdown — every discount row we were rendering is a
          // promise the server just declined to keep, and leaving them up over a
          // higher total is the exact overcharge-by-display the guard refuses.
          const overridden = acceptedPrice !== null
          const basePrice = overridden
            ? (acceptedPrice as number)
            : isPricedTrial
              ? (selectedActivity?.trialPriceAmount ?? 0)
              : (selectedDropInPrice ?? 0)
          // BOTH discount rows come from the ONE result above, and the resolver
          // stamps at most one of appliedBenefit / appliedPromo — so they are
          // mutually exclusive structurally, not by convention.
          const pay = isPricedTrial || overridden ? null : dropInQuote?.pay
          const memberDiscount = pay?.appliedBenefit
            ? pay.appliedBenefit.baseAmount - pay.amount
            : 0
          const promoLine = pay?.appliedPromo
            ? { code: pay.appliedPromo.code, discount: pay.appliedPromo.baseAmount - pay.amount }
            : null
          // The subtotal the TENDER draws against — the resolver's own number,
          // never a second subtraction.
          const afterBenefit = pay ? pay.amount : Math.max(0, basePrice)
          // THE server's own split (planGiftCardRedemption, @linyup/shared) —
          // never Math.min(balance, total). A card that can't full-cover has
          // its drawdown SHRUNK so the Stripe residual clears the 0.50 floor,
          // so a 19.80 card against a 20.00 class draws 19.50 and charges 0.50.
          // Showing the balance as the deduction promised "−19.80 / total 0.20"
          // and then sent the customer to a Stripe page saying 0.50.
          const giftLine = (() => {
            if (!giftCardApplied) return null
            const plan = planGiftCardRedemption(giftCardApplied.balance, afterBenefit)
            // null = the card contributes nothing usable here; drop the gift
            // lines entirely rather than showing a −0.00 that never applies.
            if (!plan) return null
            return {
              code: giftCardApplied.code,
              currency: giftCardApplied.currency,
              drawdown: plan.drawdown,
              residual: plan.residual,
              remaining: Math.max(0, giftCardApplied.balance - plan.drawdown),
            }
          })()
          const total = giftLine ? giftLine.residual : afterBenefit
          return (
            <div className="rounded-xl border bg-muted/30 p-4 space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('priceSubtotal')}</span>
                <span>{formatCurrency(basePrice, currency, locale)}</span>
              </div>
              {memberDiscount > 0 && (
                <div className="flex items-center justify-between text-green-700">
                  <span>{t('priceMemberDiscount')}</span>
                  <span>−{formatCurrency(memberDiscount, currency, locale)}</span>
                </div>
              )}
              {promoLine && promoLine.discount > 0 && (
                <div className="flex items-center justify-between text-green-700">
                  <span className="min-w-0 truncate">
                    {tPromo('discountRow', { code: promoLine.code })}
                  </span>
                  <span>−{formatCurrency(promoLine.discount, currency, locale)}</span>
                </div>
              )}
              {/* The tender applies to what's left AFTER the discounts — show
                  the figure it draws against whenever a discount moved it. */}
              {(memberDiscount > 0 || (promoLine?.discount ?? 0) > 0) && (
                <div className="flex items-center justify-between border-t pt-1.5">
                  <span className="text-muted-foreground">{t('priceAfterDiscounts')}</span>
                  <span>{formatCurrency(afterBenefit, currency, locale)}</span>
                </div>
              )}
              {giftLine && (
                <div className="flex items-center justify-between text-green-700">
                  <span className="min-w-0 truncate">
                    {t('priceGiftCard')}{' '}
                    <span className="text-muted-foreground">{giftLine.code}</span>
                  </span>
                  <span>−{formatCurrency(giftLine.drawdown, currency, locale)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t pt-1.5 font-semibold">
                <span>{t('priceTotal')}</span>
                <span>{formatCurrency(total, currency, locale)}</span>
              </div>
              {giftLine && giftLine.remaining > 0 && (
                <div className="flex items-center justify-between text-muted-foreground text-xs">
                  <span>{t('priceGiftCardRemaining')}</span>
                  <span>{formatCurrency(giftLine.remaining, giftLine.currency, locale)}</span>
                </div>
              )}
            </div>
          )
        })()}

        {bookingQuestionsBlock}

        <GuestDetailsForm
          ref={guestFormRef}
          showPhone={showPhone}
          contactFields={contactFields}
          customFieldDefinitions={team.publicCustomFields}
          showAggregatorField={showFitnessApp}
          aggregatorApps={partnerApps}
          submitting={isSubmitting}
          error={bookingError}
          onSubmit={onSubmitGuest}
        />

        <p className="text-xs text-muted-foreground">
          {t('consentText')}
        </p>
      </>
    )
  }

  // ─── Step: Waitlist — take a place in the queue ───────────────────────────

  if (step === 'waitlist' && selectedSession) {
    return withBar(
      <>
        <div>
          <BackButton label={t('back')} onClick={backToSessions} />
          <h1 className="text-2xl font-bold">{t('waitlistJoinTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('waitlistJoinSubtitle')}</p>
        </div>

        <div className="rounded-xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground space-y-1">
          <p>{t('waitlistHowItWorks')}</p>
          {/* The queue's SIZE, which is all the public mirror carries — an
              aggregate, never a name. It sets the expectation before someone
              joins, which is the honest thing to do at the back of a long line. */}
          {(selectedSession.waitlist_count ?? 0) > 0 && (
            <p className="font-medium text-foreground">
              {t('waitlistQueueLength', { count: selectedSession.waitlist_count ?? 0 })}
            </p>
          )}
        </div>

        {/* A WARNING, never a gate. Joining a queue settles nothing about access
            or money: a prospective member's subscription may well start before
            the class runs, and the claim is where coverage is actually
            resolved. Refusing here would turn away the person the studio most
            wants to keep. */}
        {selectedActivity?.isFreeTrial === false && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">{t('badgeMembersOnly')}</span>{' '}
            {t('waitlistAccessWarning')}
          </div>
        )}

        {bookingQuestionsBlock}

        {isAuthenticated && contact ? (
          // Signed in: nothing to collect. `joinWaitlist` reads the caller from
          // the contact-session token and ignores any body details, so a form
          // here would be a lie about what is being sent.
          <div className="rounded-xl border bg-card p-4 space-y-2">
            <p className="text-sm font-medium">
              {contact.firstname} {contact.lastname}
            </p>
            {bookingError && <p className="text-sm text-destructive">{bookingError}</p>}
          </div>
        ) : (
          <GuestDetailsForm
            ref={guestFormRef}
            showPhone={showPhone}
            // No `contactFields` here on purpose: `joinWaitlist` stores none of
            // them, and a form that asks for a date of birth and then discards
            // it is worse than one that never asked. Joining a queue is not
            // booking — the fields are collected on the claim, which goes
            // through createDropInCheckout or bookSession like any other.
            submitting={isSubmitting}
            error={bookingError}
            onSubmit={onJoinWaitlist}
          />
        )}

        <p className="text-xs text-muted-foreground">{t('consentText')}</p>
      </>
    )
  }

  // ─── Step: Waitlisted — terminal, like 'confirmed' ───────────────────────

  if (step === 'waitlisted' && selectedSession && waitlistJoined) {
    return (
      <FlowShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
        backTo={backTo}
        overlayTitle={selectedSession.activityName ?? undefined}
      >
        <div className="py-6 space-y-6">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <span className="text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {waitlistJoined.position}
              </span>
            </div>
            <div>
              <h1 className="text-2xl font-bold">{t('waitlistJoinedTitle')}</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('waitlistPosition', { position: waitlistJoined.position })}
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              {selectedSession.activityColor && (
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: selectedSession.activityColor }}
                />
              )}
              <span className="font-semibold">
                {selectedSession.activityName || t('sessionFallback')}
              </span>
            </div>
            <div className="text-sm space-y-1.5 text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{t('labelDate')}</span>
                {formatDate(selectedSession.start)}
              </p>
              <p>
                <span className="font-medium text-foreground">{t('labelTime')}</span>
                {formatTime(selectedSession.start)} – {formatTime(selectedSession.end)}
              </p>
              {selectedSession.location && (
                <p>
                  <span className="font-medium text-foreground">{t('labelLocation')}</span>
                  {selectedSession.location}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            {/* The long-lived entry token — the "check my place / leave the
                queue" credential. Deliberately NOT the claim token: this link
                is also in the join-confirmation mail, and a forwarded mail must
                never hand somebody else the seat. */}
            <Link
              href={publicHref(slug, 'waitlist', { token: waitlistJoined.entryToken })}
              className="block w-full py-2 text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('waitlistLeaveLink')}
            </Link>
            <button
              onClick={resetToStart}
              className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              {t('bookAnotherSession')}
            </button>
            {exitToSurface()}
          </div>
        </div>
      </FlowShell>
    )
  }

  // ─── Step: Confirmed ──────────────────────────────────────────────────────

  if (step === 'confirmed' && confirmedSession) {
    const ctaUrl = bookingSettings?.ctaUrl
    const ctaLabel = bookingSettings?.ctaLabel ?? t('ctaContactUsDefault')

    return (
      <FlowShell
        teamName={teamName}
        slug={slug}
        accentColor={accentColor}
        showBranding={showBranding}
        backTo={backTo}
        overlayTitle={confirmedSession.activityName ?? undefined}
      >
        <div className="py-6 space-y-6">
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-green-600 dark:text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold">{t('bookingConfirmedTitle')}</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('bookingConfirmedSubtitle')}
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              {confirmedSession.activityColor && (
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: confirmedSession.activityColor }}
                />
              )}
              <span className="font-semibold">{confirmedSession.activityName || t('sessionFallback')}</span>
            </div>
            <div className="text-sm space-y-1.5 text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{t('labelDate')}</span>
                {formatDate(confirmedSession.start)}
              </p>
              <p>
                <span className="font-medium text-foreground">{t('labelTime')}</span>
                {formatTime(confirmedSession.start)} – {formatTime(confirmedSession.end)}
              </p>
              {confirmedSession.providerName && (
                <p>
                  <span className="font-medium text-foreground">{t('labelInstructor')}</span>
                  {confirmedSession.providerName}
                </p>
              )}
              {confirmedSession.location && (
                <p>
                  <span className="font-medium text-foreground">{t('labelLocation')}</span>
                  {confirmedSession.location}
                </p>
              )}
              {bookingReference && (
                <p>
                  <span className="font-medium text-foreground">{t('labelReference')}</span>
                  {bookingReference}
                </p>
              )}
            </div>
          </div>

          {ctaUrl && (
            <a href={ctaUrl} target="_blank" rel="noopener noreferrer">
              <BioLinkButton accentColor={accentColor}>{ctaLabel}</BioLinkButton>
            </a>
          )}

          <div className="space-y-1">
            <button
              onClick={resetToStart}
              className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              {t('bookAnotherSession')}
            </button>
            {/* A booked visitor used to dead-end here with no way out but the
                header arrow. Send them back where they came from. */}
            {exitToSurface()}
          </div>
        </div>
      </FlowShell>
    )
  }

  return null
}
