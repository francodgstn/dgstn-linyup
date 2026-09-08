/* eslint-disable no-console */
// createDropInCheckout — pay-per-class booking (Stripe Connect one-off charge).
//
// A contact NOT covered by an activity's access rule may pay the drop-in price to
// book a single group-class session. We create a PENDING booking (a hold) + a Connect
// checkout; the webhook (kind: 'drop_in') confirms the booking on payment success.
// Payment itself is the proof of intent, so no email-verification step is needed here.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  GUEST_SNAPSHOT,
  WAITLIST_SUBCOLLECTION,
  countHoldingSeats,
  isPastBookingCutoff,
  sanitizeBookingAnswers,
  seatsFree,
  normalizeRedemptionCode,
  resolvePaymentOptions,
  type DropInTarget,
  type GiftCardRedemptionPlan,
  type PaymentOptionsResult,
} from '@linyup/shared'
import { buildDropInTarget, resolveDropInForContact } from './dropInPricing'
import { loadBookingSettings } from './bookingSettings'
import {
  buildContactFieldPatch,
  expandContactFieldPatch,
} from './contactFields'
import { classIsFreeForEveryone, resolveBookingContactFields } from '@linyup/shared'
import type { CustomFieldDefinition } from '@linyup/shared'
import { loadEnabledTeam, requireChargeableAccount } from '../connect/access'
import {
  assertQuotedAmount,
  assertUnderCheckoutRateLimit,
  buildResultUrls,
  checkoutRateLimit,
  closeTeamCheckoutSession,
  defaultIdempotencyKey,
  requireChargeableAmountFromMajor,
  resolveCheckoutHoldWindow,
  SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES,
  startOneOffCheckout,
  STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES,
} from '../connect/checkout'
import {
  commitGiftCardDrawdown,
  giftCardCurrency,
  releaseGiftCardHold,
  reserveGiftCardDrawdown,
} from '../connect/giftCards'
import {
  NO_PROMO_ATTEMPT,
  bindPromoCheckoutSession,
  commitPromoRedemption,
  instrumentKeyParts,
  loadPromoAttempt,
  promoCheckoutMetadata,
  promoCheckoutOutcome,
  promoScopeOf,
  releasePromoReservation,
  reservePromoRedemption,
  resolvePromoCaller,
  type PromoAttempt,
  type PromoCaller,
  type PromoQuoteTarget,
  type PromoReservationTicket,
} from '../connect/promoCodes'
import { generateSecureToken, generateBookingReference } from '../utils/crypto'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { APP_CHECK_ENFORCE, monitorAppCheck } from '../utils/appCheck'
import { resolveSingleContact } from '../utils/contacts'
import { matchGuestContact } from './guestContactMatch'
import {
  attachWaiverContact,
  enforceWaiverGate,
  parseWaiverSubmissions,
  type WaiverGateOutcome,
} from '../waivers/gate'
import { recordWaiverEvents } from '../waivers/accept'
// The paid booking's receipt, shared with the Connect webhook's drop-in confirm
// — always on, outside the `booking_confirmation` toggle. See its header.
import { sendPaidBookingConfirmation } from './paidConfirmation'
// Pure trial-gate helpers, shared with bookSession's free trial door — see
// booking/index.ts's module doc comment. Mirrors the appointments/index.ts
// same-directory-index import pattern already used elsewhere in this package.
import { holdWriteCountDelta, resolveTrialEligibility, type ReplacedBookingShape } from './index'
import {
  resolveClaimCheckoutWindow,
  WAITLIST_CLAIM_RATE_LIMIT_BUCKET,
  type ClaimCheckoutWindow,
} from './waitlist/constants'

const HOLD_MINUTES = 30
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isCoveredResult = (r: PaymentOptionsResult): boolean =>
  r.options.some((o) => o.type === 'covered' || o.type === 'spend_credits')

export const createDropInCheckout = onCall({ enforceAppCheck: APP_CHECK_ENFORCE }, async (request) => {
  monitorAppCheck(request, 'createDropInCheckout')
  const data = request.data as {
    teamId?: string
    sessionId?: string
    contactDetails?: { firstname?: string; lastname?: string; email?: string; phone?: string }
    /** Answers to the studio's book-form contact fields — narrowed server side
     *  against the resolved list. See booking/contactFields.ts. */
    contactFieldAnswers?: Record<string, unknown>
    slug?: string
    locale?: string
    origin?: string
    idempotencyKey?: string
    // Paid trial: charges Activity.trialPriceAmount instead of dropIn.priceAmount,
    // requires trialEnabled, skips the drop-in enabled/priced requirement, and
    // enforces the trial-eligibility (one trial per person) check — see
    // Activity.trialPriceAmount and Contact.trial_used_at (@linyup/shared).
    trial?: boolean
    /** Optional gift-card code to draw down against this booking's price. */
    giftCardCode?: string
    /** Optional promo code — a Stage A price MODIFIER, resolved inside
     *  resolvePaymentOptions and never applied here. A code that turns out not
     *  to apply is REPORTED and the booking completes at list price; it never
     *  blocks the purchase. */
    promoCode?: string
    /** The price the surface actually rendered, major units. When it disagrees
     *  with what Stage A resolves, the checkout is REFUSED with `price_changed`
     *  rather than silently charging a different figure. Absent ⇒ proceed (an
     *  older client, or a surface with no price display). */
    quotedAmount?: number
    /** Answers to the activity's bookingQuestions, keyed by field id. Stored on
     *  the PENDING booking so they survive the Stripe round-trip. */
    questionAnswers?: Record<string, unknown>
    /** A waitlist offer's single-use `offer_token`. Present ⇒ this is a CLAIM:
     *  the seat is already held for the offer's contact, the caller is that
     *  contact (the token names them — no contactDetails are read), and the
     *  hold's deadline replaces the ordinary 30-minute one on both the booking
     *  and the Stripe session. See booking/waitlist/claim.ts. */
    waitlistToken?: string
    /** Ticks from the waiver step (see waivers/gate.ts). On a CLAIM the seat was
     *  already gated by `claimWaitlistSeat` and the acceptance is already on the
     *  ledger, so the claim page sends nothing across the payable hop and the
     *  gate finds the signature valid. */
    waiverAcceptances?: unknown
  }
  if (!data?.teamId) throw new HttpsError('invalid-argument', 'teamId is required')
  if (!data?.sessionId) throw new HttpsError('invalid-argument', 'sessionId is required')
  const { teamId, sessionId } = data
  const locale = data.locale ?? 'en'
  const db = admin.firestore()

  // ── Rate limit: which bucket, and charged or peeked ────────────────────────
  // Public endpoint, so the ordinary drop-in buyer pays the same per-IP hourly
  // quota as every other Connect checkout.
  //
  // A CLAIM does not. It is the paid half of `claimWaitlistSeat` — the free half
  // returns `requiresPayment` and sends the caller straight here with the offer
  // token — so charging it to the shared 'checkout' bucket puts the whole
  // peek/charge split back where it started: a gym NAT that has already produced
  // 30 checkout attempts this hour locks out the ONE person on earth holding a
  // live, single-use, time-boxed offer, their claim lapses, and the seat rolls on
  // to somebody else. So the claim peeks at the claim bucket (which still bounds
  // an enumerator, because it runs before any query) and charges only the
  // attempts whose token turns out to name no live offer. Same two calls, same
  // bucket, same order as claim.ts — the two must not disagree about who is
  // entitled to a free attempt.
  const waitlistToken = typeof data.waitlistToken === 'string' ? data.waitlistToken.trim() : ''
  /** THE only attempts a claim pays for: a token that resolves to no live offer
   *  is by definition not the person the seat is being held for. */
  const chargeClaimAttempt = (): Promise<void> =>
    checkoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)
  if (waitlistToken) {
    await assertUnderCheckoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)
  } else {
    await checkoutRateLimit(request.rawRequest?.ip)
  }

  // Team must have Connect enabled + a chargeable account.
  const team = await loadEnabledTeam(teamId)
  // Chargeable-account gate: a FULL-COVER gift-card redemption moves no money
  // and must work without Stripe onboarding — when a code is supplied, the
  // check is deferred to the orchestrator (which re-checks before any charge;
  // the reserved hold is released if that late check throws).
  if (!data.giftCardCode) requireChargeableAccount(team)

  // Session must be bookable, in the future, and a group class.
  const sessionSnap = await db.collection('sessions').doc(sessionId).get()
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found')
  const sessionData = sessionSnap.data()!
  if (sessionData.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'Session does not belong to this team')
  }
  if (!sessionData.allowBooking) {
    throw new HttpsError('permission-denied', 'Bookings are not allowed for this session')
  }
  if ((sessionData.start as Timestamp).toMillis() < Date.now()) {
    throw new HttpsError('failed-precondition', 'Cannot book sessions in the past')
  }
  // Online booking cutoff — same guard as the free path (bookSession); a
  // member paying instead of using the free door must not be able to route
  // around it.
  const bookingSettings = await loadBookingSettings(teamId)
  const { cutoffMinutes } = bookingSettings
  if (isPastBookingCutoff(sessionData.start as Timestamp, cutoffMinutes)) {
    throw new HttpsError('failed-precondition', 'Online booking has closed for this session.')
  }
  if (sessionData.activityType === 'appointment') {
    throw new HttpsError('failed-precondition', 'Drop-in is not available for appointment sessions')
  }

  // Resolve the activity → drop-in config + access rule.
  const activityId = sessionData.activityId as string | undefined
  if (!activityId) throw new HttpsError('failed-precondition', 'Session has no activity')
  const actSnap = await db.collection('activities').doc(activityId).get()
  if (!actSnap.exists) throw new HttpsError('not-found', 'Activity not found')
  const activity = actSnap.data()!
  // Book-form answers, narrowed to THIS activity's own questions. Same helper
  // the free path uses, so the two can't disagree about what gets stored.
  const sanitizedAnswers = sanitizeBookingAnswers(
    Array.isArray(activity.bookingQuestions) ? activity.bookingQuestions : null,
    data.questionAnswers
  )
  const activityName =
    (activity.name as string) || (sessionData.activityName as string) || 'Class'
  const isTrial = data.trial === true
  const trialPriceAmount = activity.trialPriceAmount as number | null | undefined

  // The one target the resolver prices for every caller of this class —
  // coverage rule, list price and the member rate (Activity.memberBenefit),
  // built by the SAME helper previewPromoCode uses so a quote and a charge can
  // never come from different fields (booking/dropInPricing.ts).
  const door = buildDropInTarget(activity, { asTrial: isTrial })
  if (!door.ok) {
    throw new HttpsError(
      'failed-precondition',
      door.reason === 'trial_unavailable'
        ? 'This class does not offer a paid trial'
        : 'Drop-in is not available for this class'
    )
  }
  const { target: dropInTarget, accessRule } = door
  // A LEGACY `open` class refuses payment; a modern "anyone may book" one does
  // not, because there the drop-in price is exactly how anyone pays. Reading the
  // tier alone would have made the new combination unsellable.
  if (classIsFreeForEveryone(accessRule)) {
    throw new HttpsError('failed-precondition', 'This class is free to book — no payment needed')
  }

  // Config sanity: the BASE price must be chargeable (member rates and promo
  // discounts clamp to the floor, so a valid base guarantees a valid effective
  // amount).
  requireChargeableAmountFromMajor(door.baseMajor)

  // Set below, ONCE, for every caller — see "the single resolution point".
  let resolved: PaymentOptionsResult

  // Resolve the contact (payment is proof — no email verification needed here).
  //
  // Empty until resolved, because a brand-new guest's contact is now created
  // BELOW the waiver gate rather than inside the branch that discovers them —
  // the gate has to refuse before the first contact write, and this is that
  // write. `pendingGuestContact` carries the decision across those few lines and
  // a guard immediately after the create makes the empty string unreachable.
  let contactId = ''
  let pendingGuestContact = false
  let email: string
  let firstname: string
  let lastname: string
  let phone: string | null = null
  let isNewContact = false

  // Trust ONLY the verified contact-session token for the caller's identity —
  // never a contactId from the request body (which would let anyone act as, and
  // enumerate, arbitrary contacts of the team). Guests carry no session and fall
  // through to the email/name path below.
  const contactSession = optionalContactSessionFromRequest(request)

  // ── A waitlist claim, if that is what this is ──────────────────────────────
  // Resolved FIRST and from storage, because the offer decides two things this
  // callable normally decides for itself: WHO is paying (the entry names the
  // contact, so a claimant never re-types their details and can never claim as
  // somebody else) and WHEN the hold dies. Everything here is a read — a bad
  // token must leave no trace, least of all a reserved gift-card drawdown.
  const waitlistRef = db.collection('sessions').doc(sessionId).collection(WAITLIST_SUBCOLLECTION)
  let claim: {
    entryRef: FirebaseFirestore.DocumentReference
    contactId: string
    /** THE deadline: the booking hold's expires_at AND the Stripe session's. */
    expiresAt: Timestamp
    answers: Record<string, unknown> | null
  } | null = null
  let claimCheckout: ClaimCheckoutWindow | null = null
  if (waitlistToken) {
    if (isTrial) {
      // A trial is a newcomer's first class, taken through the guest door with
      // its own once-per-person gate. Someone who queued for a full class and
      // was offered a seat is not that person. Charged: no claimant's client
      // ever sends this pair, so it is only reachable by hand — and it would
      // otherwise be a way to reach this callable's reads with a token that is
      // never looked up, and so never costs quota either way.
      await chargeClaimAttempt()
      throw new HttpsError('invalid-argument', 'A waitlist claim cannot be booked as a trial')
    }
    // Scoped to THIS session's queue — the token is unguessable, but a lookup
    // that can only ever return an entry of the session being paid for cannot
    // be pointed at another class by a mismatched request.
    const offerSnap = await waitlistRef.where('offer_token', '==', waitlistToken).limit(1).get()
    const offer = offerSnap.docs[0]
    const offerExpiresAt = offer?.data().offer_expires_at as Timestamp | undefined
    if (!offer || offer.data().status !== 'offered' || !offerExpiresAt) {
      await chargeClaimAttempt()
      throw new HttpsError('failed-precondition', 'This offer is no longer available.', {
        reason: 'claim_expired',
      })
    }
    if (offerExpiresAt.toMillis() <= Date.now()) {
      await chargeClaimAttempt()
      throw new HttpsError('failed-precondition', 'This offer has expired.', {
        reason: 'claim_expired',
      })
    }
    // A claimant may reach the pay button at minute 119 of a 120-minute window,
    // and Stripe will not create a session that expires sooner than its own
    // floor. Refuse with a reason the page renders as "this offer is about to
    // expire" rather than a generic failure — or, worse, a Stripe session that
    // outlives the seat it is paying for.
    //
    // Neither this refusal nor the contact-mismatch one below charges quota:
    // past this point the token HAS resolved to a live offer, and the two
    // callers who hit them are the rightful holder arriving late and someone who
    // was forwarded their link. Charging the first would let a shared NAT cost
    // that person their only retry.
    claimCheckout = resolveClaimCheckoutWindow({
      nowMs: Date.now(),
      claimExpiresAtMs: offerExpiresAt.toMillis(),
      minMinutes: SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES,
      maxMinutes: STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES,
    })
    if (!claimCheckout.payable) {
      throw new HttpsError('failed-precondition', 'This offer is about to expire.', {
        reason: 'claim_window_too_short',
      })
    }
    if (contactSession && contactSession.teamId === teamId && contactSession.contactId !== offer.id) {
      throw new HttpsError('permission-denied', 'This offer belongs to another contact')
    }
    claim = {
      entryRef: offer.ref,
      contactId: offer.id,
      expiresAt: offerExpiresAt,
      answers: (offer.data().question_answers as Record<string, unknown> | undefined) ?? null,
    }
  }

  // The booking answers were collected at JOIN so the claim page never re-asks
  // them — and both booking writes below are bare `.set()`s that replace the
  // document wholesale, so they have to be re-sent or the claim silently throws
  // away what the person already told the studio. A claim page that DOES send
  // them (an activity that added a question after they joined) wins.
  const claimAnswers = sanitizedAnswers ?? claim?.answers ?? null

  // ── WHO is buying — resolved BEFORE anything is priced ────────────────────
  // Phase 3 split identity from pricing, and that is not tidying. This callable
  // used to resolve payment options in FOUR places (claim / signed-in contact /
  // matched contact / fresh guest), so threading a promo into one of them broke
  // nothing loudly: the other three would simply charge the undiscounted price
  // to a visitor who had just been quoted a discount — for every member and
  // every waitlist claimant, i.e. exactly the people this feature is for. With
  // ONE resolution point that class of bug cannot be written.
  //
  // `contactDoc` is null only for a brand-new guest, who is by construction not
  // covered by anything.
  let contactDoc: (FirebaseFirestore.DocumentData & { id: string }) | null = null
  /** An existing OFF-FUNNEL contact (form/shop lead — no stage) enters the
   *  funnel by booking a drop-in; stamped after the coverage check, as before. */
  let funnelEntryRef: FirebaseFirestore.DocumentReference | null = null
  /**
   * Every contact already stored under the typed email, on the GUEST path only —
   * captured here and handed to `resolvePromoCaller`, which is what makes the
   * `new_contacts` audience gate mean the same thing on this rail as on the
   * appointment rail.
   *
   * It has to be THESE documents rather than a fresh query: the guest branch
   * below mints a provisional contact when nothing matches, so a query issued
   * after that point sees the new document too, reads as ambiguous, and lets a
   * long-standing member take a new-customers-only code just by spelling their
   * name differently on the guest form.
   */
  let guestEmailMatches: Array<FirebaseFirestore.DocumentData & { id: string }> | null = null

  if (claim) {
    const cSnap = await db.collection('contacts').doc(claim.contactId).get()
    if (!cSnap.exists || cSnap.data()?.teamId !== teamId) {
      throw new HttpsError('not-found', 'Contact not found')
    }
    const c = cSnap.data()!
    contactId = cSnap.id
    email = (c.email as string) || ''
    firstname = (c.firstname as string) || ''
    lastname = (c.lastname as string) || ''
    phone = (c.phone as string) || null
    contactDoc = { ...c, id: cSnap.id }
  } else if (contactSession && contactSession.teamId === teamId) {
    const cSnap = await db.collection('contacts').doc(contactSession.contactId).get()
    if (!cSnap.exists || cSnap.data()?.teamId !== teamId) {
      throw new HttpsError('not-found', 'Contact not found')
    }
    const c = cSnap.data()!
    contactId = cSnap.id
    email = (c.email as string) || ''
    firstname = (c.firstname as string) || ''
    lastname = (c.lastname as string) || ''
    phone = (c.phone as string) || null
    contactDoc = { ...c, id: cSnap.id }
  } else {
    const cd = data.contactDetails
    email = (cd?.email ?? '').toLowerCase().trim()
    firstname = (cd?.firstname ?? '').trim()
    lastname = (cd?.lastname ?? '').trim()
    phone = cd?.phone?.trim() || null
    if (!EMAIL_RE.test(email) || !firstname || !lastname) {
      throw new HttpsError('invalid-argument', 'firstname, lastname and a valid email are required')
    }
    // Exact match (email + name) → reuse; else create a trial contact.
    //
    // The predicate moved to `booking/guestContactMatch.ts` — the same code
    // `bookSession` runs, and now also the code `resolveWaiverRequirement` runs,
    // so a public probe cannot resolve a shared household mailbox to a different
    // person than the rail that charges it.
    const guest = await matchGuestContact(teamId, { email, firstname, lastname }, db)
    guestEmailMatches = guest.emailMatches.map((d) => ({ ...d.data(), id: d.id }))
    const match = guest.match
    if (match) {
      contactId = match.id
      contactDoc = { ...match.data(), id: match.id }
      if (!match.data().acquisition_stage) funnelEntryRef = match.ref
    } else {
      // DEFERRED, not created. The waiver gate below must run above the first
      // contact write, and this is it — see the gate's own comment.
      pendingGuestContact = true
    }
  }

  // ── The waiver gate — ABOVE the guest contact create ───────────────────────
  // Earlier than every other gate on this callable, and deliberately so: this
  // rail's refusals otherwise sit below a contact that has already been minted,
  // a gift-card drawdown that has already been reserved and a promo use that has
  // already been consumed. Nothing above this line has written anything.
  //
  // A brand-new guest has no contact id yet, and that is fine: with no contact
  // there is no signer row, so every required waiver reads `none` — the answer
  // is identical either way, and `attachWaiverContact` binds the acceptance to
  // the id once the contact exists.
  const waiverNowMs = Date.now()
  let waiverOutcome: WaiverGateOutcome = await enforceWaiverGate({
    teamId,
    activityId,
    subject: {
      contactId: contactId || null,
      name: `${firstname} ${lastname}`.trim(),
      email,
    },
    submissions: parseWaiverSubmissions(data.waiverAcceptances),
    source: 'drop_in',
    signerEmailVerifiedBy: contactSession && contactSession.teamId === teamId ? 'session' : 'none',
    ip: request.rawRequest?.ip ?? null,
    userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
    locale,
    nowMs: waiverNowMs,
    // A CLAIM arriving here has already been gated by `claimWaitlistSeat` and is
    // not re-prompted across the payable hop: its acceptance is already on the
    // ledger, so the gate finds it valid and asks for nothing. (There used to be
    // a second, explicit inheritance here — the claim rail's guardian DEFERRAL,
    // which had to be carried across the hop or a claim that deferred would be
    // refused by the rail it was sent to. No rail defers any more, so the
    // valid-signature path is the whole of it.)
  })

  // CONTACT FIELDS — the studio's own questions about the PERSON, resolved from
  // its book settings extended by this activity's list and narrowed against it.
  // Computed once, applied to whichever branch below owns the contact, so a
  // paid drop-in collects exactly what the free path collects.
  const contactFieldPatch = buildContactFieldPatch({
    // Reuses the settings already read for the cutoff above — one read.
    fields: resolveBookingContactFields(bookingSettings, activity.contactFields),
    answers: data.contactFieldAnswers,
    definitions: (team.data.custom_field_definitions ?? null) as CustomFieldDefinition[] | null,
    existing: contactDoc,
  })

  if (pendingGuestContact) {
    isNewContact = true
    const ref = db.collection('contacts').doc()
    await ref.set({
      firstname,
      lastname,
      email,
      phone,
      // Nested, never dotted — see expandContactFieldPatch.
      ...expandContactFieldPatch(contactFieldPatch),
      acquisition_stage: 'trial_booked',
      acquisition_stage_updated_at: FieldValue.serverTimestamp(),
      entry: 'booking',
      // Doesn't count toward the cap until they attend/pay (the drop-in payment
      // webhook clears the flag on success). See Contact.provisional.
      provisional: true,
      teamId,
      archived_at: null,
      deleted_at: null,
      created_at: FieldValue.serverTimestamp(),
    })
    contactId = ref.id
  } else if (contactId && Object.keys(contactFieldPatch).length > 0) {
    await db.collection('contacts').doc(contactId).update(contactFieldPatch)
  }
  if (!contactId) throw new HttpsError('internal', 'The buyer could not be resolved')
  waiverOutcome = attachWaiverContact(waiverOutcome, contactId)

  // The acceptance is written HERE — before Stripe, in its own transaction, and
  // NOT conditional on payment. A signature is a fact about a person: they read
  // the text and ticked, and that is true whether or not the card clears. The
  // asymmetry with a promo reservation is deliberate — a promo guards a finite
  // counter and must be consumed only by a completed sale; a signature guards
  // nothing and reserves nothing.
  //
  // It is a TRANSACTION rather than a bare write because Firestore's
  // optimistic-concurrency detection is the only thing standing between a
  // manager revoking at 10:00:00 and an acceptance that read the row at
  // 09:59:59 landing at 10:00:01 and silently undoing it.
  await recordWaiverEvents(waiverOutcome.accepts, waiverNowMs)

  // ── The promo, loaded before Stage A and NEVER throwing ───────────────────
  // A code that does not apply is REPORTED, never silently charged, and never
  // blocks the purchase (the only thing a checkout refuses over is a price the
  // caller was not shown — see the quotedAmount guard below).
  //
  // NOT ON A WAITLIST CLAIM. Decided 2026-08-14 (Q11): the claim rail is the one
  // whose Stripe deadline cannot be shortened without giving one seat two timers
  // — the booking hold, the queue entry's offer_expires_at and the session are
  // ONE instant — so a code applied here would lock a use of a strictly-capped
  // campaign for the whole claim window (~124 min by default, up to 24 h if a
  // studio configures it). Strict cap plus longest hold is the worst pairing in
  // the design. There is no promo field on the claim page; a hand-made request
  // that carries one is reported `not_applicable` rather than blocked.
  const promoTarget: PromoQuoteTarget = {
    kind: 'drop_in',
    sessionId,
    activityId,
    trial: isTrial,
  }
  // ONE caller, resolved once and read by both the loader and the reserve — the
  // two moments must not answer "is this person already a member?" differently.
  //
  // Both halves of the evidence go in, and `contactDoc` being non-null does NOT
  // settle it: "joined" is a property of the EMAIL, not of whichever document
  // this rail happens to be buying as. The guest form is where that bites twice
  // over — `contactDoc` is null for anybody whose (email + exact first + exact
  // last) does not match (a joined "Ann Smith" booking as "A. Smith"), and it is
  // NON-null but not-joined for the other member of a household sharing one
  // mailbox. Both would otherwise read as a brand-new contact and walk straight
  // through a `new_contacts` code.
  //
  // `guestEmailMatches` is passed rather than left to the helper's own query
  // because of the provisional mint below — see its declaration.
  //
  // A CLAIM never asks: this rail refuses a code on the claim path outright
  // (below), so the gate is unreachable there and its lookup would be a read
  // that cannot change an answer.
  const promoCaller: PromoCaller = await resolvePromoCaller({
    teamId,
    contact: contactDoc,
    email,
    emailMatches: guestEmailMatches,
    codeTyped: !claim && Boolean(data.promoCode),
  })
  const promo: PromoAttempt = claim
    ? {
        ...NO_PROMO_ATTEMPT,
        code: data.promoCode ? normalizeRedemptionCode(data.promoCode) : null,
        refusal: data.promoCode ? 'not_applicable' : null,
      }
    : await loadPromoAttempt({
        teamId,
        code: data.promoCode,
        target: promoTarget,
        caller: promoCaller,
        chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
      })
  const promoContext = promo.modifier ? { promo: promo.modifier } : undefined

  // ── THE single resolution point ───────────────────────────────────────────
  resolved = contactDoc
    ? await resolveDropInForContact(
        teamId,
        dropInTarget,
        contactDoc,
        (sessionData.start as Timestamp).toDate(),
        promoContext
      )
    : resolvePaymentOptions(GUEST_SNAPSHOT, dropInTarget, promoContext)

  // A supplied modifier that produced NO outcome is a programming error — a
  // missed resolver call site — and must be loud rather than a silent
  // full-price charge.
  if (promo.modifier && !resolved.promo) {
    throw new HttpsError('internal', 'The promo code did not reach the resolver')
  }

  if (isCoveredResult(resolved)) {
    // Someone who can already book free must not be sold a drop-in — and a
    // covered CLAIM never comes through checkout at all (claimWaitlistSeat
    // settles it for nothing).
    throw new HttpsError('failed-precondition', 'You can already book this class for free')
  }
  if (funnelEntryRef) {
    await funnelEntryRef.update({
      acquisition_stage: 'trial_booked',
      acquisition_stage_updated_at: FieldValue.serverTimestamp(),
      trial_booked_at: FieldValue.serverTimestamp(),
    })
  }

  // The caller's effective amount — base price, their member rate, or the promo
  // price, whichever is lowest (best-one-wins, decided inside the resolver).
  const payOption = resolved.options.find((o) => o.type === 'pay')
  if (!payOption) {
    // A KNOWN contact who already used their trial gets the dedicated,
    // reason-carrying refusal the web maps to its trial-used message — the
    // generic throw below would swallow it (guests are covered by the
    // email-resolved eligibility check further down).
    if (resolved.denial === 'trial_used') {
      throw new HttpsError('failed-precondition', 'This email has already used a trial', {
        reason: 'trial_used',
      })
    }
    throw new HttpsError('failed-precondition', 'Drop-in is not available for this class')
  }
  const priceMajor = payOption.amount
  const amount = requireChargeableAmountFromMajor(priceMajor)

  // ── The price the caller was SHOWN ────────────────────────────────────────
  // Scoped to a PROMO-CARRYING checkout: a code is the only thing that makes the
  // rendered figure a promise rather than an optimistic render, and the client's
  // snapshot is documented as partial (see assertQuotedAmount). Absent quote ⇒
  // proceed. Refusal carries the server's figure so the surface can offer it —
  // and `promo.refusal`, because on this rail that is usually WHY the figure
  // moved: the guest form's email is resolved here and nowhere earlier, so a
  // `new_contacts` code that previewed fine for an anonymous visitor is refused
  // at exactly this point. Reporting only "the price changed" told that visitor
  // something untrue about what happened.
  assertQuotedAmount(data.quotedAmount, priceMajor, {
    promoAttempted: Boolean(data.promoCode),
    promoRefusal: promo.refusal,
  })

  // Trial eligibility: one trial per person, ever — free or paid. Resolved by
  // email (never the looser name+email match above), same lookup bookSession's
  // free trial door uses. Only enforced in trial mode.
  if (isTrial) {
    const { contactId: eligibilityContactId } = await resolveSingleContact(teamId, email)
    let trialUsedAt: unknown = null
    if (eligibilityContactId) {
      const eligibilityDoc = await db.collection('contacts').doc(eligibilityContactId).get()
      trialUsedAt = eligibilityDoc.exists ? eligibilityDoc.data()?.trial_used_at : null
    }
    const eligibility = resolveTrialEligibility(trialUsedAt)
    if (!eligibility.ok) {
      throw new HttpsError('failed-precondition', 'This email has already used a trial', {
        reason: eligibility.reason,
      })
    }
  }

  // Guard: already registered (confirmed booking or attendance).
  const sessionRef = db.collection('sessions').doc(sessionId)
  const bookingsRef = sessionRef.collection('bookings')
  const bookingRef = bookingsRef.doc(contactId)
  const contactDocRef = db.collection('contacts').doc(contactId)
  const [bookingSnap, participantSnap] = await Promise.all([
    bookingRef.get(),
    sessionRef.collection('participants').doc(contactId).get(),
  ])
  if (participantSnap.exists || (bookingSnap.exists && bookingSnap.data()?.status === 'confirmed')) {
    throw new HttpsError('already-exists', 'You are already registered for this session')
  }

  // ── Capacity, fail-fast ────────────────────────────────────────────────────
  // This callable had NO capacity check whatsoever: a full class sold drop-ins,
  // deterministically, no race required. The authoritative gate is inside the
  // booking transaction below; this early copy (same helper, same predicate)
  // refuses before anything with a side effect happens — before a gift-card
  // drawdown is reserved, before a Stripe session exists.
  //
  // It sits AFTER contact resolution because it needs the caller's own id: their
  // live-but-unpaid hold occupies a seat, and counting it would refuse them
  // permission to pay for the seat they are already holding.
  const preflightSeats = seatsFree(
    sessionData.max_participants as number | undefined,
    countHoldingSeats((await bookingsRef.get()).docs, Date.now(), contactId)
  )
  if (preflightSeats <= 0) {
    throw new HttpsError('resource-exhausted', 'This session is fully booked.', {
      reason: 'session_full',
    })
  }

  const bookingToken = generateSecureToken()
  const bookingReference = generateBookingReference()
  // A claim has exactly ONE deadline, and this is it: the booking hold, the
  // waitlist entry's `offer_expires_at` and the Stripe session below all expire
  // at the same instant. Two timers for one seat is how a seat gets sold twice —
  // the hold releases at +30, someone else takes it, and the original payer's
  // Stripe session is still live hours later. HOLD_MINUTES does not apply to a
  // claim at all.
  const expiresAt = claim?.expiresAt ?? Timestamp.fromMillis(Date.now() + HOLD_MINUTES * 60_000)

  // The Stripe session's deadline and the window every reservation riding it
  // must outlive, derived ONCE from the same number (see
  // resolveCheckoutHoldWindow). A claim brings its own already-reconciled
  // instant; every other drop-in gets the short window, because a drop-in's
  // booking hold frees the seat at +HOLD_MINUTES whatever the buyer pays with.
  //
  // Deriving the two separately is what made a 120-minute claim reserve its
  // gift-card drawdown for a flat 35 minutes, freeing the held value for
  // another purchase while the claim was still payable.
  //
  // FIXING THE INSTANT HERE STARTS A CLOCK, and this rail has the most work of
  // any between that instant and its Stripe create: the promo reserve (a
  // transaction plus up to two Stripe calls, because superseding a slot closes
  // the session it was already backing), the gift-card reserve, and the
  // booking-hold transaction. All of it is spent out of
  // CHECKOUT_WINDOW_WORK_BUDGET_SECONDS — 60s on the short window (31 minutes
  // chosen, 30 required by Stripe). The instant cannot be computed later without
  // re-introducing the two-computations bug above, so the budget is enforced
  // rather than avoided: assertCheckoutWindowPayable refuses inside
  // startOneOffCheckout, and THE guard below hands every reservation back.
  const promoApplied = resolved.promo?.status === 'applied'
  const holdWindow = resolveCheckoutHoldWindow({
    nowMs: Date.now(),
    carriesReservation: Boolean(data.giftCardCode) || promoApplied,
    fixedExpiresAtEpochSeconds: claimCheckout?.expiresAtEpochSeconds,
    alwaysBounded: true,
  })

  // ── RESERVE, in the order the failure modes dictate ───────────────────────
  //
  // The promo goes FIRST, and it goes here rather than higher up:
  //  • AFTER the non-money gates (trial eligibility, already-registered,
  //    capacity), because none of them has a release path — nothing is reserved
  //    above them. A visitor with a ten-use flyer code clicking Pay on a full
  //    class would otherwise burn a use and, because the reservation is keyed to
  //    her own identity, bar herself from the code on any OTHER class for the
  //    whole window; ten such clicks would exhaust the campaign without a sale.
  //  • BEFORE the gift card, because the drawdown is computed against
  //    `priceMajor`; if the promo reservation could fail after it, the card
  //    would have been reserved against a price that no longer applies.
  //
  // A promo refusal REFUSES THE CHECKOUT — it never silently re-prices. The
  // caller was quoted a discount we can no longer honour, which is the one case
  // a checkout must refuse rather than charge something else.
  //
  // THE TICKET IS THE ONLY PROOF ANYTHING WAS RESERVED. It stays null unless the
  // resolver said `applied`, and everything downstream that touches the
  // reservation — the checkout metadata, the release, the full-cover commit —
  // takes it. So a valid code that LOST best-one-wins cannot reach the webhook's
  // commit and burn a use it never got.
  let promoTicket: PromoReservationTicket | null = null
  if (promoApplied && promo.code) {
    promoTicket = await reservePromoRedemption({
      teamId,
      code: promo.code,
      contactId,
      identityKey: promo.identityKey,
      reservationKey: promo.reservationKey,
      targetKey: promo.targetKey,
      scope: promoScopeOf(promoTarget),
      caller: promoCaller,
      // The same instant the Stripe session gets, plus the promo BACKSTOP — two
      // copies of one number, never two computations. Longer than the gift
      // card's margin on purpose: this slot is freed by the expiry webhook, and
      // its lazy expiry must not race the delivery of the completion webhook
      // that decides the same slot (PROMO_RESERVATION_BACKSTOP_MINUTES).
      expiresAt: Timestamp.fromMillis(
        Date.now() + (holdWindow.promoHoldMinutes ?? 0) * 60_000
      ),
      amountMajor: priceMajor,
      baseAmount: payOption.appliedPromo?.baseAmount ?? priceMajor,
      chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
      // Close the session this slot was already backing before minting another,
      // or refuse. A drop-in duplicate is refunded by the webhook, but the slot
      // it consumed is not — and the same reserve serves the rails where a
      // second payment is a second genuine order.
      closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
    })
  }

  // Optional gift-card redemption — reserve a drawdown against the total BEFORE
  // writing any booking doc (a failed/invalid code must leave no trace).
  let giftCardPlan: GiftCardRedemptionPlan | null = null
  let giftCardHoldKey: string | null = null
  /**
   * Hand back everything reserved, in the REVERSE of the order it was taken:
   * gift card, then promo. Both are idempotent no-ops when nothing was
   * reserved, or when it has already been committed.
   *
   * This is called from ONE guard spanning every path from the reservations to
   * the successful return — not from an enumerated list of catch sites. The set
   * of throw sites in between is larger than it looks and grows with the code:
   * reserveGiftCardDrawdown's three throws, the full-cover booking transaction,
   * the pending-hold transaction and the Stripe create. (An earlier version of
   * this comment named the capacity refusal as a caller; that refusal moved
   * ABOVE the reservations and the comment did not, which is how a stale
   * precondition comment becomes a wrong design.)
   */
  const releaseReserved = async (): Promise<void> => {
    if (giftCardPlan && data.giftCardCode && giftCardHoldKey) {
      await releaseGiftCardHold({
        teamId,
        code: data.giftCardCode,
        holdKey: giftCardHoldKey,
      }).catch(() => undefined)
    }
    if (promoTicket) {
      await releasePromoReservation({
        teamId,
        code: promoTicket.code,
        reservationKey: promoTicket.reservationKey,
        // OUR instance: if a later attempt at this same purchase already
        // refreshed the entry, this release is a no-op rather than unguarding a
        // slot that session still needs.
        instanceId: promoTicket.instanceId,
      }).catch(() => undefined)
    }
  }

  try {
  if (data.giftCardCode) {
    giftCardHoldKey = generateSecureToken(16)
    giftCardPlan = await reserveGiftCardDrawdown({
      teamId,
      code: data.giftCardCode,
      // Post-promo: the resolver already applied the modifier, so the card is
      // drawn against the discounted total with no change to its own code.
      totalMajor: priceMajor,
      holdKey: giftCardHoldKey,
      // Same instant the Stripe session below gets, plus the margin — the hold
      // must outlive the payment window it is guarding.
      holdMinutes: holdWindow.holdMinutes,
      // The card must match the currency this booking will actually be charged
      // in — see the guard in reserveGiftCardDrawdown.
      chargeCurrency: giftCardCurrency(team.data?.default_currency as string | undefined),
    })
  }

  if (giftCardPlan && giftCardPlan.residual === 0) {
    // FULL COVER — no Stripe at all: confirm the booking directly, mirroring
    // handleDropInCheckout's confirm effects (minus payment_intent_id, which
    // doesn't exist on this path).
    //
    // Seat + counter in one transaction, for the same reason as bookSession: the
    // session doc is the serialization point, and `bookings_count` is written as
    // an absolute value from the read set (the old `increment(1)` landed on top
    // of trackBookings' recount of this very write). A refusal here has to hand
    // the reserved stored value back — the drawdown is committed further down,
    // so bailing out before that leaves the balance held but unspent.
    //
    // A CLAIM flips its waitlist entry in this very transaction. This branch
    // creates no Stripe session, so no webhook ever fires for it and there is no
    // later hook to hang the flip on — and the seat becomes permanent HERE. An
    // entry left at 'offered' behind a confirmed, gift-card-paid booking is the
    // worst state the feature has: the sweep would match it, and a release that
    // did not check the booking would delete a paid seat and hand it to the next
    // person, costing the buyer both the balance and the class.
    try {
      await db.runTransaction(async (tx) => {
        const freshSession = await tx.get(sessionRef)
        if (!freshSession.exists) throw new HttpsError('not-found', 'Session not found')
        const bookingsSnap = await tx.get(bookingsRef)
        // Read rather than blind-update, exactly as the Connect webhook does with
        // the same document: a `tx.update` on an entry that was purged (the queue
        // of a deleted session is hard-deleted by teardownWaitlistOnSessionDeleted)
        // throws, and stored value that has already been reserved must never be
        // lost to a bookkeeping document.
        const entrySnap = claim ? await tx.get(claim.entryRef) : null
        const holding = countHoldingSeats(bookingsSnap.docs, Date.now(), contactId)
        if (seatsFree(freshSession.data()?.max_participants as number | undefined, holding) <= 0) {
          throw new HttpsError('resource-exhausted', 'This session is fully booked.', {
            reason: 'session_full',
          })
        }
        // A full set, no merge — which is also what retires the claim fields the
        // promoter wrote. Leaving `waitlist_claim` on a confirmed booking would
        // make it stop holding its seat at `claim_expires_at` (bookingHoldsSeat
        // → isExpiredWaitlistClaim), silently freeing a seat that is paid for.
        tx.set(bookingRef, {
          firstname,
          lastname,
          email,
          phone,
          contact: contactId,
          session: sessionId,
          teamId,
          joinedAt: FieldValue.serverTimestamp(),
          fromBioLink: true,
          is_new_contact: isNewContact,
          booking_token: bookingToken,
          booking_reference: bookingReference,
          source: 'online' as const,
          ...(claimAnswers ? { question_answers: claimAnswers } : {}),
          ...(claim ? { claimed_from_waitlist: true } : {}),
          authenticated_booking: !!contactSession,
          status: 'confirmed',
          payment_status: 'gift_card',
          // Denormalised for the day sheet / printed manifest only; absent when
          // no required waiver applied.
          ...(waiverOutcome.bookingWaiverState
            ? { waiver_state: waiverOutcome.bookingWaiverState }
            : {}),
        })
        if (claim && entrySnap?.exists) {
          tx.update(claim.entryRef, {
            status: 'claimed',
            claimed_at: FieldValue.serverTimestamp(),
            offer_token: FieldValue.delete(),
          })
        }
        tx.set(
          sessionRef,
          {
            has_bookings: true,
            bookings_count: holding + 1,
            last_booking_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      })
    } catch (err) {
      await releaseReserved()
      throw err
    }
    // A gift-card payment confirms a provisional contact, exactly as a paid
    // Stripe drop-in does (handleDropInCheckout clears it for ANY provisional
    // contact). This used to fire only for a contact created a moment ago, which
    // left a waitlist-born one — provisional WITH a reaper date — to be deleted
    // 30 days after a class they paid for and attended. Deleting an absent field
    // is a no-op, so the unconditional write costs one update.
    await db.collection('contacts').doc(contactId).update({
      provisional: FieldValue.delete(),
      provisional_expires_at: FieldValue.delete(),
    })
    if (isTrial) {
      await db
        .collection('contacts')
        .doc(contactId)
        .update({ trial_used_at: FieldValue.serverTimestamp() })
    }
    await db
      .collection('contacts')
      .doc(contactId)
      .collection('activity_log')
      .add({
        type: 'drop_in_booked',
        source: 'gift_card',
        message: `Drop-in booking · ${activityName}`,
        timestamp: FieldValue.serverTimestamp(),
      })
    // Commit + journal in one call. Nothing else records this sale: a
    // full-cover booking creates no Stripe session, so handleCheckoutCompleted
    // never runs and there is no member_payments doc either.
    await commitGiftCardDrawdown({
      teamId,
      code: data.giftCardCode!,
      holdKey: giftCardHoldKey!,
      targetCategory: 'drop_in',
      contactId,
      description: `Drop-in · ${activityName}`,
    })
    // …and the promo, for the same reason and NOT on the same call. It cannot
    // ride on commitGiftCardDrawdown: that function returns early for a card
    // with nothing left to commit and again for an `admin_comp` card, and it
    // only runs at all when a gift-card code was supplied — so a promo used
    // WITHOUT a card (the overwhelmingly common case) would never commit its
    // reservation, giving the discount and losing the count with no error and
    // no alarm.
    if (promoTicket) {
      await commitPromoRedemption({
        teamId,
        code: promoTicket.code,
        reservationKey: promoTicket.reservationKey,
        instanceId: promoTicket.instanceId,
        // Our own claim deadline: only the attempt still holding the slot spends
        // it. Here the reserve is seconds old, so it is always ours.
        reservationExpiresMs: promoTicket.expiresAtMs,
        fallbackContactId: contactId,
        fallbackIdentityKey: promoTicket.identityKey,
        fallbackAmountMajor: priceMajor,
        targetKind: 'drop_in',
      }).catch((err) => {
        // Best-effort, exactly like its gift-card neighbour: the customer paid
        // and owning the seat matters more than the count. A lapsed reservation
        // under-reports by one, which is the safe direction.
        console.error('[promo] full-cover drop-in commit failed:', err)
      })
    }
    // THE SAME RECEIPT THE STRIPE-PAID DROP-IN GETS (UX-76). Stored value is
    // money: this branch confirms a seat, spends a balance and — until now —
    // said nothing, so a card-paying buyer got a confirmation with a
    // manage-booking link and a gift-card-paying one got silence. Always on for
    // the same reason; see booking/paidConfirmation.ts. `giftCardHoldKey` is the
    // tender ref, minted once per attempt, so a client retry cannot mail twice.
    await sendPaidBookingConfirmation({
      teamId,
      sessionId,
      contactId,
      tenderRef: `gc:${giftCardHoldKey}`,
      paid: {
        amount: giftCardPlan.drawdown,
        currency: giftCardCurrency(team.data?.default_currency as string | undefined),
      },
      recipient: { firstname, lastname, email },
    })
    return {
      url: null,
      sessionId: null,
      paidWithGiftCard: true,
      amount: 0,
      drawdown: giftCardPlan.drawdown,
      ...promoCheckoutOutcome(promo, resolved),
    }
  }

  // Write / overwrite the PENDING hold, gated on capacity in the same
  // transaction. The hold HOLDS A SEAT from this instant (bookingHoldsSeat
  // counts a live `required` hold), so it has to be taken under the same lock
  // every other seat is taken under — otherwise a full class keeps selling
  // checkouts and the payer discovers at the door that there was never a seat.
  // The seat counter moves here, not in the webhook, for the same reason.
  //
  // The CONTACT counter moves here too, and only here, because this is the write
  // that decides which kind of hold the document is. A plain drop-in hold is
  // uncounted for its whole life (nobody increments it, expirePendingBookings
  // deletes it without a decrement); a waitlist claim hold is counted from the
  // moment the promoter mints it. Turning one into the other — which is exactly
  // what an offer holder does by abandoning the claim link and buying through the
  // ordinary form — has to move the ledger with it, or the count is stranded on a
  // document that every later reader treats as uncounted. See holdWriteCountDelta
  // for the full shape table; the fixtures are pendingBookingsCount.test.ts.
  try {
    await db.runTransaction(async (tx) => {
      const freshSession = await tx.get(sessionRef)
      if (!freshSession.exists) throw new HttpsError('not-found', 'Session not found')
      const bookingsSnap = await tx.get(bookingsRef)
      const holding = countHoldingSeats(bookingsSnap.docs, Date.now(), contactId)
      if (seatsFree(freshSession.data()?.max_participants as number | undefined, holding) <= 0) {
        throw new HttpsError('resource-exhausted', 'This session is fully booked.', {
          reason: 'session_full',
        })
      }
      const countDelta = holdWriteCountDelta(
        bookingsSnap.docs.find((d) => d.id === contactId)?.data() as
          | ReplacedBookingShape
          | undefined,
        !!claim
      )
      // Read rather than blind-update, the same reason the promoter reads its
      // candidates: a contact document can be gone (a purged provisional
      // contact), and `tx.update` on a missing document throws — which would
      // fail a checkout over a counter.
      const contactSnap = countDelta === 0 ? null : await tx.get(contactDocRef)
      tx.set(bookingRef, {
        firstname,
        lastname,
        email,
        phone,
        contact: contactId,
        session: sessionId,
        teamId,
        joinedAt: FieldValue.serverTimestamp(),
        fromBioLink: true,
        is_new_contact: isNewContact,
        booking_token: bookingToken,
        booking_reference: bookingReference,
        // Drop-in checkout is only reachable from the public booking page.
        source: 'online' as const,
        ...(claimAnswers ? { question_answers: claimAnswers } : {}),
        authenticated_booking: !!contactSession,
        status: 'pending',
        payment_status: 'required',
        expires_at: expiresAt,
        // A CLAIM stays a claim while it is being paid for. This `.set()` has no
        // merge option, so the promoter's hold fields have to be rewritten here
        // or the seat quietly stops being the queue's: the entry would still say
        // 'offered' while the booking had become an ordinary drop-in hold, and
        // on abandonment expirePendingBookings would delete it and leave the
        // entry stuck at 'offered' forever — a permanently blocked queue.
        ...(claim ? { waitlist_claim: true, claim_expires_at: claim.expiresAt } : {}),
        // Denormalised for the day sheet / printed manifest only; absent when no
        // required waiver applied.
        ...(waiverOutcome.bookingWaiverState
          ? { waiver_state: waiverOutcome.bookingWaiverState }
          : {}),
      })
      tx.set(
        sessionRef,
        {
          has_bookings: true,
          bookings_count: holding + 1,
          last_booking_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      if (countDelta !== 0 && contactSnap?.exists) {
        tx.update(contactDocRef, { pending_bookings_count: FieldValue.increment(countDelta) })
      }
    })
  } catch (err) {
    await releaseReserved()
    throw err
  }

  // Create the Connect checkout; the webhook (kind: 'drop_in') confirms the booking.
  const slugQuery = data.slug ? `&slug=${encodeURIComponent(data.slug)}&seg=booking` : ''
  const { successUrl, cancelUrl } = buildResultUrls(locale, {
    extraQuery: slugQuery,
    origin: data.origin,
  })
  const metadata: Record<string, string> = {
    teamId,
    kind: 'drop_in',
    purpose: 'drop_in',
    sessionId,
    contactId,
    activityName,
    // Trial mode keeps kind: 'drop_in' (so the existing webhook path confirms
    // it) and just flags itself for the extra trial_used_at stamp — see
    // handleDropInCheckout.
    ...(isTrial ? { trial: 'true' } : {}),
    // Tells the webhook this payment settles a waitlist claim, so it flips the
    // entry in the same transaction that confirms the booking. The value is the
    // entry's own doc id (= contactId) rather than a flag, so the webhook never
    // has to infer which queue it is closing.
    ...(claim ? { waitlistEntry: claim.contactId } : {}),
    ...(giftCardPlan
      ? {
          giftCardCode: normalizeRedemptionCode(data.giftCardCode!),
          giftCardHold: giftCardHoldKey!,
          giftCardDrawdown: String(giftCardPlan.drawdown),
        }
      : {}),
    // The promo's mirror of that trio — what the webhook commits, and what
    // handleCheckoutExpired releases. Keyed off the TICKET, so it is stamped IFF
    // a reservation was actually taken: a code that loaded but lost
    // best-one-wins leaves this empty and the webhook has nothing to commit.
    ...promoCheckoutMetadata(promoTicket, priceMajor),
  }
  const idempotencyKey =
    data.idempotencyKey ??
    // The applied instruments are APPENDED, last, never reordered: Stripe
    // rejects a reused idempotency key whose request parameters differ, and this
    // key buckets by minute — so "submit at 40.00, get bounced, type a code,
    // resubmit twelve seconds later" is the same key with a different amount,
    // which surfaces as a bare `internal` "Failed to start checkout". A call
    // with no instruments produces ZERO extra parts and therefore a
    // byte-identical key (moneyCore.test.ts snapshots all eight legacy shapes).
    defaultIdempotencyKey(
      'dropin',
      teamId,
      sessionId,
      contactId,
      // The gift card contributes its HOLD KEY as well as its code — that key is
      // stamped into the metadata above and is therefore a request parameter, so
      // a key without it is reused across attempts whose parameters differ. This
      // rail already mints it above the key, so nothing had to be hoisted here.
      ...instrumentKeyParts(
        promoTicket,
        data.giftCardCode && giftCardHoldKey
          ? { code: data.giftCardCode, holdKey: giftCardHoldKey }
          : null
      )
    )

  // A gift hold is live only when giftCardPlan is set — give Stripe a SHORT
  // expiry then so the hold releases promptly (drop-in otherwise has no
  // checkout expiry; Stripe's 24h default would sit on the card too long).
  const chargeAmount = giftCardPlan ? requireChargeableAmountFromMajor(giftCardPlan.residual) : amount

  let checkout
  try {
    checkout = await startOneOffCheckout({
      team,
      amountMinor: chargeAmount,
      productName: `${isTrial ? 'Trial' : 'Drop-in'} · ${activityName}`,
      successUrl,
      cancelUrl,
      customerEmail: email || undefined,
      metadata,
      idempotencyKey,
      // The Stripe session must NEVER outlive the booking hold it represents.
      //
      // The hold frees its seat at +HOLD_MINUTES (30) — `bookingHoldsSeat`
      // stops counting it and `bookSession` persists that correction — while a
      // Stripe session left to its own devices stays payable for 24 HOURS. That
      // gap is an oversell AND a wrong charge: the seat gets handed to someone
      // else at +31 min, then the original buyer pays hours later and
      // `handleDropInCheckout` confirms unconditionally (it must — a real charge
      // can never be dropped), so the class ends up over capacity and the payer
      // holds a seat that no longer exists.
      //
      // SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES (31) is one minute past the hold, so
      // the payment window closes just after the seat is released. This applies
      // to EVERY drop-in, not only gift-card ones — the gift-card branch was
      // already correct for its own reasons and the plain path was the 24-hour
      // hole.
      //
      // A CLAIM expires with its own window instead — the same instant as the
      // booking hold and the waitlist entry, which is the whole point of
      // collapsing the three timers into one (resolveClaimCheckoutWindow).
      //
      // Both this instant and the gift-card hold above come from the ONE
      // holdWindow computed before the reservation; they are two copies of one
      // number, never two computations.
      expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
      label: 'createDropInCheckout',
    })
    // Bind the slot to the ONE session that may be paid against it, before the
    // URL leaves this function. A bind that cannot happen closes that session
    // and refuses rather than handing back a payable URL with nothing holding a
    // use for it.
    await bindPromoCheckoutSession({
      teamId,
      ticket: promoTicket,
      sessionId: checkout.sessionId,
      closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
    })
  } catch (err) {
    // Don't leave a reserved gift-card drawdown dangling until its lazy expiry.
    await releaseReserved()
    throw err
  }
  return {
    url: checkout.url,
    sessionId: checkout.sessionId,
    amount: chargeAmount,
    ...(giftCardPlan ? { drawdown: giftCardPlan.drawdown, residual: giftCardPlan.residual } : {}),
    // What the code did, so a surface can say why a valid code changed nothing
    // rather than going silent between the preview and the pay button.
    ...promoCheckoutOutcome(promo, resolved),
  }
  } catch (err) {
    // THE guard. Every path from the reservations above to a successful return
    // passes through here, which is what makes "release whatever was reserved"
    // structural rather than a list of catch sites that goes stale — the two
    // transactions' own catches release early, and this one covers everything
    // else: reserveGiftCardDrawdown's three throws (not-found / currency /
    // unusable — the flagship "promo plus a mistyped gift card" case), the
    // full-cover branch's post-transaction writes, and the Stripe create.
    // Releasing twice is a no-op: both releases delete a key that is already
    // gone.
    await releaseReserved()
    throw err
  }
})
