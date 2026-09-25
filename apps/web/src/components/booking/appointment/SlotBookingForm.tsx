'use client'

import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { type FunctionsError } from 'firebase/functions'
import {
  PARTICIPANT_NAME_MAX,
  normalizePartyRequest,
  resolvePaymentOptions,
  resolveBookingContactFields,
  resolveDurationBenefit,
  heldSubscriptionTypeIds,
  type ActivityMemberBenefit,
  type Benefit,
  type BookingContactField,
  type DurationParty,
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
import { formatCurrency } from '@/lib/format'
import {
  GuestDetailsForm,
  type GuestDetailsFormHandle,
  type GuestDetailsValues,
} from '@/components/booking/GuestDetailsForm'
import { ReturningSignIn, type ContactData } from '@/components/booking/ReturningSignIn'
import { BackButton } from '@/components/booking/BackButton'
import { WaiverStep } from '@/components/booking/WaiverStep'
import { BookingTerms, resolveCancellationPolicy } from '@/components/booking/BookingTerms'
import { useWaiverGate } from '@/hooks/useWaiverGate'
import { waiverErrorMessage, type WaiverAcceptancePayload } from '@/lib/waiver'
import { useBookingChrome } from '@/components/booking/BookingChrome'
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
// The public surfaces' own contexts. They live with the routes rather than
// here, and moving them is its own change: sixty files import `usePublicTeam`
// alone. This component is mounted by two of those routes and needs what they
// hold, so it reaches for them by path rather than taking four more props.
import { usePublicTeam } from '@/app/[locale]/(public)/public/[slug]/PublicTeamProvider'
import { usePublicContactAuth } from '@/app/[locale]/(public)/public/[slug]/PublicContactAuthProvider'
import { usePublicContactRecord } from '@/app/[locale]/(public)/public/[slug]/usePublicContactRecord'
import { Check, Tag, User } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'

// THE APPOINTMENT BOOKING RAIL: everything between a chosen time and a booked
// one. Guest details, the sign-in offer, the member confirmation, the consent
// screen, the promo field and both submits, free and paid.
//
// It lived inside the appointment picker until the two public funnels merged
// (plan section 4). It is mounted by the merged funnel now, and by the picker
// until that route becomes a shim: the whole point is that a visitor who
// picked an appointment never leaves the funnel they started in.
//
// Everything it needs about the offer arrives as props, and the two callables
// arrive as `book` and `checkout`, so this file knows nothing about how an
// appointment is taken: only about asking a person for what taking one needs.

export type BookArgs = BookingCallBody & {
  /** A party length only: how many people, the booker included, and the
   *  companions' names. Added by this form to every call it makes. */
  people?: number
  participants?: string[]
}

// Which screen the in-page booking step is showing. Reported UP so the parent's
// sticky bar shows its Confirm only on the guest screen (the sign-in and member
// screens carry their own action buttons) — the same rule the class BookingForm
// applies (Confirm only on its 'details' step).
// 'waiver' is a screen of its own for the same reason it is a step of its own in
// the class flow: this file's terminal submits are `onSubmitGuest`,
// `runMemberFreeBooking` and `onMemberPay`, and only the first has a form.
// `autobooking` books the instant a covered member's code verifies, with no
// confirm control at all — a consent block hung off the guest form would be
// invisible on exactly that path, and the refusal that followed would arrive
// after `resolveAppointmentCaller` had already marked the code used, against a
// three-per-hour re-request budget.
export type BookScreen = 'party' | 'guest' | 'signIn' | 'member' | 'autobooking' | 'waiver'

/**
 * The scope of a sentence that belongs to the TRANSITION rather than to a
 * caller — "this booking was re-priced, confirm again".
 *
 * Every other sentence on this screen names a figure and is therefore true only
 * for the identity it was composed for; it is stamped with `callerKey` and
 * retires the moment that moves. This one is true for whoever is here NOW, and
 * it has to survive a SECOND identity move that the visitor cannot see: a
 * sign-in changes the caller once, and the live held-set read landing a moment
 * later changes `callerKey` again. Stamped with a caller key it would blink out
 * inside a few hundred milliseconds, which is how "your code was removed"
 * becomes a code that vanished silently — the thing it exists to prevent.
 *
 * Not a value `callerKey` can produce ('guest', or `kind:contactId:held`), and
 * cleared like any other sentence the moment the visitor acts.
 */
const ANY_IDENTITY = '*'

/** What `checkout` adds on top of the identity: the Stage A MODIFIER the visitor
 *  typed, and the figure this screen actually rendered. `bookAppointment` (the
 *  free path) takes neither — there is no price for a code to change. */
export type CheckoutExtras = { promoCode?: string; quotedAmount?: number }

// Pulls the {code, reason, priceAmount} triad off a callable's FunctionsError —
// `code` is prefixed ('functions/failed-precondition'); `reason`/`priceAmount`
// come from the HttpsError's `details` (see bookAppointment / createAppointmentCheckout).
export function errorDetails(err: unknown): { code?: string; message?: string; reason?: string; priceAmount?: number } {
  const fe = err as FunctionsError
  const details = (fe?.details ?? {}) as { reason?: string; priceAmount?: number }
  return { code: fe?.code, message: fe?.message, reason: details.reason, priceAmount: details.priceAmount }
}

export function SlotBookingForm({
  teamId,
  guestFormRef,
  onScreenChange,
  onSubmittingChange,
  accentColor,
  hasAnyPrice,
  settleAtStudio,
  benefitOnly,
  shopHref,
  priceAmount,
  party,
  memberBenefit,
  cancellationPolicy,
  activityContactFields,
  durationMinutes,
  providerId,
  activityId,
  startMs,
  startMsList,
  currency,
  locale,
  backLabel,
  onExit,
  book: bookCall,
  checkout: checkoutCall,
  onBooked,
}: {
  teamId: string
  guestFormRef: Ref<GuestDetailsFormHandle>
  onScreenChange: (screen: BookScreen) => void
  onSubmittingChange: (submitting: boolean) => void
  accentColor: string | null
  hasAnyPrice: boolean
  /** The studio cannot take money online, so a priced length is booked here and
   *  paid in person. Server-resolved (`listAvailability`) — never inferred. */
  settleAtStudio: boolean
  /** This length is not sold individually (UX-70). Never true together with
   *  `hasAnyPrice`: the resolver reads the mode, not the leftover number. */
  benefitOnly: boolean
  /** Where "see plans" goes — the parent owns the slug. */
  shopHref: string
  priceAmount: number | null
  /** A GROUP books this length and `priceAmount` is per person: the form asks
   *  who is coming before anything else. Null for one person. */
  party: DurationParty | null
  /** null/empty subscriptionTypeIds = nothing to offer — the sign-in link never
   *  renders (there's no price a member could get that a guest can't). */
  memberBenefit: ActivityMemberBenefit | Benefit | null
  /** The activity's own cancellation terms, or null to fall back to the team's. */
  cancellationPolicy: string | null
  /** Extends the team-wide contact-field list on the guest step. */
  activityContactFields: BookingContactField[] | null
  durationMinutes: number
  /** The three ids the promo preview needs — its per-rail target key is
   *  `apt:{providerId}:{startMs}:{durationMinutes}`, and preview and checkout
   *  must derive the SAME one or a retry silently becomes a second use. */
  providerId: string
  activityId: string
  startMs: number
  /** Every date of a basket (`[startMs]` for one). Priced as that many
   *  lessons; the calls themselves carry the list from the parent. */
  startMsList: number[]
  currency: string
  locale: string
  backLabel: string
  /** Leaves the booking step entirely — back to the time picker. */
  onExit: () => void
  book: (args: BookArgs) => Promise<void>
  checkout: (args: BookArgs & CheckoutExtras) => Promise<{ url?: string; amount?: number }>
  /** The address the confirmation went to, or null when this rail never learned
   *  one — a contact session identifies the CONTACT, and an older persisted
   *  session may predate the address being carried on it. */
  onBooked: (email: string | null) => void
}) {
  const t = useTranslations('AppointmentBooking')
  const tPublic = useTranslations('PublicBooking')
  const tPromo = useTranslations('Promo')
  const tWaiver = useTranslations('Waiver')
  // 'page' unless a panel host wraps this flow (the website overlay, or the
  // embed on a studio's own site). The two checkout handoffs below go through
  // it, not through `window.location`: inside an iframe that assignment
  // navigates the FRAME, and Stripe Checkout refuses to be framed — so a paid
  // appointment booked from an embedded panel would dead-end on a blank box.
  // The page default IS `window.location.href = href`, so nothing changes here.
  const chrome = useBookingChrome()
  const { team: publicTeam } = usePublicTeam()
  // The studio's contact fields for THIS booking — team-wide, extended by the
  // activity's own. The same resolver the callables run, so the guest step and
  // the server never disagree about what is being asked.
  const contactFields = useMemo(
    () => resolveBookingContactFields(publicTeam?.bookingSettings, activityContactFields),
    [publicTeam?.bookingSettings, activityContactFields]
  )
  const publicCustomFields = publicTeam?.publicCustomFields
  // THE SESSION THIS RAIL USED TO IGNORE. `PublicContactAuthProvider` is mounted
  // at the team root, so it wraps every `/public/{slug}/…` surface including this
  // one — a contact signed in from the Space, the shop or the corner pill is in
  // context here, and their ID token is ALREADY riding on every callable this
  // file makes. Reading it is what makes the screen agree with the server.
  const { contact: sessionContact, isAuthenticated } = usePublicContactAuth()
  // ── WHAT THE MEMBER ACTUALLY HOLDS, RE-RESOLVED ON LOAD ───────────────────
  // The session's contact is a SEVEN-DAY SNAPSHOT: it carries the plan types
  // the contact held when they signed in, serialised into
  // localStorage and never refreshed. On every other surface that is a label; on
  // this one it is the PRICE, and the divergence it produces points the unsafe
  // way — a member whose subscription lapsed, changed, or ran its credits out
  // since sign-in is quoted the benefit they no longer have, and
  // `loadContactPaymentSnapshot` charges the real figure. Nothing downstream
  // catches it either: `assertQuotedAmount` returns on its first line unless the
  // checkout carried a promo code, so a silently dearer charge is exactly the
  // case the guard does not cover.
  //
  // So the held set is re-resolved from the contact's own document — the
  // `isSelfContact` read the Space already makes — through the SAME shared
  // `heldSubscriptionTypeIds` union the OTP path receives from
  // `verifyBookingCode`: live subscriptions, the primary type, and unexpired
  // credit packs, rather than one frozen id. The frozen value survives only as
  // the fallback for a read that FAILED, because "we don't know what you hold"
  // is not "you hold nothing"; and while the read is still in flight the member
  // screen's CTA waits, since the whole point is to stop offering a figure
  // derived from the stale one.
  const contactRecord = usePublicContactRecord()
  const liveHeld = contactRecord.data ? heldSubscriptionTypeIds(contactRecord.data) : null
  const heldSettled = contactRecord.data !== undefined || contactRecord.isError
  // ── The error sentence, STAMPED WITH THE IDENTITY IT WAS SAID TO ──────────
  // Read back through `identityKey` rather than cleared by an effect, for the
  // reason `useAcceptedPrice` gives about the figure it stores: an effect clears
  // one render too late, so the stale sentence is rendered once — and these
  // sentences NAME A PRICE. "…the price without the code is CHF 40.00", composed
  // for the guest, above a member's CHF 24.00 button, is the same lie as the
  // figure itself. A scope that no longer matches reads `null` immediately.
  //
  // `setError` is re-created each render on purpose: it stamps the identity of
  // the render that called it, so a sign-in DURING a round trip retires the
  // sentence rather than stranding it on the member who arrived meanwhile.
  const [errorState, setErrorState] = useState<{ identity: string; text: string } | null>(null)
  const [submittingGuest, setSubmittingGuest] = useState(false)
  const [submittingPay, setSubmittingPay] = useState(false)
  // The first code field on this surface. Appointments take no gift card by
  // design, so a promo is the only instrument that can ride this rail.
  const [promoApplied, setPromoApplied] = useState<AppliedPromo | null>(null)

  // 'guest' is the default screen for an UNRECOGNISED visitor — appointments
  // have no access gate (see ActivityMemberBenefit's history note): a guest may
  // always book, priced or not. Signing in is purely an OFFER to check a
  // possibly-lower member price, reached via a link on the guest form, and it is
  // never shown to someone who is already signed in.
  type Screen = 'guest' | 'signIn'
  const [screen, setScreen] = useState<Screen>('guest')

  // The OTP result, once a guest has taken the sign-in offer on THIS screen.
  // Never set for someone who arrived with a session — they are not offered it.
  const [verified, setVerified] = useState<VerifiedCaller | null>(null)
  // Transient state while a covered member's free booking is in flight.
  const [autobooking, setAutobooking] = useState(false)

  // ── WHO IS COMING, for a length a group books together ────────────────────
  // Asked FIRST, on its own screen, and settled before any identity screen can
  // submit. Not a field on the guest form: a member whose code verifies is
  // booked at once (`autobooking`), and a party the server then refuses would
  // be refused after that one-time code was already spent.
  const [people, setPeople] = useState(party?.min ?? 1)
  const [companions, setCompanions] = useState<string[]>([])
  const [partyConfirmed, setPartyConfirmed] = useState(party === null)
  const participants = companions.slice(0, Math.max(0, people - 1)).map((n) => n.trim())
  // THE SAME CHECK every booking callable runs, so this screen cannot let
  // through a party the server refuses.
  const partyCheck = party
    ? normalizePartyRequest(
        { minutes: durationMinutes, priceAmount, benefitOnly, party },
        { people, participants }
      )
    : null
  /** What each call adds for a party; nothing for one person, so a solo
   *  booking's request body is exactly what it always was. */
  const partyArgs = party ? { people, participants } : {}
  /** Part of WHAT IS BEING BOUGHT, so it scopes every figure the server named
   *  for this screen: a price accepted for two people is not a price for three. */
  const dateCount = Math.max(1, startMsList.length)
  const partyKey = `${party ? `|p${people}` : ''}${dateCount > 1 ? `|d${dateCount}` : ''}`
  const book = (args: BookArgs) => bookCall({ ...args, ...partyArgs })
  const checkout = (args: BookArgs & CheckoutExtras) => checkoutCall({ ...args, ...partyArgs })

  // ── WHO IS BOOKING, derived ───────────────────────────────────────────────
  // Session first, an OTP result second, a guest last: the shared resolver
  // holds that order because it is the SERVER's order.
  const caller = resolveBookingCaller({ sessionContact, isAuthenticated, liveHeld, verified })
  const identityKey = callerKey(caller)
  const error =
    errorState &&
    (errorState.identity === identityKey || errorState.identity === ANY_IDENTITY)
      ? errorState.text
      : null
  const setError = (text: string | null) =>
    setErrorState(text === null ? null : { identity: identityKey, text })
  /** The transition's own sentence — see `ANY_IDENTITY`. */
  const setNotice = (text: string) => setErrorState({ identity: ANY_IDENTITY, text })
  /**
   * A promo landed. Retire the transition notice, because the one that can be on
   * screen here says the previous code was DROPPED — and leaving it beside a
   * freshly applied code makes the screen assert a removal while showing the
   * discount. The notice is advice ("re-apply it"); doing the thing it advises
   * has to end it, or it reads as a failure the visitor cannot clear.
   * Anything caller-scoped is retired by `identityKey` already, so this only has
   * to reach the ANY_IDENTITY ones.
   */
  const onPromoApplied = (p: AppliedPromo | null) => {
    setPromoApplied(p)
    if (p) setErrorState((prev) => (prev?.identity === ANY_IDENTITY ? null : prev))
  }
  /** The member screen is quoting from the frozen session snapshot and the live
   *  read has not answered yet. Its CTA waits — a sub-second wait beats a figure
   *  the server may not honour, and an ERRORED read settles too, so a contact
   *  whose document is unreadable still gets a working button. */
  const heldPending = caller.kind === 'session' && hasAnyPrice && !heldSettled

  // ── The consent gate ──────────────────────────────────────────────────────
  // Inert unless the team's public mirror lists a required waiver. This
  // component is keyed on provider/activity/start/duration, so picking a
  // different slot builds a fresh one — which is right: a different activity may
  // carry a different scoped waiver, and a tick must never survive the change.
  const waiverGate = useWaiverGate({
    teamId,
    requiredWaivers: publicTeam.required_waivers,
    activityId,
  })
  /**
   * Which of the three submits the consent screen is standing in front of —
   * AND WHOSE. The `identity` is not decoration: this record is replayed by
   * `resumePendingBook` after an unbounded pause (the visitor is reading a
   * waiver), during which the corner pill can sign somebody in or out. Stored so
   * that the replay can be compared against the caller the rail has NOW, rather
   * than resuming a request half captured from one person and half re-derived
   * for another.
   *
   * It is stamped from the SUBJECT, not from the render: `memberFree` stamps
   * `callerKey(theCaller)`, because that arm is captured in the same async block
   * that produced the caller and the render carrying it may not have committed
   * yet. Reading `identityKey` there would stamp the guest this member just
   * stopped being.
   */
  const [pendingBook, setPendingBook] = useState<
    | ({ identity: string } & (
        | { kind: 'guest'; values: GuestDetailsValues }
        | { kind: 'memberFree'; caller: BookingCaller }
        | { kind: 'memberPay' }
      ))
    | null
  >(null)

  // ── The recovery half of the `price_changed` guard ────────────────────────
  // The server's own figure, once it has refused this screen's quote. It is BOTH
  // what the screen shows from then on AND what the next attempt sends back as
  // `quotedAmount` — which is what makes the refusal cost one extra, informed
  // confirmation instead of looping (the screen would otherwise re-derive the
  // same optimistic figure from the same optimistic snapshot and be refused
  // again, with no path to the real price).
  //
  // AN ACCEPTED FIGURE BELONGS TO ONE (target, code, IDENTITY) — the rule lives
  // in `useAcceptedPrice`, shared with every other mount. The TARGET half is
  // the remount: `SlotBookingForm` is keyed on provider/activity/start/duration,
  // so changing the slot builds a fresh component. The other two are the scope
  // below — and IDENTITY is the one this screen alone can move without changing
  // what is being bought: a guest can sign in mid-flow (here or through the
  // corner pill) and be re-quoted as a member, and a member can sign out.
  const { acceptedPrice, acceptPrice } = useAcceptedPrice(
    `${identityKey}|${promoApplied?.code ?? ''}${partyKey}`
  )

  // ── The server's `payment_required` figure ────────────────────────────────
  // The one number this screen cannot re-derive: the client resolved free and
  // the server did not, so there is no client `pay` option to read. Stored WITH
  // the identity it priced and read back THROUGH it, for the same reason
  // `useAcceptedPrice` does — an effect would clear it one render too late, and
  // on this surface the window between "one render too late" and a submit is a
  // ref-driven sticky bar.
  const [race, setRace] = useState<{ identity: string; amount: number } | null>(null)
  const racePrice = race && race.identity === `${identityKey}${partyKey}` ? race.amount : null

  // ── ONE RULE FOR AN IDENTITY CHANGE ───────────────────────────────────────
  // Everything this screen SAID or CAPTURED belongs to the caller it was said to
  // and captured from. The identity can move under an open booking step at any
  // moment, because the provider that owns the corner sign-in pill wraps this
  // page — so this is a live transition, not a theoretical one.
  //
  // `useAcceptedPrice` already retires the accepted figure through its scope and
  // `racePrice` is read through `identityKey`. Three things were not retired
  // with them:
  //
  //  • THE ERROR SENTENCE, which NAMES A FIGURE — handled above by scoping it
  //    to `identityKey` rather than here, because a sentence cleared by an
  //    effect is a sentence rendered once. `onVerifiedAppointment` used to clear
  //    it by hand on the OTP transition; the contact-session transition — the
  //    one nothing in this file used to notice — had nobody to clear it at all.
  //  • THE CAPTURED SUBMIT behind the consent screen. `pendingBook` stores the
  //    caller (`memberFree`) and the typed values (`guest`) while everything
  //    else is re-derived at resume, so resuming after a change replays a MIXED
  //    request: an old caller against a new price, or a new caller against an
  //    old typed email. The acceptances standing behind it were resolved for
  //    the old identity too, which is why the gate is dismissed rather than
  //    carried.
  //  • THE APPLIED PROMO, previewed for whoever was here when Apply was
  //    pressed. `previewPromoCode` resolves ITS caller from a contact session
  //    and nothing else, so a code quoted anonymously and carried onto a member
  //    screen is re-priced by the client for an audience the server judges
  //    differently — an audience-restricted code showing as applied on a screen
  //    whose checkout is obliged to refuse it. Retiring it means the only code
  //    on any screen is one applied BY this caller, and a `session` caller
  //    re-applying gets a preview resolved as exactly who they are.
  //
  // Retirement is silent only when nothing was actually dropped. A dropped
  // submit or code is said out loud: both are things the visitor did, and a
  // control that empties itself without a word is the same category of defect
  // as the sentence this rule exists to clear.
  const identityRef = useRef(identityKey)
  useEffect(() => {
    if (identityRef.current === identityKey) return
    identityRef.current = identityKey
    const droppedPromo = promoApplied !== null
    // Only a capture that belongs to SOMEBODY ELSE. The OTP arm sets `verified`
    // and its pending record in one async block, so both can land in one batch —
    // and a record stamped with the caller it was captured for is kept, rather
    // than being torn down by the very transition that created it.
    const droppedSubmit = pendingBook !== null && pendingBook.identity !== identityKey
    setPromoApplied(null)
    if (droppedSubmit) setPendingBook(null)
    setRace(null)
    // `reset`, not `dismiss`. `dismiss` only hides the step — it keeps `items`,
    // `ticks`, `choices` and the resolved identity, so the next `ensure()` would
    // reuse consent that was gathered for, and attributed to, the person who was
    // signed in a moment ago. On an immutable acceptance ledger that is the one
    // thing this transition must not do. `reset` is the call that clears them.
    if (droppedSubmit) waiverGate.reset()
    // `setNotice`, not `setError`: this sentence is about the transition, and a
    // sign-in fires this effect TWICE — once when the session appears, once when
    // the live held-set read lands under it. Stamped with a caller key, the
    // first sentence would be retired by the second move and the code would have
    // vanished without a word after all. See `ANY_IDENTITY`.
    if (droppedPromo) setNotice(t('identityChangedPromo'))
    else if (droppedSubmit) setNotice(t('identityChanged'))
  }, [identityKey, promoApplied, pendingBook, waiverGate, t])

  /**
   * THE ONE PRICE COMPUTATION for this screen — the same resolver the server
   * runs, given the same target and the same held types.
   *
   * Every screen that shows a price calls this with the SAME derived `caller`:
   * the guest screen, the member screen, and the post-verify routing decision.
   * A second, promo-free computation anywhere here is what would let the screen
   * promise one figure while Stripe charged another — and quoting it for the
   * wrong caller is what showed a signed-in member the guest price.
   */
  const quote = (c: BookingCaller) =>
    resolvePaymentOptions(
      clientPaymentSnapshot({
        authenticated: c.kind !== 'guest',
        heldSubscriptionTypeIds: heldOf(c),
      }),
      {
        kind: 'appointment',
        duration: { minutes: durationMinutes, priceAmount, benefitOnly, ...(party ? { party } : {}) },
        benefit: memberBenefit,
        people,
        quantity: dateCount,
      },
      promoApplied ? { promo: promoApplied } : undefined
    )

  // Also resolved for a benefit_only length, where the interesting answer is
  // not a price but the ABSENCE of any option — the refusal below reads it.
  const callerQuote = hasAnyPrice || benefitOnly ? quote(caller) : null
  /** No option at all: this length is not sold on its own and this caller holds
   *  nothing that opens it. The server refuses the same booking, so offering
   *  the Confirm button would be a button whose only outcome is an error. */
  const noWayIn = benefitOnly && callerQuote?.options.length === 0
  const callerPay = callerQuote?.options[0]
  const resolvedAmount = callerPay?.type === 'pay' ? callerPay.amount : null
  /** What this screen renders, and what the next attempt sends back as
   *  `quotedAmount`: the server's refused figure first, then this screen's own,
   *  then the server's race figure (the only one left when the client resolved
   *  free). Null ⇒ nothing to pay. */
  const payNow = acceptedPrice ?? resolvedAmount ?? racePrice
  /** The figure on screen is the SERVER's `payment_required` one — i.e. the two
   *  earlier sources were both empty, which is exactly the case where this
   *  screen was showing "included with your subscription" a moment ago. The
   *  member is owed the reason, not just the new number. */
  const showsRacePrice = acceptedPrice === null && resolvedAmount === null && racePrice !== null
  /**
   * Does this caller owe money for this slot?
   *
   * Derived from the quote rather than from `hasAnyPrice`, and that is the whole
   * repair: routing a covered member down the paid door made
   * `createAppointmentCheckout` refuse `{ reason: 'covered' }`, which this file
   * rendered as "This slot is no longer available." — a false sentence and a
   * dead end for the studio's own subscribers.
   */
  const owesPayment = hasAnyPrice && payNow != null && !settleAtStudio
  /** There IS a price, and it is settled in person rather than here. Rendered
   *  beside the figure so the visitor is not surprised at the door, and the
   *  reason the Confirm button is not a Pay button. */
  const paysAtStudio = hasAnyPrice && payNow != null && settleAtStudio

  /**
   * What every checkout call carries beyond the caller's identity.
   *
   * THE QUOTE RIDES THE CODE, and only the code. A promo is what turns the
   * rendered figure into a promise ("Code X applied", a struck-through base);
   * without one it is an optimistic render from a snapshot documented as partial,
   * and asserting it server-side would refuse ordinary bookings over divergences
   * that are nobody's fault and that this screen cannot re-render its way out of.
   */
  const checkoutExtras = (amount: number | null): CheckoutExtras =>
    promoApplied
      ? {
          promoCode: promoApplied.code,
          ...(typeof amount === 'number' ? { quotedAmount: amount } : {}),
        }
      : {}

  const offersMemberBenefit = !!memberBenefit?.subscriptionTypeIds.length

  // Report the current screen UP so the sticky bar can gate its Confirm button.
  // The guest/member fork is `caller`, never a stored step: a recognised contact
  // is on the member screen from the first render, and a sign-in through the
  // corner pill moves them there mid-flow without anything having to notice.
  const currentScreen: BookScreen = !partyConfirmed
    ? 'party'
    : waiverGate.presented
    ? 'waiver'
    : autobooking
      ? 'autobooking'
      : caller.kind !== 'guest'
        ? 'member'
        : screen === 'signIn'
          ? 'signIn'
          : 'guest'
  useEffect(() => {
    onScreenChange(currentScreen)
  }, [currentScreen, onScreenChange])
  useEffect(() => {
    onSubmittingChange(submittingGuest)
  }, [submittingGuest, onSubmittingChange])

  // ── Guest submit — reached ONLY by an unrecognised visitor (`caller.kind ===
  // 'guest'`); a contact session takes the member screen's CTA instead. Routes
  // to the free callable or checkout on what this caller actually OWES, not on
  // whether the duration has a price. GuestDetailsForm supplies the fields; its
  // submit is sr-only and fired by the sticky bar's Confirm (via guestFormRef). ──
  async function onSubmitGuest(values: GuestDetailsValues) {
    setError(null)
    setSubmittingGuest(true)
    try {
      // THE GUEST FORM — this file's one submit that has a form to interrupt. The consent screen goes before
      // the call, not after the refusal: `bookAppointment` refuses above its
      // contact write, so this costs nothing, and it is the only path where a
      // form exists to interrupt.
      if (!(await waiverGate.ensure(waiverIdentity(caller, values)))) {
        setPendingBook({ identity: identityKey, kind: 'guest', values })
        return
      }
      const waiverAcceptances = waiverGate.acceptances
      const identity = bodyIdentity(caller, values)
      if (!owesPayment) {
        await book({ ...identity, ...(waiverAcceptances.length ? { waiverAcceptances } : {}) })
        onBooked(values.email)
        return
      }
      const res = await checkout({
        ...identity,
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
        ...checkoutExtras(payNow),
      })
      if (res?.url) {
        chrome.navigate(res.url)
        return
      }
      throw new Error('no-url')
    } catch (err) {
      const { code, reason } = errorDetails(err)
      // A waiver refusal is a SCREEN, not a sentence: the requirement moved
      // between the resolve and the call. Re-resolve and present rather than
      // printing "this slot is unavailable", which is both wrong and a dead end.
      // `recover` rather than `reset` + `ensure`, because the refusal also tells
      // us the team's public mirror may be stale-empty — and `ensure` answers
      // "clear" for an empty mirror, leaving the sentence with nothing behind it.
      const waiverMsg = waiverErrorMessage(err, tWaiver)
      if (waiverMsg) {
        if (await waiverGate.recover(err, waiverIdentity(caller, values))) {
          setPendingBook({ identity: identityKey, kind: 'guest', values })
          return
        }
        setError(waiverMsg)
        return
      }
      // RECOVERY FIRST: the server has told us what this slot really costs. Show
      // that figure and let the visitor confirm again — the next attempt sends
      // it back as the quote and the booking completes. Without this the screen
      // re-derives the same optimistic number and is refused again, forever.
      // The sentence is composed by `priceChangedMessage`: on this rail the
      // guest's email reaches the server only now, so a refused code — not a
      // moved price — is the likeliest cause and must be the one named.
      const serverPrice = priceChangedAmount(err)
      if (serverPrice !== null) {
        acceptPrice(serverPrice)
        setError(priceChangedMessage(err, tPromo, formatCurrency(serverPrice, currency, locale)))
        return
      }
      // PAY-TIME promo refusals next: the preview is advisory about
      // availability, so a code that applied cleanly can still be refused here
      // (exhausted, busy, already used, disabled mid-checkout) — and those
      // arrive as `failed-precondition`, which the generic branch below would
      // otherwise render as "this slot is unavailable".
      const promoMsg = promoCheckoutErrorMessage(err, tPromo)
      if (promoMsg) setError(promoMsg)
      // COVERED — the server resolved this caller as owing nothing and refused
      // the paid door by design. Unreachable for a true guest (a guest is never
      // covered); reachable when a contact session appeared under this form
      // between the render and the call, in which case the honest answer is to
      // walk through the free door, not to claim the slot is gone. That claim is
      // what this branch replaces: `covered` used to fall through to
      // `errorSlotUnavailable` and end the booking of every covered member the
      // guest form had already mis-recognised.
      else if (code === 'functions/failed-precondition' && reason === 'covered') {
        try {
          const carried = waiverGate.acceptances
          await book({
            ...bodyIdentity(caller, values),
            ...(carried.length ? { waiverAcceptances: carried } : {}),
          })
          // Whoever the SERVER booked it for, which on this branch is the session
          // contact — reaching it means the server recognised a session and made
          // the booking free, so naming the address typed into a form it ignored
          // would be the same substitution one line further down the flow.
          //
          // NOT `emailOf(caller)`: `caller` is closed over from the render that
          // showed the guest form, so it is `guest` here BY CONSTRUCTION and that
          // read is always null. `sessionContact` comes from the auth context and
          // is the identity the server actually used. The typed address survives
          // only as the last resort, for a session whose contact carries none.
          onBooked(sessionContact?.email ?? values.email)
        } catch {
          setError(t('errorGeneric'))
        }
      } else if (code === 'functions/already-exists') setError(t('errorAlreadyBooked'))
      else if (code === 'functions/failed-precondition') setError(t('errorSlotUnavailable'))
      else setError(owesPayment ? t('errorCheckoutFailed') : t('errorGeneric'))
    } finally {
      setSubmittingGuest(false)
    }
  }

  // ── Returning member, post-verify. Reached ONLY via the priced guest form's
  // sign-in offer, which is never shown to someone who already has a contact
  // session — so this path always produces a `code` caller. Throwing surfaces
  // the message on ReturningSignIn's current step. ──
  async function onVerifiedAppointment({
    contactId,
    verificationCodeId,
    contactData,
  }: {
    contactId: string
    verificationCodeId: string
    contactData: ContactData
  }) {
    // NOTHING IS CLEARED BY HAND HERE ANY MORE. The guest screen's error goes
    // with the guest's figure, and both now retire through `identityKey` — the
    // error because it is read through the scope, the figure because
    // `useAcceptedPrice` is. Clearing here as well would have been the OTP arm
    // of a rule the contact-session arm did not have, which is precisely how the
    // guest's "…the price without the code is CHF 40.00" survived onto a member
    // screen quoting 24.00.
    const verifiedCaller: BookingCaller = {
      kind: 'code',
      contactId,
      verificationCodeId,
      name:
        [contactData.firstname, contactData.lastname].filter(Boolean).join(' ') ||
        contactData.email,
      email: contactData.email,
      held: contactData.held_subscription_type_ids ?? [],
    }
    setVerified(verifiedCaller)
    // The SAME `quote` the guest screen used, with this member's held types —
    // so a code applied before signing in is still in the price afterwards, and
    // the member never sees two different figures for one booking. DISPLAY /
    // ROUTING only; book()/checkout() always re-resolve authoritatively.
    const owes = hasAnyPrice && quote(verifiedCaller).options[0]?.type === 'pay'
    // Owes money → the member screen renders from `verified` and its CTA takes
    // it from here.
    if (owes) return

    // THE COVERED MEMBER'S FREE BOOKING, AND THE ONE WITH NO CONTROL AT ALL —
    // this path renders a spinner and books. `resolveAppointmentCaller` marks
    // the verification code used before any gate, so a `waiver_required` refusal
    // here funnels into "something went wrong" and costs the member their code
    // against a three-per-hour budget. The screen is interposed HERE, before
    // `setAutobooking(true)`, so the spinner never appears for a booking that
    // cannot complete.
    if (!(await waiverGate.ensure(waiverIdentity(verifiedCaller)))) {
      setPendingBook({ identity: callerKey(verifiedCaller), kind: 'memberFree', caller: verifiedCaller })
      return
    }
    await runMemberFreeBooking(verifiedCaller)
  }

  /**
   * A recognised caller's FREE booking — the covered member, and the signed-in
   * contact on an unpriced slot.
   *
   * Extracted so the consent screen's Confirm and the member screen's Confirm
   * re-enter EXACTLY what they interrupted, rather than the file growing further
   * places that build a `bookAppointment` payload. It takes the caller rather
   * than a bag of ids so the SESSION arm sends no body identity at all.
   */
  async function runMemberFreeBooking(c: BookingCaller) {
    const waiverAcceptances = waiverGate.acceptances
    setAutobooking(true)
    try {
      await book({
        ...bodyIdentity(c),
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
      })
      onBooked(emailOf(c))
    } catch (bookErr) {
      const { code, reason, priceAmount: amt } = errorDetails(bookErr)
      const waiverMsg = waiverErrorMessage(bookErr, tWaiver)
      if (waiverMsg) {
        // The requirement moved under the member. Re-present; an OTP caller's
        // code is already spent and the screen is the only way forward — which
        // is also why this forces the resolve rather than asking `applies` first.
        if (await waiverGate.recover(bookErr, waiverIdentity(c))) {
          setPendingBook({ identity: callerKey(c), kind: 'memberFree', caller: c })
          return
        }
        throw new Error(waiverMsg)
      }
      if (code === 'functions/already-exists') {
        throw new Error(t('errorAlreadyBooked'))
      } else if (code === 'functions/failed-precondition' && reason === 'payment_required') {
        // Race: pricing/coverage changed between our check and the free
        // attempt — the server is authoritative, fall back to the pay CTA at
        // ITS figure, stamped with the identity it priced.
        if (typeof amt === 'number') {
          setRace({ identity: `${callerKey(c)}${partyKey}`, amount: amt })
        } else {
          throw new Error(t('errorPaymentRequired'))
        }
      } else {
        throw new Error(t('errorGeneric'))
      }
    } finally {
      setAutobooking(false)
    }
  }

  /** The member screen's Confirm when there is nothing to pay. It is not a
   *  fourth booking path — it resolves the gate and re-enters
   *  `runMemberFreeBooking`, catching what that function throws because, unlike
   *  the OTP entry, there is no ReturningSignIn step underneath to show it. */
  async function onMemberBook() {
    if (caller.kind === 'guest') return
    setError(null)
    setSubmittingPay(true)
    try {
      if (!(await waiverGate.ensure(waiverIdentity(caller)))) {
        setPendingBook({ identity: callerKey(caller), kind: 'memberFree', caller })
        return
      }
      await runMemberFreeBooking(caller)
    } catch (err) {
      setError((err as { message?: string }).message ?? t('errorGeneric'))
    } finally {
      setSubmittingPay(false)
    }
  }

  // A recognised caller's effective price is an AMOUNT — pay to confirm.
  async function onMemberPay() {
    if (caller.kind === 'guest') return
    setSubmittingPay(true)
    setError(null)
    try {
      // THE MEMBER'S PAID CTA.
      if (!(await waiverGate.ensure(waiverIdentity(caller)))) {
        setPendingBook({ identity: identityKey, kind: 'memberPay' })
        return
      }
      const waiverAcceptances = waiverGate.acceptances
      const res = await checkout({
        ...bodyIdentity(caller),
        ...(waiverAcceptances.length ? { waiverAcceptances } : {}),
        // The figure THIS screen is showing — re-quoted, not one frozen at
        // verify time, or removing the code here would send a number the button
        // stopped displaying.
        ...checkoutExtras(payNow),
      })
      if (res?.url) {
        chrome.navigate(res.url)
        return
      }
      throw new Error('no-url')
    } catch (err) {
      const { code, reason } = errorDetails(err)
      // Recovery first — the pay button below re-renders at the server's figure
      // and pressing it again sends that number as the quote. Same composed
      // sentence as the guest path: a refused code names itself.
      const serverPrice = priceChangedAmount(err)
      if (serverPrice !== null) {
        acceptPrice(serverPrice)
        setError(priceChangedMessage(err, tPromo, formatCurrency(serverPrice, currency, locale)))
        return
      }
      const waiverMsg = waiverErrorMessage(err, tWaiver)
      const promoMsg = promoCheckoutErrorMessage(err, tPromo)
      if (waiverMsg) {
        if (await waiverGate.recover(err, waiverIdentity(caller))) {
          setPendingBook({ identity: identityKey, kind: 'memberPay' })
          return
        }
        setError(waiverMsg)
      } else if (promoMsg) {
        setError(promoMsg)
      } else if (code === 'functions/failed-precondition' && reason === 'covered') {
        // Race: became covered since we checked — retry the free path. It
        // carries the acceptances too: the resolver's answer does not change,
        // but a signature collected on this screen must ride whichever call
        // actually books the seat.
        try {
          const carried = waiverGate.acceptances
          await book({
            ...bodyIdentity(caller),
            ...(carried.length ? { waiverAcceptances: carried } : {}),
          })
          onBooked(emailOf(caller))
        } catch {
          setError(t('errorGeneric'))
        }
      } else if (code === 'functions/already-exists') {
        setError(t('errorAlreadyBooked'))
      } else {
        setError(t('errorCheckoutFailed'))
      }
    } finally {
      setSubmittingPay(false)
    }
  }

  /** Back off the OTP member screen, to the guest form this visitor came from.
   *  Not reachable for a session caller — signing out is the corner pill's job,
   *  and the member screen sends them back to the time picker instead. */
  function backToGuest() {
    setScreen('guest')
    setVerified(null)
    setRace(null)
    setAutobooking(false)
    setError(null)
  }

  const errorBox = error ? (
    <p className="text-destructive text-sm bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
      {error}
    </p>
  ) : null

  /** Finish what the consent screen interrupted, by re-entering the SAME
   *  function. Three submits, three resumptions, no fourth booking path. */
  async function resumePendingBook() {
    const pending = pendingBook
    if (!pending) return
    // THE CAPTURE MUST STILL BE THIS CALLER'S. The identity rule above already
    // drops a foreign capture the moment it becomes foreign; this is the same
    // fact asserted where it is USED, because what a resume replays is a
    // half-captured request — `pending.caller` and `pending.values.email` come
    // from then, while the price, the body identity and the acceptances are all
    // re-derived now. A mixture of two people is worth one more confirmation.
    if (pending.identity !== identityKey) {
      setPendingBook(null)
      waiverGate.dismiss()
      setNotice(t('identityChanged'))
      return
    }
    if (pending.kind === 'guest') {
      await onSubmitGuest(pending.values)
      return
    }
    if (pending.kind === 'memberPay') {
      await onMemberPay()
      return
    }
    setSubmittingGuest(true)
    try {
      await runMemberFreeBooking(pending.caller)
    } catch (err) {
      setError((err as { message?: string }).message ?? t('errorGeneric'))
    } finally {
      setSubmittingGuest(false)
    }
  }

  // The cancellation terms + the no-show fee, resolved once (activity override →
  // team default, exactly as the confirmation email resolves them) and rendered
  // above every CTA this component can end on. Renders null when the studio has
  // written no policy and runs no fee — see BookingTerms.
  //
  // Three of this component's five screens get it: the consent screen, the
  // member screen and the guest form, i.e. every screen carrying a control that
  // takes the slot. `autobooking` is past the decision (it is a spinner over a
  // booking already sent) and `signIn` is only ever reached FROM the guest form,
  // which showed them.
  const termsBlock = (
    <BookingTerms
      cancellationPolicy={resolveCancellationPolicy(
        cancellationPolicy,
        publicTeam.bookingCancellationPolicy
      )}
      noShowPolicy={publicTeam.noShowPolicy}
      currency={currency}
      locale={locale}
    />
  )

  // ── NOT SOLD INDIVIDUALLY, and this caller holds nothing that opens it
  // (UX-70). BEFORE every other screen, because none of them can be reached
  // from here: there is no price to quote, no code to type, and the only submit
  // this screen could offer is one the server refuses. It says what to buy —
  // and, for a visitor we don't recognise, offers the sign-in that might
  // already answer it. The sign-in screen itself is allowed through below.
  // ── THE PARTY, as the rest of the flow shows it ───────────────────────────
  /** The booking's list price: one per person on a party length. What a
   *  lowered price is struck through against. */
  const listTotal = priceAmount != null ? priceAmount * (party ? people : 1) * dateCount : null
  /** Back from an identity screen returns to "who's coming" when there is one,
   *  rather than throwing the names away with the slot. */
  const backFromIdentity = party ? () => setPartyConfirmed(false) : onExit
  const partySummary =
    party && people > 1 ? (
      <p className="text-muted-foreground mt-1 text-sm">
        {t('partySummary', { count: people, names: participants.join(', ') })}{' '}
        <button
          type="button"
          onClick={() => setPartyConfirmed(false)}
          className="font-medium text-foreground underline underline-offset-2"
        >
          {t('partyChange')}
        </button>
      </p>
    ) : null

  // ── WHO'S COMING: first, for a length a group books together ──
  if (party && !partyConfirmed) {
    const namesMissing = partyCheck?.ok === false && partyCheck.reason === 'participant_names'
    return (
      <>
        <div>
          <BackButton label={backLabel} onClick={onExit} />
          <h1 className="text-2xl font-bold">{t('partyTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {party.min === party.max
              ? t('partyHintFixed', { count: party.min })
              : t('partyHintRange', { min: party.min, max: party.max })}
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4 space-y-4">
          {party.min !== party.max && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{t('partyPeopleLabel')}</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={people <= party.min}
                  onClick={() => setPeople((n) => Math.max(party.min, n - 1))}
                  aria-label={t('partyFewer')}
                  className="h-9 w-9 rounded-full border text-lg leading-none disabled:opacity-40"
                >
                  −
                </button>
                <span className="w-6 text-center text-base font-semibold tabular-nums">{people}</span>
                <button
                  type="button"
                  disabled={people >= party.max}
                  onClick={() => setPeople((n) => Math.min(party.max, n + 1))}
                  aria-label={t('partyMore')}
                  className="h-9 w-9 rounded-full border text-lg leading-none disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4 shrink-0" />
              {t('partyYou')}
            </div>
            {Array.from({ length: Math.max(0, people - 1) }, (_, i) => (
              <input
                key={i}
                value={companions[i] ?? ''}
                onChange={(e) =>
                  setCompanions((prev) => {
                    const next = [...prev]
                    next[i] = e.target.value
                    return next
                  })
                }
                maxLength={PARTICIPANT_NAME_MAX}
                autoComplete="off"
                placeholder={t('partyCompanionPlaceholder')}
                aria-label={t('partyCompanionLabel', { n: i + 2 })}
                className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
              />
            ))}
          </div>
          {listTotal != null && priceAmount != null && (
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {t('partyTotal', {
                  count: people,
                  unit: formatCurrency(priceAmount, currency, locale),
                  total: formatCurrency(priceAmount * people, currency, locale),
                })}
              </p>
              {dateCount > 1 && (
                <p className="text-sm text-muted-foreground">
                  {t('partyTotalDates', {
                    count: dateCount,
                    total: formatCurrency(listTotal, currency, locale),
                  })}
                </p>
              )}
            </div>
          )}
        </div>
        {namesMissing && people > 1 && participants.some((n) => n.length > 0) && (
          <p className="text-sm text-destructive">{t('partyNamesMissing')}</p>
        )}
        <button
          type="button"
          disabled={!partyCheck?.ok}
          onClick={() => setPartyConfirmed(true)}
          style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
          className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {t('partyContinue')}
        </button>
      </>
    )
  }

  if (noWayIn && screen !== 'signIn') {
    return (
      <>
        <div>
          <BackButton label={backLabel} onClick={onExit} />
          <h1 className="text-2xl font-bold">{t('benefitOnlyTitle')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {caller.kind === 'guest' ? t('benefitOnlyBodyGuest') : t('benefitOnlyBodyMember')}
          </p>
        </div>
        {/* New tab, the same reason the class flow opens the shop in one: buying
            is a detour, and losing the slot they picked loses the booking. */}
        <a
          href={shopHref}
          target="_blank"
          rel="noopener noreferrer"
          style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t('benefitOnlySeePlans')}
        </a>
        {caller.kind === 'guest' && (
          <button
            type="button"
            onClick={() => setScreen('signIn')}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed p-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <Tag className="h-4 w-4 shrink-0" />
            {t('benefitOnlySignIn')}
          </button>
        )}
      </>
    )
  }

  // ── The consent screen — FIRST, because it stands in front of all three ──
  // submits and must win over `autobooking`'s spinner and `memberPay`'s CTA.
  // It carries its own Confirm for the same reason the member-pay screen does:
  // the parent's sticky bar drives the guest form and nothing else.
  if (waiverGate.presented) {
    return (
      <>
        <div>
          <BackButton
            label={backLabel}
            onClick={() => {
              waiverGate.dismiss()
              setPendingBook(null)
            }}
          />
        </div>
        <WaiverStep gate={waiverGate} teamName={publicTeam.name || ''} disabled={submittingGuest} />
        {termsBlock}
        {errorBox}
        <button
          type="button"
          disabled={!waiverGate.ready || submittingGuest || submittingPay}
          onClick={() => void resumePendingBook()}
          style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
          className="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {submittingGuest || submittingPay ? tPublic('ctaBooking') : tPublic('ctaConfirm')}
        </button>
      </>
    )
  }

  // ── A recognised caller's free booking is in flight. The subscription
  // sentence is only true when there is a price the subscription is covering —
  // on an unpriced slot nobody's membership is doing anything. ──
  if (autobooking) {
    return (
      <div className="py-10 text-center space-y-3">
        <div className="mx-auto h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-muted-foreground">
          {hasAnyPrice ? t('memberCoveredHint') : tPublic('ctaBooking')}
        </p>
      </div>
    )
  }

  // ── THE MEMBER SCREEN — a caller this rail RECOGNISES, whether they arrived
  // with a contact session or signed in on the offer below. It replaces the
  // guest form for them entirely: the server would discard anything they typed
  // into it, so asking is a lie, and asking a member who is standing in their
  // own signed-in session is the defect this file was opened for.
  //
  // One screen, two CTAs, chosen by what they OWE rather than by how they got
  // here: nothing to pay → Confirm (books free); an amount → Pay. The base price
  // is struck through only when a benefit or a code actually lowered it. ──
  if (caller.kind !== 'guest') {
    // WHAT THIS PRICE WAS BEFORE, read off the ONE quote rather than re-derived:
    // the resolver stamps at most one of `appliedBenefit` / `appliedPromo`, so
    // "member price" and "code price" are mutually exclusive structurally. Null
    // once the server has refused our figure (nothing left to strike through)
    // and null on the `payment_required` race, where the client resolved free
    // and so has no quote to read a base off — no number beats a made-up one.
    const strikeBase = (() => {
      if (acceptedPrice !== null) return null
      if (callerPay?.type === 'pay') {
        const base =
          callerPay.appliedBenefit?.baseAmount ?? callerPay.appliedPromo?.baseAmount ?? null
        return base != null && base > callerPay.amount ? base : null
      }
      return null
    })()
    return (
      <>
        <div>
          {/* A session caller has no guest form behind them — Back leaves the
              booking step. Signing out is the corner pill's job, not this
              screen's. */}
          <BackButton
            label={backLabel}
            onClick={caller.kind === 'session' ? backFromIdentity : backToGuest}
          />
          <h1 className="text-2xl font-bold">{tPublic('welcomeBackTitle')}</h1>
          {caller.name && (
            <p className="text-muted-foreground mt-1 text-sm">
              {t('bookingAs', { name: caller.name })}
            </p>
          )}
          {partySummary}
        </div>
        <div className="rounded-xl border bg-card p-4 space-y-4">
          {/* The SENTENCE waits on the same fact the CTA does. Gating only the
              button left "Included with your subscription" on screen for the
              length of the round trip for a member whose subscription lapsed
              since sign-in — the frozen snapshot's answer, presented as the
              live one. A disabled button under a confident wrong price is not
              meaningfully safer than an enabled one. */}
          {heldPending ? (
            <Skeleton className="h-6 w-44" />
          ) : paysAtStudio && payNow != null ? (
            /* THE PRICE IS REAL, THE TILL IS NOT HERE. The studio has no Stripe
               account, so this length is booked now and paid in person. Saying
               so on the same line as the figure is the whole point: the visitor
               must not reach the door expecting to have paid already. */
            <div className="flex flex-col gap-0.5">
              <p className="text-base font-semibold">
                {t('yourPrice', { price: formatCurrency(payNow, currency, locale) })}
              </p>
              <p className="text-xs text-muted-foreground">{t('payAtStudioNote')}</p>
            </div>
          ) : owesPayment && payNow != null ? (
            <div className="flex items-baseline gap-2">
              {strikeBase != null && (
                <span className="text-sm text-muted-foreground line-through">
                  {formatCurrency(strikeBase, currency, locale)}
                </span>
              )}
              <p className="text-base font-semibold">
                {t('yourPrice', { price: formatCurrency(payNow, currency, locale) })}
              </p>
            </div>
          ) : (
            hasAnyPrice && (
              <div className="flex items-baseline gap-2">
                {priceAmount != null && (
                  <span className="text-sm text-muted-foreground line-through">
                    {formatCurrency(priceAmount, currency, locale)}
                  </span>
                )}
                <p className="text-base font-semibold">{t('memberCovered')}</p>
              </div>
            )
          )}

          {/* THE SECOND MOUNT: the code, on the screen that can be refused for
              it. Without it, a pay-time reserve refusal here (exhausted, busy,
              already used, disabled mid-checkout) left the visitor pressing a
              button that could not succeed and no way to drop the code — the sale
              lost to a discount that no longer existed. Removing the code
              re-quotes the price above, relabels the button and completes the
              purchase at the member rate.
              IT RENDERS FOR EVERY RECOGNISED CALLER, and used to render its
              input for a `session` caller only — on the reasoning that
              `previewPromoCode` resolves ITS caller from a contact session and
              nothing else, so a `code` caller would be quoted anonymously. True,
              but it is equally true of the guest screen, which has always shown
              the input and always recovered an anonymous preview's refusal at
              pay time through `promoCheckoutErrorMessage` /
              `priceChangedMessage`. What actually made the old shape dishonest
              was the other half of that condition: a chip CARRIED from the guest
              screen, quoted for whoever was there then and re-priced here for
              somebody else. That is gone — the identity rule retires an applied
              code with the identity that applied it — so every code on this
              screen was applied by this caller, and the only contract left is
              the one the guest screen already has. */}
          {hasAnyPrice && (
            <PromoCodeField
              teamId={teamId}
              target={{
                kind: 'appointment',
                providerId,
                activityId,
                startMs,
                durationMinutes,
                ...(party ? { people } : {}),
                ...(dateCount > 1 ? { quantity: dateCount } : {}),
              }}
              applied={promoApplied}
              onApplied={onPromoApplied}
              outcome={callerQuote?.promo ?? null}
              // Locked for the same instant the CTA is: a code applied against
              // the frozen held set would be retired by the live answer landing
              // under it, and "your code was removed" is a poor reward for
              // typing one.
              disabled={submittingPay || heldPending}
            />
          )}
          {/* WHY THE BUTTON BELOW CHANGED UNDER YOUR HANDS. On the
              `payment_required` race the client resolved this booking free, the
              server did not, and the CTA silently turned from "Confirm booking"
              into "Pay CHF X" with nothing to explain it — a member reading a
              covered price one moment and a charge the next, and no sentence
              claiming responsibility for the difference. The figure is the
              server's, so the reason is stated as the server's too. */}
          {showsRacePrice && (
            <p className="text-xs text-muted-foreground">{t('coverageEnded')}</p>
          )}
          {termsBlock}
          {errorBox}
          <button
            type="button"
            disabled={submittingPay || heldPending}
            onClick={owesPayment && payNow != null ? onMemberPay : onMemberBook}
            style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-sm"
          >
            {/* After a `price_changed` refusal the paid form of this button IS
                the consent: it names the server's figure and pressing it
                re-sends that number. */}
            {owesPayment && payNow != null
              ? submittingPay
                ? t('payingEllipsis')
                : t('confirmPay', { price: formatCurrency(payNow, currency, locale) })
              : submittingPay
                ? tPublic('ctaBooking')
                : tPublic('confirmBookingCta')}
          </button>
        </div>
      </>
    )
  }

  // ── Sign-in offer — the shared returning-member flow. Reached only via the
  // guest form's "check your price" link — never a requirement. It renders its
  // own back button + headings. ──
  if (screen === 'signIn') {
    return (
      <ReturningSignIn
        teamId={teamId}
        onVerified={onVerifiedAppointment}
        onBack={backToGuest}
        accentColor={accentColor}
        noAccountMessage={tPublic('errorNoAccountMembersOnly')}
      />
    )
  }

  // ── DEFAULT — guest details, for a visitor this rail does NOT recognise. The
  // sign-in offer is a link, never a gate. The visible submit is sr-only — the
  // parent's sticky bar drives it. ──
  return (
    <>
      <div>
        <BackButton label={backLabel} onClick={backFromIdentity} />
        <h1 className="text-2xl font-bold">{tPublic('yourDetailsTitle')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{tPublic('detailsSubtitle')}</p>
        {partySummary}
      </div>

      {/* The price this screen renders comes from the ONE quote above, so an
          applied code moves it here and nowhere else — and the same number is
          what goes back as `quotedAmount`. The base is struck through only when
          a modifier actually lowered it. */}
      {hasAnyPrice && payNow != null && (
        <p className="text-sm text-muted-foreground">
          {listTotal != null && payNow < listTotal && (
            <span className="mr-1.5 line-through">
              {formatCurrency(listTotal, currency, locale)}
            </span>
          )}
          {t('payToBook', { price: formatCurrency(payNow, currency, locale) })}
        </p>
      )}

      {/* Promo code — the only instrument this rail takes (appointments accept
          no gift card by design). The applied code persists in this component's
          state through the sign-in offer, so the post-verify member price
          already carries it — and the member screen re-mounts the field so it
          can be removed (or, for a session caller, typed) there too. Applying or
          removing one retires any accepted figure through the scope in
          `useAcceptedPrice`, not through a wrapper here. */}
      {hasAnyPrice && (
        <PromoCodeField
          teamId={teamId}
          target={{
                kind: 'appointment',
                providerId,
                activityId,
                startMs,
                durationMinutes,
                ...(party ? { people } : {}),
                ...(dateCount > 1 ? { quantity: dateCount } : {}),
              }}
          applied={promoApplied}
          onApplied={onPromoApplied}
          outcome={callerQuote?.promo ?? null}
          disabled={submittingGuest}
        />
      )}

      {hasAnyPrice && offersMemberBenefit && (
        <button
          type="button"
          onClick={() => setScreen('signIn')}
          className="flex w-full items-center gap-2 rounded-lg border border-dashed p-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          <Tag className="h-4 w-4 shrink-0" />
          {t('memberSignInOffer')}
        </button>
      )}

      {termsBlock}

      <GuestDetailsForm
        ref={guestFormRef}
        showPhone
        contactFields={contactFields}
        customFieldDefinitions={publicCustomFields}
        whatsappOptIn={{
          offered: publicTeam?.whatsapp_opt_in_offered === true,
          studioName: publicTeam?.name || '',
        }}
        submitting={submittingGuest}
        error={error}
        onSubmit={onSubmitGuest}
      />

      <p className="text-xs text-muted-foreground">{tPublic('consentText')}</p>
    </>
  )
}

