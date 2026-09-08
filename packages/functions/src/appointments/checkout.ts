/* eslint-disable no-console */
// createAppointmentCheckout — pay-per-appointment booking (Stripe Connect one-off
// charge), modelled on booking/dropIn.ts. A priced appointment DURATION whose
// effective price (for the caller) is an amount can't book free — the client
// calls this instead. THE HOLD IS THE SESSION: we write a 'pending_payment'
// session + a 'pending'/'required' booking BEFORE creating the Checkout Session,
// because an appointment session doesn't exist until booked — payment precedes
// existence. The Connect webhook (kind: 'appointment') confirms on success.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  GUEST_SNAPSHOT,
  normalizeBenefit,
  resolveDurationBenefit,
  resolveDurationSale,
  resolvePaymentOptions,
} from '@linyup/shared'
import { loadEnabledTeam, requireChargeableAccount } from '../connect/access'
import {
  assertQuotedAmount,
  buildResultUrls,
  checkoutRateLimit,
  closeTeamCheckoutSession,
  defaultIdempotencyKey,
  requireChargeableAmountFromMajor,
  resolveCheckoutHoldWindow,
  startOneOffCheckout,
} from '../connect/checkout'
import { giftCardCurrency } from '../connect/giftCards'
import {
  NO_PROMO_ATTEMPT,
  bindPromoCheckoutSession,
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
import { loadContactPaymentSnapshot } from '../booking/access'
import { attachWaiverContact, enforceWaiverGate, parseWaiverSubmissions } from '../waivers/gate'
import { recordWaiverEvents } from '../waivers/accept'
import { generateSecureToken } from '../utils/crypto'
import { APP_CHECK_ENFORCE, monitorAppCheck } from '../utils/appCheck'
import {
  loadAppointmentBookingContext,
  resolveAppointmentCaller,
  resolveOrCreateAppointmentContact,
  runAppointmentSlotTransaction,
} from './booking'
import { releaseAppointmentHold } from './holdRelease'
import { resolveContactFieldPatchForBooking } from '../booking/contactFields'

const HOLD_MINUTES = 30

/**
 * WHAT A FAILED CHECKOUT MAY UNDO — and it is not "everything above it".
 *
 * The appointment session's doc id is DETERMINISTIC (`apt_{providerId}_{startMs}`),
 * so it is shared by every visitor racing that slot. `runAppointmentSlotTransaction`
 * refuses the loser precisely BECAUSE the winner's live hold is sitting at that
 * id — which means the loser's catch is running with somebody else's document in
 * `sessionRef`. Cancelling it there would take a slot away from a person who
 * successfully booked it, and the loser would never notice.
 *
 * So the two rollbacks answer two different questions:
 *
 *  • THE HOLD is undone only when WE ACQUIRED IT — i.e. the slot transaction
 *    returned. "We never got the hold" and "we got it and then failed" are
 *    different states and only the second is ours to undo. (Everything between
 *    the slot transaction and the return — the Stripe create — is squarely the
 *    second.)
 *  • THE PROMO RESERVATION is undone whenever WE took one, including when the
 *    slot transaction is what threw: that reservation is ours by construction
 *    (its key is derived from this caller's identity and this target, and the
 *    release is instance-checked besides), and leaving it stranded until its
 *    lazy expiry is what makes two visitors racing one slot with one code cost
 *    the campaign a use for no sale.
 *
 * NEITHER FLAG IS AN INSTRUCTION TO DELETE. Each one answers only "did this
 * attempt ever take the thing?"; whether it still HOLDS it is decided at the
 * release, against the document as it stands — `releaseAppointmentHold` /
 * `decideAppointmentHoldRelease` (appointments/holdRelease.ts, which also carries
 * the CENSUS of every site that can release a hold) for the hold,
 * `decidePromoRelease` for the slot. Two rollbacks, one ownership rule.
 *
 * Pure and exported so the losing-racer path is pinned by a fixture rather than
 * by this comment.
 */
export function decideAppointmentCheckoutRollback(state: {
  /** True once runAppointmentSlotTransaction has RETURNED. */
  holdAcquired: boolean
  /** True once reservePromoRedemption has returned a ticket. */
  promoReserved: boolean
}): { releaseHold: boolean; releasePromo: boolean } {
  return { releaseHold: state.holdAcquired, releasePromo: state.promoReserved }
}
// The Checkout Session's expiry is no longer a constant here: it comes from
// `resolveCheckoutHoldWindow`, which owns the ONE instant this rail's session
// and its promo reservation are both derived from, and which carries the same
// 31-minute short window the local constant used to.
//
// The reason for the extra minute is NOT what the local constant said, and the
// change is worth noticing rather than inheriting: Stripe's `expires_at` floor
// is 30 minutes from the moment the CREATE CALL LANDS, and that gap used to be
// clock-skew slack with nothing happening inside it. It is now a WORK BUDGET —
// the promo reserve, the gift-card reserve and the booking-hold transaction all
// run between choosing the instant and creating the session, and
// `assertCheckoutWindowPayable` refuses a checkout that overspends it. See
// `CHECKOUT_WINDOW_WORK_BUDGET_SECONDS` in connect/checkout.ts.

export const createAppointmentCheckout = onCall(
  { enforceAppCheck: APP_CHECK_ENFORCE },
  async (request) => {
    monitorAppCheck(request, 'createAppointmentCheckout')
    const data = request.data as {
      teamId?: string
      providerId?: string
      activityId?: string
      startMs?: number
      durationMinutes?: number
      contactDetails?: { firstname: string; lastname: string; email: string; phone?: string }
      /** Answers to the studio's book-form contact fields — narrowed server
       *  side against the resolved list. See booking/contactFields.ts. */
      contactFieldAnswers?: Record<string, unknown>
      authenticatedContactId?: string
      verificationCodeId?: string
      slug?: string
      locale?: string
      origin?: string
      idempotencyKey?: string
      /** Optional promo code — a Stage A price MODIFIER, applied inside the
       *  resolver and never here. Appointments take no gift card by design, so
       *  this is the only instrument that can ride this rail's session. */
      promoCode?: string
      /** The price the surface rendered, major units. Disagreement → refuse with
       *  `price_changed` rather than charge a figure the caller never saw. */
      quotedAmount?: number
      /** Ticks from the waiver step — see waivers/gate.ts. */
      waiverAcceptances?: unknown
    }
    if (
      !data?.teamId ||
      !data?.providerId ||
      !data?.activityId ||
      typeof data.startMs !== 'number' ||
      typeof data.durationMinutes !== 'number'
    ) {
      throw new HttpsError(
        'invalid-argument',
        'teamId, providerId, activityId, startMs and durationMinutes are required'
      )
    }
    const { teamId, providerId, activityId, startMs, durationMinutes } = data
    const locale = data.locale ?? 'en'
    const db = admin.firestore()

    // Public endpoint — same per-IP hourly limit as the other Connect checkouts.
    await checkoutRateLimit(request.rawRequest?.ip)

    // Team must have Connect enabled + a chargeable account.
    const team = await loadEnabledTeam(teamId)
    requireChargeableAccount(team) // fail before the reads; the orchestrator re-checks

    // ── The *what* + the *when* ──
    const ctx = await loadAppointmentBookingContext({ teamId, providerId, activityId, startMs, durationMinutes })
    // Covers BOTH non-priced modes: a free length has nothing to charge for,
    // and a benefit_only one (UX-70) is deliberately not sold by the session —
    // reading the mode rather than the raw number is what stops a stale
    // `priceAmount` left behind by a mode switch from being charged.
    if (resolveDurationSale(ctx.chosenDuration).mode !== 'priced') {
      throw new HttpsError('failed-precondition', 'This duration is not for sale', { reason: 'not_priced' })
    }

    // ── Caller + effective price — THE PRICE IS THE GATE, there's no access
    // check any more: a guest always pays base; a benefit holder pays their
    // resolved (possibly discounted) price. Free path callers never reach
    // here — the client only calls checkout after bookAppointment's refusal. ──
    const caller = await resolveAppointmentCaller(request, { ...data, teamId })
    // THE ONE READER: the member rule for THE LENGTH being bought. `bookAppointment`
    // resolves the identical rule for the free path — the two must agree, or a
    // caller is refused at one price and charged another.
    const durationRule = resolveDurationBenefit(ctx.activity, ctx.chosenDuration.minutes)
    const snapshot = caller.authenticatedContact
      ? await loadContactPaymentSnapshot({
          teamId,
          contact: caller.authenticatedContact,
          relevantTypeIds: normalizeBenefit(durationRule)?.subscriptionTypeIds ?? [],
        })
      : GUEST_SNAPSHOT

    // ── The promo, loaded before Stage A and NEVER throwing ──
    // A code that does not apply is REPORTED and the purchase completes at list
    // price; the only thing this callable refuses over is a price the caller was
    // not shown (assertQuotedAmount, below).
    //
    // The audience gate needs the caller's funnel stage, and "joined" is a
    // property of the EMAIL rather than of one contact document — so when (and
    // only when) a code was typed, `resolvePromoCaller` resolves the email
    // against the team's contacts, whether or not this rail holds a document of
    // its own. Without it a long-standing member takes a new-customers-only code
    // by using the guest form, or by sharing a household mailbox with the
    // contact this booking is attributed to. That helper is shared with the
    // drop-in rail on purpose: one definition of "new customer", not one per rail.
    const promoTarget: PromoQuoteTarget = {
      kind: 'appointment',
      providerId,
      activityId,
      startMs,
      durationMinutes,
    }
    const promoCaller: PromoCaller = await resolvePromoCaller({
      teamId,
      contact: caller.authenticatedContact,
      email: caller.sanitized.email,
      codeTyped: Boolean(data.promoCode),
    })
    const chargeCurrency = giftCardCurrency(team.data?.default_currency as string | undefined)
    const promo: PromoAttempt = data.promoCode
      ? await loadPromoAttempt({
          teamId,
          code: data.promoCode,
          target: promoTarget,
          caller: promoCaller,
          chargeCurrency,
        })
      : NO_PROMO_ATTEMPT

    const priced = resolvePaymentOptions(
      snapshot,
      {
        kind: 'appointment',
        duration: ctx.chosenDuration,
        benefit: durationRule,
      },
      promo.modifier ? { promo: promo.modifier } : undefined
    )
    if (promo.modifier && !priced.promo) {
      // A supplied modifier that produced no outcome is a missed resolver call
      // site — loud, never a silent full-price charge.
      throw new HttpsError('internal', 'The promo code did not reach the resolver')
    }
    const payOption = priced.options[0]
    if (payOption?.type !== 'pay') {
      // 'covered' or 'spend_credits' — the free path (bookAppointment) is the
      // right door; this caller owes nothing.
      throw new HttpsError(
        'failed-precondition',
        'You can book this for free — no payment needed',
        { reason: 'covered' }
      )
    }
    // Scoped to a promo-carrying checkout — see assertQuotedAmount: without a
    // code the rendered price is an optimistic render, not a quote, and refusing
    // over it blocks ordinary sales the client cannot re-render its way out of.
    // `promo.refusal` rides along so a code refused HERE (this rail resolves the
    // guest's email at `resolveAppointmentCaller`, after the preview ran) is
    // reported as a refused code rather than as a moved price.
    assertQuotedAmount(data.quotedAmount, payOption.amount, {
      promoAttempted: Boolean(data.promoCode),
      promoRefusal: promo.refusal,
    })
    const promoApplied = priced.promo?.status === 'applied'

    // ── The waiver gate — before the contact write, and therefore before the
    // promo reserve, the hold transaction and the Stripe session. ──
    const waiverNowMs = Date.now()
    let waiverOutcome = await enforceWaiverGate({
      teamId,
      activityId,
      subject: {
        contactId: caller.authenticatedContact?.id ?? null,
        name: `${caller.sanitized.firstname} ${caller.sanitized.lastname}`.trim(),
        email: caller.sanitized.email,
      },
      submissions: parseWaiverSubmissions(data.waiverAcceptances),
      source: 'appointment_checkout',
      signerEmailVerifiedBy: data.authenticatedContactId
        ? 'verified_code'
        : caller.authenticatedContact
          ? 'session'
          : 'none',
      // The address that strength is ABOUT — see the twin in window.ts.
      signerEmail: caller.verifiedEmail,
      ip: request.rawRequest?.ip ?? null,
      userAgent: (request.rawRequest?.headers?.['user-agent'] as string | undefined) ?? null,
      locale,
      nowMs: waiverNowMs,
    })

    // ── Resolve/create the contact — guests always allowed; there is no access gate. ──
    const { contactId, isNewContact } = await resolveOrCreateAppointmentContact({
      teamId,
      plan: ctx.plan,
      sanitized: caller.sanitized,
      authenticatedContact: caller.authenticatedContact,
      // The book form's contact-field answers, already narrowed against the
      // team + activity list. `{}` — and no extra read — when none were sent.
      contactFieldPatch: await resolveContactFieldPatchForBooking({
        teamId,
        team: ctx.team,
        activityContactFields: ctx.activity.contactFields,
        answers: data.contactFieldAnswers,
        existing: caller.authenticatedContact,
      }),
    })
    waiverOutcome = attachWaiverContact(waiverOutcome, contactId)

    // Written BEFORE Stripe, in its own transaction, and NOT conditional on
    // payment: they read the text and ticked, and that is true whether or not
    // the card clears. Nothing about it is reserved, so nothing about it needs
    // releasing when a checkout is abandoned.
    await recordWaiverEvents(waiverOutcome.accepts, waiverNowMs)

    // The resolver's discount clamp guarantees derived prices are already ≥ the
    // floor; this guards the AUTHORED base price.
    const amount = requireChargeableAmountFromMajor(payOption.amount)

    // ── HOLD tx — the hold IS the session. A retry from the SAME contact rewrites
    // its own still-live hold (fresh Checkout Session, same slot). ──
    const bookingToken = generateSecureToken()
    const holdExpiresAt = Timestamp.fromMillis(Date.now() + HOLD_MINUTES * 60_000)
    const sessionRef = db.collection('sessions').doc(`apt_${providerId}_${ctx.start.getTime()}`)

    const sessionDoc = {
      teamId,
      templateId: ctx.tpl.id,
      origin: 'window',
      activityType: 'appointment',
      activityId,
      activityName: ctx.activity.name,
      // NOTE: no accessRule any more — appointments dropped the gate entirely.
      autoConfirm: ctx.autoConfirm,
      providerId,
      providerName: ctx.providerName,
      start: Timestamp.fromDate(ctx.start),
      end: Timestamp.fromDate(ctx.end),
      duration_minutes: durationMinutes,
      max_participants: 1,
      bookings_count: 1,
      // Structured place + its free-text note, both from the window — same as the
      // free path in window.ts. A paid hold becomes the confirmed session, so
      // dropping the place here would lose it for every paid appointment.
      ...(ctx.tpl.placeId ? { placeId: ctx.tpl.placeId } : {}),
      ...(ctx.tpl.roomId ? { roomId: ctx.tpl.roomId } : {}),
      location: ctx.tpl.location ?? null,
      onlineUrl: ctx.tpl.onlineUrl ?? null,
      allowBooking: true,
      // THE HOLD IS THE SESSION — never published (see syncSessionPublicProfile),
      // never counted by trackBookings (see analytics/index.ts), and skipped by
      // listAvailability's busy filter once hold_expires_at lapses (lazy release).
      status: 'pending_payment',
      hold_expires_at: holdExpiresAt,
      has_bookings: true,
      last_booking_at: FieldValue.serverTimestamp(),
      created_at: FieldValue.serverTimestamp(),
    }
    const bookingDoc = {
      firstname: caller.sanitized.firstname,
      lastname: caller.sanitized.lastname,
      email: caller.sanitized.email,
      phone: caller.sanitized.phone,
      contact: contactId,
      session: sessionRef.id,
      teamId,
      joinedAt: FieldValue.serverTimestamp(),
      fromBioLink: true,
      is_new_contact: isNewContact,
      booking_token: bookingToken,
      authenticated_booking: !!caller.authenticatedContact,
      // WHICH MEMBERSHIP priced this booking — not an access-gate match any
      // more. The fallback through `supersededBenefit` is what stops a running
      // campaign from blanking the studio's own subscription attribution for
      // exactly the members who used the code: when a promo beats an applicable
      // benefit, that benefit rides out on appliedPromo and is recorded here.
      subscription_type_id:
        payOption.appliedBenefit?.subscriptionTypeId ??
        payOption.appliedPromo?.supersededBenefit?.subscriptionTypeId ??
        null,
      // NO fullname — that's only stamped once the webhook confirms payment.
      status: 'pending',
      payment_status: 'required',
      expires_at: holdExpiresAt,
      ...(waiverOutcome.bookingWaiverState
        ? { waiver_state: waiverOutcome.bookingWaiverState }
        : {}),
    }

    // ── Create the Connect checkout; the webhook (kind: 'appointment') confirms. ──
    const slugQuery = data.slug ? `&slug=${encodeURIComponent(data.slug)}&seg=appointments` : ''
    const { successUrl, cancelUrl } = await buildResultUrls(locale, {
      extraQuery: slugQuery,
      origin: data.origin,
      teamId,
    })

    // ONE instant for the Stripe session and for the promo reservation guarding
    // it. `alwaysBounded` because this rail's hold IS the session: the slot is
    // released at the hold deadline whatever the buyer pays with, so the payment
    // window was already short before promos existed (31 minutes, unchanged).
    //
    // Same clock as every other rail: what runs between here and the Stripe
    // create — the promo reserve (a transaction plus up to two Stripe calls) and
    // the slot transaction — is spent out of CHECKOUT_WINDOW_WORK_BUDGET_SECONDS,
    // and overspending it is refused at startOneOffCheckout rather than papered
    // over by moving this instant, which the slot hold is derived from.
    const holdWindow = resolveCheckoutHoldWindow({
      nowMs: Date.now(),
      carriesReservation: promoApplied,
      alwaysBounded: true,
    })

    // ── RESERVE the promo, AFTER every non-money gate and immediately before
    // the first side effect this rail has. Two visitors racing one slot with the
    // same code is exactly why the slot transaction below sits INSIDE the guard:
    // the loser's reservation must come back, or one abandoned race consumes a
    // use of the campaign. ──
    //
    // THE TICKET IS THE ONLY PROOF ANYTHING WAS RESERVED — null unless the
    // resolver said `applied`, and required by the metadata stamp and the
    // release. A valid code that lost best-one-wins therefore cannot reach the
    // webhook's commit and burn a use it was never granted.
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
        // The session's instant plus the promo BACKSTOP, never the gift card's
        // tighter margin — PROMO_RESERVATION_BACKSTOP_MINUTES says why.
        expiresAt: Timestamp.fromMillis(Date.now() + (holdWindow.promoHoldMinutes ?? 0) * 60_000),
        amountMajor: payOption.amount,
        baseAmount: payOption.appliedPromo?.baseAmount ?? payOption.amount,
        chargeCurrency,
        // Close the session this slot was already backing before minting
        // another: one slot, at most one payable session, on every rail.
        closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
      })
    }
    /** Idempotent no-op when nothing was reserved. */
    const releaseReservedPromo = async (): Promise<void> => {
      if (promoTicket) {
        await releasePromoReservation({
          teamId,
          code: promoTicket.code,
          reservationKey: promoTicket.reservationKey,
          // OUR instance: a retry of this same purchase (same deterministic key)
          // may already have refreshed the entry, and this release must not free
          // a slot that retry's live session is still guarding.
          instanceId: promoTicket.instanceId,
        }).catch(() => undefined)
      }
    }

    const metadata: Record<string, string> = {
      kind: 'appointment',
      purpose: 'appointment',
      teamId,
      sessionId: sessionRef.id,
      contactId,
      activityId,
      activityName: ctx.activity.name,
      providerId,
      startMs: String(startMs),
      durationMinutes: String(durationMinutes),
      // THIS ATTEMPT'S PROOF OF OWNERSHIP, carried so `handleCheckoutExpired` can
      // present it. Without it that handler cancels the hold on PRESENCE, and
      // presence is not ownership at a deterministic, shared session id: a promo
      // refresh expires the superseded Checkout Session at Stripe, so its expiry
      // event now arrives seconds after the buyer's retry and would cancel the
      // hold the retry's live session is guarding. See appointments/holdRelease.ts.
      bookingToken,
      // What the webhook commits at the confirm point and releases on expiry.
      // Keyed off the TICKET, so it is stamped IFF a reservation was actually
      // taken — a plain session's payload is unchanged, and so is a session
      // whose code loaded but lost best-one-wins.
      ...promoCheckoutMetadata(promoTicket, payOption.amount),
    }
    const idempotencyKey =
      data.idempotencyKey ??
      // Instruments appended LAST, never reordered, and ZERO parts when none
      // applied — Stripe rejects a reused key whose parameters differ, and a
      // promo makes "re-price and resubmit" the primary interaction. The TICKET
      // goes in, not the code: the attempt's instance is what makes a resubmit a
      // new Stripe request instead of a parameter mismatch.
      defaultIdempotencyKey(
        'apt',
        teamId,
        sessionRef.id,
        contactId,
        ...instrumentKeyParts(promoTicket, null)
      )

    // The two rollback questions are DIFFERENT, and this flag is what separates
    // them — see decideAppointmentCheckoutRollback. The slot transaction is
    // inside the guard so a losing racer's promo reservation comes back; the
    // hold, which the loser never got, is not the loser's to cancel.
    let holdAcquired = false
    try {
      await runAppointmentSlotTransaction({
        sessionRef,
        sessionDoc,
        bookingDocId: contactId,
        bookingDoc,
        teamId,
        providerId,
        startMs: ctx.start.getTime(),
        endMs: ctx.end.getTime(),
        bufferMs: ctx.bufferMs,
        allowRewriteByHolder: contactId,
      })
      holdAcquired = true

      const checkoutSession = await startOneOffCheckout({
        team,
        amountMinor: amount,
        productName: `${ctx.activity.name} · ${durationMinutes} min`,
        successUrl,
        cancelUrl,
        customerEmail: caller.sanitized.email || undefined,
        metadata,
        idempotencyKey,
        // Derived from the ONE instant above rather than recomputed here — the
        // session's expiry and the reservation's must be two copies of one
        // number, never two computations. Equal to the previous
        // CHECKOUT_EXPIRY_MINUTES by construction.
        expiresAtEpochSeconds: holdWindow.expiresAtEpochSeconds,
        label: 'createAppointmentCheckout',
      })
      // Bind the slot to the ONE session that may be paid against it, before the
      // URL leaves this function. A bind that cannot happen closes that session
      // and throws — into the rollback below, which is where a slot hold we did
      // acquire gets given back.
      await bindPromoCheckoutSession({
        teamId,
        ticket: promoTicket,
        sessionId: checkoutSession.sessionId,
        closeCheckoutSession: (id) => closeTeamCheckoutSession(team, id),
      })
      return { url: checkoutSession.url, amount, ...promoCheckoutOutcome(promo, priced) }
    } catch (err) {
      // Every path from the promo reserve to the successful return passes
      // through here. Release order is the reverse of reservation: the slot
      // hold first, then the promo — but ONLY what is ours.
      //
      // `sessionRef` is a deterministic, SHARED id (apt_{provider}_{start}). When
      // the slot transaction refused us, the document at that id is the WINNER's
      // live hold: cancelling it here would sell a slot out from under somebody
      // who successfully booked it, triggered by a concurrent loser. So the hold
      // is released only when we actually acquired it — AND only while we still
      // hold it (decideAppointmentHoldRelease), because "we acquired it" and "it
      // is still ours" are different facts once a sibling attempt by the same
      // contact can rewrite it.
      const rollback = decideAppointmentCheckoutRollback({
        holdAcquired,
        promoReserved: !!promoTicket,
      })
      console.error(
        `[appointments] createAppointmentCheckout failed (holdAcquired=${holdAcquired}):`,
        err
      )
      if (rollback.releaseHold) {
        try {
          // TWO ROLLBACKS, ONE OWNERSHIP RULE — `releaseAppointmentHold` is the
          // hold's `releasePromoReservation`: read the thing at the shared
          // address, compare the per-attempt marker we wrote, and no-op when a
          // newer attempt owns it, all inside one transaction. It is the SAME
          // call the staff payment-link catch (appointments/staffBooking.ts) and
          // the expiry webhook (connect/webhook.ts) make — one call each is what
          // stops them drifting apart again, and connect/commitSites.test.ts
          // asserts that no fourth caller has appeared without a census entry.
          await releaseAppointmentHold({
            teamId,
            sessionId: sessionRef.id,
            contactId,
            bookingToken,
            label: 'createAppointmentCheckout',
          })
        } catch (releaseErr) {
          console.error('[appointments] createAppointmentCheckout: hold release failed:', releaseErr)
        }
      }
      if (rollback.releasePromo) await releaseReservedPromo()
      // A refusal from the slot transaction (the slot was taken) is a real
      // eligibility answer and must keep its own code; only a Stripe failure
      // collapses to `internal`.
      if (err instanceof HttpsError) throw err
      throw new HttpsError('internal', 'Failed to start checkout')
    }
  }
)
