/* eslint-disable no-console */
import { randomInt } from 'crypto'
import * as admin from 'firebase-admin'
import { Timestamp, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { getTeam, isTeamMember } from '../utils/teams'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { getTeamContactEmail } from '../mail/senderConfig'
import { ctaButton } from '../utils/emailLayout'
import { systemEmailEnabledFor } from '../utils/systemEmails'
import { hashVerificationCode, verifyCode, generateSecureToken, generateBookingReference } from '../utils/crypto'
import { getHostingUrl } from '../utils/env'
import { to } from '../utils/async'
import { resolveReferralCode, createReferral } from '../utils/referrals'
import { fireReferralCreated } from '../referrals/events'
import {
  buildClassBookingConfirmationMail,
  buildTeacherNotificationEmail,
  buildVerificationCodeEmail,
} from './templates'
import { resolveBookingAccessGate } from './access'
import { checkoutRateLimit } from '../connect/checkout'
import {
  buildContactFieldPatch,
  expandContactFieldPatch,
  loadTeamPartnerAppNames,
} from './contactFields'
import { memberCanCancel } from './myBookings'
import { isSessionCancelled } from './waitlist/constants'
import { loadBookingSettings } from './bookingSettings'
import { healSessionSeatCount } from './seatCount'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import { isKioskDeviceForTeam } from '../utils/kioskSession'
import { resolveSingleContact } from '../utils/contacts'
import { matchGuestContact } from './guestContactMatch'
import {
  attachWaiverContact,
  enforceWaiverGate,
  parseWaiverSubmissions,
  type WaiverGateOutcome,
} from '../waivers/gate'
import { commitWaiverLedgerWrites, planWaiverLedgerWrites } from '../waivers/accept'
import {
  resolveActivityAccessRule,
  resolveAutoConfirm,
  countHoldingSeats,
  seatsFree,
  heldSubscriptionTypeIds,
  isPastBookingCutoff,
  parseBookingSource,
  sanitizeBookingAnswers,
  type FormField,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  PARTNER_VISITS_SUBCOLLECTION,
  type ActivityAccessRule,
  type ActivityType,
  localizedPublicUrl,
  bookingWasPaidFor,
  type SeatHold,
  type BookingCancelEffect,
  type BookingCancelRefusal,
  type CancelBookingResult,
  resolveBookingContactFields,
  type BookingContactField,
  type CustomFieldDefinition,
  resolveActivityDropIn,
  studioDropInOf,
  type ActivityDropIn,
} from '@linyup/shared'

// ─────────────────────────────────────────────────────────────────────────────
// Paid trial — pure decision logic, shared with createDropInCheckout's
// `trial: true` mode (booking/dropIn.ts imports these from here — mirrors the
// getDatePartsInTz/localTimeToUtc pattern in appointments/index.ts). No
// Firestore here so the decisions are trivially unit-tested (see trial.test.ts)
// and the two call sites can't drift apart on them. The trial's ELIGIBILITY
// semantics (newcomer/guest-only, once) are unchanged by paid trials — only the
// money changes. See Activity.trialPriceAmount and Contact.trial_used_at
// (@linyup/shared) for the field docs.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrialGateResult {
  ok: boolean
  reason?: 'payment_required' | 'trial_used'
  priceAmount?: number
}

const TRIAL_GATE_OK: TrialGateResult = { ok: true }

/** Whether a FREE-path trial booking attempt on a PRICED trial must be refused.
 *  Defence-in-depth: the client normally routes straight to the paid-trial
 *  checkout (createDropInCheckout with `trial: true`) and never reaches the
 *  free booking path when a price is configured. Absent/null `trialPriceAmount`
 *  (today's default) always passes — the free path is untouched. */
export function resolveFreeTrialPaymentGate(
  trialPriceAmount: number | null | undefined
): TrialGateResult {
  if (typeof trialPriceAmount === 'number') {
    return { ok: false, reason: 'payment_required', priceAmount: trialPriceAmount }
  }
  return TRIAL_GATE_OK
}

/** Whether a contact has already used their one trial — free or paid, ever.
 *  `trialUsedAt` is whatever truthy/falsy value the resolved contact's
 *  `trial_used_at` field holds (a Firestore Timestamp in production; callers
 *  pass `null`/`undefined` when no contact matched). Only meaningful on the
 *  trial door itself — never applied to normal/covered bookings. */
export function resolveTrialEligibility(trialUsedAt: unknown): TrialGateResult {
  if (trialUsedAt) return { ok: false, reason: 'trial_used' }
  return TRIAL_GATE_OK
}

type Lang = 'en' | 'de' | 'fr' | 'it'
const VALID_LANGS: Lang[] = ['en', 'de', 'fr', 'it']
function isLang(v: unknown): v is Lang {
  return VALID_LANGS.includes(v as Lang)
}

// ─────────────────────────────────────────────────────────────────────────────
// sendBookingVerificationCode
// ─────────────────────────────────────────────────────────────────────────────

export const sendBookingVerificationCode = onCall(async (request) => {
  const data = request.data as { email?: string; teamId?: string }

  if (!data?.email || !data?.teamId) {
    throw new HttpsError('invalid-argument', 'email and teamId are required')
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(data.email)) {
    throw new HttpsError('invalid-argument', 'Invalid email format')
  }

  const sanitizedEmail = data.email.toLowerCase().trim()
  const teamId = data.teamId.trim()

  // Validate team exists
  const teamDoc = await admin.firestore().collection('teams').doc(teamId).get()
  if (!teamDoc.exists) throw new HttpsError('not-found', 'Team not found')

  const teamData = teamDoc.data()!
  const teamName: string = teamData.name || 'Our Team'
  const lang: Lang = isLang(teamData.language) ? teamData.language : 'en'

  // Rate limit: max 3 codes per email+team per hour
  const oneHourAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)
  const recentCodes = await admin
    .firestore()
    .collection('booking_verification_codes')
    .where('email', '==', sanitizedEmail)
    .where('team_id', '==', teamId)
    .where('created_at', '>', oneHourAgo)
    .get()

  if (recentCodes.size >= 3) {
    throw new HttpsError(
      'resource-exhausted',
      'Too many verification requests. Please try again in an hour.'
    )
  }

  // Find matching contacts
  const contactsSnap = await admin
    .firestore()
    .collection('contacts')
    .where('teamId', '==', teamId)
    .where('email', '==', sanitizedEmail)
    .where('deleted_at', '==', null)
    .get()

  if (contactsSnap.empty) {
    return {
      success: true,
      hasContacts: false,
      message: 'No existing profile found. Please use the regular booking form.',
    }
  }

  const matchedContactIds = contactsSnap.docs.map((d) => d.id)

  // Generate and store code
  const code = randomInt(100000, 1000000).toString()
  const expiresAt = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000)
  const codeHash = hashVerificationCode(code, sanitizedEmail)

  const codeRef = await admin.firestore().collection('booking_verification_codes').add({
    email: sanitizedEmail,
    team_id: teamId,
    code_hash: codeHash,
    attempts: 0,
    created_at: FieldValue.serverTimestamp(),
    expires_at: expiresAt,
    verified: false,
    used: false,
    matched_contact_ids: matchedContactIds,
    type: 'booking_verification',
  })

  // Send email
  try {
    const emailContent = buildVerificationCodeEmail({ code, teamName, expiresInMinutes: 10, lang })
    const subjects: Record<Lang, string> = {
      en: `Your verification code for ${teamName}`,
      de: `Ihr Verifizierungscode für ${teamName}`,
      fr: `Votre code de vérification pour ${teamName}`,
      it: `Il tuo codice di verifica per ${teamName}`,
    }
    await sendEmail({
      to: sanitizedEmail,
      subject: subjects[lang],
      html: emailContent.html,
      text: emailContent.text,
      teamId,
    })
    console.log(`Booking verification email sent (team: ${teamId})`)
  } catch (err) {
    await codeRef.delete()
    throw new HttpsError('internal', 'Failed to send verification email. Please try again.')
  }

  return {
    success: true,
    hasContacts: true,
    codeId: codeRef.id,
    expiresAt: expiresAt.toMillis(),
    contactsCount: matchedContactIds.length,
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// verifyBookingCode
// ─────────────────────────────────────────────────────────────────────────────

export const verifyBookingCode = onCall(async (request) => {
  const data = request.data as { codeId?: string; code?: string; selectedContactId?: string }

  if (!data?.codeId) throw new HttpsError('invalid-argument', 'codeId is required')
  if (!data.code && !data.selectedContactId)
    throw new HttpsError('invalid-argument', 'code or selectedContactId is required')

  if (data.code && !/^\d{6}$/.test(data.code)) {
    throw new HttpsError('invalid-argument', 'Code must be 6 digits')
  }

  const codeRef = admin.firestore().collection('booking_verification_codes').doc(data.codeId)
  const codeDoc = await codeRef.get()
  if (!codeDoc.exists) throw new HttpsError('not-found', 'Invalid verification code')

  const codeData = codeDoc.data()!

  if (codeData.used)
    throw new HttpsError('failed-precondition', 'This verification code has already been used.')

  const now = Timestamp.now()
  if (codeData.expires_at.toMillis() < now.toMillis()) {
    throw new HttpsError(
      'deadline-exceeded',
      'Verification code has expired. Please request a new code.'
    )
  }

  if (codeData.attempts >= 5) {
    throw new HttpsError(
      'resource-exhausted',
      'Too many failed attempts. Please request a new code.'
    )
  }

  const matchedContactIds: string[] = codeData.matched_contact_ids || []

  // Handle contact selection after already verified
  if (codeData.verified && data.selectedContactId) {
    if (!matchedContactIds.includes(data.selectedContactId)) {
      throw new HttpsError('invalid-argument', 'Selected contact not found in matched contacts')
    }
    const contactDoc = await admin
      .firestore()
      .collection('contacts')
      .doc(data.selectedContactId)
      .get()
    if (!contactDoc.exists) throw new HttpsError('not-found', 'Selected contact no longer exists')
    const c = contactDoc.data()!
    return {
      verified: true,
      codeId: data.codeId,
      selectedContactId: data.selectedContactId,
      contactData: {
        id: contactDoc.id,
        firstname: c.firstname || '',
        lastname: c.lastname || '',
        email: c.email || '',
        phone: c.phone || '',
        // Coverage snapshot so the booking UI can warn about a missing
        // subscription up front (bookSession stays authoritative).
        held_subscription_type_ids: heldSubscriptionTypeIds(c),
      },
      requiresContactSelection: false,
    }
  }

  // Verify the code
  if (data.code) {
    const isValid = codeData.code_hash
      ? verifyCode(data.code, codeData.email, codeData.code_hash)
      : false

    if (!isValid) {
      await codeRef.update({ attempts: FieldValue.increment(1) })
      const remaining = 5 - (codeData.attempts + 1)
      throw new HttpsError(
        'invalid-argument',
        `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
      )
    }

    await codeRef.update({ verified: true, verified_at: FieldValue.serverTimestamp() })
  }

  // Fetch matched contacts
  const contacts = await Promise.all(
    matchedContactIds.map(async (id) => {
      const d = await admin.firestore().collection('contacts').doc(id).get()
      if (!d.exists) return null
      const c = d.data()!
      return {
        id: d.id,
        firstname: c.firstname || '',
        lastname: c.lastname || '',
        phone: c.phone || '',
      }
    })
  ).then(
    (r) => r.filter(Boolean) as { id: string; firstname: string; lastname: string; phone: string }[]
  )

  // Auto-select if single contact
  if (contacts.length === 1) {
    const single = contacts[0]
    const contactDoc = await admin.firestore().collection('contacts').doc(single.id).get()
    const c = contactDoc.data()!
    return {
      verified: true,
      codeId: data.codeId,
      selectedContactId: single.id,
      contactData: {
        id: contactDoc.id,
        firstname: c.firstname || '',
        lastname: c.lastname || '',
        email: c.email || '',
        phone: c.phone || '',
        held_subscription_type_ids: heldSubscriptionTypeIds(c),
      },
      requiresContactSelection: false,
    }
  }

  return {
    verified: true,
    codeId: data.codeId,
    matchedContacts: contacts,
    requiresContactSelection: true,
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// bookSession
// ─────────────────────────────────────────────────────────────────────────────

/** The shape of a replaced booking document that `replacedBookingWasCounted`
 *  reads — plus the two markers it deliberately does NOT read. */
export interface ReplacedBookingShape {
  payment_status?: string
  waitlist_claim?: boolean
  /** Read by `holdWriteCountDelta` and NOT by `replacedBookingWasCounted`, on
   *  purpose: bookSession's duplicate guard admits only `status === 'pending'`
   *  (its `already-exists` refusal, written twice — once in the authenticated
   *  branch, once in the guest `exactMatch` branch), so every shape that reaches
   *  THAT seam is a live pending booking and the status carries no information
   *  there.
   *  `createDropInCheckout`'s guard is looser — it blocks only `'confirmed'` and
   *  a `participants` doc — so a terminal document (cancelled / no_show /
   *  rebooked away) does reach the hold seam, and a terminal document owns no
   *  count: whoever moved it out of `pending` already gave the count back. */
  status?: string
  /** Set by `rebookSession` on the document it creates. Not part of the
   *  decision, and named here so it cannot quietly become one: a rebooked seat
   *  is counted by `rebookSession` itself (the ledger is per document, and only
   *  the path that creates a document knows whether the one it replaces was
   *  holding a count), so from here it is an ordinary counted pending booking. */
  rebooked_from?: string
}

/**
 * Was the document a booking write REPLACES already counted in the contact's
 * `pending_bookings_count`?
 *
 * `bookSession` full-replaces the caller's own booking document, so the counter
 * must move exactly once per pending booking. Its duplicate guard lets only two
 * kinds of live document through (everything else is refused with
 * `already-exists`):
 *
 *  • a plain drop-in payment hold — `createDropInCheckout` writes it and NEVER
 *    increments the counter, so the replacing write must. It is recognised by
 *    `payment_status: 'required'` WITHOUT `waitlist_claim`, because a PAID
 *    waitlist claim carries both and the promoter counted that one when it
 *    minted the offer.
 *  • every other live `pending` document — a waitlist claim hold, a claim that
 *    already SETTLED free (its `waitlist_claim` deleted, which is exactly why
 *    testing that flag was too narrow), a booking a coach reverted from
 *    confirmed, a seat `rebookSession` moved here. All four were counted by
 *    whoever created that state, and a second increment leaves the contact
 *    permanently one high: the eventual cancel / no-show / check-in only ever
 *    decrements once.
 *
 * The rebook shape is the one that cannot be decided from here, and that is why
 * it is not: the document `rebookSession` writes looks the same whether it grew
 * out of a live pending booking (whose count carried over) or out of a `no_show`
 * / a checked-in participant (whose count had already been given back). Only
 * `rebookSession` can see the difference, so it does its own counting — see the
 * ledger note there.
 *
 * Erring the other way — skipping the increment for the drop-in hold — drives a
 * real person's counter negative, which is the failure someone notices.
 */
export function replacedBookingWasCounted(
  replaced: ReplacedBookingShape | null | undefined
): boolean {
  if (!replaced) return false
  const uncountedDropInHold =
    replaced.payment_status === 'required' && replaced.waitlist_claim !== true
  return !uncountedDropInHold
}

/** A booking status that has already been disposed of — cancelled, marked absent
 *  or moved to another session. Every one of those transitions hands the
 *  contact's count back (`cancelBooking`'s own decrement, `markNoShowBookings`,
 *  the admin bookings page, `rebookSession`'s own ledger), so the document left
 *  behind owns no count. Unreachable at bookSession's seam, reachable at the
 *  hold seam — and at `cancelSingleSession`, which reads a whole bookings
 *  subcollection including the documents somebody already cancelled. */
export const DISPOSED_BOOKING_STATUSES = new Set(['cancelled', 'no_show', 'rebooked'])

/**
 * How much a PAYMENT-HOLD write (`createDropInCheckout`) must move the contact's
 * `pending_bookings_count`.
 *
 * `replacedBookingWasCounted` answers "was the document I am replacing counted?"
 * at bookSession's seam. This closes the other half of the same question at the
 * OTHER seam: the hold write also decides what the document IS from now on, and
 * the ledger has to agree with that — one count per counted document, no more,
 * no less. So: **delta = (the document left behind owns a count) − (the document
 * replaced owned one)**.
 *
 * Exactly two hold shapes come out of this write:
 *
 *  • a WAITLIST CLAIM hold (`waitlist_claim: true`) — COUNTED. The promoter
 *    counted it when it minted the offer and `releaseWaitlistOffer` gives that
 *    count back when the offer lapses.
 *  • a PLAIN drop-in hold (`payment_status: 'required'`, no claim flag) —
 *    UNCOUNTED for its whole life: nothing counts it at creation,
 *    `expirePendingBookings` deletes it without a decrement, and the webhook
 *    confirms it without one either.
 *
 * The bug this exists for: an offer holder who abandons the claim link and buys
 * through the ordinary booking form. Their claim hold is full-`.set()` into a
 * plain drop-in hold — `waitlist_claim` gone — while the promoter's `+1` stays
 * on the contact. From then on the document is, to every reader, an ordinary
 * uncounted hold: `replacedBookingWasCounted` classifies it as one (correctly —
 * the two origins are byte-identical at that seam), so a later free `bookSession`
 * counts it a SECOND time, and if it is simply abandoned `expirePendingBookings`
 * deletes it and the `+1` is stranded forever. The repair belongs where the
 * document changes kind, not at the seam that can no longer tell.
 *
 * The mirror case gets the `+1` for the identical reason: someone who opened an
 * ordinary drop-in checkout and then went back to their claim link turns an
 * uncounted hold into a counted one.
 *
 * NOTE the deliberate asymmetry with `replacedBookingWasCounted`: this reads
 * `status` and that one does not. The two guards differ (see
 * `ReplacedBookingShape.status`), so this seam — and only this seam — can be
 * handed a disposed document, which owns no count and must not be decremented
 * again. The complete shape table lives in `pendingBookingsCount.test.ts`.
 */
export function holdWriteCountDelta(
  replaced: ReplacedBookingShape | null | undefined,
  /** True when the document being written carries `waitlist_claim: true`. */
  writesClaimHold: boolean
): -1 | 0 | 1 {
  const after = writesClaimHold ? 1 : 0
  // Nothing there, or something already disposed of: no count to take away.
  if (!replaced) return after as -1 | 0 | 1
  if (replaced.status && DISPOSED_BOOKING_STATUSES.has(replaced.status)) return after as -1 | 0 | 1
  // Unreachable — `createDropInCheckout` refuses a confirmed booking outright
  // (its already-registered guard) — and genuinely ambiguous if it ever became
  // reachable: 'confirmed' means "counted, booked" on an auto-confirming session
  // and "count already released at check-in" everywhere else. Move nothing.
  if (replaced.status === 'confirmed') return 0
  const before = replacedBookingWasCounted(replaced) ? 1 : 0
  return (after - before) as -1 | 0 | 1
}

/** What the booking transaction learned about the document it replaced — the two
 *  facts that only its read set can supply, and that everything after the commit
 *  (the contact counter, the manage-booking link in the mail) depends on. */
interface BookingCommitResult {
  /** The replaced document had already moved `pending_bookings_count` up. */
  alreadyCounted: boolean
  /** The token this seat ends up carrying: the replaced document's, if there was
   *  one, so links already in someone's inbox keep working. */
  bookingToken: string
}

export const bookSession = onCall(async (request) => {
  await checkoutRateLimit(request.rawRequest?.ip, 'book')
  const data = request.data as {
    teamId?: string
    sessionId?: string
    contactDetails?: {
      firstname: string
      lastname: string
      email: string
      phone?: string
      /** "Which fitness app did you come through?" — asked only when the studio
       *  both wants the question (BookingSettings.showFitnessAppField) and has
       *  partner apps to name. Untrusted: narrowed against the same public list
       *  the form offered (TeamPublicProfile.partner_apps, via
       *  `loadTeamPartnerAppNames`) before it is stored, and it grants nothing —
       *  see Contact.acquisition_partner_app. */
      aggregatorApp?: string | null
    }
    authenticatedContactId?: string
    verificationCodeId?: string
    referralCode?: string
    subscription_type_id?: string
    /** Attribution hint (see BookingSource). Untrusted — validated with
     *  parseBookingSource before it's persisted. */
    source?: string
    /** Answers to the activity's bookingQuestions, keyed by field id. */
    questionAnswers?: Record<string, unknown>
    /** Answers to the book form's CONTACT fields, keyed the same way the fields
     *  are (`phone`, `custom:{id}`). Narrowed server-side against the resolved
     *  list — see booking/contactFields.ts. */
    contactFieldAnswers?: Record<string, unknown>
    /** Ticks from the waiver step, each echoing the version and text hash the
     *  visitor was actually shown. Coerced by `parseWaiverSubmissions`; anything
     *  malformed is dropped and the gate refuses in the ordinary way. */
    waiverAcceptances?: unknown
  }

  if (!data?.teamId || !data?.sessionId) {
    throw new HttpsError('invalid-argument', 'teamId and sessionId are required')
  }

  // ── Referral code resolution (non-fatal) ────────────────────────────────────
  let referrerContactId: string | null = null
  if (data.referralCode && typeof data.referralCode === 'string') {
    try {
      const referral = await resolveReferralCode(data.referralCode.trim().toUpperCase())
      if (referral && referral.teamId === data.teamId) {
        referrerContactId = referral.contactId
      }
    } catch (err) {
      console.error('Error resolving referral code, ignoring:', err)
    }
  }

  // ── IP rate limit: max 10 bookings per hour per IP ──────────────────────────
  const bookingIp: string | null = request.rawRequest?.ip || null
  const oneHourAgo = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000)

  if (bookingIp) {
    const recentIpBookings = await admin
      .firestore()
      .collection('sessions')
      .doc(data.sessionId)
      .collection('bookings')
      .where('booking_ip', '==', bookingIp)
      .where('joinedAt', '>', oneHourAgo)
      .get()
    if (recentIpBookings.size >= 10) {
      // Reason codes matter here: 'resource-exhausted' is thrown by four
      // unrelated conditions on this callable, and the public form has to tell
      // "this class is full" (offer the waitlist) from "you are throttled"
      // (try again later). Without them a shared NAT looks like a full class.
      throw new HttpsError(
        'resource-exhausted',
        'Too many booking requests. Please try again later.',
        { reason: 'rate_limited_ip' }
      )
    }
  }

  // ── Session rate limit: max 50 bookings per hour per session ─────────────────
  const recentSessionBookings = await admin
    .firestore()
    .collection('sessions')
    .doc(data.sessionId)
    .collection('bookings')
    .where('joinedAt', '>', oneHourAgo)
    .get()

  if (recentSessionBookings.size >= 50) {
    throw new HttpsError('resource-exhausted', 'This session has reached its booking limit.', {
      reason: 'rate_limited_session',
    })
  }

  // ── Resolve authenticated contact ────────────────────────────────────────────
  // Two ways a caller can prove who they are, checked in this order:
  //   1. authenticatedContactId (+ verificationCodeId) — the public booking form's
  //      passwordless email-OTP flow. Explicit, so it WINS when supplied: a contact
  //      signed in as themselves may legitimately book for another contact they just
  //      verified by code (e.g. a parent booking their child — see the login-email
  //      allow-list in buildContactSession).
  //   2. Contact session — the custom-token claims { contactId, teamId,
  //      sessionExpires } minted by buildContactSession, which httpsCallable attaches
  //      to request.auth once the contact is signed in (mobile app / web Space). This
  //      is the ONLY trustworthy source of a caller's own contactId on a public
  //      callable (see utils/contactSession.ts) — the same mechanism bookAppointment,
  //      createDropInCheckout and requestContactUpdate use, so a signed-in app never
  //      has to type an emailed code to book something it's already authenticated for.
  // Neither present → guest booking from contactDetails, below.
  let authenticatedContact: (admin.firestore.DocumentData & { id: string }) | null = null
  // The address the six-digit code was actually MAILED TO, kept because it is
  // not, in general, the contact's own — path 1 above exists precisely so a
  // parent can verify with their address and book for their child. The waiver
  // ledger records it as `signer_email`; see WaiverGateParams.signerEmail.
  let verifiedSignerEmail: string | null = null

  if (data.authenticatedContactId) {
    // The code is MANDATORY. It is the ONLY thing that proves the caller is this
    // contact — a contactId in the request body proves nothing by itself, and
    // trusting one is the High-severity "booking-on-behalf-of + contact-id oracle"
    // pattern the July 2026 audit fixed in createDropInCheckout (finding #2,
    // docs/security-audit-2026-07.md). A caller who is already signed in should
    // send NO authenticatedContactId and let their contact session identify them
    // (the `else` branch below).
    if (!data.verificationCodeId) {
      throw new HttpsError(
        'invalid-argument',
        'verificationCodeId is required when authenticatedContactId is supplied'
      )
    }
    const codeDoc = await admin
      .firestore()
      .collection('booking_verification_codes')
      .doc(data.verificationCodeId)
      .get()
    if (!codeDoc.exists) throw new HttpsError('invalid-argument', 'Invalid verification code')
    const codeData = codeDoc.data()!
    if (!codeData.verified)
      throw new HttpsError('failed-precondition', 'Verification code not verified')
    if (codeData.team_id !== data.teamId)
      throw new HttpsError('permission-denied', 'Code does not match team')
    const isValid = (codeData.matched_contact_ids || []).includes(data.authenticatedContactId)
    if (!isValid) throw new HttpsError('permission-denied', 'Contact not found in verified matches')
    verifiedSignerEmail = ((codeData.email as string | undefined) ?? '').toLowerCase().trim() || null
    await admin
      .firestore()
      .collection('booking_verification_codes')
      .doc(data.verificationCodeId)
      .update({
        used: true,
        used_at: FieldValue.serverTimestamp(),
        used_for_session: data.sessionId,
        used_contact_id: data.authenticatedContactId,
      })

    const contactDoc = await admin
      .firestore()
      .collection('contacts')
      .doc(data.authenticatedContactId)
      .get()
    if (!contactDoc.exists) throw new HttpsError('not-found', 'Contact not found')
    const contactData = contactDoc.data()!
    if (contactData.teamId !== data.teamId)
      throw new HttpsError('permission-denied', 'Contact does not belong to this team')
    authenticatedContact = { id: data.authenticatedContactId, ...contactData }
  } else {
    const contactSession = optionalContactSessionFromRequest(request)
    if (contactSession && contactSession.teamId === data.teamId) {
      const contactDoc = await admin
        .firestore()
        .collection('contacts')
        .doc(contactSession.contactId)
        .get()
      if (!contactDoc.exists) throw new HttpsError('not-found', 'Contact not found')
      const contactData = contactDoc.data()!
      if (contactData.teamId !== data.teamId)
        throw new HttpsError('permission-denied', 'Contact does not belong to this team')
      authenticatedContact = { id: contactSession.contactId, ...contactData }
    }
  }

  const isAuthenticatedBooking = !!authenticatedContact

  // Build sanitized contact details
  let sanitized: { firstname: string; lastname: string; email: string; phone?: string | null }

  if (authenticatedContact) {
    sanitized = {
      firstname: authenticatedContact.firstname || '',
      lastname: authenticatedContact.lastname || '',
      email: (authenticatedContact.email || '').toLowerCase().trim(),
      phone: authenticatedContact.phone || null,
    }
  } else {
    if (!data.contactDetails)
      throw new HttpsError('invalid-argument', 'contactDetails required for new bookings')
    const { firstname, lastname, email, phone } = data.contactDetails
    if (!firstname || !lastname || !email)
      throw new HttpsError('invalid-argument', 'firstname, lastname, email required')
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) throw new HttpsError('invalid-argument', 'Invalid email format')
    sanitized = {
      firstname: firstname.trim(),
      lastname: lastname.trim(),
      email: email.toLowerCase().trim(),
      phone: phone?.trim() || null,
    }
  }

  // Validate team and get owner email
  const team = await getTeam(data.teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')

  const lang: Lang = isLang(team.language) ? team.language : 'en'
  const teamName: string = team.name || 'Our Team'

  let ownerEmail: string | null = null
  let ownerFirstname = 'Team'
  const ownersSnap = await admin
    .firestore()
    .collection('teams')
    .doc(data.teamId)
    .collection('team_members')
    .where('role', '==', 'owner')
    .limit(1)
    .get()
  if (!ownersSnap.empty) {
    const ownerId = ownersSnap.docs[0].id
    const ownerDoc = await admin.firestore().collection('users').doc(ownerId).get()
    if (ownerDoc.exists) {
      ownerEmail = ownerDoc.get('email')
      ownerFirstname = ownerDoc.get('firstname') || 'Team'
    }
  }

  // Validate session
  const sessionDoc = await admin.firestore().collection('sessions').doc(data.sessionId).get()
  if (!sessionDoc.exists) throw new HttpsError('not-found', 'Session not found')
  const sessionData = sessionDoc.data()!

  if (sessionData.teamId !== data.teamId)
    throw new HttpsError('permission-denied', 'Session does not belong to this team')
  // bookSession is class-only — no pre-generated appointment session can exist any
  // more; a coach's time is materialised lazily by bookAppointment (see appointments/window.ts).
  if (sessionData.activityType === 'appointment') {
    throw new HttpsError('failed-precondition', 'Appointments are booked via bookAppointment')
  }
  if (!sessionData.allowBooking)
    throw new HttpsError('permission-denied', 'Bookings are not allowed for this session')

  const now = Timestamp.now()
  if (sessionData.start.toMillis() < now.toMillis()) {
    throw new HttpsError('failed-precondition', 'Cannot book sessions in the past')
  }

  // Get activity name and access rule (the paid-access gate)
  let activityName = (sessionData.activityName as string) || 'Session'
  let accessRule: ActivityAccessRule = { type: 'open' }
  // Per-activity confirmation note (overrides the team-wide setting below).
  let activityInstructions: string | null = null
  // Per-activity cancellation policy (overrides the team-wide default below).
  let activityCancellationPolicy: string | null = null
  // The activity's own book-form questions — the allow-list the submitted
  // answers get narrowed to (see sanitizeBookingAnswers).
  let activityBookingQuestions: FormField[] = []
  // The activity's own CONTACT fields — extended onto the team-wide list by
  // resolveBookingContactFields. Distinct from the questions above: these
  // answers are written to the CONTACT, not to the booking.
  let activityContactFields: BookingContactField[] = []
  let activityAutoConfirm: boolean | undefined
  let activityTypeVal: ActivityType | undefined
  // CLASS-ONLY (Activity.trialEnabled, @linyup/shared). Independent of
  // accessRule: a gated class still accepts a newcomer's (guest) trial
  // booking when set — see the access-gate override below.
  let activityTrialEnabled = false
  // CLASS-ONLY (Activity.trialPriceAmount, @linyup/shared). Absent/null ⇒ the
  // trial stays FREE (today's behaviour). A number means this trial is paid —
  // see the payment gate below.
  let activityTrialPriceAmount: number | null = null
  // The class's paid door, read for the GATE (not for pricing — bookSession is
  // the free path). It is what tells "books free" apart from "must go and pay"
  // for someone no plan covers: with no price there is nowhere to send her.
  let activityDropIn: ActivityDropIn | null = null

  if (sessionData.activityId) {
    try {
      const actDoc = await admin
        .firestore()
        .collection('activities')
        .doc(sessionData.activityId)
        .get()
      if (actDoc.exists) {
        const actData = actDoc.data()!
        activityName = actData.name || activityName
        accessRule = resolveActivityAccessRule({
          accessRule: actData.accessRule as ActivityAccessRule | undefined,
          isFreeTrial: actData.isFreeTrial as boolean | undefined,
        })
        activityDropIn = (actData.dropIn as ActivityDropIn | undefined) ?? null
        activityInstructions = (actData.confirmationInstructions as string) || null
        activityCancellationPolicy = (actData.cancellationPolicy as string) || null
        activityBookingQuestions = Array.isArray(actData.bookingQuestions)
          ? (actData.bookingQuestions as FormField[])
          : []
        activityContactFields = Array.isArray(actData.contactFields)
          ? (actData.contactFields as BookingContactField[])
          : []
        activityAutoConfirm = actData.autoConfirm as boolean | undefined
        activityTypeVal = actData.type as ActivityType | undefined
        activityTrialEnabled = actData.trialEnabled === true
        activityTrialPriceAmount =
          typeof actData.trialPriceAmount === 'number' ? (actData.trialPriceAmount as number) : null
      }
    } catch (_) {
      /* non-fatal */
    }
  }

  // Does this booking confirm itself on the spot? The session's own field wins
  // (denormalised by whoever created it); otherwise fall back through the
  // parent activity — resolveAutoConfirm's default (on) applies when neither
  // is set.
  const autoConfirm =
    typeof sessionData.autoConfirm === 'boolean'
      ? (sessionData.autoConfirm as boolean)
      : resolveAutoConfirm({ autoConfirm: activityAutoConfirm, type: activityTypeVal })

  // Studio note appended to the confirmation email: activity override ?? team default.
  const teamInstructions =
    ((team.settings as Record<string, unknown> | undefined)?.bookingConfirmationInstructions as
      | string
      | undefined) || null
  const bookingInstructions = activityInstructions?.trim() || teamInstructions?.trim() || null

  // Cancellation policy appended to the confirmation email: activity override ??
  // team default (mirrors the instructions pattern above; separate field
  // because this one is ALSO shown publicly before the visitor books).
  const teamCancellationPolicy =
    ((team.settings as Record<string, unknown> | undefined)?.bookingCancellationPolicy as
      | string
      | undefined) || null
  const cancellationPolicy =
    activityCancellationPolicy?.trim() || teamCancellationPolicy?.trim() || null

  // Group-class booking cap — FAIL-FAST ONLY. The authoritative gate lives in
  // the write transaction below (which reads the session doc and the bookings
  // subcollection in the same read set, so two concurrent bookers serialize);
  // this pre-flight exists so a refusal on a genuinely full class costs no side
  // effects — no contact created, no funnel stamp, no trial_used_at burned.
  //
  // The stored counter is only a cheap filter: it can be STALE-FULL, because an
  // abandoned drop-in checkout leaves a lapsed `payment_status: 'required'`
  // hold and trackBookings only recounts on a booking WRITE — which is exactly
  // what we are about to refuse to do. So when it says full, re-derive the live
  // count with the same predicate before locking a real customer out of a free
  // seat, and PERSIST the correction (healSessionSeatCount, a transaction that
  // reads the session doc and its bookings in one read set — the only shape
  // `bookings_count` may be written in). Persisting is what makes the fix reach
  // anyone but this caller: the public mirror is derived from that number, so
  // until it is corrected the class stays advertised full and its slot row stays
  // unclickable, with a genuinely free seat behind it, until the 02:00 sweep.
  //
  // WHO is booking, as far as the seat count is concerned. Resolved HERE, before
  // the gate below, so the pre-flight can exclude the caller's own hold exactly
  // as the write transaction does — a caller holding a waitlist claim (or an
  // abandoned drop-in hold) on a full class would otherwise be refused the seat
  // they already have, by a fail-fast filter its own authoritative gate would
  // have let through. Reads only: the contact is still CREATED far below, after
  // every refusal path, and the guest branch would run this same exact
  // email+name match anyway.
  //
  // The email+name predicate itself lives in `booking/guestContactMatch.ts` —
  // moved, not changed. `createDropInCheckout` had a byte-identical copy, and
  // `resolveWaiverRequirement` now needs the SAME answer: a public callable that
  // resolved a shared household mailbox differently from this rail would tell a
  // 12-year-old there is nothing to sign and then have the gate refuse him on
  // his mother's signature.
  let guestMatch: admin.firestore.QueryDocumentSnapshot | null = null
  if (!authenticatedContact) {
    guestMatch = (await matchGuestContact(data.teamId, sanitized)).match
  }
  const callerContactId = authenticatedContact?.id ?? guestMatch?.id

  const maxGroup = sessionData.max_participants as number | undefined
  if (seatsFree(maxGroup, (sessionData.bookings_count as number) || 0) <= 0) {
    const healed = await healSessionSeatCount(data.sessionId, callerContactId)
    if (
      healed.exists &&
      seatsFree(healed.maxParticipants ?? maxGroup, healed.holdingExcludingCaller) <= 0
    ) {
      throw new HttpsError('resource-exhausted', 'This session is fully booked.', {
        reason: 'session_full',
      })
    }
  }

  // Online booking cutoff — authoritative; the client hides/disables the same
  // slots but never trust it alone. Read from THE booking-settings store
  // (teams/{id}/public_profile/{id}.bookingSettings — see bookingSettings.ts),
  // which is the same document the public booking page reads, so the page and
  // this refusal can no longer disagree.
  const bookingSettings = await loadBookingSettings(data.teamId)
  const { cutoffMinutes } = bookingSettings
  if (isPastBookingCutoff(sessionData.start as Timestamp, cutoffMinutes)) {
    throw new HttpsError('failed-precondition', 'Online booking has closed for this session.')
  }

  // ── Access gate (paid-access axis) ─────────────────────────────────────────
  // trialEnabled override: a gated class ('members'/'subscription') still lets
  // a newcomer (guest — no authenticatedContact) through, following EXACTLY the
  // 'open' tier's guest path (same contact creation below, same booking shape,
  // no repeat-limiting). Authenticated callers (trial accounts included) are
  // NOT affected — trialEnabled is a guest-only door, not a looser tier.
  //
  // On an OPEN class the door is a no-op — everyone already books free, so
  // trialEnabled grants nothing extra. It must therefore stay fully inert
  // there: no payment gate (else a mispriced open class deadlocks — the free
  // path would refuse with payment_required while createDropInCheckout refuses
  // the same booking as "free to book, no payment needed") and no
  // once-per-person eligibility (else setting the flag on a free class would
  // silently block every returning guest from re-booking it).
  const isTrialDoor =
    !authenticatedContact && activityTrialEnabled && accessRule.type !== 'open'

  if (isTrialDoor) {
    // Refuse a FREE booking of a PRICED trial — the price is the gate; the
    // client normally routes straight to the paid-trial checkout instead
    // (createDropInCheckout with trial: true). Defence-in-depth only.
    const paymentGate = resolveFreeTrialPaymentGate(activityTrialPriceAmount)
    if (!paymentGate.ok) {
      throw new HttpsError('failed-precondition', 'This trial requires payment.', {
        reason: paymentGate.reason,
        priceAmount: paymentGate.priceAmount,
      })
    }

    // Trial eligibility: one trial per person, ever — free or paid. Resolved
    // by email (same lookup other Connect/webhook flows use), never by the
    // looser name+email match below, so a repeat trial-seeker can't dodge it
    // by fudging their name. Only checked on the trial door itself.
    const { contactId: eligibilityContactId } = await resolveSingleContact(
      data.teamId,
      sanitized.email
    )
    let trialUsedAt: unknown = null
    if (eligibilityContactId) {
      const eligibilityDoc = await admin
        .firestore()
        .collection('contacts')
        .doc(eligibilityContactId)
        .get()
      trialUsedAt = eligibilityDoc.exists ? eligibilityDoc.data()?.trial_used_at : null
    }
    const eligibility = resolveTrialEligibility(trialUsedAt)
    if (!eligibility.ok) {
      throw new HttpsError('failed-precondition', 'This email has already used a trial', {
        reason: eligibility.reason,
      })
    }
  }

  const gateAccessRule: ActivityAccessRule = isTrialDoor ? { type: 'open' } : accessRule
  // THE ONE READER of the drop-in price: a class that follows the studio
  // default stores no price of its own, so the raw field is not the answer
  // (shared/utils/dropIn.ts).
  const resolvedDropIn = resolveActivityDropIn(
    { type: activityTypeVal, accessRule, dropIn: activityDropIn },
    studioDropInOf(bookingSettings)
  )
  const { matchedSubscriptionTypeId, creditSpendTypeId, usageSpend } = await resolveBookingAccessGate({
    teamId: data.teamId,
    accessRule: gateAccessRule,
    authenticatedContact,
    isAppointment: false,
    // Meter usage limits against the week the CLASS happens, not the booking
    // moment — advance bookings must debit the session's own window.
    usageAt: (sessionData.start as Timestamp).toDate(),
    // The trial door is its own free path (`gateAccessRule` is forced open
    // above), so it must not be told a paid door exists.
    dropIn: isTrialDoor ? null : resolvedDropIn,
  })

  // ── The waiver gate ────────────────────────────────────────────────────────
  // HERE, and not one line lower: the first CONTACT write is immediately below,
  // so a refusal creates no contact, stamps no funnel, burns no `trial_used_at`
  // and records no acceptance.
  //
  // ONE side effect does precede it and cannot be moved: the verification code
  // was marked `used: true` at the identity check near the top of this callable,
  // long before any gate. What that actually costs is worth stating precisely,
  // because the obvious reading is wrong in a way that TESTS AS FINE — this
  // callable never re-checks `used` (its entry checks are `exists`, `verified`,
  // `team_id` and `matched_contact_ids`), so re-calling it with the same
  // `codeId` still succeeds. The cost only materialises if the SURFACE unwinds
  // to the email step, because `verifyBookingCode` does refuse a used code and
  // re-requesting is capped per email+team per hour. That is why the returning-
  // member path must present the waiver step BEFORE calling this callable rather
  // than reacting to the refusal: the refusal is the floor, not the plan.
  //
  // The caller is already identified at this point — `callerContactId` above,
  // from the guest email+name match this rail runs regardless for the seat
  // count — so the gate's cost is one policy read plus one signer read per
  // applicable waiver, and a team with no waivers pays exactly one document
  // read per booking.
  //
  // `nowMs` is captured ONCE, here, and carried into the commit transaction.
  // Stamping the tick inside the transaction instead would re-stamp it on a
  // Firestore retry, and a retried acceptance that overtakes a manager's
  // revocation silently undoes it.
  const waiverNowMs = Date.now()
  // THE ONE PLACE THIS RAIL ASKS WHETHER THE DEVICE IS A KIOSK. The answer feeds
  // two `source` stamps and nothing else — the acceptance's below, and the
  // booking document's further down — so it changes ATTRIBUTION, not
  // authorization.
  //
  // The tablet used to buy a guardian DEFERRAL here — the walk-in was admitted
  // with the waiver outstanding and a link was mailed to a parent afterwards.
  // That mechanism is gone; the consent step is completable by the person at the
  // desk, so the kiosk refuses like every other rail.
  //
  // What survives is the reason the check is a real identity rather than
  // `data.source`: an acceptance may claim `source: 'kiosk'` only when the
  // device PROVED it was one (the custom token `unlockKiosk` mints after a
  // timing-safe PIN comparison), so the one value a caller might want to claim
  // is the one value they cannot fake into the record. See utils/kioskSession.ts.
  const isKiosk = await isKioskDeviceForTeam(request, data.teamId)
  let waiverOutcome: WaiverGateOutcome = await enforceWaiverGate({
    teamId: data.teamId,
    activityId: (sessionData.activityId as string | undefined) ?? null,
    subject: {
      contactId: callerContactId ?? null,
      name: `${sanitized.firstname} ${sanitized.lastname}`.trim(),
      email: sanitized.email,
    },
    submissions: parseWaiverSubmissions(data.waiverAcceptances),
    // The LEDGER's source, and it is evidence rather than a dashboard label: an
    // acceptance claims `kiosk` only when the device proved it was one. A studio
    // running the tablet without the PIN lock therefore files its walk-in ticks
    // as `booking`, which is exactly what we can stand behind about them.
    source: isKiosk ? 'kiosk' : 'booking',
    // The three strengths this rail can honestly claim, and they are different
    // facts: an OTP means the signer received and typed a code sent to THAT
    // mailbox; a contact session means only that a session was open, which
    // identifies the CONTACT and not the person at the keyboard; a guest form
    // means the address was merely typed. The record says which.
    signerEmailVerifiedBy: data.authenticatedContactId
      ? 'verified_code'
      : isAuthenticatedBooking
        ? 'session'
        : 'none',
    // …and the address that strength is ABOUT. Recording `verified_code` beside
    // the contact's own address would claim a mailbox proof for whoever the
    // booking is for, which on this rail is routinely somebody else: the parent
    // typed the code, the child is the subject. null on the session and guest
    // paths, where the subject's address is the only one there is.
    signerEmail: verifiedSignerEmail,
    ip: bookingIp,
    userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
    locale: null,
    nowMs: waiverNowMs,
  })

  // Resolve or create contact
  // CONTACT FIELDS. Resolved from the team's book settings extended by the
  // activity's own list, then NARROWED against that list — the payload is
  // anonymous and is writing to a contact document, so the server decides which
  // keys exist. See booking/contactFields.ts.
  const resolvedContactFields = resolveBookingContactFields(
    // Reuses the settings already loaded for the booking cutoff — one read, and
    // the same document the callables enforce the cutoff from.
    bookingSettings,
    activityContactFields
  )
  // THE PARTNER-APP ANSWER, if there is one to store. Only a guest is ever
  // asked (an authenticated booking ignores `contactDetails` entirely), only
  // while the studio's own switch is on, and the allowed-names read (one get of
  // the same public_profile document the form rendered from) is paid only when
  // something non-empty was actually posted — so the rail that existed before
  // this feature performs exactly the reads it always did.
  const postedPartnerApp =
    !authenticatedContact &&
    bookingSettings.showFitnessAppField !== false &&
    typeof data.contactDetails?.aggregatorApp === 'string'
      ? data.contactDetails.aggregatorApp.trim()
      : ''
  const partnerApp = postedPartnerApp
    ? { value: postedPartnerApp, allowed: await loadTeamPartnerAppNames(data.teamId) }
    : null

  const contactFieldPatch = buildContactFieldPatch({
    fields: resolvedContactFields,
    answers: data.contactFieldAnswers,
    definitions: (team.custom_field_definitions ?? null) as CustomFieldDefinition[] | null,
    // Read ONLY to merge an address over the stored one — an answer that names
    // a street and a town must not take the postcode with it.
    existing: authenticatedContact,
    partnerApp,
  })

  let contactId: string
  let isNewContact = false

  if (authenticatedContact) {
    contactId = authenticatedContact.id
    // Check for duplicate booking
    const [existingBooking, existingParticipant] = await Promise.all([
      admin
        .firestore()
        .collection('sessions')
        .doc(data.sessionId)
        .collection('bookings')
        .doc(contactId)
        .get(),
      admin
        .firestore()
        .collection('sessions')
        .doc(data.sessionId)
        .collection('participants')
        .doc(contactId)
        .get(),
    ])
    // A pending (unpaid drop-in) hold does not block a free booking — the buyer may
    // have abandoned checkout; only a confirmed booking / attendance blocks re-booking.
    if (
      existingParticipant.exists ||
      (existingBooking.exists && existingBooking.data()?.status !== 'pending')
    ) {
      throw new HttpsError('already-exists', 'You are already registered for this session')
    }
  } else {
    // The exact email+name match was already resolved above, before the capacity
    // gate — it is the caller's identity for the seat count as much as it is the
    // contact to book.
    const exactMatch = guestMatch

    if (exactMatch) {
      contactId = exactMatch.id
      const [existingBooking, existingParticipant] = await Promise.all([
        admin
          .firestore()
          .collection('sessions')
          .doc(data.sessionId)
          .collection('bookings')
          .doc(contactId)
          .get(),
        admin
          .firestore()
          .collection('sessions')
          .doc(data.sessionId)
          .collection('participants')
          .doc(contactId)
          .get(),
      ])
      // Same rule as the authenticated branch above, which this used to
      // contradict: a pending hold is not a registration. A guest who abandoned
      // a drop-in checkout (or holds a seat awaiting confirmation) would
      // otherwise get a bare 'already-exists' for a booking they never made.
      if (
        existingParticipant.exists ||
        (existingBooking.exists && existingBooking.data()?.status !== 'pending')
      ) {
        throw new HttpsError('already-exists', 'You are already registered for this session')
      }
      // An existing OFF-FUNNEL contact (form/shop lead — no acquisition stage)
      // booking a trial enters the funnel normally at this point.
      const exactMatchUpdate: Record<string, unknown> = {}
      if (!exactMatch.data().acquisition_stage) {
        exactMatchUpdate.acquisition_stage = 'trial_booked'
        exactMatchUpdate.acquisition_stage_updated_at = FieldValue.serverTimestamp()
        exactMatchUpdate.trial_booked_at = FieldValue.serverTimestamp()
      }
      // One-trial-per-person enforcement: stamped on a successful FREE trial-door
      // booking (a priced trial never reaches here — refused above).
      if (isTrialDoor) {
        exactMatchUpdate.trial_used_at = FieldValue.serverTimestamp()
      }
      // Contact fields the form collected. Merged onto whatever else this
      // branch is already updating, so an existing member's booking is still
      // one write.
      Object.assign(exactMatchUpdate, contactFieldPatch)
      if (Object.keys(exactMatchUpdate).length) {
        await exactMatch.ref.update(exactMatchUpdate)
      }
    } else {
      isNewContact = true
      const newContactRef = admin.firestore().collection('contacts').doc()
      await newContactRef.set({
        firstname: sanitized.firstname,
        lastname: sanitized.lastname,
        email: sanitized.email,
        phone: sanitized.phone,
        // Acquisition: a trial booking is born at 'trial_booked' (booked, not yet
        // attended). First attendance promotes it to 'trial_attended'.
        acquisition_stage: 'trial_booked',
        acquisition_stage_updated_at: FieldValue.serverTimestamp(),
        entry: 'booking',
        // A never-attended trial lead doesn't count toward the contact cap (no
        // expiry — the 'lib_trial_cleanup' automation archives stale ones).
        // Cleared on first attendance/payment/promotion. See Contact.provisional.
        provisional: true,
        teamId: data.teamId,
        archived_at: null,
        deleted_at: null,
        created_at: FieldValue.serverTimestamp(),
        pending_bookings_count: 1,
        // One-trial-per-person enforcement (see the exactMatch branch above).
        ...(isTrialDoor ? { trial_used_at: FieldValue.serverTimestamp() } : {}),
        // Contact fields from the book form. `set()` treats a dotted key as a
        // LITERAL field name — it is `update()` that reads it as a path — so
        // the custom entries are nested here rather than written as
        // "custom_fields.swim_level", which would create a field with a dot in
        // its name that nothing can ever read back.
        ...expandContactFieldPatch(contactFieldPatch),
      })
      contactId = newContactRef.id
      console.log(`New trial contact created: ${contactId}`)
    }
  }

  // The gate ran above the contact write and therefore could not know this id.
  // Rebinding here — rather than resolving the gate a second time now that the
  // contact exists — is what keeps ONE answer to "does this person need to
  // sign".
  waiverOutcome = attachWaiverContact(waiverOutcome, contactId)

  // Add booking to session
  const bookingToken = generateSecureToken()
  const bookingReference = generateBookingReference()
  const teamSlug: string | null = team.slug || null
  const subscriptionTypeId =
    matchedSubscriptionTypeId ??
    (typeof data.subscription_type_id === 'string' && data.subscription_type_id
      ? data.subscription_type_id
      : null)

  const bookingDoc = {
    firstname: sanitized.firstname,
    lastname: sanitized.lastname,
    email: sanitized.email,
    phone: sanitized.phone ?? null,
    contact: contactId,
    session: data.sessionId,
    teamId: data.teamId,
    joinedAt: FieldValue.serverTimestamp(),
    fromBioLink: true,
    is_new_contact: isNewContact,
    booking_token: bookingToken,
    booking_reference: bookingReference,
    // Attribution, and ONLY attribution — it decides what a dashboard says and
    // nothing else. Client-supplied but validated against the union; an
    // unrecognised value falls back to 'online' rather than persisting junk. A
    // VERIFIED kiosk device overrides whatever was typed, so the one value a
    // caller might want to claim is also the one value they cannot fake into the
    // record. Nothing on a decision path may read this field.
    source: isKiosk ? 'kiosk' : (parseBookingSource(data.source) ?? 'online'),
    // Narrowed to the activity's own questions — unknown ids and off-list
    // choices are dropped rather than persisted.
    ...(() => {
      const answers = sanitizeBookingAnswers(activityBookingQuestions, data.questionAnswers)
      return answers ? { question_answers: answers } : {}
    })(),
    booking_ip: bookingIp,
    authenticated_booking: isAuthenticatedBooking,
    subscription_type_id: subscriptionTypeId,
    // Auto-confirming sessions write the confirmed status immediately (the
    // client's slot is theirs); otherwise leave status unset — pending, still
    // holds capacity — until the studio confirms/checks the client in.
    ...(autoConfirm && {
      status: 'confirmed' as const,
      fullname: `${sanitized.firstname} ${sanitized.lastname}`,
    }),
    // Denormalised for the day sheet and the printed manifest only. Absent when
    // no required waiver applied, which the roster renders as nothing.
    ...(waiverOutcome.bookingWaiverState
      ? { waiver_state: waiverOutcome.bookingWaiverState }
      : {}),
  }
  const db = admin.firestore()
  const bookingRef = db
    .collection('sessions')
    .doc(data.sessionId)
    .collection('bookings')
    .doc(contactId)
  const sessionRef = db.collection('sessions').doc(data.sessionId)
  const bookingsRef = sessionRef.collection('bookings')

  // ── The booking commit — ONE transaction, whatever pays for it ──────────────
  // The seat and the thing that buys it (a pack credit, a usage-window unit, or
  // nothing at all) are decided together or not at all. Two things ride on that:
  //
  //  1. CAPACITY. The session doc is read AND written here, which is the
  //     serialization point: two people booking the last seat of a class
  //     conflict on that document and one of them retries against the other's
  //     committed count. The bookings subcollection supplies the number; the
  //     session doc is the lock. Reading `bookings_count` outside a transaction
  //     (what this did before) let both callers see 9 of 10 and both write.
  //  2. THE COUNTER. `bookings_count` is written as an ABSOLUTE value derived
  //     from the read set, never `increment(1)` — the increment landed ON TOP of
  //     trackBookings' recount of the very same booking write, leaving a filling
  //     class one seat over until the next write healed it, i.e. refusing a real
  //     customer.
  //
  // `bio_link_new_contact_bookings_count` stays an increment on purpose: it is a
  // lifetime tally, not a capacity number, and nothing recounts it.
  //
  // It also reports what it found in the caller's own booking slot, because that
  // decides two things below: whether the contact counter moves, and which
  // booking token this seat keeps.
  const commit = await db.runTransaction<BookingCommitResult>(async (tx) => {
    // ── READS (all of them, before the first write) ──
    const freshSession = await tx.get(sessionRef)
    if (!freshSession.exists) throw new HttpsError('not-found', 'Session not found')
    const bookingsSnap = await tx.get(bookingsRef)

    // The acceptance's READ phase, inside the same read set as the seat. Two
    // single-document gets per signed waiver, both on documents only this
    // contact ever writes, so neither adds contention.
    //
    // The get of the ACCEPTANCE REF is not optional and is the trap this whole
    // module exists to disarm: `recordFinanceTransaction`'s `.create()` +
    // catch-gRPC-6 idiom works only OUTSIDE a transaction. Inside one, a
    // `tx.create` collision does not throw at the call — it fails the WHOLE
    // commit as a precondition violation and takes the seat with it. A client
    // retrying after a network timeout, or a visitor who ticks once and books
    // Tuesday's class and then Thursday's from the same mounted flow, both
    // produce the identical derived id.
    const waiverPlans = await planWaiverLedgerWrites(tx, waiverOutcome.accepts, waiverNowMs)

    interface UsableGrant {
      ref: FirebaseFirestore.DocumentReference
      credits_used: number
    }
    let grant: UsableGrant | null = null
    let windowRef: FirebaseFirestore.DocumentReference | null = null
    let windowUsed = 0
    const nowMs = Date.now()

    if (creditSpendTypeId) {
      // Credit-pack booking: FIFO across the contact's usable grants (soonest
      // expiry first, then oldest). Re-read inside the transaction so the last
      // credit cannot be spent twice.
      const grantsSnap = await tx.get(
        db
          .collection('contacts')
          .doc(contactId)
          .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
          .where('teamId', '==', data.teamId)
          .where('subscription_type_id', '==', creditSpendTypeId)
      )
      grant =
        grantsSnap.docs
          .map((d) => {
            const g = d.data()
            return {
              ref: d.ref,
              credits_total: (g.credits_total as number) ?? 0,
              credits_used: (g.credits_used as number) ?? 0,
              expires_at: (g.expires_at as Timestamp | null) ?? null,
              created_at: (g.created_at as Timestamp | null) ?? null,
            }
          })
          .filter(
            (g) =>
              g.credits_used < g.credits_total && (!g.expires_at || g.expires_at.toMillis() > nowMs)
          )
          .sort((a, b) => {
            const ax = a.expires_at?.toMillis() ?? Number.MAX_SAFE_INTEGER
            const bx = b.expires_at?.toMillis() ?? Number.MAX_SAFE_INTEGER
            if (ax !== bx) return ax - bx
            return (a.created_at?.toMillis() ?? 0) - (b.created_at?.toMillis() ?? 0)
          })[0] ?? null
      if (!grant) {
        throw new HttpsError(
          'permission-denied',
          'No lesson credits remaining on your pack. Purchase a new pack to book this class.'
        )
      }
    } else if (usageSpend) {
      // Usage-limited subscription ("3 classes per week"): consume one unit of
      // the window the CLASS falls in. Same race, settled the same way.
      windowRef = db
        .collection('contacts')
        .doc(contactId)
        .collection('usage_windows')
        .doc(usageSpend.docId)
      const windowSnap = await tx.get(windowRef)
      windowUsed = (windowSnap.data()?.used as number | undefined) ?? 0
      if (windowUsed >= usageSpend.count) {
        throw new HttpsError(
          'permission-denied',
          'You have used all the classes your membership includes for this period.'
        )
      }
    }

    // ── CAPACITY (authoritative) ──
    // The caller's own document is excluded: this write REPLACES it (a returning
    // guest whose drop-in hold is still live, a re-book over a pending booking),
    // so counting it would refuse them a seat they already occupy.
    const holding = countHoldingSeats(bookingsSnap.docs, nowMs, contactId)
    if (seatsFree(freshSession.data()?.max_participants as number | undefined, holding) <= 0) {
      throw new HttpsError('resource-exhausted', 'This session is fully booked.', {
        reason: 'session_full',
      })
    }

    // What is this write landing ON TOP of? Both answers below come from that
    // one document, resolved once, inside the transaction that replaces it.
    const replaced = bookingsSnap.docs.find((d) => d.id === contactId)?.data() as
      | (ReplacedBookingShape & { booking_token?: string })
      | undefined

    // The write is a full `set`, so a fresh token here would silently kill the
    // manage/cancel link in the confirmation mail the FIRST booking sent — the
    // person clicks it and is told their booking no longer exists. The document
    // is the same person on the same session, so it keeps the token it already
    // had; only a brand-new seat mints one. (The duplicate confirmation email
    // itself remains: re-booking a seat you already hold sends a second mail.
    // Both now carry a link that works.)
    const effectiveToken = replaced?.booking_token || bookingToken
    const bookingDocToWrite = { ...bookingDoc, booking_token: effectiveToken }

    // ── WRITES ──
    // The acceptance and the seat commit together or not at all: a signature
    // that could fail while the seat succeeded is an evidence hole in a
    // compliance feature, and the alternative placement — beside the partner
    // ledger and the contact alert after the commit — is the zone where
    // failures are logged and swallowed.
    commitWaiverLedgerWrites(tx, waiverPlans)
    if (grant) {
      tx.update(grant.ref, { credits_used: grant.credits_used + 1 })
      tx.set(bookingRef, { ...bookingDocToWrite, credit_grant_id: grant.ref.id, credit_spent: 1 })
    } else if (usageSpend && windowRef) {
      tx.set(
        windowRef,
        {
          teamId: data.teamId,
          subscription_type_id: usageSpend.subscriptionTypeId,
          used: windowUsed + 1,
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      tx.set(bookingRef, {
        ...bookingDocToWrite,
        usage_window_doc_id: usageSpend.docId,
        usage_window_type_id: usageSpend.subscriptionTypeId,
      })
    } else {
      tx.set(bookingRef, bookingDocToWrite)
    }
    tx.set(
      sessionRef,
      {
        has_bookings: true,
        bookings_count: holding + 1,
        ...(isNewContact && { bio_link_new_contact_bookings_count: FieldValue.increment(1) }),
        last_booking_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )

    // Was the document this write replaces ALREADY counted in the contact's
    // `pending_bookings_count`? That, and not "was it a waitlist claim", is the
    // question — see `replacedBookingWasCounted` for which shapes can be
    // standing here and which one of them was never counted.
    return {
      alreadyCounted: replacedBookingWasCounted(replaced),
      bookingToken: effectiveToken,
    }
  })
  // Locale-pinned: the confirmation mail is built in the studio's language
  // (`lang`), and an unprefixed link would hand the member an English page.
  const manageBookingUrl = teamSlug
    ? localizedPublicUrl(getHostingUrl(), lang, teamSlug, 'manage-booking', {
        token: commit.bookingToken,
      })
    : null

  // Partner (aggregator) visit ledger — a booking covered via a
  // source:'aggregator' subscription type (FitPass/SportPass/USC…) earns the
  // studio a per-visit payout from the partner. Reporting only, best-effort:
  // a ledger failure must never fail the booking. Doc id session_contact ⇒
  // idempotent across retries; cancelBooking flips it to 'cancelled'.
  if (matchedSubscriptionTypeId && !creditSpendTypeId) {
    try {
      const typeSnap = await admin
        .firestore()
        .collection('teams')
        .doc(data.teamId)
        .collection('subscription_types')
        .doc(matchedSubscriptionTypeId)
        .get()
      const typeData = typeSnap.data()
      if (typeData?.source === 'aggregator') {
        await admin
          .firestore()
          .collection('teams')
          .doc(data.teamId)
          .collection(PARTNER_VISITS_SUBCOLLECTION)
          .doc(`${data.sessionId}_${contactId}`)
          .set({
            teamId: data.teamId,
            contactId,
            sessionId: data.sessionId,
            subscription_type_id: matchedSubscriptionTypeId,
            subscription_type_name: (typeData.name as string) ?? null,
            // Major units, team currency; null = rate not configured yet.
            amount: typeof typeData.payoutPerVisit === 'number' ? typeData.payoutPerVisit : null,
            session_start: sessionData.start ?? null,
            activity_name: (sessionData.activityName as string | undefined) ?? null,
            status: 'booked',
            created_at: FieldValue.serverTimestamp(),
          })
      }
    } catch (ledgerErr) {
      console.error('[bookSession] partner_visits ledger write failed:', ledgerErr)
    }
  }

  // A brand-new contact is created carrying `pending_bookings_count: 1`, and a
  // replaced document that was already counted must not be counted twice — see
  // the transaction's return value. Everything else gets the increment here.
  if (!isNewContact && !commit.alreadyCounted) {
    await admin
      .firestore()
      .collection('contacts')
      .doc(contactId)
      .update({ pending_bookings_count: FieldValue.increment(1) })
  }

  // Contact alert (booking notification, shows immediately)
  try {
    const sessionStart: Date = (sessionData.start as Timestamp).toDate()
    await admin
      .firestore()
      .collection('contacts')
      .doc(contactId)
      .collection('contact_alerts')
      .add({
        teamId: data.teamId,
        contact: {
          id: contactId,
          firstname: sanitized.firstname,
          lastname: sanitized.lastname,
          avatar_url: authenticatedContact?.avatar_url ?? null,
        },
        message: `New booking for ${activityName} on ${sessionStart.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich' })}`,
        schedule: { type: 'datetime', value: Timestamp.now() },
        alert_type: 'booking',
        session_id: data.sessionId,
        created_at: FieldValue.serverTimestamp(),
        archived_at: null,
      })
  } catch (alertErr) {
    console.error('Failed to create contact alert for booking:', alertErr)
  }

  // Referral tracking (non-fatal)
  if (referrerContactId && referrerContactId !== contactId) {
    try {
      const existingReferral = await admin
        .firestore()
        .collection('referrals')
        .where('referred_contact_id', '==', contactId)
        .where('team_id', '==', data.teamId)
        .limit(1)
        .get()
      if (existingReferral.empty) {
        const referralId = await createReferral(referrerContactId, contactId, data.teamId)
        // The plugin's `referral_created` trigger. Fired HERE, at the write that
        // creates the referral — see referrals/events.ts for why the subject is
        // the referrer and not the friend who just booked.
        await fireReferralCreated({
          teamId: data.teamId,
          referrerContactId,
          referredContactId: contactId,
          referralId,
        })
      }
    } catch (refErr) {
      console.error('Failed to create referral record:', refErr)
    }
  }

  // Send confirmation email — member-facing, per-team toggleable (Automations →
  // System emails). Coach/studio notifications below are unaffected.
  //
  // THIS IS THE FREE PATH, AND ITS TOGGLE STAYS. A free booking's confirmation
  // is a courtesy: a studio may legitimately run its own from the automations
  // engine, and switching this off leaves nobody stuck. The PAID path
  // deliberately has no toggle at all (booking/paidConfirmation.ts, reached from
  // the Connect webhook and the gift-card full cover) because there the same
  // mail is the receipt, the manage-booking link and the only invitation into
  // the member area. Free-is-switchable / paid-is-not is the design — do not
  // "tidy" the two into one flag.
  const confirmationEnabled = await systemEmailEnabledFor(data.teamId, 'booking_confirmation')
  const sessionStart: Date = sessionData.start.toDate()
  const sessionEnd: Date = sessionData.end.toDate()

  try {
    if (confirmationEnabled) {
      const mail = buildClassBookingConfirmationMail({
        firstname: sanitized.firstname,
        teamName,
        activityName,
        sessionStart,
        sessionEnd,
        locationName: sessionData.location || null,
        manageBookingUrl,
        // The Space link rides on the free path too: the complaint it answers —
        // nobody is ever told the portal exists — is not about the tender.
        spaceUrl: teamSlug
          ? localizedPublicUrl(getHostingUrl(), lang, teamSlug, 'space')
          : null,
        instructions: bookingInstructions,
        cancellationPolicy,
        reference: bookingReference,
        lang,
        bookingId: `${data.sessionId}-${contactId}`,
        attendeeName: `${sanitized.firstname} ${sanitized.lastname}`.trim(),
        attendeeEmail: sanitized.email,
        // The ORGANIZER of the calendar invite: the studio's published address,
        // through the ONE resolver that owns that precedence (the same one
        // `sendEmail` uses for Reply-To) rather than a second reading of it.
        organizerEmail: await getTeamContactEmail(
          data.teamId,
          team as unknown as Record<string, unknown>
        ),
      })
      await sendEmail({
        to: sanitized.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: mail.attachments,
        teamId: data.teamId,
      })
      console.log(`Confirmation email sent to ${sanitized.email}`)
    }
  } catch (err) {
    console.error('Error sending confirmation email:', err)
  }

  // Send notification to owner
  if (ownerEmail) {
    try {
      const notifEmail = buildTeacherNotificationEmail({
        teamOwnerFirstname: ownerFirstname,
        contactName: `${sanitized.firstname} ${sanitized.lastname}`,
        contactEmail: sanitized.email,
        contactPhone: sanitized.phone,
        activityName,
        sessionStart,
        sessionEnd,
        lang,
      })
      const subjects: Record<Lang, string> = {
        en: `New Booking: ${sanitized.firstname} ${sanitized.lastname}`,
        de: `Neue Buchung: ${sanitized.firstname} ${sanitized.lastname}`,
        fr: `Nouvelle réservation : ${sanitized.firstname} ${sanitized.lastname}`,
        it: `Nuova prenotazione: ${sanitized.firstname} ${sanitized.lastname}`,
      }
      await sendEmail({
        to: ownerEmail,
        subject: subjects[lang],
        html: notifEmail.html,
        text: notifEmail.text,
        teamId: data.teamId,
      })
      console.log(`Owner notification sent to ${ownerEmail}`)
    } catch (err) {
      console.error('Error sending owner notification:', err)
    }
  }

  return {
    success: true,
    contactId,
    sessionId: data.sessionId,
    isNewContact,
    isAuthenticatedBooking,
    bookingReference,
    sessionDetails: {
      activityName,
      start: sessionStart.toISOString(),
      end: sessionEnd.toISOString(),
    },
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// cancelBooking — public, token-based (unauthenticated)
//
// WHAT IT GIVES BACK, stated once so the copy on the member surfaces can be
// checked against it: a spent lesson credit and a usage-window unit, both
// unconditionally (no window, and even if the pack/window has since expired).
// NOT money — this callable issues no refund of any kind, and none of its
// callers may say otherwise. See `BookingCancelEffect` in @linyup/shared.
//
// Every refusal below is FINAL, and carries `details.reason` so a public page
// can print what happened rather than a raw server sentence under a "try
// again" that cannot work. See `BookingCancelRefusal`.
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal, tagged with the machine reason the member surfaces render. */
function cancelRefused(
  code: 'not-found' | 'failed-precondition',
  reason: BookingCancelRefusal,
  message: string
): HttpsError {
  return new HttpsError(code, message, { reason })
}

export const cancelBooking = onCall(async (request): Promise<CancelBookingResult> => {
  const { token } = request.data as { token?: string }
  if (!token) throw new HttpsError('invalid-argument', 'Booking token is required')

  const db = admin.firestore()

  let bookingsSnapshot = await db
    .collectionGroup('bookings')
    .where('booking_token', '==', token)
    .limit(1)
    .get()
  if (bookingsSnapshot.empty) {
    bookingsSnapshot = await db
      .collectionGroup('participants')
      .where('booking_token', '==', token)
      .limit(1)
      .get()
  }
  if (bookingsSnapshot.empty) {
    throw cancelRefused(
      'not-found',
      'not_found',
      'Booking not found. The link may have expired or the booking was already cancelled.'
    )
  }

  const bookingDoc = bookingsSnapshot.docs[0]
  const booking = bookingDoc.data()

  const pathParts = bookingDoc.ref.path.split('/')
  const sessionId = pathParts[1]
  const contactId = booking.contact as string | undefined

  const [sessionErr, sessionDoc] = await to(db.collection('sessions').doc(sessionId).get())
  if (sessionErr || !sessionDoc || !sessionDoc.exists)
    throw cancelRefused('not-found', 'session_gone', 'Session no longer exists.')

  const session = sessionDoc.data()!
  const isAppointment = session.activityType === 'appointment'

  // Resolve the parent activity once — used both for the cancellable-status
  // re-key below (session-level autoConfirm, else the activity's) and for the
  // activity name shown in the cancellation email.
  let activityName = 'Session'
  let activityAutoConfirm: boolean | undefined
  let activityTypeVal: ActivityType | undefined
  if (session.activityId) {
    const [actErr, actDoc] = await to(
      db
        .collection('activities')
        .doc(session.activityId as string)
        .get()
    )
    if (!actErr && actDoc && actDoc.exists) {
      const actData = actDoc.data()!
      activityName = (actData.name as string) || 'Session'
      activityAutoConfirm = actData.autoConfirm as boolean | undefined
      activityTypeVal = actData.type as ActivityType | undefined
    }
  }
  const sessionAutoConfirm =
    typeof session.autoConfirm === 'boolean'
      ? (session.autoConfirm as boolean)
      : resolveAutoConfirm({
          autoConfirm: activityAutoConfirm,
          type: activityTypeVal ?? (isAppointment ? 'appointment' : 'class'),
        })

  // A session that auto-confirms treats 'confirmed' as the normal (still
  // cancellable) booked state; one that doesn't uses 'confirmed' to mean the
  // studio checked the client in — that stays locked.
  const cancellableStatuses = sessionAutoConfirm
    ? ['pending', 'no_show', 'confirmed']
    : ['pending', 'no_show']
  if (booking.status && !cancellableStatuses.includes(booking.status as string)) {
    throw cancelRefused(
      'failed-precondition',
      'already_settled',
      'This booking has already been cancelled or confirmed.'
    )
  }

  const sessionStart = (session.start as Timestamp).toDate()
  if (sessionStart < new Date())
    throw cancelRefused(
      'failed-precondition',
      'past',
      'Cannot cancel a booking for a past session.'
    )

  const teamId = (session.teamId || session.teacher) as string
  let teamName = ''
  let teamLanguage = 'en'
  let teamSlug: string | null = null
  let ctaUrl: string | null = null

  const [teamErr, teamDoc] = await to(db.collection('teams').doc(teamId).get())
  if (!teamErr && teamDoc && teamDoc.exists) {
    const team = teamDoc.data()!
    teamName = (team.name as string) || ''
    teamSlug = (team.slug as string) || null
    teamLanguage = (team.language as string) || 'en'
    ctaUrl = (team.settings?.trialBookingCtaUrl as string) || null
  }

  // Transaction (not a batch) so a spent lesson credit is refunded atomically
  // with the cancellation. Refund floors at 0 and applies even if the grant has
  // expired meanwhile — the swimmer paid for a lesson they now didn't take.
  //
  // It reads the session document AND its bookings, and writes the session
  // document. The freed seat is written as an ABSOLUTE count from that same read
  // set (no `increment(-1)`), and the session doc being genuinely IN the read set
  // is what makes a cancel and a concurrent booking conflict on it and
  // serialize — the identical lock bookSession takes (see its transaction: "the
  // bookings subcollection supplies the number; the session doc is the lock").
  //
  // The session read is not optional bookkeeping. This paragraph used to assert
  // the serialization while the transaction only ever read the bookings
  // subcollection: a document that is written but never read carries no version
  // precondition, so the claim was simply false. One read is a small price for a
  // lock that is real rather than asserted.
  //
  // It also REPORTS what it gave back (`BookingCancelEffect`), read off the same
  // read set that performed the refunds — so the sentence the member is shown
  // ("your credit is back on your pack") is the transaction's own outcome and
  // not a second guess made from the pre-read booking document.
  const sessionRef = db.collection('sessions').doc(sessionId)
  const returned: BookingCancelEffect = await db.runTransaction(async (tx) => {
    const freshSession = await tx.get(sessionRef)
    if (!freshSession.exists)
      throw cancelRefused('not-found', 'session_gone', 'Session no longer exists.')
    const freshSessionData = freshSession.data()!
    const bookingsSnap = await tx.get(sessionRef.collection('bookings'))
    // The document being cancelled still counts as holding a seat in this read
    // set — exclude it, since the very next write releases it. Only when it IS
    // a booking: a `participants` hit (checked-in attendee) leaves the bookings
    // subcollection untouched, so the honest post-state is the plain recount.
    const cancelledBookingId =
      bookingDoc.ref.parent.id === 'bookings' ? bookingDoc.id : undefined
    const remaining = countHoldingSeats(bookingsSnap.docs, Date.now(), cancelledBookingId)

    let grantRefund: { ref: FirebaseFirestore.DocumentReference; used: number } | null = null
    if (contactId && booking.credit_grant_id && booking.credit_spent) {
      const grantRef = db
        .collection('contacts')
        .doc(contactId)
        .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
        .doc(booking.credit_grant_id as string)
      const grantSnap = await tx.get(grantRef)
      if (grantSnap.exists) {
        grantRefund = { ref: grantRef, used: (grantSnap.data()?.credits_used as number) ?? 0 }
      }
    }
    // Usage-limited booking: refund the window unit (floors at 0; applies even
    // if the window has meanwhile rolled over — the doc id pins the ORIGINAL
    // window, so a cancellation after the reset harmlessly refunds a past one).
    let usageRefund: { ref: FirebaseFirestore.DocumentReference; used: number } | null = null
    if (contactId && booking.usage_window_doc_id) {
      const windowRef = db
        .collection('contacts')
        .doc(contactId)
        .collection('usage_windows')
        .doc(booking.usage_window_doc_id as string)
      const windowSnap = await tx.get(windowRef)
      if (windowSnap.exists) {
        usageRefund = { ref: windowRef, used: (windowSnap.data()?.used as number) ?? 0 }
      }
    }
    tx.update(bookingDoc.ref, {
      status: 'cancelled',
      cancelled_at: FieldValue.serverTimestamp(),
    })
    tx.update(sessionRef, {
      bookings_count: remaining,
      // Release the appointment slot. A window-created session only existed for this
      // booking, so cancel it (unpublishes via the sync gate) — its time returns
      // to the coach's open window. A fixed slot reopens for the next client.
      //
      // Decided from the IN-TRANSACTION snapshot, not the pre-read `session`:
      // `status` is exactly the field a concurrent writer moves, and reopening a
      // slot from a copy taken before the lock was held is how a cancelled
      // session gets flipped back to 'open'.
      ...(isAppointment && {
        ...(freshSessionData.origin === 'window'
          ? { status: 'cancelled', allowBooking: false }
          : freshSessionData.status === 'full'
            ? { status: 'open' }
            : {}),
      }),
    })
    if (contactId) {
      tx.update(db.collection('contacts').doc(contactId), {
        pending_bookings_count: FieldValue.increment(-1),
      })
    }
    if (grantRefund) {
      tx.update(grantRefund.ref, { credits_used: Math.max(0, grantRefund.used - 1) })
    }
    if (usageRefund) {
      tx.update(usageRefund.ref, { used: Math.max(0, usageRefund.used - 1) })
    }
    // `paid` is a fact about the booking, not an action taken here: nothing in
    // this callable refunds money, and the member surfaces say so.
    return {
      credit: !!grantRefund,
      usageUnit: !!usageRefund,
      paid: bookingWasPaidFor(booking as SeatHold),
    }
  })

  // Partner visit ledger: a cancelled booking earns no payout. Best-effort —
  // most bookings have no ledger row (update on a missing doc just throws).
  try {
    await db
      .collection('teams')
      .doc(teamId)
      .collection(PARTNER_VISITS_SUBCOLLECTION)
      .doc(`${sessionId}_${contactId}`)
      .update({ status: 'cancelled', cancelled_at: FieldValue.serverTimestamp() })
  } catch {
    // No ledger row — not an aggregator-covered booking.
  }

  // Locale-pinned: this URL goes into a mail written in the studio's language.
  const rebookUrl = teamSlug
    ? isAppointment
      ? localizedPublicUrl(getHostingUrl(), teamLanguage, teamSlug, 'appointments')
      : localizedPublicUrl(getHostingUrl(), teamLanguage, teamSlug, 'booking', {
          activity: session.activityId,
        })
    : null

  const sessionEnd = (session.end as Timestamp).toDate()
  const dateStr = sessionStart.toLocaleDateString('en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const timeStr = `${sessionStart.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })} – ${sessionEnd.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`
  const firstname = (booking.firstname as string) || 'Guest'
  const rebookLine = rebookUrl
    ? `<p style="text-align:center;margin-top:24px;">${ctaButton(rebookUrl, 'Book another session')}</p>`
    : ''

  try {
    if (await systemEmailEnabledFor(teamId, 'booking_confirmation')) {
      const { html } = buildEmailTemplate({
        title: 'Booking cancelled',
        body: `<p>Hi ${firstname},</p><p>Your booking for <strong>${activityName}</strong> with ${teamName} on ${dateStr} at ${timeStr} has been cancelled.</p>${rebookLine}`,
      })
      await sendEmail({
        to: booking.email as string,
        teamId,
        subject: `Booking Cancelled – ${activityName}`,
        html,
        text: `Hi ${firstname},\n\nYour booking for ${activityName} with ${teamName} on ${dateStr} at ${timeStr} has been cancelled.\n${rebookUrl ? `Book another session: ${rebookUrl}` : ''}`,
      })
    }
  } catch (err) {
    console.error('Error sending cancellation confirmation email:', err)
  }

  return { success: true, message: 'Your booking has been cancelled.', rebookUrl, returned }
})

// ─────────────────────────────────────────────────────────────────────────────
// getBookingDetails — public, token-based (unauthenticated)
// ─────────────────────────────────────────────────────────────────────────────

export const getBookingDetails = onCall(async (request) => {
  const { token } = request.data as { token?: string }
  if (!token) throw new HttpsError('invalid-argument', 'Booking token is required.')

  const db = admin.firestore()

  let bookingsSnapshot = await db
    .collectionGroup('bookings')
    .where('booking_token', '==', token)
    .limit(1)
    .get()
  if (bookingsSnapshot.empty) {
    bookingsSnapshot = await db
      .collectionGroup('participants')
      .where('booking_token', '==', token)
      .limit(1)
      .get()
  }
  if (bookingsSnapshot.empty) {
    throw new HttpsError(
      'not-found',
      'Booking not found. The link may have expired or the booking was cancelled.'
    )
  }

  const bookingDoc = bookingsSnapshot.docs[0]
  const booking = bookingDoc.data()
  const pathParts = bookingDoc.ref.path.split('/')
  const sessionId = pathParts[1]

  const [sessionErr, sessionDoc] = await to(db.collection('sessions').doc(sessionId).get())
  if (sessionErr || !sessionDoc || !sessionDoc.exists) {
    throw new HttpsError('not-found', 'Session no longer exists.')
  }
  const session = sessionDoc.data()!
  const teamId = (session.teamId || session.teacher) as string

  let activityName = 'Session'
  let activityAutoConfirm: boolean | undefined
  let activityKind: ActivityType | undefined
  const activityId = (session.activityId as string) || null
  if (activityId) {
    const [actErr, actDoc] = await to(db.collection('activities').doc(activityId).get())
    if (!actErr && actDoc && actDoc.exists) {
      const actData = actDoc.data()!
      activityName = (actData.name as string) || 'Session'
      activityAutoConfirm = actData.autoConfirm as boolean | undefined
      activityKind = actData.type as ActivityType | undefined
    }
  }

  let teamName = ''
  let teamSlug: string | null = null
  let teamLanguage = 'en'
  const [, teamDoc] = await to(db.collection('teams').doc(teamId).get())
  if (teamDoc && teamDoc.exists) {
    const team = teamDoc.data()!
    teamName = (team.name as string) || ''
    teamSlug = (team.slug as string) || null
    teamLanguage = (team.language as string) || 'en'
  }
  // This list IS the public rebook picker (manage-booking page). `rebookSession`
  // refuses a move past the online booking cutoff for a token holder, so a slot
  // offered here that the callable will reject is a dead end with an error
  // message at the end of it. Filtered where the list is built rather than in
  // the page, so the picker and the callable that accepts its choice apply one
  // rule read from one store (bookingSettings.ts).
  const { cutoffMinutes: rebookCutoffMinutes } = await loadBookingSettings(teamId)

  const now = Timestamp.now()
  const futureLimit = new Date()
  futureLimit.setDate(futureLimit.getDate() + 60)

  let availableSessions: Array<{
    id: string
    start: string
    end: string
    location: string | null
  }> = []
  if (activityId) {
    const [, sessSnap] = await to(
      db
        .collection('sessions')
        .where('teamId', '==', teamId)
        .where('activityId', '==', activityId)
        .where('allowBooking', '==', true)
        .where('start', '>=', now)
        .where('start', '<=', Timestamp.fromDate(futureLimit))
        .orderBy('start', 'asc')
        .limit(5)
        .get()
    )
    if (sessSnap) {
      availableSessions = sessSnap.docs
        .filter((d) => {
          const data = d.data()
          if (data.isException && data.exceptionType === 'cancelled') return false
          if (isPastBookingCutoff(data.start as Timestamp, rebookCutoffMinutes)) return false
          return d.id !== sessionId
        })
        .map((d) => {
          const data = d.data()
          return {
            id: d.id,
            start: (data.start as Timestamp).toDate().toISOString(),
            end: (data.end as Timestamp).toDate().toISOString(),
            location: (data.location as string) || null,
          }
        })
    }
  }

  const sessionStart = (session.start as Timestamp).toDate()
  const isPastSession = sessionStart < new Date()
  const bookingStatus = (booking.status as string) || 'pending'
  // ONE cancellable rule, shared with the member portal (`memberCanCancel`),
  // which re-derives `cancelBooking`'s own gates. The local copy this replaces
  // was a THIRD reading of them and disagreed with both: it hard-coded
  // ['pending','no_show'], so on a session that AUTO-CONFIRMS — where
  // 'confirmed' is the ordinary booked state — the emailed link offered no
  // Cancel button at all for a booking the callable would happily have
  // cancelled, and the portal did. It also offered one on a session the studio
  // had already called off.
  const autoConfirm =
    typeof session.autoConfirm === 'boolean'
      ? (session.autoConfirm as boolean)
      : resolveAutoConfirm({
          autoConfirm: activityAutoConfirm,
          type:
            activityKind ?? (session.activityType === 'appointment' ? 'appointment' : 'class'),
        })
  const canCancel = memberCanCancel({
    bookingStatus,
    hasToken: true, // the caller reached this document BY its token
    startMs: sessionStart.getTime(),
    nowMs: Date.now(),
    autoConfirm,
    sessionCancelled: isSessionCancelled(session),
  })
  const canRebook = canCancel && availableSessions.length > 0

  // What cancelling would give back, so the confirmation step can SAY it before
  // the member commits rather than after. Read off this booking's own markers —
  // the same three fields `cancelBooking`'s transaction acts on. `paid` is the
  // one that has to be stated without softening: nothing here refunds money.
  const cancelReturns: BookingCancelEffect = {
    credit: !!booking.credit_grant_id && !!booking.credit_spent,
    usageUnit: !!booking.usage_window_doc_id,
    paid: bookingWasPaidFor(booking as SeatHold),
  }

  return {
    success: true,
    cancelReturns,
    booking: {
      contactId: booking.contact,
      firstname: booking.firstname,
      lastname: booking.lastname,
      email: booking.email,
      phone: (booking.phone as string) || null,
      status: bookingStatus,
      joinedAt: (booking.joinedAt as Timestamp | undefined)?.toDate().toISOString() || null,
    },
    session: {
      id: sessionId,
      start: sessionStart.toISOString(),
      end: (session.end as Timestamp).toDate().toISOString(),
      location: (session.location as string) || null,
      isPast: isPastSession,
    },
    activity: { id: activityId, name: activityName },
    team: { id: teamId, name: teamName, slug: teamSlug, language: teamLanguage },
    availableSessions,
    canCancel,
    canRebook,
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// rebookSession — public, token-based (unauthenticated)
//
// TAKES NO WAIVER, deliberately. It MOVES an existing seat and creates no new
// attendance relationship, and a publish never retroactively invalidates a
// booking that already committed. Its two callers — the studio's bookings list
// and the public manage-booking link — have no waiver step to send anyone to,
// so a refusal here would be a dead end on one and would break a coach's daily
// workflow on the other, while that same coach can add the same person to the
// same session directly. Gating it would be stricter on the reversible
// operation than on the irreversible one. See the census in waivers/gate.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const rebookSession = onCall(async (request) => {
  const { token, newSessionId } = request.data as { token?: string; newSessionId?: string }
  if (!token) throw new HttpsError('invalid-argument', 'Booking token is required.')
  if (!newSessionId) throw new HttpsError('invalid-argument', 'New session ID is required.')

  const db = admin.firestore()

  let bookingsSnapshot = await db
    .collectionGroup('bookings')
    .where('booking_token', '==', token)
    .limit(1)
    .get()
  if (bookingsSnapshot.empty) {
    bookingsSnapshot = await db
      .collectionGroup('participants')
      .where('booking_token', '==', token)
      .limit(1)
      .get()
  }
  if (bookingsSnapshot.empty) {
    throw new HttpsError(
      'not-found',
      'Booking not found. The link may have expired or the booking was already cancelled.'
    )
  }

  const bookingDoc = bookingsSnapshot.docs[0]
  const booking = bookingDoc.data()
  const rebookableStatuses = ['pending', 'no_show']
  if (booking.status && !rebookableStatuses.includes(booking.status as string)) {
    throw new HttpsError('failed-precondition', 'This booking can no longer be modified.')
  }

  const pathParts = bookingDoc.ref.path.split('/')
  const oldSessionId = pathParts[1]
  const contactId = booking.contact as string

  if (oldSessionId === newSessionId) {
    throw new HttpsError('invalid-argument', 'You are already booked for this session.')
  }

  const [, oldSessionDoc] = await to(db.collection('sessions').doc(oldSessionId).get())
  if (!oldSessionDoc || !oldSessionDoc.exists)
    throw new HttpsError('not-found', 'Original session no longer exists.')
  const oldSession = oldSessionDoc.data()!
  const teamId = (oldSession.teamId || oldSession.teacher) as string

  const [, newSessionDoc] = await to(db.collection('sessions').doc(newSessionId).get())
  if (!newSessionDoc || !newSessionDoc.exists)
    throw new HttpsError('not-found', 'New session not found.')
  const newSession = newSessionDoc.data()!

  const newTeamId = (newSession.teamId || newSession.teacher) as string
  if (newTeamId !== teamId)
    throw new HttpsError('permission-denied', 'Cannot rebook to a session from a different team.')
  if (!newSession.allowBooking)
    throw new HttpsError('failed-precondition', 'This session is not available for booking.')

  const newSessionStart = (newSession.start as Timestamp).toDate()
  if (newSessionStart < new Date())
    throw new HttpsError('failed-precondition', 'Cannot book a session in the past.')
  if (newSession.isException && newSession.exceptionType === 'cancelled') {
    throw new HttpsError('failed-precondition', 'This session has been cancelled.')
  }

  const [[, existBookDoc], [, existPartDoc]] = await Promise.all([
    to(db.collection('sessions').doc(newSessionId).collection('bookings').doc(contactId).get()),
    to(db.collection('sessions').doc(newSessionId).collection('participants').doc(contactId).get()),
  ])
  if ((existBookDoc && existBookDoc.exists) || (existPartDoc && existPartDoc.exists)) {
    throw new HttpsError('already-exists', 'You already have a booking for this session.')
  }

  // The team + its booking settings are read BEFORE the move because the cutoff
  // is a studio-wide setting and this callable never enforced it — a token
  // holder could move themselves into a class minutes before it starts, which
  // every other booking surface refuses (bookSession, createDropInCheckout).
  let teamName = ''
  let teamSlug: string | null = null
  let teamLanguage = 'en'
  const [, teamDoc] = await to(db.collection('teams').doc(teamId).get())
  if (teamDoc && teamDoc.exists) {
    teamName = (teamDoc.data()!.name as string) || ''
    teamSlug = (teamDoc.data()!.slug as string) || null
    teamLanguage = (teamDoc.data()!.language as string) || 'en'
  }
  const { cutoffMinutes: rebookCutoffMinutes } = await loadBookingSettings(teamId)
  // …but ONLY against the public, self-service door. The cutoff is an ONLINE
  // booking rule — that is what the setting is called, what its help text says,
  // and what the refusal below says — and this one callable serves two doors:
  // the token link in a member's own email (unauthenticated, the rule binds) and
  // the studio's Bookings page, where a coach on the phone at 18:30 moves
  // someone into the 19:00 class. Refusing the coach turns a desk workflow that
  // worked yesterday into "Online booking has closed", which is not even a true
  // statement about what they are doing.
  //
  // Team MEMBERSHIP is the test, not a capability: every staff role works the
  // desk, and `request.auth` is populated only for the admin page's call — the
  // public page calls the same function with no auth at all, so the rule still
  // binds exactly where it is meant to.
  const staffCaller = request.auth?.uid ? await isTeamMember(request.auth.uid, teamId) : false
  if (!staffCaller && isPastBookingCutoff(newSession.start as Timestamp, rebookCutoffMinutes)) {
    throw new HttpsError('failed-precondition', 'Online booking has closed for this session.', {
      reason: 'booking_closed',
    })
  }

  // SAME-ACTIVITY only on the public (token) door. rebookSession never runs the
  // booking ACCESS gate that bookSession does (resolveBookingAccessGate —
  // subscription coverage, credit spend, drop-in price), so permitting a move to a
  // DIFFERENT activity let a token holder who booked a FREE/open class rebook into
  // a members-only or drop-in-priced activity and take a free `pending` seat it
  // neither qualified for nor paid for (and escape the once-per-trial limit).
  // accessRule and the drop-in price are per-ACTIVITY, so restricting the
  // self-service move to the same activity keeps the access + payment posture
  // identical to the original booking — which is exactly what getBookingDetails
  // already offers the client (its availableSessions query is scoped to the same
  // activityId). Staff at the desk may move across activities, mirroring the cutoff
  // exemption above.
  if (!staffCaller) {
    const oldActivityId = (oldSession.activityId as string | undefined) ?? null
    const newActivityId = (newSession.activityId as string | undefined) ?? null
    if (oldActivityId !== newActivityId) {
      throw new HttpsError(
        'permission-denied',
        'A booking can only be moved to another session of the same activity.',
        { reason: 'different_activity' }
      )
    }
  }

  const newBookingToken = generateSecureToken()
  const newSessionRef = db.collection('sessions').doc(newSessionId)
  const newBookingRef = newSessionRef.collection('bookings').doc(contactId)

  // The contact's `pending_bookings_count` is a per-DOCUMENT ledger: whoever
  // creates a pending booking counts it, whoever takes it out of that state
  // gives it back. A rebook does both at once and used to do neither, which
  // cancelled out only when the old document was itself a live pending booking.
  // It is not, whenever the token came from a `no_show` (rebookable, and its
  // count was already released when it was marked) or from a `participants`
  // document (a checked-in attendee — released at check-in). Then the new
  // pending booking existed with nothing counting it, and the first cancel or
  // no-show on it drove a real person's counter negative.
  //
  // `replacedBookingWasCounted` cannot repair this from bookSession's side: the
  // rebook-created document looks identical whichever origin it came from, so
  // counting it there would double-count the ordinary pending→pending move. The
  // count belongs where the document is created.
  const oldHeldPendingCount =
    bookingDoc.ref.parent.id === 'bookings' && (!booking.status || booking.status === 'pending')
  const pendingCountDelta = oldHeldPendingCount ? 0 : 1
  const rebookContactRef = contactId ? db.collection('contacts').doc(contactId) : null

  // A transaction, not a batch: this callable had NO capacity check at all, so a
  // token holder could rebook into a class that was already full and oversell
  // it. The new session's doc is in the read AND write set, so the move
  // serializes against bookSession/createDropInCheckout on that class.
  //
  // The old session's counter is deliberately NOT written here: flipping the
  // booking to 'rebooked' fires trackBookings ('rebooked' is in STATUS_EVENT),
  // whose recount owns that number — a blind `increment(-1)` from this batch
  // could only fight it.
  await db.runTransaction(async (tx) => {
    const freshNewSession = await tx.get(newSessionRef)
    if (!freshNewSession.exists) throw new HttpsError('not-found', 'New session not found.')
    const newBookingsSnap = await tx.get(newSessionRef.collection('bookings'))
    // Read rather than blind-update: a contact document can be gone (a purged
    // provisional contact), and `tx.update` on a missing document throws — which
    // would fail the whole rebook over a counter.
    const contactSnap = rebookContactRef ? await tx.get(rebookContactRef) : null
    const holding = countHoldingSeats(newBookingsSnap.docs, Date.now(), contactId)
    if (seatsFree(freshNewSession.data()?.max_participants as number | undefined, holding) <= 0) {
      throw new HttpsError('resource-exhausted', 'This session is fully booked.', {
        reason: 'session_full',
      })
    }

    tx.update(bookingDoc.ref, {
      status: 'rebooked',
      rebooked_to: newSessionId,
      rebooked_at: FieldValue.serverTimestamp(),
    })
    tx.set(newBookingRef, {
      firstname: booking.firstname,
      lastname: booking.lastname,
      email: booking.email,
      phone: (booking.phone as string) || null,
      contact: contactId,
      session: newSessionId,
      teamId,
      joinedAt: FieldValue.serverTimestamp(),
      fromBioLink: true,
      status: 'pending',
      booking_token: newBookingToken,
      rebooked_from: oldSessionId,
      rebooked_at: FieldValue.serverTimestamp(),
    })
    tx.set(
      newSessionRef,
      {
        has_bookings: true,
        bookings_count: holding + 1,
        last_booking_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
    // Zero for the ordinary pending→pending move (the old document's count
    // carries over to the new one), +1 when the old document was not holding a
    // count at all.
    if (pendingCountDelta !== 0 && rebookContactRef && contactSnap?.exists) {
      tx.update(rebookContactRef, {
        pending_bookings_count: FieldValue.increment(pendingCountDelta),
      })
    }
  })

  let activityName = 'Session'
  if (newSession.activityId) {
    const [, actDoc] = await to(
      db
        .collection('activities')
        .doc(newSession.activityId as string)
        .get()
    )
    if (actDoc && actDoc.exists) activityName = (actDoc.data()?.name as string) || 'Session'
  }

  // Locale-pinned — see the note on the confirmation mail's copy of this link.
  const manageBookingUrl = teamSlug
    ? localizedPublicUrl(getHostingUrl(), teamLanguage, teamSlug, 'manage-booking', {
        token: newBookingToken,
      })
    : null

  const oldSessionStart = (oldSession.start as Timestamp).toDate()
  const newSessionEnd = (newSession.end as Timestamp).toDate()
  const locale = 'en-GB'
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }
  const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  const firstname = (booking.firstname as string) || 'Guest'
  const oldDateStr = oldSessionStart.toLocaleDateString(locale, dateOpts)
  const newDateStr = newSessionStart.toLocaleDateString(locale, dateOpts)
  const newTimeStr = `${newSessionStart.toLocaleTimeString(locale, timeOpts)} – ${newSessionEnd.toLocaleTimeString(locale, timeOpts)}`
  const locationLine = newSession.location
    ? `<p><strong>Location:</strong> ${newSession.location}</p>`
    : ''
  const manageLink = manageBookingUrl
    ? `<p><a href="${manageBookingUrl}">Manage your booking</a></p>`
    : ''

  try {
    if (await systemEmailEnabledFor(teamId, 'booking_confirmation')) {
      await sendEmail({
        to: booking.email as string,
        teamId,
        subject: `Booking Changed – ${activityName}`,
        html: `<p>Hi ${firstname},</p><p>Your booking for <strong>${activityName}</strong> with ${teamName} has been changed.</p><p><strong>Previous date:</strong> ${oldDateStr}</p><p><strong>New date:</strong> ${newDateStr} at ${newTimeStr}</p>${locationLine}${manageLink}`,
        text: `Hi ${firstname},\n\nYour booking for ${activityName} with ${teamName} has been changed.\nPrevious date: ${oldDateStr}\nNew date: ${newDateStr} at ${newTimeStr}\n${newSession.location ? `Location: ${newSession.location}\n` : ''}${manageBookingUrl ? `Manage your booking: ${manageBookingUrl}` : ''}`,
      })
    }
  } catch (err) {
    console.error('Error sending rebook confirmation email:', err)
  }

  return {
    success: true,
    message: 'Your booking has been changed.',
    newBookingToken,
    newSession: {
      id: newSessionId,
      start: newSessionStart.toISOString(),
      end: newSessionEnd.toISOString(),
    },
    manageBookingUrl,
  }
})
