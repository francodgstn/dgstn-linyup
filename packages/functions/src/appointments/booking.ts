/* eslint-disable no-console */
// Shared appointment-booking helpers — extracted from bookAppointment so the
// FREE path, the paid checkout callable (checkout.ts), and the Connect webhook's
// re-acquire path all agree on: how a booking context is resolved (the *what* +
// the *when*), how a caller proves their identity, how a contact is
// resolved/created, and how the overlap-safe slot transaction runs.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  AVAILABILITY_COLLECTION,
  AVAILABILITY_EXCEPTIONS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  appointmentSlotBlocked,
  isExpiredAppointmentHold,
  resolveAppointmentDurations,
  resolveAutoConfirm,
  type Activity,
  type ActivityDuration,
  type Availability,
  type SaasPlan,
  type Team,
} from '@linyup/shared'
import { getTeam } from '../utils/teams'
import { resolveSingleContact } from '../utils/contacts'
import { canCreateContact } from '../utils/contactCap'
import { expandContactFieldPatch } from '../booking/contactFields'
import { optionalContactSessionFromRequest } from '../utils/contactSession'
import {
  commitWaiverLedgerWrites,
  planWaiverLedgerWrites,
  type WaiverEventInput,
} from '../waivers/accept'
import { getDatePartsInTz, localTimeToUtc } from './index'

export type Lang = 'en' | 'de' | 'fr' | 'it'
const VALID_LANGS: Lang[] = ['en', 'de', 'fr', 'it']
export const asLang = (v: unknown): Lang => (VALID_LANGS.includes(v as Lang) ? (v as Lang) : 'en')

export const DAY_MS = 24 * 60 * 60_000
export const MAX_SESSION_MS = 8 * 60 * 60_000 // upper bound on any single appointment

export const parseHHMM = (s: unknown): [number, number] => {
  const [h, m] = String(s ?? '').split(':').map((x) => parseInt(x, 10))
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0]
}

// A provider's published free time — the *when*. `id` is the Firestore doc id.
export interface WindowTemplate extends Availability {
  id: string
}

// Does availability `tpl` (offering some activity, already pre-filtered by the
// caller) cover this exact start for a booking of length `durMs`?
export function availabilityCoversStart(tpl: WindowTemplate, startMsVal: number, durMs: number): boolean {
  const { year, month, day, dayOfWeek } = getDatePartsInTz(new Date(startMsVal))
  if (!(tpl.recurrence?.daysOfWeek ?? []).includes(dayOfWeek)) return false
  const sd = tpl.recurrence?.startDate ? tpl.recurrence.startDate.toMillis() : 0
  const ed = tpl.recurrence?.endDate ? tpl.recurrence.endDate.toMillis() : Infinity
  if (startMsVal < sd || startMsVal > ed + DAY_MS) return false

  if (tpl.mode === 'times') {
    return (tpl.times ?? []).some((hhmm) => {
      const [h, m] = parseHHMM(hhmm)
      return localTimeToUtc(year, month, day, h, m).getTime() === startMsVal
    })
  }

  // 'range' mode
  if (!tpl.window) return false
  const [wsH, wsM] = parseHHMM(tpl.window.start)
  const [weH, weM] = parseHHMM(tpl.window.end)
  const winStart = localTimeToUtc(year, month, day, wsH, wsM).getTime()
  const winEnd = localTimeToUtc(year, month, day, weH, weM).getTime()
  const gran = (tpl.granularityMinutes || 15) * 60_000
  if (startMsVal < winStart || startMsVal + durMs > winEnd) return false
  if ((startMsVal - winStart) % gran !== 0) return false
  return true
}

// ─── loadAppointmentBookingContext ─────────────────────────────────────────────

export interface AppointmentBookingContext {
  activity: Activity
  chosenDuration: ActivityDuration
  autoConfirm: boolean
  tpl: WindowTemplate
  providerName: string
  start: Date
  end: Date
  bufferMs: number
  team: Team
  teamName: string
  teamSlug: string | null
  plan: SaasPlan
  lang: Lang
}

/** Resolve the *what* (activity + duration) and the *when* (the availability
 *  covering this exact start) for a would-be appointment booking. No access
 *  rule is resolved here any more — appointments dropped the access gate;
 *  money (the activity's durations + memberBenefit) is the only gate. Shared
 *  by the free path, the paid checkout, and (indirectly) the webhook's
 *  re-acquire, which rebuilds from an already-materialized session instead. */
export async function loadAppointmentBookingContext(params: {
  teamId: string
  providerId: string
  activityId: string
  startMs: number
  durationMinutes: number
}): Promise<AppointmentBookingContext> {
  const { teamId, providerId, activityId, startMs, durationMinutes } = params
  const db = admin.firestore()

  const start = new Date(startMs)
  if (start.getTime() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Cannot book a time in the past')
  }
  const durationMs = durationMinutes * 60_000
  const end = new Date(start.getTime() + durationMs)

  // ── Load + validate the activity (the *what*) ──
  const actDoc = await db.collection(ACTIVITIES_COLLECTION).doc(activityId).get()
  if (!actDoc.exists) throw new HttpsError('not-found', 'Activity not found')
  const activity = actDoc.data() as Activity
  if (activity.teamId !== teamId) throw new HttpsError('permission-denied', 'Team mismatch')
  if (activity.type !== 'appointment')
    throw new HttpsError('failed-precondition', 'This activity does not support appointment booking')
  const allowedDurations = resolveAppointmentDurations(activity)
  const chosenDuration = allowedDurations.find((d) => d.minutes === durationMinutes)
  if (!chosenDuration) throw new HttpsError('failed-precondition', 'Duration is not offered')

  const autoConfirm = resolveAutoConfirm({ autoConfirm: activity.autoConfirm, type: activity.type })

  // ── Resolve the availability (the *when*) that covers this start ──
  const tplSnap = await db
    .collection(AVAILABILITY_COLLECTION)
    .where('teamId', '==', teamId)
    .where('providerId', '==', providerId)
    .where('status', '==', 'active')
    .get()
  const templates: WindowTemplate[] = tplSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Availability) }))
  const tpl = templates.find(
    (t) => (t.activityIds ?? []).includes(activityId) && availabilityCoversStart(t, start.getTime(), durationMs)
  )
  if (!tpl) {
    throw new HttpsError('failed-precondition', 'This time is no longer available. Please pick another.')
  }

  // Provider time-off (availability_exceptions) OVERRIDES the templates — refuse a
  // start inside one (defense-in-depth; listAvailability already hides these).
  const exSnap = await db
    .collection(AVAILABILITY_EXCEPTIONS_COLLECTION)
    .where('teamId', '==', teamId)
    .where('providerId', '==', providerId)
    .get()
  const startMsVal = start.getTime()
  const endMsVal = end.getTime()
  if (
    exSnap.docs.some((d) => {
      const e = d.data()
      return startMsVal < (e.end as Timestamp).toMillis() && endMsVal > (e.start as Timestamp).toMillis()
    })
  ) {
    throw new HttpsError('failed-precondition', 'This time is no longer available. Please pick another.')
  }

  const providerName = tpl.providerName

  // ── Team ──
  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')
  const teamName = team.name || 'Our Team'
  const teamSlug = team.slug || null
  const plan = (team.plan || 'free') as SaasPlan
  const lang = asLang(team.language)

  const bufferMs = (tpl.bufferMinutes || 0) * 60_000

  return {
    activity,
    chosenDuration,
    autoConfirm,
    tpl,
    providerName,
    start,
    end,
    bufferMs,
    team,
    teamName,
    teamSlug,
    plan,
    lang,
  }
}

// ─── resolveAppointmentCaller ───────────────────────────────────────────────────

export interface AppointmentCallerResult {
  /** Non-null for a verified caller (contact session OR OTP-verified match);
   *  null for a guest — reachable on ANY appointment activity now, in both the
   *  free path and the checkout path, since there is no access gate to refuse
   *  a guest with. A guest always resolves to the base price (no held benefit
   *  types). */
  authenticatedContact: (admin.firestore.DocumentData & { id: string }) | null
  sanitized: { firstname: string; lastname: string; email: string; phone: string | null }
  /**
   * The address the six-digit code was actually MAILED TO, on the OTP path only
   * — null on the contact-session and guest paths, where there is no second
   * address. It is not, in general, the contact's own: a parent verifies with
   * theirs and selects their child from the matched list. The waiver ledger
   * records it as `signer_email`, so that a record claiming `verified_code`
   * names the mailbox that was actually proved. See WaiverGateParams.signerEmail.
   */
  verifiedEmail: string | null
}

/** The 3 trust paths a caller can identify themselves with, checked in trust
 *  order — see the identical gate in bookSession:
 *   1. Contact session (signed-in mobile/web contact).
 *   2. authenticatedContactId + verificationCodeId — the OTP flow. The code is
 *      MANDATORY and is marked `used` here (single-use).
 *   3. Guest contactDetails — no verification. */
export async function resolveAppointmentCaller(
  request: CallableRequest<unknown>,
  data: {
    teamId: string
    contactDetails?: { firstname: string; lastname: string; email: string; phone?: string }
    authenticatedContactId?: string
    verificationCodeId?: string
  }
): Promise<AppointmentCallerResult> {
  const db = admin.firestore()
  const contactSession = optionalContactSessionFromRequest(request)
  const sessionAuthenticated = !!contactSession && contactSession.teamId === data.teamId
  const authenticated = sessionAuthenticated || !!data.authenticatedContactId

  if (sessionAuthenticated) {
    const cDoc = await db.collection('contacts').doc(contactSession!.contactId).get()
    if (!cDoc.exists) throw new HttpsError('not-found', 'Contact not found')
    const c = cDoc.data()!
    if (c.teamId !== data.teamId) throw new HttpsError('permission-denied', 'Contact team mismatch')
    return {
      authenticatedContact: { id: contactSession!.contactId, ...c },
      sanitized: {
        firstname: c.firstname || '',
        lastname: c.lastname || '',
        email: (c.email || '').toLowerCase().trim(),
        phone: c.phone || null,
      },
      // A session identifies the CONTACT, never the person at the keyboard, so
      // it proves no mailbox and contributes no second address.
      verifiedEmail: null,
    }
  }

  if (authenticated) {
    // The code is MANDATORY — see the identical gate in bookSession. Without it a
    // contactId from the request body would be trusted on nothing but its own say-so
    // (audit finding #2, docs/security-audit-2026-07.md). Signed-in callers take the
    // session branch above and never supply authenticatedContactId at all.
    if (!data.verificationCodeId) {
      throw new HttpsError(
        'invalid-argument',
        'verificationCodeId is required when authenticatedContactId is supplied'
      )
    }
    const codeDoc = await db.collection('booking_verification_codes').doc(data.verificationCodeId).get()
    if (!codeDoc.exists) throw new HttpsError('invalid-argument', 'Invalid verification code')
    const cd = codeDoc.data()!
    if (!cd.verified) throw new HttpsError('failed-precondition', 'Verification code not verified')
    if (cd.team_id !== data.teamId) throw new HttpsError('permission-denied', 'Code team mismatch')
    if (!(cd.matched_contact_ids || []).includes(data.authenticatedContactId))
      throw new HttpsError('permission-denied', 'Contact not in verified matches')
    await codeDoc.ref.update({
      used: true,
      used_at: FieldValue.serverTimestamp(),
      used_contact_id: data.authenticatedContactId,
    })

    const cDoc = await db.collection('contacts').doc(data.authenticatedContactId as string).get()
    if (!cDoc.exists) throw new HttpsError('not-found', 'Contact not found')
    const c = cDoc.data()!
    if (c.teamId !== data.teamId) throw new HttpsError('permission-denied', 'Contact team mismatch')
    return {
      authenticatedContact: { id: data.authenticatedContactId as string, ...c },
      sanitized: {
        firstname: c.firstname || '',
        lastname: c.lastname || '',
        email: (c.email || '').toLowerCase().trim(),
        phone: c.phone || null,
      },
      verifiedEmail: ((cd.email as string | undefined) ?? '').toLowerCase().trim() || null,
    }
  }

  const cd = data.contactDetails
  if (!cd?.firstname || !cd?.lastname || !cd?.email)
    throw new HttpsError('invalid-argument', 'firstname, lastname and email are required')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cd.email))
    throw new HttpsError('invalid-argument', 'Invalid email format')
  return {
    authenticatedContact: null,
    sanitized: {
      firstname: cd.firstname.trim(),
      lastname: cd.lastname.trim(),
      email: cd.email.toLowerCase().trim(),
      phone: cd.phone?.trim() || null,
    },
    // A typed address proves nothing, which `signerEmailVerifiedBy: 'none'`
    // already says. There is no second address here either.
    verifiedEmail: null,
  }
}

// ─── resolveOrCreateAppointmentContact ─────────────────────────────────────────

/** Resolve the caller's contact, or create a new trial one. Reached
 *  unauthenticated in BOTH the free path and the checkout path — appointments
 *  have no access gate any more (money is the only gate), so a guest is always
 *  allowed to book/pay; they just always resolve to the base price. */
export async function resolveOrCreateAppointmentContact(params: {
  teamId: string
  plan: SaasPlan
  sanitized: { firstname: string; lastname: string; email: string; phone: string | null }
  authenticatedContact: (admin.firestore.DocumentData & { id: string }) | null
  /**
   * Already narrowed by `buildContactFieldPatch` — the book form's answers to
   * the contact fields the studio asks for. `{}` for every caller that sent
   * none, which is the whole pre-existing world.
   *
   * Applied HERE rather than at each callable because both appointment rails
   * (free and checkout) come through this one function, and an answer that
   * lands on one rail and not the other is the kind of gap nobody notices
   * until a studio asks why the paid bookings have no phone numbers.
   */
  contactFieldPatch?: Record<string, unknown>
}): Promise<{ contactId: string; isNewContact: boolean }> {
  const { teamId, plan, sanitized, authenticatedContact } = params
  const patch = params.contactFieldPatch ?? {}
  const hasPatch = Object.keys(patch).length > 0
  const db = admin.firestore()

  if (authenticatedContact) {
    if (hasPatch) await db.collection('contacts').doc(authenticatedContact.id).update(patch)
    return { contactId: authenticatedContact.id, isNewContact: false }
  }

  const match = await resolveSingleContact(teamId, sanitized.email)
  if (match.contactId) {
    if (hasPatch) await db.collection('contacts').doc(match.contactId).update(patch)
    return { contactId: match.contactId, isNewContact: false }
  }

  if (!(await canCreateContact(teamId, plan)))
    throw new HttpsError('resource-exhausted', 'Contact limit reached — please contact the studio.')
  const ref = db.collection('contacts').doc()
  await ref.set({
    firstname: sanitized.firstname,
    lastname: sanitized.lastname,
    email: sanitized.email,
    phone: sanitized.phone,
    // Nested, never dotted — a `set()` reads `custom_fields.x` as a literal
    // field name. See expandContactFieldPatch.
    ...expandContactFieldPatch(patch),
    acquisition_stage: 'trial_booked',
    acquisition_stage_updated_at: FieldValue.serverTimestamp(),
    entry: 'booking',
    provisional: true,
    teamId,
    archived_at: null,
    deleted_at: null,
    created_at: FieldValue.serverTimestamp(),
    pending_bookings_count: 1,
  })
  return { contactId: ref.id, isNewContact: true }
}

// ─── runAppointmentSlotTransaction ──────────────────────────────────────────────

export interface AppointmentSlotTxParams {
  sessionRef: FirebaseFirestore.DocumentReference
  /** Full session doc — this is a REPLACE (tx.set, no merge), matching the
   *  materialize-lazily model: a reused doc id is fully rewritten, not patched. */
  sessionDoc: Record<string, unknown>
  /** Booking subdoc id under sessionRef.collection('bookings') — the contactId. */
  bookingDocId: string
  bookingDoc: Record<string, unknown>
  teamId: string
  providerId: string
  startMs: number
  endMs: number
  bufferMs: number
  /** Spend one FIFO lesson-credit atomically with the booking write. */
  creditSpend?: { contactId: string; subscriptionTypeId: string }
  /** A contactId allowed to rewrite ITS OWN still-live 'pending_payment' hold at
   *  this doc id (checkout retry — a fresh Stripe session for the same slot). */
  allowRewriteByHolder?: string
  /**
   * Waiver acceptances to commit WITH the seat. Supplied only by the FREE path
   * (`bookAppointment`), where the signature and the seat must be atomic.
   *
   * Deliberately absent on the other three callers of this transaction, and
   * each absence is a decision rather than an omission: `createAppointmentCheckout`
   * writes its acceptance BEFORE Stripe in its own transaction (the tick is a
   * fact whether or not the card clears); the Connect webhook only CONFIRMS a
   * hold whose acceptance is already on the ledger; and `createStaffAppointment`
   * is the manual-override tool, which surfaces an unsigned waiver on the roster
   * rather than blocking a coach booking a client by phone.
   */
  waiverLedger?: { accepts: WaiverEventInput[]; nowMs: number }
}

/** The overlap-safe create/reuse transaction for an appointment session —
 *  shared by the free path, checkout's hold, and the webhook's re-acquire.
 *  ALL READS BEFORE WRITES. */
export async function runAppointmentSlotTransaction(params: AppointmentSlotTxParams): Promise<void> {
  const db = admin.firestore()
  const {
    sessionRef,
    sessionDoc,
    bookingDocId,
    bookingDoc,
    teamId,
    providerId,
    startMs,
    endMs,
    bufferMs,
    creditSpend,
    allowRewriteByHolder,
    waiverLedger,
  } = params

  await db.runTransaction(async (tx) => {
    // ── READS ──
    const nowMs = Date.now()
    // The acceptance's read phase, in the same read set as the slot. Each plan
    // `tx.get`s its own acceptance ref and skips the create when it exists — a
    // bare `tx.create` collision would fail the WHOLE commit as a precondition
    // violation and take the slot with it, which is what a client retrying after
    // a network timeout produces.
    const waiverPlans = waiverLedger
      ? await planWaiverLedgerWrites(tx, waiverLedger.accepts, waiverLedger.nowMs)
      : []
    const existing = await tx.get(sessionRef)
    let staleBookingRefs: FirebaseFirestore.DocumentReference[] = []

    if (existing.exists) {
      const ex = existing.data()!
      const cancelled = ex.status === 'cancelled'
      const expiredHold = isExpiredAppointmentHold(
        ex as { status?: string; hold_expires_at?: Timestamp | null },
        nowMs
      )
      const existingBookingsSnap = await tx.get(sessionRef.collection('bookings'))
      const ownsLiveHold =
        !!allowRewriteByHolder &&
        ex.status === 'pending_payment' &&
        !expiredHold &&
        existingBookingsSnap.docs.some((d) => d.id === allowRewriteByHolder)

      const reusable = cancelled || expiredHold || ownsLiveHold
      if (!reusable) {
        throw new HttpsError('failed-precondition', 'This time was just taken. Please pick another.')
      }
      // Reclaiming an expired/foreign hold (not just refreshing our own live
      // one): the OLD holder's pending booking must not survive — it HOLDS
      // CAPACITY per trackBookings' NON_HOLDING set, so leaving it in place
      // would make the next recount count 2 bookings for a 1-seat slot.
      //
      // SITE 5 OF THE APPOINTMENT-HOLD RELEASE CENSUS (appointments/holdRelease.ts).
      // It deletes another attempt's booking without a `booking_token` check, and
      // the guard that makes that sound is the `cancelled || expiredHold`
      // condition right here: a canceled session and a lapsed hold are owned by
      // nobody. The `ownsLiveHold` branch — the retry path — deliberately does NOT
      // reclaim, because that booking IS ours and is rewritten instead.
      if (cancelled || expiredHold) {
        staleBookingRefs = existingBookingsSnap.docs
          .filter((d) => d.data().payment_status === 'required')
          .map((d) => d.ref)
      }
    }

    const overlapQ = db
      .collection('sessions')
      .where('teamId', '==', teamId)
      .where('providerId', '==', providerId)
      .where('start', '>=', Timestamp.fromMillis(startMs - MAX_SESSION_MS))
      .where('start', '<=', Timestamp.fromMillis(endMs + bufferMs))
    const overlapSnap = await tx.get(overlapQ)
    for (const d of overlapSnap.docs) {
      if (d.id === sessionRef.id) continue
      const s = d.data()
      if (!appointmentSlotBlocked(s as { status?: string; hold_expires_at?: Timestamp | null }, nowMs)) continue
      const bStart = (s.start as Timestamp).toMillis()
      const bEnd = (s.end as Timestamp).toMillis()
      if (startMs < bEnd + bufferMs && endMs > bStart - bufferMs) {
        throw new HttpsError('failed-precondition', 'This time overlaps another appointment.')
      }
    }

    // Credit-pack coverage: spend one credit atomically with the booking write,
    // inside the SAME transaction as the overlap check (all reads before writes).
    // FIFO across the contact's usable grants (soonest expiry first, then oldest).
    let grant: { ref: FirebaseFirestore.DocumentReference; credits_used: number } | null = null
    if (creditSpend) {
      const grantsQuery = db
        .collection('contacts')
        .doc(creditSpend.contactId)
        .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
        .where('teamId', '==', teamId)
        .where('subscription_type_id', '==', creditSpend.subscriptionTypeId)
      const grantsSnap = await tx.get(grantsQuery)
      const usable = grantsSnap.docs
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
          (g) => g.credits_used < g.credits_total && (!g.expires_at || g.expires_at.toMillis() > nowMs)
        )
        .sort((a, b) => {
          const ax = a.expires_at?.toMillis() ?? Number.MAX_SAFE_INTEGER
          const bx = b.expires_at?.toMillis() ?? Number.MAX_SAFE_INTEGER
          if (ax !== bx) return ax - bx
          return (a.created_at?.toMillis() ?? 0) - (b.created_at?.toMillis() ?? 0)
        })
      const picked = usable[0]
      if (!picked) {
        throw new HttpsError(
          'permission-denied',
          'No lesson credits remaining on your pack. Purchase a new pack to book this class.'
        )
      }
      grant = { ref: picked.ref, credits_used: picked.credits_used }
    }

    // ── WRITES ──
    commitWaiverLedgerWrites(tx, waiverPlans)
    for (const ref of staleBookingRefs) tx.delete(ref)
    if (grant) tx.update(grant.ref, { credits_used: grant.credits_used + 1 })
    tx.set(sessionRef, sessionDoc)
    tx.set(sessionRef.collection('bookings').doc(bookingDocId), {
      ...bookingDoc,
      ...(grant && { credit_grant_id: grant.ref.id, credit_spent: 1 }),
    })
  })
}
