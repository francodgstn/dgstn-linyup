/* eslint-disable no-console */
// The "phone booking" case — a studio manager creates an appointment ON BEHALF
// OF a client (or blocks a provider's calendar) directly from the admin. This is
// NOT the public booking flow: there is no availability lookup, no price gate,
// no guest/OTP trust ladder — the manager decides the client, the price, and
// how it gets paid. Reuses the SAME overlap-safe slot machinery as the public
// paths (runAppointmentSlotTransaction from ./booking) so a staff-created
// appointment and a client-created one can never double-book the same provider
// window, and reuses the manual-payment ledger (writeManualPaymentEvent) and
// the Connect checkout helpers (createOneOffCheckoutSession) so every rail a
// staff booking can settle through is the SAME rail an equivalent public flow
// already uses — see docs/appointments.md "Paid appointments".
//
//   • createStaffAppointment — book an existing/new contact, or block time.
//     Four ways to settle a priced booking: free (unpriced/explicit 0), paid on
//     the spot (offline, recorded immediately), pending offline (confirmed, pay
//     later in person), or a Stripe Connect payment LINK emailed to the client
//     (mirrors the public checkout hold — confirmed by the SAME webhook).
//   • markAppointmentPaid — settle a 'pending_offline' hold once the client
//     actually pays (cash/bank transfer/TWINT taken in person).
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  CONTACTS_COLLECTION,
  SESSIONS_COLLECTION,
  TEAMS_COLLECTION,
  TEAM_MEMBERS_SUBCOLLECTION,
  computePlatformFee,
  resolveAppointmentDurations,
  resolveDurationSale,
  resolveAutoConfirm,
  type Activity,
  type SaasPlan,
  localizedPublicUrl,
} from '@linyup/shared'
import {
  assertManager,
  loadEnabledTeam,
  platformFeeMetadata,
  requireChargeableAccount,
} from '../connect/access'
import { closeTeamCheckoutSession, STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES } from '../connect/checkout'
import type { CheckoutSessionCloseOutcome } from '../utils/connect/client'
import { createOneOffCheckoutSession } from '../utils/connect/client'
import { resolveBaseUrl, getHostingUrl } from '../utils/env'
import { generateSecureToken } from '../utils/crypto'
import { getTeam } from '../utils/teams'
import { resolveSingleContact } from '../utils/contacts'
import { canCreateContact } from '../utils/contactCap'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { writeManualPaymentEvent } from '../payments/recordManualPayment'
import { asLang, runAppointmentSlotTransaction } from './booking'
import { releaseAppointmentHold } from './holdRelease'
import { sendAppointmentBookingEmails } from './emails'
import { partyBookingFields, partyCheckoutMetadata, readStaffAppointmentParty } from './party'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NOTE_LEN = 500
// Stripe's minimum charge — only enforced on the 'payment_link' rail (the
// offline modes don't touch Stripe at all).
const MIN_LINK_AMOUNT_MINOR = 50
// The Stripe Checkout Session stays open as long as Stripe allows, which is
// just under 24 hours (a manager sending a link by phone/SMS can't count on the
// client paying within the public flow's 30-minute hold window).
// checkout.session.expired (already handled by the Connect webhook, see
// webhook.ts's handleCheckoutExpired) releases the hold when it lapses; the
// session doc deliberately carries NO hold_expires_at so the daily sweep
// (dailyTasks/expirePendingBookings.ts) leaves it alone in the meantime, same
// rationale as the pending_offline mode.
//
// It was a WEEK until 2026-09-25, which Stripe refuses outright ("expires_at
// must be less than 24 hours from Checkout Session creation"): every
// "Send payment link" failed with "Failed to create the payment link", and the
// email promised a week the link could never have. The margin keeps the value
// strictly below Stripe's limit, which counts from ITS clock, not ours.
export const PAYMENT_LINK_EXPIRY_SECONDS = (STRIPE_MAX_CHECKOUT_EXPIRY_MINUTES - 10) * 60

type StaffBookingPaymentMode = 'paid_offline' | 'pending_offline' | 'payment_link'

interface CreateStaffAppointmentInput {
  teamId?: string
  providerId?: string
  activityId?: string
  startMs?: number
  durationMinutes?: number
  contactId?: string
  newContact?: { firstname: string; lastname: string; email: string; phone?: string }
  blocked?: boolean
  paymentMode?: StaffBookingPaymentMode
  /** Minor units (Rappen/cents). Overrides the activity duration's base price. */
  amount?: number
  /** A party length: how many people, the booker included. Absent = the
   *  smallest party the length takes. See party.ts. */
  people?: number
  /** Companions' names, optional on a studio-made booking. */
  participants?: string[]
  currency?: string
  /** Studio-configured manual-payment mode label, e.g. "Cash" (paid_offline only). */
  method?: string
  note?: string
  locale?: string
  origin?: string
}

// ─── resolveStaffBookingPlan — pure, unit-testable ─────────────────────────────

export interface StaffBookingPlan {
  sessionStatus: 'full' | 'pending_payment'
  paymentPending: boolean
  paymentIntentMode?: 'offline' | 'link'
  bookingStatus: 'confirmed' | 'pending'
  bookingPaymentStatus?: 'required'
  /** paid_offline only — record the manual payment immediately after the tx. */
  recordPaymentNow: boolean
}

/** Decide how a (blocked?, amountMinor, paymentMode) triple resolves into the
 *  session/booking status shape — see the module doc comment for the four
 *  settlement rails. Pure so it's cheaply unit-testable without Firestore. */
export function resolveStaffBookingPlan(params: {
  blocked: boolean
  amountMinor: number
  paymentMode?: StaffBookingPaymentMode
}): StaffBookingPlan {
  const { blocked, amountMinor } = params
  if (blocked || amountMinor === 0) {
    return { sessionStatus: 'full', paymentPending: false, bookingStatus: 'confirmed', recordPaymentNow: false }
  }
  switch (params.paymentMode) {
    case 'paid_offline':
      return { sessionStatus: 'full', paymentPending: false, bookingStatus: 'confirmed', recordPaymentNow: true }
    case 'pending_offline':
      return {
        sessionStatus: 'pending_payment',
        paymentPending: true,
        paymentIntentMode: 'offline',
        bookingStatus: 'confirmed',
        recordPaymentNow: false,
      }
    case 'payment_link':
      return {
        sessionStatus: 'pending_payment',
        paymentPending: true,
        paymentIntentMode: 'link',
        bookingStatus: 'pending',
        bookingPaymentStatus: 'required',
        recordPaymentNow: false,
      }
    default:
      throw new HttpsError(
        'invalid-argument',
        "paymentMode must be 'paid_offline', 'pending_offline' or 'payment_link' for a priced booking",
      )
  }
}

// ─── providerName resolution ────────────────────────────────────────────────────

/** users/{providerId} (firstname+lastname, else displayName/email) → the
 *  team_members doc's own name field (legacy denormalization, if ever present)
 *  → the bare uid. Mirrors the client-side fallback in AppointmentAvailability.tsx
 *  (`member?.name || data.providerId`) since staff bookings have no availability
 *  template to read a denormalised providerName off. */
async function resolveProviderName(teamId: string, providerId: string): Promise<string> {
  const db = admin.firestore()
  const userSnap = await db.collection('users').doc(providerId).get()
  if (userSnap.exists) {
    const u = userSnap.data()!
    const full = `${(u.firstname as string | undefined) || ''} ${(u.lastname as string | undefined) || ''}`.trim()
    if (full) return full
    if (u.displayName) return u.displayName as string
    if (u.email) return u.email as string
  }
  const memberSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection(TEAM_MEMBERS_SUBCOLLECTION)
    .doc(providerId)
    .get()
  if (memberSnap.exists) {
    const m = memberSnap.data() as Record<string, unknown>
    const name = (m.name as string | undefined) || (m.displayName as string | undefined)
    if (name) return name
  }
  return providerId
}

// ─── minimal payment-link email (English-only for now) ─────────────────────────
// TODO: i18n — every other appointment email (templates.ts) is 4-language;
// this one is new and English-only until the staff-booking UI has a locale to
// hand it (see CreateStaffAppointmentInput.locale, unused here on purpose).

function buildPaymentLinkEmail(params: {
  firstname: string
  teamName: string
  activityName: string
  start: Date
  paymentUrl: string
}) {
  const dateStr = params.start.toLocaleString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Zurich',
  })
  const body = [
    `<p>Hi ${params.firstname},</p>`,
    `<p>${params.teamName} has booked you in for <strong>${params.activityName}</strong> on ${dateStr}. Please complete your payment to confirm the booking:</p>`,
    `<p style="margin:16px 0;text-align:center;">${ctaButton(params.paymentUrl, 'Pay now')}</p>`,
    `<p>This link expires in 24 hours.</p>`,
  ].join('\n')
  return buildEmailTemplate({ title: `Complete your payment — ${params.activityName}`, body })
}

// ─── createStaffAppointment ─────────────────────────────────────────────────────

export const createStaffAppointment = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid

  const data = request.data as CreateStaffAppointmentInput
  if (
    !data?.teamId ||
    !data?.providerId ||
    !data?.activityId ||
    typeof data.startMs !== 'number' ||
    typeof data.durationMinutes !== 'number'
  ) {
    throw new HttpsError(
      'invalid-argument',
      'teamId, providerId, activityId, startMs and durationMinutes are required',
    )
  }
  const { teamId, providerId, activityId, startMs, durationMinutes } = data
  const blocked = data.blocked === true

  await assertManager(uid, teamId)

  const db = admin.firestore()
  const start = new Date(startMs)
  const end = new Date(start.getTime() + durationMinutes * 60_000)
  const note = typeof data.note === 'string' ? data.note.trim().slice(0, MAX_NOTE_LEN) : ''

  // ── Load + validate the activity (the *what*) — same rule as the public
  // paths: only a type:'appointment' activity, and only one of its configured
  // durations. No availability lookup — a staff booking works OUTSIDE
  // availability by design (this IS the manual-override tool). ──
  const actSnap = await db.collection(ACTIVITIES_COLLECTION).doc(activityId).get()
  if (!actSnap.exists) throw new HttpsError('not-found', 'Activity not found')
  const activity = actSnap.data() as Activity
  if (activity.teamId !== teamId) throw new HttpsError('permission-denied', 'Team mismatch')
  if (activity.type !== 'appointment') {
    throw new HttpsError('failed-precondition', 'This activity does not support appointment booking')
  }
  const allowedDurations = resolveAppointmentDurations(activity)
  const chosenDuration = allowedDurations.find((d) => d.minutes === durationMinutes)
  if (!chosenDuration) throw new HttpsError('failed-precondition', 'Duration is not offered')
  // A staff booking is the studio's own judgement and is NOT refused on a
  // benefit_only length — but it carries no price either: `resolveDurationSale`
  // returns null for every mode but 'priced', so a stale amount can't be billed.
  const basePriceMajor = resolveDurationSale(chosenDuration).priceAmount
  const autoConfirm = resolveAutoConfirm({ autoConfirm: activity.autoConfirm, type: activity.type })

  // ── Team ──
  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')
  const teamName = team.name || 'Our Team'
  const teamSlug = team.slug || null
  const plan = (team.plan || 'free') as SaasPlan
  // The standard confirmation/.ics/coach-notify template is already 4-language
  // (see templates.ts) — use the team's own language, same as the public flow.
  // Only the NEW payment-link email below is intentionally English-only for now.
  const lang = asLang(team.language)

  const providerName = await resolveProviderName(teamId, providerId)

  // ── Resolve the client — blocked time has none. ──
  let contactId: string | null = null
  let isNewContact = false
  let client: { firstname: string; lastname: string; email: string; phone: string | null } | null = null

  if (!blocked) {
    if (data.contactId) {
      const cSnap = await db.collection(CONTACTS_COLLECTION).doc(data.contactId).get()
      if (!cSnap.exists || cSnap.data()?.teamId !== teamId) {
        throw new HttpsError('invalid-argument', 'Contact does not belong to this team')
      }
      if (cSnap.data()?.deleted_at != null) throw new HttpsError('invalid-argument', 'Contact is deleted')
      const c = cSnap.data()!
      contactId = cSnap.id
      client = {
        firstname: (c.firstname as string) || '',
        lastname: (c.lastname as string) || '',
        email: ((c.email as string) || '').toLowerCase().trim(),
        phone: (c.phone as string) || null,
      }
    } else if (data.newContact) {
      const nc = data.newContact
      if (!nc.firstname?.trim() || !nc.lastname?.trim() || !nc.email?.trim()) {
        throw new HttpsError('invalid-argument', 'firstname, lastname and email are required for a new contact')
      }
      if (!EMAIL_RE.test(nc.email.trim())) throw new HttpsError('invalid-argument', 'Invalid email format')
      const sanitized = {
        firstname: nc.firstname.trim(),
        lastname: nc.lastname.trim(),
        email: nc.email.toLowerCase().trim(),
        phone: nc.phone?.trim() || null,
      }
      // Avoid a duplicate — reuse an existing active match by email, same as
      // the public flow's resolveOrCreateAppointmentContact.
      const match = await resolveSingleContact(teamId, sanitized.email)
      if (match.contactId) {
        contactId = match.contactId
        const existing = await db.collection(CONTACTS_COLLECTION).doc(contactId).get()
        const c = existing.data() || {}
        client = {
          firstname: (c.firstname as string) || sanitized.firstname,
          lastname: (c.lastname as string) || sanitized.lastname,
          email: ((c.email as string) || sanitized.email).toLowerCase().trim(),
          phone: (c.phone as string) || sanitized.phone,
        }
      } else {
        if (!(await canCreateContact(teamId, plan))) {
          throw new HttpsError('resource-exhausted', 'Contact limit reached — please upgrade your plan.')
        }
        const ref = db.collection(CONTACTS_COLLECTION).doc()
        await ref.set({
          firstname: sanitized.firstname,
          lastname: sanitized.lastname,
          email: sanitized.email,
          phone: sanitized.phone,
          teamId,
          entry: 'manual',
          created_at: FieldValue.serverTimestamp(),
          archived_at: null,
          deleted_at: null,
        })
        contactId = ref.id
        isNewContact = true
        client = sanitized
      }
    } else {
      throw new HttpsError('invalid-argument', 'contactId or newContact is required unless blocked is true')
    }
  }

  // ── Amount / currency / settlement plan ──
  // A party length's price is per person, so its default is one per person. A
  // blocked slot books nobody.
  const party = blocked
    ? { people: 1, participants: [] }
    : readStaffAppointmentParty(chosenDuration, data)
  let amountMinor: number
  if (typeof data.amount === 'number') {
    if (!Number.isInteger(data.amount) || data.amount < 0) {
      throw new HttpsError('invalid-argument', 'amount must be a non-negative integer in minor units')
    }
    amountMinor = data.amount
  } else {
    amountMinor = basePriceMajor != null ? Math.round(basePriceMajor * 100) * party.people : 0
  }
  const currency = (data.currency ?? team.default_currency ?? 'CHF').toUpperCase().slice(0, 3)

  const plan_ = resolveStaffBookingPlan({ blocked, amountMinor, paymentMode: data.paymentMode })
  if (plan_.paymentIntentMode === 'link' && amountMinor < MIN_LINK_AMOUNT_MINOR) {
    throw new HttpsError('failed-precondition', `A payment link needs at least ${MIN_LINK_AMOUNT_MINOR} Rappen`)
  }

  // ── Build + run the overlap-safe slot transaction ──
  const bookingToken = blocked ? null : generateSecureToken()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(`apt_${providerId}_${start.getTime()}`)
  const clientName = client ? `${client.firstname} ${client.lastname}`.trim() : null

  const sessionDoc: Record<string, unknown> = {
    teamId,
    templateId: null,
    origin: 'staff',
    activityType: 'appointment',
    activityId,
    activityName: blocked ? note || activity.name : activity.name,
    autoConfirm,
    providerId,
    providerName,
    start: Timestamp.fromDate(start),
    end: Timestamp.fromDate(end),
    duration_minutes: durationMinutes,
    max_participants: 1,
    bookings_count: 1,
    location: null,
    onlineUrl: null,
    allowBooking: true,
    status: plan_.sessionStatus,
    has_bookings: true,
    last_booking_at: FieldValue.serverTimestamp(),
    created_at: FieldValue.serverTimestamp(),
    createdBy: uid,
    notes: blocked ? null : note || null,
    // Denormalised so list views (e.g. the Payments page) can render a
    // client name/amount without an N+1 read into the bookings subcollection.
    contact_id: blocked ? null : contactId,
    client_name: blocked ? note || null : clientName,
    ...(blocked ? { blocked_time: true } : {}),
    ...(plan_.paymentPending
      ? {
          payment_pending: true,
          payment_intent_mode: plan_.paymentIntentMode,
          payment_amount: amountMinor,
          payment_currency: currency,
        }
      : {}),
  }

  const bookingDoc: Record<string, unknown> = blocked
    ? {
        blocked_time: true,
        teamId,
        session: sessionRef.id,
        joinedAt: FieldValue.serverTimestamp(),
        status: 'confirmed',
      }
    : {
        firstname: client!.firstname,
        lastname: client!.lastname,
        email: client!.email,
        phone: client!.phone,
        contact: contactId,
        session: sessionRef.id,
        teamId,
        joinedAt: FieldValue.serverTimestamp(),
        fromBioLink: false,
        is_new_contact: isNewContact,
        booking_token: bookingToken,
        authenticated_booking: false,
        subscription_type_id: null,
        status: plan_.bookingStatus,
        fullname: clientName,
        created_by_staff: uid,
        ...partyBookingFields(party),
        ...(plan_.bookingPaymentStatus ? { payment_status: plan_.bookingPaymentStatus } : {}),
      }

  await runAppointmentSlotTransaction({
    sessionRef,
    sessionDoc,
    // No availability template exists for a staff booking, so there's no
    // provider-configured buffer to respect — the overlap check still runs
    // (start/end collision with any other live appointment), just with 0 pad.
    bookingDocId: blocked ? 'staff-blocked' : contactId!,
    bookingDoc,
    teamId,
    providerId,
    startMs: start.getTime(),
    endMs: end.getTime(),
    bufferMs: 0,
  })

  // ── Post-tx effects per settlement rail ──
  let paymentUrl: string | undefined
  let checkoutSessionId: string | undefined

  if (plan_.recordPaymentNow) {
    await writeManualPaymentEvent({
      teamId,
      contactId,
      amount: amountMinor,
      currency,
      paymentMode: data.method ?? null,
      lineItem: { kind: 'appointment', label: activity.name },
      comment: note || null,
      idempotencyKey: `apt-staff-paid:${sessionRef.id}`,
      recordedBy: uid,
    })
  }

  if (plan_.paymentIntentMode === 'link') {
    const enabledTeam = await loadEnabledTeam(teamId)
    const { accountId, model } = requireChargeableAccount(enabledTeam)
    const applicationFeeAmount = computePlatformFee({
      tier: enabledTeam.plan,
      amount: amountMinor,
      model,
      waived: enabledTeam.feeWaived,
      rate: enabledTeam.fee.rate,
    })
    const locale = data.locale ?? 'en'
    const base = `${resolveBaseUrl(data.origin)}/${locale}/pay/result`
    const slugQuery = teamSlug ? `&slug=${encodeURIComponent(teamSlug)}&seg=appointments` : ''
    const minuteBucket = Math.floor(Date.now() / 60_000)
    const metadata: Record<string, string> = {
      kind: 'appointment',
      purpose: 'appointment',
      teamId,
      sessionId: sessionRef.id,
      contactId: contactId as string,
      activityId,
      activityName: activity.name,
      providerId,
      startMs: String(startMs),
      durationMinutes: String(durationMinutes),
      // This hold's proof of ownership, for `handleCheckoutExpired` — which on
      // THIS rail is the only release path there is (the session deliberately
      // carries no hold_expires_at, so the daily sweep never sees it). Without it
      // the expiry handler falls back to the weaker EXCLUSIVITY proof, which is
      // sound but is an argument about the document rather than a fact about this
      // attempt. See appointments/holdRelease.ts.
      bookingToken: bookingToken as string,
      ...platformFeeMetadata(enabledTeam),
      // The webhook writes the booking's party from what was paid for, and
      // ERASES it on a solo payment; without this a pair booked here would lose
      // its party the moment the client paid the link.
      ...partyCheckoutMetadata(party),
    }
    try {
      const checkoutSession = await createOneOffCheckoutSession({
        accountId,
        amount: amountMinor,
        currency: currency.toLowerCase(),
        applicationFeeAmount,
        productName: `${activity.name} · ${durationMinutes} min`,
        // `&cs=…` mirrors `buildResultUrls` (connect/checkout.ts): the success
        // page claims the checkout and signs the payer in rather than asking
        // them for a credential after they have paid (UX-88). This rail builds
        // its own URLs because it is a payment LINK the studio sends, so the
        // param has to be repeated here — it is not a second mechanism.
        successUrl: `${base}?status=success${slugQuery}&cs={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}?status=cancelled${slugQuery}`,
        customerEmail: client?.email || undefined,
        metadata,
        idempotencyKey: `apt-staff-link:${teamId}:${sessionRef.id}:${contactId}:${minuteBucket}`,
        expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + PAYMENT_LINK_EXPIRY_SECONDS,
      })
      paymentUrl = checkoutSession.url
      checkoutSessionId = checkoutSession.sessionId
    } catch (err) {
      // Stripe create failed AFTER the hold was written — release it through the
      // SAME ownership-checked transaction `createAppointmentCheckout`'s
      // rollback and `handleCheckoutExpired` use (appointments/holdRelease.ts,
      // which owns the census and the proof each site rests on). This used to
      // cancel the session and delete the booking on PRESENCE while a comment
      // claimed it followed `createAppointmentCheckout`'s catch; that claim was
      // false, and the gap was reachable: this rail writes its hold at the same
      // deterministic `apt_{provider}_{start}` id, and the client's own public
      // retry (`createAppointmentCheckout`, `allowRewriteByHolder: contactId`)
      // can rewrite it between this transaction returning and this catch running
      // — at which point a blind cancel here kills a live, payable Stripe session
      // of theirs.
      console.error('[appointments] createStaffAppointment: payment-link create failed, releasing hold:', err)
      try {
        await releaseAppointmentHold({
          teamId,
          sessionId: sessionRef.id,
          contactId: contactId as string,
          bookingToken,
          label: 'createStaffAppointment',
        })
      } catch (releaseErr) {
        console.error('[appointments] createStaffAppointment: hold release failed:', releaseErr)
      }
      throw new HttpsError('internal', 'Failed to create the payment link')
    }
    // STORE THE SESSION ID, so the link can be CLOSED and not merely waited out.
    //
    // This rail's whole deadline lives at Stripe (just under a day, deliberately no
    // `hold_expires_at`, unreachable by the daily sweep), so a client who turns
    // up and pays CASH instead leaves a link that stays payable until it lapses.
    // `markAppointmentPaid` expires it through `closeTeamCheckoutSession` before
    // it records the money, and this is the only reference it has to expire with.
    //
    // OUTSIDE the try above on purpose: by here Stripe has created a live,
    // payable session, so a Firestore hiccup must not fall into a catch whose
    // job is to release the hold and report that the link could not be created.
    // A failure here costs the ability to close the link (the late-payment
    // refund in `handleAppointmentCheckout` is the remaining net) — it does not
    // cost the appointment.
    if (checkoutSessionId) {
      try {
        await sessionRef.set({ payment_checkout_session_id: checkoutSessionId }, { merge: true })
      } catch (err) {
        console.error(
          `[appointments] createStaffAppointment: could not store the checkout session id ` +
            `(session=${sessionRef.id}) — the payment link cannot be closed from the admin:`,
          err
        )
      }
    }
  }

  // ── Emails ──
  if (!blocked && client) {
    // Locale-pinned to the studio's language, like the mail it goes into.
    const cancelUrl =
      teamSlug && bookingToken
        ? localizedPublicUrl(getHostingUrl(), lang, teamSlug, 'appointments/cancel', {
            token: bookingToken,
          })
        : null
    await sendAppointmentBookingEmails({
      teamId,
      teamName,
      lang,
      activityName: activity.name,
      providerId,
      providerName,
      start,
      end,
      location: null,
      onlineUrl: null,
      cancelUrl,
      bookingId: `${sessionRef.id}-${contactId}`,
      // The one staff rail on which money has ALREADY changed hands: `paid_offline`
      // takes it over the counter and `writeManualPaymentEvent` records it above.
      // The booking document carries no marker for that settlement —
      // `bookingWasPaidFor` would answer false for every rail here, since the only
      // `payment_status` this callable ever writes is `'required'` — so the plan,
      // which IS this callable's tender decision, answers instead. The other two
      // priced rails are debts, not receipts: `pending_offline` is owed at the
      // door and `payment_link` is unpaid until the webhook confirms it (and the
      // link mail below is the message that actually matters for it).
      wasPaidFor: plan_.recordPaymentNow,
      client,
    })
    if (paymentUrl) {
      try {
        const email = buildPaymentLinkEmail({
          firstname: client.firstname,
          teamName,
          activityName: activity.name,
          start,
          paymentUrl,
        })
        await sendEmail({
          to: client.email,
          subject: `Complete your payment — ${activity.name}`,
          html: email.html,
          text: email.text,
          teamId,
        })
      } catch (err) {
        console.error('[appointments] createStaffAppointment: payment-link email failed:', err)
      }
    }
  }

  return { sessionId: sessionRef.id, contactId: contactId ?? null, ...(paymentUrl ? { paymentUrl } : {}) }
})

// ─── markAppointmentPaid ─────────────────────────────────────────────────────
//
// THE DESK SETTLEMENT OF AN APPOINTMENT THAT WAS AWAITING A PAYMENT — cash over
// the counter, a bank transfer, TWINT. It now covers BOTH awaiting-payment
// shapes, and the second one is why this comment exists.
//
//   • 'offline' — the studio always meant to be paid in person. Nothing external
//     exists; the settlement is a manual payment row and a status flip.
//   • 'link' — a Stripe Checkout link was emailed and the client paid CASH
//     instead. Until UX-59 this callable refused the mode by name and the
//     payments dashboard did not even offer the button, so the ONLY thing that
//     could ever close such a booking was the link's own expiry at Stripe, which
//     cancels the session and deletes the booking. The studio's appointment
//     quietly disappeared when it lapsed and the cash was never recorded anywhere.
//
// ── THE LINK RAIL'S ONE EXTRA OBLIGATION: KILL THE LINK ─────────────────────
//
// A link that is still payable after the money has been taken at the desk is a
// double charge waiting for a client to tidy their inbox. So the settlement
// EXPIRES the Checkout Session (`closeTeamCheckoutSession`, three-valued on
// purpose) and reports what happened:
//
//   closed → the link can never take money again. The ordinary case.
//   paid   → the client paid online in the seconds before this call. Record NO
//            cash: the webhook owns that money. The seat is already theirs.
//   failed → Stripe could not tell us. The manager took cash and that is a fact,
//            so it IS recorded — but the caller is told the link may still be
//            live so it can say so.
//
// ORDER IS LOAD-BEARING. The settle transaction runs BEFORE the close, not
// after. Expiring a session makes Stripe deliver `checkout.session.expired`,
// which is census site 3 of the appointment-hold release
// (appointments/holdRelease.ts) and would cancel this very hold — it holds the
// booking token from the checkout metadata, so its ownership proof SUCCEEDS.
// Settling first moves the session off `pending_payment`, at which point
// `releaseAppointmentHold` returns `not_a_live_hold` and the event is inert.
// Closing first would open a window in which the studio's own settlement
// deletes the appointment it was settling.
//
// And the belt to that brace: the booking is stamped `settled_offline`, which is
// what lets `handleAppointmentCheckout` REFUND a payment that arrives late on a
// link this call could not close (or on one whose id was never stored).

export const markAppointmentPaid = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')

  const data = request.data as { teamId?: string; sessionId?: string; method?: string; amount?: number }
  if (!data?.teamId || !data?.sessionId) {
    throw new HttpsError('invalid-argument', 'teamId and sessionId are required')
  }
  const { teamId, sessionId } = data

  await assertManager(request.auth.uid, teamId)

  const db = admin.firestore()
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const sSnap = await sessionRef.get()
  if (!sSnap.exists) throw new HttpsError('not-found', 'Session not found')
  const s = sSnap.data()!
  if (s.teamId !== teamId) throw new HttpsError('permission-denied', 'Team mismatch')
  if (s.activityType !== 'appointment') throw new HttpsError('failed-precondition', 'Not an appointment session')
  const intentMode = s.payment_intent_mode as 'offline' | 'link' | undefined
  if (
    s.status !== 'pending_payment' ||
    s.payment_pending !== true ||
    (intentMode !== 'offline' && intentMode !== 'link')
  ) {
    throw new HttpsError('failed-precondition', 'This appointment is not awaiting a payment')
  }

  const amountMinor =
    typeof data.amount === 'number' ? Math.round(data.amount) : ((s.payment_amount as number | undefined) ?? 0)
  if (!Number.isInteger(amountMinor) || amountMinor < 1) {
    throw new HttpsError('invalid-argument', 'amount must be a positive integer in minor units')
  }
  const currency = (s.payment_currency as string | undefined) ?? 'CHF'
  // Denormalised on the session by createStaffAppointment — no bookings-subcollection read needed.
  const contactId = (s.contact_id as string | null | undefined) ?? null
  const checkoutSessionId = (s.payment_checkout_session_id as string | null | undefined) ?? null

  // ── 1. SETTLE, in one transaction, before anything touches Stripe. ──
  // The session leaves `pending_payment` and the booking becomes an ordinary
  // confirmed one, so from here no release path in the census can act on it.
  // Re-reads inside the transaction: the manager may have been looking at a row
  // the Connect webhook settled a moment ago.
  const settled = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(sessionRef)
    if (!fresh.exists) return false
    const f = fresh.data()!
    if (f.status !== 'pending_payment' || f.payment_pending !== true) return false

    tx.set(
      sessionRef,
      {
        status: 'full',
        payment_pending: FieldValue.delete(),
        payment_intent_mode: FieldValue.delete(),
        payment_checkout_session_id: FieldValue.delete(),
      },
      { merge: true }
    )
    // On the 'link' rail the booking is still `pending` / `payment_status:
    // 'required'` — the webhook was going to confirm it. Nobody else will now.
    // On the 'offline' rail it is already confirmed and this only adds the
    // markers, which is the point: both rails end in the same shape.
    if (contactId) {
      tx.set(
        sessionRef.collection('bookings').doc(contactId),
        {
          status: 'confirmed',
          // The seat WAS paid for — `bookingWasPaidFor` must say so — and
          // `settled_offline` is the extra fact a bare 'paid' cannot carry.
          payment_status: 'paid',
          settled_offline: true,
          expires_at: FieldValue.delete(),
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    return true
  })
  if (!settled) {
    throw new HttpsError('failed-precondition', 'This appointment is no longer awaiting a payment', {
      reason: 'not_pending',
    })
  }

  // ── 2. Kill the link, if there is one. ──
  let linkOutcome: CheckoutSessionCloseOutcome | 'no_reference' | null = null
  if (intentMode === 'link') {
    if (!checkoutSessionId) {
      // A hold written before the id was stored (or one whose store failed).
      // Nothing to expire — the late-payment refund below is the only net.
      linkOutcome = 'no_reference'
      console.warn(
        `[appointments] markAppointmentPaid: no stored checkout session for a link hold ` +
          `(session=${sessionId}) — the link cannot be closed from here`
      )
    } else {
      // `loadEnabledTeam` THROWS for a studio that has since switched Connect
      // off, and a refusal here would put the manager straight back in the state
      // this whole callable exists to end: cash in the till and a booking
      // nothing can close. A studio that cannot reach Stripe is told the link
      // may still be live, exactly like any other failed close.
      // `closeTeamCheckoutSession` swallows its own account-resolution errors
      // the same way — this only covers the read that happens before it.
      try {
        const team = await loadEnabledTeam(teamId)
        linkOutcome = await closeTeamCheckoutSession(team, checkoutSessionId)
      } catch (err) {
        console.error(
          `[appointments] markAppointmentPaid: could not reach Stripe to close the link ` +
            `(session=${sessionId}):`,
          err
        )
        linkOutcome = 'failed'
      }
    }
  }

  // ── 3. Record the money — unless Stripe already took it. ──
  // `paid` is the one branch that records nothing: the client paid online in the
  // seconds before this call, `handlePaymentIntent` writes that row, and adding a
  // cash row on top would double the studio's revenue for one appointment. The
  // seat stays settled, because it is: they paid.
  if (linkOutcome === 'paid') {
    // …and TAKE THE MARKER BACK OFF. `settled_offline` means "this seat was paid
    // for somewhere Stripe cannot see", and it is exactly what makes
    // `handleAppointmentCheckout` refund an incoming charge. Leaving it standing
    // here would refund the payment the client legitimately just made. It is
    // stamped in step 1 rather than here because the case it guards — a link
    // this call could NOT close — needs it as early as possible; this is the one
    // outcome that retracts it.
    if (contactId) {
      await sessionRef
        .collection('bookings')
        .doc(contactId)
        .set({ settled_offline: FieldValue.delete() }, { merge: true })
    }
    console.log(
      `[appointments] markAppointmentPaid: link was already paid (session=${sessionId}) — no cash recorded`
    )
    return { ok: true, recorded: false, reason: 'already_paid_online' as const }
  }

  await writeManualPaymentEvent({
    teamId,
    contactId,
    amount: amountMinor,
    currency,
    paymentMode: data.method ?? null,
    lineItem: { kind: 'appointment', label: (s.activityName as string | undefined) ?? 'Appointment' },
    comment: null,
    idempotencyKey: `apt-staff-mark-paid:${sessionId}`,
    recordedBy: request.auth.uid,
  })

  // `linkStillOpen` is the honest half of a three-valued close: the studio is
  // told when the link it emailed may still be payable, so it can cancel it in
  // its own Stripe dashboard. A late payment is refunded automatically either
  // way (handleAppointmentCheckout) — this is so nobody is surprised by that.
  const linkStillOpen = linkOutcome === 'failed' || linkOutcome === 'no_reference'
  return { ok: true, recorded: true, linkStillOpen }
})
