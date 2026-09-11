/* eslint-disable no-console */
// claimWaitlistSeat — take the seat that was held for you.
//
// The seat already exists when this runs: the promoter wrote a `pending`
// booking carrying `waitlist_claim` + `claim_expires_at`, which every capacity
// gate in the codebase already counts (bookingHoldsSeat), so no direct booker
// can take it while the window is open. This callable does not acquire a seat —
// it SETTLES one, which is why there is no capacity check anywhere below.
//
// ONE transaction, and the entry's own status is the guard inside it. That is
// the whole answer to the double-click: two concurrent calls with the same token
// both read `status: 'offered'`, but only one commits — the loser retries, sees
// 'claimed', and is refused BEFORE it can spend a second credit or a second
// usage unit for one seat.
//
// Money is not settled here. A claim that has to be paid for returns
// `requiresPayment` and writes NOTHING; the client takes the same
// createDropInCheckout every drop-in buyer takes, with the offer token attached.
// Adding a second pricing path would put a price modifier in a checkout callable
// and a tender in a resolver, which is exactly the split the pricing core exists
// to prevent.

import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  CONTACTS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  PARTNER_VISITS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  WAITLIST_SUBCOLLECTION,
  clearedClaimHoldFields,
  isPastBookingCutoff,
  isUnclaimedClaimHold,
  localizedPublicUrl,
  resolveActivityAccessRule,
  resolveAutoConfirm,
  resolvePaymentOptions,
  type ActivityAccessRule,
  type ActivityType,
  type AnyBenefit,
  type DropInTarget,
  type SeatHold,
  resolveActivityDropIn,
  studioDropInOf,
  type ActivityDropIn,
} from '@linyup/shared'
import { denialMessage, loadContactPaymentContext } from '../access'
import { loadBookingSettings } from '../bookingSettings'
import { buildClassBookingConfirmationMail } from '../templates'
import { enforceWaiverGate, parseWaiverSubmissions } from '../../waivers/gate'
import { commitWaiverLedgerWrites, planWaiverLedgerWrites } from '../../waivers/accept'
import { assertUnderCheckoutRateLimit, checkoutRateLimit } from '../../connect/checkout'
import { optionalContactSessionFromRequest } from '../../utils/contactSession'
import { sendEmail } from '../../utils/email'
import { getTeamContactEmail } from '../../mail/senderConfig'
import { getHostingUrl } from '../../utils/env'
import { systemEmailEnabledFor } from '../../utils/systemEmails'
import { getTeam } from '../../utils/teams'
import { WAITLIST_CLAIM_RATE_LIMIT_BUCKET, isSessionCancelled } from './constants'

type Lang = 'en' | 'de' | 'fr' | 'it'
const isLang = (v: unknown): v is Lang => v === 'en' || v === 'de' || v === 'fr' || v === 'it'

export const claimWaitlistSeat = onCall(async (request) => {
  const data = request.data as {
    offerToken?: string
    /** Optional cross-checks. The TOKEN is the credential — it is single-use and
     *  unguessable, and the entry itself names the team, the session and the
     *  person, so a claim page holding nothing but a link still works. */
    teamId?: string
    sessionId?: string
    /** Ticks from the waiver step the claim page renders inside the claim
     *  window — see waivers/gate.ts. */
    waiverAcceptances?: unknown
  }
  const offerToken = typeof data?.offerToken === 'string' ? data.offerToken.trim() : ''
  if (!offerToken) throw new HttpsError('invalid-argument', 'offerToken is required')

  // PEEK, do not charge — and on the claim's own bucket, never the join one.
  // An offer is a one-shot entitlement with exactly one rightful holder, and the
  // people queueing for that class share their gym's NAT with them, so a charged
  // per-IP quota is a way for strangers to make somebody's seat un-claimable.
  // The peek still bounds an enumerator, because it runs before the query below.
  await assertUnderCheckoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)

  const db = admin.firestore()
  const tokenSnap = await db
    .collectionGroup(WAITLIST_SUBCOLLECTION)
    .where('offer_token', '==', offerToken)
    .limit(1)
    .get()
  // The token is DELETED the moment an offer resolves in any direction, so a
  // miss is indistinguishable between "lapsed" and "already claimed" — and it
  // has to be, or the token would survive its own offer. The status view behind
  // the long-lived entry_token is where someone finds out which it was.
  if (tokenSnap.empty) {
    // THE only attempt that costs quota: a token that resolves belongs to the
    // one person the seat is held for, and a miss is by definition not them.
    await checkoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)
    throw new HttpsError('failed-precondition', 'This offer is no longer available.', {
      reason: 'claim_expired',
    })
  }
  const entryRef = tokenSnap.docs[0].ref
  const entry = tokenSnap.docs[0].data()
  const contactId = tokenSnap.docs[0].id
  const teamId = entry.teamId as string
  const sessionId = entry.session as string
  if ((data.teamId && data.teamId !== teamId) || (data.sessionId && data.sessionId !== sessionId)) {
    throw new HttpsError('permission-denied', 'This offer belongs to another session')
  }

  // A signed-in caller must be the person the seat is held for. Without this a
  // contact who was forwarded someone else's claim link could book themselves
  // into a seat the queue reserved for another person.
  const contactSession = optionalContactSessionFromRequest(request)
  if (contactSession && contactSession.teamId === teamId && contactSession.contactId !== contactId) {
    throw new HttpsError('permission-denied', 'This offer belongs to another contact')
  }

  // ── The seat has to still be claimable ─────────────────────────────────────
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found')
  const session = sessionSnap.data()!
  // Both cancellation shapes — see isSessionCancelled. A cancelled occurrence of
  // a series is the case the teardown races: the queue is closed out on cancel,
  // but a claim already in flight must be refused rather than confirmed into a
  // class that is off.
  if (isSessionCancelled(session) || session.allowBooking !== true) {
    throw new HttpsError('failed-precondition', 'This class is no longer bookable.', {
      reason: 'booking_closed',
    })
  }
  const start = session.start as Timestamp
  const team = await getTeam(teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')
  // The cutoff comes from THE booking-settings store (public_profile), never the
  // team doc — see bookingSettings.ts. The team doc is still read above for the
  // studio's name/slug/language and its confirmation-email defaults.
  const bookingSettings = await loadBookingSettings(teamId)
  // Checked HERE rather than left to bookSession/createDropInCheckout, which
  // would refuse anyway: the claim page's whole job is to explain what happened,
  // and "booking closed" and "your offer expired" are different stories.
  if (start.toMillis() <= Date.now() || isPastBookingCutoff(start, bookingSettings.cutoffMinutes)) {
    throw new HttpsError('failed-precondition', 'Online booking has closed for this class.', {
      reason: 'booking_closed',
    })
  }

  const offerExpiresAt = entry.offer_expires_at as Timestamp | undefined
  if (entry.status !== 'offered' || !offerExpiresAt) {
    throw new HttpsError('failed-precondition', 'This offer has already been used.', {
      reason: 'already_claimed',
    })
  }
  if (offerExpiresAt.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'This offer has expired.', {
      reason: 'claim_expired',
    })
  }

  const activityId = session.activityId as string | undefined
  if (!activityId) throw new HttpsError('failed-precondition', 'Session has no activity')
  const activitySnap = await db.collection(ACTIVITIES_COLLECTION).doc(activityId).get()
  if (!activitySnap.exists) throw new HttpsError('not-found', 'Activity not found')
  const activity = activitySnap.data()!
  const activityName = (activity.name as string) || (session.activityName as string) || 'Class'

  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const contactSnap = await contactRef.get()
  if (!contactSnap.exists || contactSnap.data()?.teamId !== teamId) {
    throw new HttpsError('not-found', 'Contact not found')
  }
  const contact = { ...contactSnap.data()!, id: contactId }

  // ── What does this seat cost THIS person? ──────────────────────────────────
  // The same target createDropInCheckout builds for the same class, resolved by
  // the same resolver — the claim adds no arm, no rule and no price of its own.
  // Access is enforced HERE and not at join, because a prospective member's
  // subscription may start between joining the queue and being offered a seat.
  const accessRule = resolveActivityAccessRule({
    accessRule: activity.accessRule as ActivityAccessRule | undefined,
    isFreeTrial: activity.isFreeTrial as boolean | undefined,
  })
  // THE ONE READER of the drop-in price (shared/utils/dropIn.ts) — the studio
  // default, read from the same settings the cutoff above came from.
  const dropIn = resolveActivityDropIn(
    {
      type: activity.type as ActivityType | undefined,
      accessRule: activity.accessRule as ActivityAccessRule | undefined,
      isFreeTrial: activity.isFreeTrial as boolean | undefined,
      dropIn: activity.dropIn as ActivityDropIn | undefined,
    },
    studioDropInOf(bookingSettings)
  )
  const benefit = (activity.memberBenefit as AnyBenefit | undefined) ?? null
  const target: DropInTarget = {
    kind: 'drop_in',
    accessRule,
    dropIn,
    // A waitlist claim is never a trial: a trial is a newcomer's first class,
    // and the trial door is a guest path with its own once-per-person gate.
    trial: null,
    asTrial: false,
    benefit,
  }
  const { snapshot, limitedWindows } = await loadContactPaymentContext({
    teamId,
    contact,
    relevantTypeIds: [
      ...(accessRule.subscriptionTypeIds ?? []),
      ...(benefit?.subscriptionTypeIds ?? []),
    ],
    // Meter usage limits against the week the CLASS happens, exactly as the free
    // booking path does — an advance claim must debit the session's own window.
    usageAt: start.toDate(),
  })
  const resolved = resolvePaymentOptions(snapshot, target)
  const option = resolved.options[0]

  if (!option) {
    // No free coverage and no pay path — a members-only class this person cannot
    // book. Refusing at the claim (rather than at join) is deliberate; the
    // public form shows the access badge as a warning, not a gate.
    const denial = resolved.denial ?? 'no_subscription'
    throw new HttpsError('permission-denied', denialMessage(denial, false), { reason: denial })
  }

  if (option.type === 'pay') {
    // NEVER auto-charge. The claim page shows the price (and the member rate it
    // resolved to), takes a gift card or a promo, and calls createDropInCheckout
    // with this same offer token. Nothing is written here — an abandoned pay
    // screen must leave the offer exactly as it was.
    return {
      requiresPayment: true,
      amount: option.amount,
      appliedBenefit: option.appliedBenefit ?? null,
      claimExpiresAt: offerExpiresAt.toDate().toISOString(),
      sessionId,
      contactId,
    }
  }

  // ── The free claim — ONE transaction ───────────────────────────────────────
  const bookingRef = sessionRef.collection('bookings').doc(contactId)
  const creditSpendTypeId = option.type === 'spend_credits' ? option.via.subscriptionTypeId : null
  const matchedSubscriptionTypeId =
    option.type === 'covered' && option.via.reason === 'subscription'
      ? option.via.subscriptionTypeId
      : option.type === 'spend_credits'
        ? option.via.subscriptionTypeId
        : null
  // A usage-limited subscription's coverage costs one unit of the window the
  // class falls in — the counter moves with the booking or not at all.
  const usageSpend =
    option.type === 'covered' && matchedSubscriptionTypeId
      ? (limitedWindows[matchedSubscriptionTypeId] ?? null)
      : null

  const autoConfirm =
    typeof session.autoConfirm === 'boolean'
      ? (session.autoConfirm as boolean)
      : resolveAutoConfirm({
          autoConfirm: activity.autoConfirm as boolean | undefined,
          type: activity.type as ActivityType | undefined,
        })

  // ── The waiver gate — PRESENTABLE, not merely refusable ────────────────────
  // The claim page shows the waiver inside the claim window and sends the tick
  // with the claim, which is why this runs here rather than being left to
  // bookSession: a bare refusal would silently cost a queued member the ONE
  // offer their entry will ever get, for a document they were never shown.
  //
  // It adds NO second timer. The tick happens inside the existing claim window
  // and holds nothing — a waiver is not a price modifier, so the argument that
  // refused a promo code on this rail (a code would lock a strictly-capped use
  // for the whole claim window) does not carry, and is cited rather than
  // inherited.
  //
  // THIS RAIL USED TO DEFER, AND NO LONGER DOES — a behaviour change, not a
  // refactor. The divergence existed only for a guardian's EMAILED signature: a
  // link ran 72 hours against a claim window whose default is 120 minutes, the
  // offer is one per entry ever, and refusing would have spent a queued member's
  // only offer on a document nobody could complete in time. With the emailed
  // guardian path gone, the consent step is completable by the claimant on the
  // screen they are already looking at, inside the claim window, so there is
  // nothing left that refusing would destroy. The claim now refuses like every
  // other rail, and no booking in the product commits with a waiver unsigned.
  const waiverNowMs = Date.now()
  const waiverOutcome = await enforceWaiverGate({
    teamId,
    activityId,
    subject: {
      contactId,
      name: `${(contactSnap.data()?.firstname as string) ?? ''} ${
        (contactSnap.data()?.lastname as string) ?? ''
      }`.trim(),
      email: (contactSnap.data()?.email as string) ?? null,
    },
    submissions: parseWaiverSubmissions(data.waiverAcceptances),
    source: 'waitlist_claim',
    // The offer token proves control of the mailbox the offer was emailed to,
    // but it names the CONTACT rather than the person reading it — the same
    // strength a contact session carries, and no more.
    signerEmailVerifiedBy: 'session',
    ip: request.rawRequest?.ip ?? null,
    userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
    locale: null,
    nowMs: waiverNowMs,
  })

  const committed = await db.runTransaction(async (tx) => {
    // ── READS ──
    const freshEntry = await tx.get(entryRef)
    const freshBooking = await tx.get(bookingRef)
    // The acceptance commits with the seat — same read set, same transaction.
    const waiverPlans = await planWaiverLedgerWrites(tx, waiverOutcome.accepts, waiverNowMs)
    const e = freshEntry.data()
    const b = freshBooking.data()
    const nowMs = Date.now()

    // THE double-click guard, and it is inside the transaction on purpose: the
    // entry's status is the only thing that makes a claim single-use, so reading
    // it outside would let two calls both pass and both spend. The loser of the
    // race retries against the winner's commit, reads 'claimed', and stops here.
    const entryExpiresAt = e?.offer_expires_at as Timestamp | undefined
    if (e?.status !== 'offered' || e.offer_token !== offerToken) {
      throw new HttpsError('failed-precondition', 'This offer has already been used.', {
        reason: 'already_claimed',
      })
    }
    if (!entryExpiresAt || entryExpiresAt.toMillis() <= nowMs) {
      throw new HttpsError('failed-precondition', 'This offer has expired.', {
        reason: 'claim_expired',
      })
    }
    // The hold IS the seat. If it is gone the seat went back to the pool (a
    // sweep, an admin delete) and writing a booking here would take a seat that
    // may no longer exist — the person re-joins the queue instead.
    //
    // `isUnclaimedClaimHold` and NOT a bare `waitlist_claim === true`, because
    // this is the same decision release.ts makes about the same document and the
    // two must never disagree. A coach who cancels the hold, or marks its holder
    // a no-show, leaves the flags set on a DEAD booking while the recount frees
    // the seat and the promoter gives it to the next person; a bare flag test
    // would then let the original link flip that dead booking back to confirmed
    // with no capacity read anywhere — one seat granted twice.
    const holdExpiresAt = b?.claim_expires_at as Timestamp | undefined
    if (!isUnclaimedClaimHold(b as SeatHold | undefined)) {
      throw new HttpsError('failed-precondition', 'This offer has already been used.', {
        reason: 'already_claimed',
      })
    }
    if (!holdExpiresAt || holdExpiresAt.toMillis() <= nowMs) {
      throw new HttpsError('failed-precondition', 'This offer has expired.', {
        reason: 'claim_expired',
      })
    }

    interface UsableGrant {
      ref: FirebaseFirestore.DocumentReference
      credits_used: number
    }
    let grant: UsableGrant | null = null
    let windowRef: FirebaseFirestore.DocumentReference | null = null
    let windowUsed = 0

    if (creditSpendTypeId) {
      // FIFO across the contact's usable grants (soonest expiry first, then
      // oldest) — the same selection bookSession makes, re-read in-transaction
      // so the last credit of a pack cannot be spent twice.
      const grantsSnap = await tx.get(
        contactRef
          .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
          .where('teamId', '==', teamId)
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
          .sort((a, z) => {
            const ax = a.expires_at?.toMillis() ?? Number.MAX_SAFE_INTEGER
            const zx = z.expires_at?.toMillis() ?? Number.MAX_SAFE_INTEGER
            if (ax !== zx) return ax - zx
            return (a.created_at?.toMillis() ?? 0) - (z.created_at?.toMillis() ?? 0)
          })[0] ?? null
      if (!grant) {
        throw new HttpsError('permission-denied', denialMessage('no_credits', false), {
          reason: 'no_credits',
        })
      }
    } else if (usageSpend) {
      windowRef = contactRef.collection('usage_windows').doc(usageSpend.docId)
      const windowSnap = await tx.get(windowRef)
      windowUsed = (windowSnap.data()?.used as number | undefined) ?? 0
      if (windowUsed >= usageSpend.count) {
        throw new HttpsError('permission-denied', denialMessage('limit_reached', false), {
          reason: 'limit_reached',
        })
      }
    }

    // ── WRITES ──
    commitWaiverLedgerWrites(tx, waiverPlans)
    if (grant) tx.update(grant.ref, { credits_used: grant.credits_used + 1 })
    if (usageSpend && windowRef) {
      tx.set(
        windowRef,
        {
          teamId,
          subscription_type_id: usageSpend.subscriptionTypeId,
          used: windowUsed + 1,
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
    }
    tx.update(bookingRef, {
      status: autoConfirm ? 'confirmed' : 'pending',
      ...(autoConfirm ? { fullname: `${e!.firstname ?? ''} ${e!.lastname ?? ''}`.trim() } : {}),
      // EVERY hold marker goes, not just the two claim fields — see
      // CLAIM_HOLD_FIELDS. This is an update, so anything the document is
      // carrying survives unless it is named, and a claimant who opened the pay
      // screen first is carrying `payment_status: 'required'` + `expires_at`
      // from createDropInCheckout. Leaving either behind on a confirmed booking
      // frees its seat at the deadline (bookingHoldsSeat) AND puts it in
      // releaseExpiredBookingHolds' delete query.
      ...clearedClaimHoldFields(FieldValue.delete()),
      claimed_from_waitlist: true,
      subscription_type_id: matchedSubscriptionTypeId,
      ...(grant ? { credit_grant_id: grant.ref.id, credit_spent: 1 } : {}),
      ...(usageSpend
        ? {
            usage_window_doc_id: usageSpend.docId,
            usage_window_type_id: usageSpend.subscriptionTypeId,
          }
        : {}),
      // The denormalised stamp for the day sheet and the printed manifest —
      // `ok`, or one of the two "check who is actually here" prompts a
      // minors-flagged waiver produces. Never read for a decision.
      ...(waiverOutcome.bookingWaiverState
        ? { waiver_state: waiverOutcome.bookingWaiverState }
        : {}),
      updated_at: FieldValue.serverTimestamp(),
    })
    tx.update(entryRef, {
      status: 'claimed',
      claimed_at: FieldValue.serverTimestamp(),
      // Single use: the credential dies with the offer it belonged to.
      offer_token: FieldValue.delete(),
    })
    // No `bookings_count` write and no `pending_bookings_count` write. The seat
    // was already counted when the offer was minted and it never stopped being
    // counted — settling a hold moves no number. Touching the session document
    // here would also re-enter the promotion trigger for nothing.
    return {
      bookingToken: (b!.booking_token as string | undefined) ?? null,
      bookingReference: (b!.booking_reference as string | undefined) ?? null,
    }
  })

  // ── After the commit: everything that must not be able to fail the claim ───

  // Partner (aggregator) visit ledger — reporting only, idempotent by doc id.
  if (matchedSubscriptionTypeId && !creditSpendTypeId) {
    try {
      const typeSnap = await db
        .collection('teams')
        .doc(teamId)
        .collection('subscription_types')
        .doc(matchedSubscriptionTypeId)
        .get()
      const typeData = typeSnap.data()
      if (typeData?.source === 'aggregator') {
        await db
          .collection('teams')
          .doc(teamId)
          .collection(PARTNER_VISITS_SUBCOLLECTION)
          .doc(`${sessionId}_${contactId}`)
          .set({
            teamId,
            contactId,
            sessionId,
            subscription_type_id: matchedSubscriptionTypeId,
            subscription_type_name: (typeData.name as string) ?? null,
            amount: typeof typeData.payoutPerVisit === 'number' ? typeData.payoutPerVisit : null,
            session_start: session.start ?? null,
            activity_name: (session.activityName as string | undefined) ?? null,
            status: 'booked',
            created_at: FieldValue.serverTimestamp(),
          })
      }
    } catch (ledgerErr) {
      console.error('[waitlist] partner_visits ledger write failed:', ledgerErr)
    }
  }

  // The funnel stamp lands HERE, not at join: joining a queue is not a booking,
  // and stamping someone who never got a seat would report a funnel entry that
  // never happened. Clearing `provisional` is what makes a waitlist-born contact
  // permanent — join set a 30-day reaper on them precisely so an abandoned queue
  // entry does not leave a contact behind, and this is the moment it came good.
  try {
    const c = contactSnap.data()!
    const update: Record<string, unknown> = {}
    if (!c.acquisition_stage) {
      update.acquisition_stage = 'trial_booked'
      update.acquisition_stage_updated_at = FieldValue.serverTimestamp()
      update.trial_booked_at = FieldValue.serverTimestamp()
    }
    if (c.provisional === true) {
      update.provisional = FieldValue.delete()
      update.provisional_expires_at = FieldValue.delete()
    }
    if (Object.keys(update).length) await contactRef.update(update)
  } catch (err) {
    console.error('[waitlist] contact stamp after claim failed:', err)
  }

  // The ordinary booking confirmation — a claimed seat IS an ordinary booking
  // from this point, and a second "you're in" template would drift from it.
  try {
    if (await systemEmailEnabledFor(teamId, 'booking_confirmation')) {
      const lang: Lang = isLang(team.language) ? team.language : 'en'
      const manageBookingUrl =
        team.slug && committed.bookingToken
          // Locale-pinned to the studio's language, like the mail it goes into.
          ? localizedPublicUrl(getHostingUrl(), lang, team.slug, 'manage-booking', {
              token: committed.bookingToken,
            })
          : null
      const mail = buildClassBookingConfirmationMail({
        firstname: (entry.firstname as string) || '',
        teamName: team.name || 'Our Team',
        activityName,
        sessionStart: start.toDate(),
        sessionEnd: (session.end as Timestamp).toDate(),
        locationName: (session.location as string) || null,
        manageBookingUrl,
        spaceUrl: team.slug
          ? localizedPublicUrl(getHostingUrl(), lang, team.slug, 'space')
          : null,
        instructions:
          (activity.confirmationInstructions as string)?.trim() ||
          ((team.settings as Record<string, unknown> | undefined)
            ?.bookingConfirmationInstructions as string)?.trim() ||
          null,
        cancellationPolicy: (activity.cancellationPolicy as string)?.trim() || null,
        reference: committed.bookingReference,
        lang,
        bookingId: `${sessionId}-${contactId}`,
        attendeeName: `${(entry.firstname as string) || ''} ${(entry.lastname as string) || ''}`.trim(),
        attendeeEmail: (entry.email as string) || '',
        organizerEmail: await getTeamContactEmail(
          teamId,
          team as unknown as Record<string, unknown>
        ),
      })
      await sendEmail({
        to: (entry.email as string) || '',
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: mail.attachments,
        teamId,
      })
    }
  } catch (err) {
    console.error('[waitlist] claim confirmation email failed:', err)
  }

  console.log(`[waitlist] seat claimed on session ${sessionId} by contact ${contactId}`)
  return {
    requiresPayment: false,
    sessionId,
    contactId,
    bookingReference: committed.bookingReference,
    confirmed: autoConfirm,
  }
})
