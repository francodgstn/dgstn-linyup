import assert from 'node:assert/strict'
import {
  CHECKOUT_WINDOW_WORK_BUDGET_SECONDS,
  PROMO_RESERVATION_BACKSTOP_MINUTES,
  PROMO_RESERVATION_MARGIN_MINUTES,
  SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES,
  STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES,
  assertCheckoutWindowPayable,
  assertQuotedAmount,
  checkoutWindowBudgetLeftSeconds,
  resolveCheckoutHoldWindow,
} from './checkout'

// Unit tests for the reservation timer rule (Wave 3 Phase 3, P3-B2). Two live
// bugs at 4b3177f are pinned here as invariants rather than as prose:
//  • B3  — a hold that died BEFORE the session it guarded (35 vs a 120-minute
//          waitlist claim), freeing held gift-card value for another purchase
//          while the claim was still payable;
//  • B3b — a plain product/course session that lives 24 hours, which would
//          force a 24-hour reservation on anything riding it.
// Run with: pnpm --filter @linyup/functions test

const NOW = 1_700_000_000_000
const MIN = 60_000

/** The N9 relation, asserted the same way for every rail. */
function assertOutlivesSession(w: { expiresAtEpochSeconds?: number; holdMinutes?: number }) {
  assert.ok(w.expiresAtEpochSeconds !== undefined, 'a reservation needs a bounded session')
  assert.ok(w.holdMinutes !== undefined)
  const sessionMs = w.expiresAtEpochSeconds! * 1000
  const reservationMs = NOW + w.holdMinutes! * MIN
  assert.ok(reservationMs > sessionMs, 'the reservation must outlive the session it guards')
  // …and not by much: the margin, plus at most the one minute Math.ceil adds
  // because the hold parameter is minute-granular.
  //
  // This is the bound on THIS FUNCTION'S OUTPUT, measured at the same instant it
  // was given. The bound on the STORED deadline carries one more term — the hold
  // parameter is a duration applied at the reserve's own clock — which is why
  // that drift is bounded separately, by the work budget below. Do not read this
  // assertion as the document invariant.
  assert.ok(reservationMs <= sessionMs + (PROMO_RESERVATION_MARGIN_MINUTES + 1) * MIN)
}

describe('resolveCheckoutHoldWindow', () => {
  it('nothing reserved and no rail deadline ⇒ NO expiry (Stripe keeps its 24h default)', () => {
    // The plain product / course branches. Passing an expiry here would take a
    // buyer's overnight thinking time away for no gain — nothing is being held.
    assert.deepEqual(resolveCheckoutHoldWindow({ nowMs: NOW, carriesReservation: false }), {})
  })

  it('a reservation forces the SHORT window — this is B3b’s fix', () => {
    const w = resolveCheckoutHoldWindow({ nowMs: NOW, carriesReservation: true })
    assert.equal(
      w.expiresAtEpochSeconds,
      Math.floor(NOW / 1000) + SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES * 60
    )
    assert.equal(w.holdMinutes, SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES + PROMO_RESERVATION_MARGIN_MINUTES)
    assertOutlivesSession(w)
  })

  it('the short-window hold reproduces the old 35-minute constant exactly (no drift)', () => {
    // 31 + 4 === 35 === the former DEFAULT_HOLD_MINUTES, so every plain drop-in,
    // product and course purchase behaves byte-identically to 4b3177f.
    assert.equal(SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES + PROMO_RESERVATION_MARGIN_MINUTES, 35)
  })

  it('alwaysBounded shortens a session even with nothing reserved (the drop-in seat hold)', () => {
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: false,
      alwaysBounded: true,
    })
    assert.equal(
      w.expiresAtEpochSeconds,
      Math.floor(NOW / 1000) + SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES * 60
    )
  })

  it('B3: a 120-minute waitlist claim holds for ~124 minutes, not 35', () => {
    const claim = Math.floor((NOW + 120 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: claim,
      alwaysBounded: true,
    })
    assert.equal(w.expiresAtEpochSeconds, claim)
    assert.equal(w.holdMinutes, 120 + PROMO_RESERVATION_MARGIN_MINUTES)
    assertOutlivesSession(w)
    // The bug, stated as the thing that can no longer happen.
    assert.ok(w.holdMinutes! > 35)
  })

  it('a rail deadline is used VERBATIM — never clamped, or the seat gets two timers', () => {
    // A studio may configure a claim window past Stripe's ceiling; clamping is
    // resolveClaimCheckoutWindow's job, upstream, where the ONE instant is
    // reconciled with the booking hold and the queue entry.
    const fixed = Math.floor((NOW + 23 * 60 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: fixed,
      alwaysBounded: true,
    })
    assert.equal(w.expiresAtEpochSeconds, fixed)
    assertOutlivesSession(w)
  })

  it('a rail deadline wins even with nothing reserved', () => {
    const fixed = Math.floor((NOW + 90 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: false,
      fixedExpiresAtEpochSeconds: fixed,
    })
    assert.equal(w.expiresAtEpochSeconds, fixed)
  })

  it('null/undefined rail deadlines fall through to the derived rules', () => {
    for (const fixedExpiresAtEpochSeconds of [null, undefined]) {
      assert.deepEqual(
        resolveCheckoutHoldWindow({
          nowMs: NOW,
          carriesReservation: false,
          fixedExpiresAtEpochSeconds,
        }),
        {}
      )
    }
  })

  it('an already-past deadline still leaves the reservation findable by the release path', () => {
    const past = Math.floor((NOW - 10 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: past,
    })
    assert.equal(w.holdMinutes, PROMO_RESERVATION_MARGIN_MINUTES)
    assert.ok(w.holdMinutes! > 0)
  })

  it('holdMinutes is defined exactly when expiresAtEpochSeconds is', () => {
    const cases = [
      { nowMs: NOW, carriesReservation: false },
      { nowMs: NOW, carriesReservation: true },
      { nowMs: NOW, carriesReservation: false, alwaysBounded: true },
      { nowMs: NOW, carriesReservation: true, fixedExpiresAtEpochSeconds: Math.floor(NOW / 1000) },
    ]
    for (const c of cases) {
      const w = resolveCheckoutHoldWindow(c)
      assert.equal(w.holdMinutes === undefined, w.expiresAtEpochSeconds === undefined)
      assert.equal(w.promoHoldMinutes === undefined, w.expiresAtEpochSeconds === undefined)
    }
  })

  // ── The promo backstop is a SEPARATE, longer window, and that is the point ──
  //
  // A gift-card hold is released by a marker on the card, so four minutes of
  // slack costs nothing. A promo slot is released by `checkout.session.expired`,
  // and its lazy expiry must not race Stripe's delivery of the OTHER event that
  // decides the same slot — `checkout.session.completed`, which Stripe retries
  // over hours. At +4 the lazy expiry WAS the mechanism, and a payment made one
  // second before expiry whose webhook arrived five minutes late found its slot
  // already re-handed. Both counted. That is the breach this window closes.

  it('the promo reservation outlives the session by the BACKSTOP, not the margin', () => {
    const w = resolveCheckoutHoldWindow({ nowMs: NOW, carriesReservation: true })
    assert.equal(
      w.promoHoldMinutes,
      SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES + PROMO_RESERVATION_BACKSTOP_MINUTES
    )
    assert.ok(w.promoHoldMinutes! > w.holdMinutes!, 'the promo slot must outlive the gift-card hold')
    const sessionMs = w.expiresAtEpochSeconds! * 1000
    assert.ok(NOW + w.promoHoldMinutes! * MIN > sessionMs)
  })

  it('the backstop leaves real room for a late Stripe delivery', () => {
    // Not a magic number: it has to be longer than an ordinary webhook retry
    // takes, and the four-minute margin is not.
    assert.ok(PROMO_RESERVATION_BACKSTOP_MINUTES >= 30)
    assert.ok(PROMO_RESERVATION_BACKSTOP_MINUTES > PROMO_RESERVATION_MARGIN_MINUTES)
  })

  it('a waitlist claim derives BOTH windows from the one rail deadline', () => {
    // The claim rail takes no promo today, but the derivation must not fork:
    // both numbers are copies of ONE instant, never two computations.
    const claim = Math.floor((NOW + 120 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: claim,
      alwaysBounded: true,
    })
    assert.equal(w.holdMinutes, 120 + PROMO_RESERVATION_MARGIN_MINUTES)
    assert.equal(w.promoHoldMinutes, 120 + PROMO_RESERVATION_BACKSTOP_MINUTES)
  })

  it('an already-past deadline still leaves the promo slot findable', () => {
    const past = Math.floor((NOW - 10 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: past,
    })
    assert.equal(w.promoHoldMinutes, PROMO_RESERVATION_BACKSTOP_MINUTES)
  })
})

// ─── The WORK BUDGET — the cost of fixing the instant before reserving ────────
//
// The instant is chosen BEFORE the reserves, because each reservation's window
// is derived from it and deriving them separately is B3. That ordering is not
// free: Stripe's `expires_at` floor is measured against the moment the CREATE
// call lands, so everything in between spends the gap between the instant we
// chose (31 minutes) and the floor Stripe enforces (30). Before promos that gap
// was clock-skew slack with nothing happening inside it. It is now a budget, and
// what spends it is a promo reserve that may make two Stripe calls of its own,
// a gift-card reserve, and a booking-hold transaction.
//
// It cannot be widened (31 is pinned to the 30-minute booking hold on one side
// and to 31 + 4 === 35 on the other) and the instant cannot be computed later
// (that IS B3). So it is named, enforced, and pinned here.

describe('the checkout window work budget', () => {
  const SHORT = Math.floor(NOW / 1000) + SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES * 60

  /** Run with console captured, so a refusal's log is asserted rather than
   *  printed — the ERROR is half of "this can never fail silently". */
  function captureLogs<T>(fn: () => T): { result?: T; error?: unknown; logs: string[] } {
    const logs: string[] = []
    const realError = console.error
    const realWarn = console.warn
    console.error = (...args: unknown[]) => void logs.push(`ERROR ${args.join(' ')}`)
    console.warn = (...args: unknown[]) => void logs.push(`WARN ${args.join(' ')}`)
    try {
      return { result: fn(), logs }
    } catch (error) {
      return { error, logs }
    } finally {
      console.error = realError
      console.warn = realWarn
    }
  }

  it('is DERIVED from the two ends, so it cannot drift out of step with either', () => {
    assert.equal(
      CHECKOUT_WINDOW_WORK_BUDGET_SECONDS,
      (SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES - STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES) * 60
    )
    // And it is POSITIVE — a short window that did not clear Stripe's floor would
    // refuse every promo-carrying checkout on every rail, deterministically.
    assert.ok(CHECKOUT_WINDOW_WORK_BUDGET_SECONDS > 0)
    assert.equal(CHECKOUT_WINDOW_WORK_BUDGET_SECONDS, 60)
  })

  it('a freshly resolved SHORT window starts with exactly the budget', () => {
    // The producer and the constant, tied together: this is what makes the
    // budget the real number the rails have, not an assumption about it.
    const w = resolveCheckoutHoldWindow({ nowMs: NOW, carriesReservation: true })
    assert.equal(
      checkoutWindowBudgetLeftSeconds({ expiresAtEpochSeconds: w.expiresAtEpochSeconds, nowMs: NOW }),
      CHECKOUT_WINDOW_WORK_BUDGET_SECONDS
    )
  })

  it('a 24-hour session has NO budget to blow (null, not a number)', () => {
    // The plain product/course branch passes no expiry at all; the guard must be
    // a no-op there rather than inventing a deadline for it.
    const w = resolveCheckoutHoldWindow({ nowMs: NOW, carriesReservation: false })
    const expiresAtEpochSeconds = w.expiresAtEpochSeconds
    assert.equal(checkoutWindowBudgetLeftSeconds({ expiresAtEpochSeconds, nowMs: NOW }), null)
    assert.deepEqual(
      captureLogs(() =>
        assertCheckoutWindowPayable({ expiresAtEpochSeconds, nowMs: NOW, label: 'plain' })
      ).logs,
      []
    )
  })

  it('a waitlist claim has minutes of budget, not seconds', () => {
    // The claim rail is refused upstream unless 31 minutes remain
    // (resolveClaimCheckoutWindow, minMinutes), so its budget is never smaller
    // than the short window's — one threshold serves every rail.
    const claim = Math.floor((NOW + 120 * MIN) / 1000)
    const w = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: claim,
      alwaysBounded: true,
    })
    assert.equal(
      checkoutWindowBudgetLeftSeconds({ expiresAtEpochSeconds: w.expiresAtEpochSeconds, nowMs: NOW }),
      (120 - STRIPE_MIN_CHECKOUT_EXPIRY_MINUTES) * 60
    )
    const minimumClaim = resolveCheckoutHoldWindow({
      nowMs: NOW,
      carriesReservation: true,
      fixedExpiresAtEpochSeconds: Math.floor(NOW / 1000) + SHORT_HOLD_CHECKOUT_EXPIRY_MINUTES * 60,
      alwaysBounded: true,
    })
    assert.equal(
      checkoutWindowBudgetLeftSeconds({
        expiresAtEpochSeconds: minimumClaim.expiresAtEpochSeconds,
        nowMs: NOW,
      }),
      CHECKOUT_WINDOW_WORK_BUDGET_SECONDS
    )
  })

  it('spending the whole budget and one second more REFUSES — it never moves the instant', () => {
    // Moving `expires_at` out to clear Stripe's floor would keep this sale and
    // break, silently and in data, everything the instant was reconciled with:
    // the seat freed at +30, the appointment slot hold, a claim's one instant,
    // and the upper bound on every reservation derived from it.
    const atTheLimit = NOW + CHECKOUT_WINDOW_WORK_BUDGET_SECONDS * 1000
    const edge = captureLogs(() =>
      assertCheckoutWindowPayable({ expiresAtEpochSeconds: SHORT, nowMs: atTheLimit, label: 'edge' })
    )
    // Exactly at Stripe's floor still goes through — the budget is spent, not
    // overspent — and it has been warning since half of it went.
    assert.equal(edge.error, undefined)
    assert.match(edge.logs[0] ?? '', /^WARN /)
    const { error, logs } = captureLogs(() =>
      assertCheckoutWindowPayable({
        expiresAtEpochSeconds: SHORT,
        nowMs: atTheLimit + 1_000,
        label: 'createDropInCheckout',
      })
    )
    const e = error as { code?: string; message?: string; details?: { reason?: string } }
    assert.equal(e?.details?.reason, 'checkout_window_lapsed')
    // Byte-identical to the Stripe-failure error this helper already throws, so
    // no surface changes and no new copy is needed in any of the four locales.
    assert.equal(e?.message, 'Failed to start checkout')
    // Loud, and it names the rail that overspent.
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^ERROR /)
    assert.match(logs[0], /createDropInCheckout/)
  })

  it('half the budget spent WARNS — erosion is visible before a customer finds it', () => {
    // The tripwire. Adding one more await inside the window shows up here, in
    // logs, on a sale that still completed — rather than as the first refused
    // checkout after a deploy.
    const { error, logs } = captureLogs(() =>
      assertCheckoutWindowPayable({
        expiresAtEpochSeconds: SHORT,
        nowMs: NOW + (CHECKOUT_WINDOW_WORK_BUDGET_SECONDS / 2 + 1) * 1000,
        label: 'createAppointmentCheckout',
      })
    )
    assert.equal(error, undefined)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /^WARN /)
    assert.match(logs[0], /createAppointmentCheckout/)
  })

  it('an ordinary checkout is silent — the tripwire must not cry wolf', () => {
    // A whole second of work between fixing the instant and calling Stripe is
    // already far above what these rails take; nothing should be logged.
    const { error, logs } = captureLogs(() =>
      assertCheckoutWindowPayable({
        expiresAtEpochSeconds: SHORT,
        nowMs: NOW + 1_000,
        label: 'createProductCheckout',
      })
    )
    assert.equal(error, undefined)
    assert.deepEqual(logs, [])
  })

  it('an already-past expiry is refused rather than sent to Stripe', () => {
    // resolveCheckoutHoldWindow deliberately TOLERATES a past deadline so the
    // release path can still find the reservation. That tolerance must not reach
    // Stripe as a create.
    const past = Math.floor((NOW - 10 * MIN) / 1000)
    const { error } = captureLogs(() =>
      assertCheckoutWindowPayable({ expiresAtEpochSeconds: past, nowMs: NOW, label: 'lapsed' })
    )
    assert.equal(
      (error as { details?: { reason?: string } })?.details?.reason,
      'checkout_window_lapsed'
    )
  })
})

// ─── assertQuotedAmount — the SCOPED, one-sided price guard ─────────────────
//
// Two properties are pinned here because both read like they should be the other
// way round:
//
//  • it is SCOPED to promo-carrying checkouts. Off the promo path the client's
//    figure is an optimistic render, not a quote, and the two snapshots are
//    documented as allowed to disagree — so enforcing it there refuses ORDINARY
//    sales, deterministically (an exhausted credit pack listed in a benefit; a
//    price raised under a shop tab that fetched its catalog once).
//  • it is ONE-SIDED. Refusing on ANY difference would refuse a member whose
//    benefit comes from a SECONDARY held subscription type: the contact session
//    carries only the primary one, so the client quotes base and the server
//    resolves the discount — routinely, with nothing wrong anywhere.
const WITH_PROMO = { promoAttempted: true }
const NO_PROMO = { promoAttempted: false }

describe('assertQuotedAmount', () => {
  it('no code typed ⇒ never refuses, however far apart the two numbers are', () => {
    // The whole non-promo blast radius, in one line: the client quoting a member
    // rate the server does not reproduce must not block the sale.
    assert.doesNotThrow(() => assertQuotedAmount(32, 40, NO_PROMO))
    assert.doesNotThrow(() => assertQuotedAmount(0.5, 999, NO_PROMO))
  })

  it('no quote supplied ⇒ proceeds (an older client, or a surface with no price)', () => {
    assert.doesNotThrow(() => assertQuotedAmount(undefined, 40, WITH_PROMO))
    assert.doesNotThrow(() => assertQuotedAmount(null, 40, WITH_PROMO))
    assert.doesNotThrow(() => assertQuotedAmount(Number.NaN, 40, WITH_PROMO))
  })

  it('equal to the cent ⇒ proceeds, float noise and all', () => {
    assert.doesNotThrow(() => assertQuotedAmount(30, 30, WITH_PROMO))
    assert.doesNotThrow(() => assertQuotedAmount(28.3, 28.304999999999996, WITH_PROMO))
  })

  it('the server resolves LESS than shown ⇒ proceeds — nobody is harmed by paying less', () => {
    assert.doesNotThrow(() => assertQuotedAmount(40, 32, WITH_PROMO))
  })

  it('the server resolves MORE than shown ⇒ refuses, carrying the CURRENT figure', () => {
    // The flagship case: a code that stopped applying between preview and pay.
    assert.throws(
      () => assertQuotedAmount(30, 40, WITH_PROMO),
      (err: unknown) => {
        const e = err as { code?: string; details?: { reason?: string; amount?: number } }
        assert.equal(e.details?.reason, 'price_changed')
        assert.equal(e.details?.amount, 40)
        return true
      }
    )
  })

  it('the refusal is RECOVERABLE: re-sending the figure it carried proceeds', () => {
    // What every mount does with `details.amount` — show it, let the visitor
    // accept it, re-send it. A refusal the buyer cannot act on is a lost sale.
    let accepted: number | null = null
    try {
      assertQuotedAmount(30, 40, WITH_PROMO)
    } catch (err) {
      accepted = (err as { details?: { amount?: number } }).details?.amount ?? null
    }
    assert.equal(accepted, 40)
    assert.doesNotThrow(() => assertQuotedAmount(accepted, 40, WITH_PROMO))
  })

  it('one cent more is still more', () => {
    assert.throws(() => assertQuotedAmount(30, 30.01, WITH_PROMO))
    assert.doesNotThrow(() => assertQuotedAmount(30, 29.99, WITH_PROMO))
  })

  it('a REFUSED CODE is named, so the visitor is not told the price moved', () => {
    // The gap this closes: the loader REPORTS rather than throws, so an
    // audience-mismatched code reaches Stage A as "no modifier", the server
    // prices at list, and this guard fires first. Told only `price_changed`, the
    // visitor hears a sentence about the studio's pricing when the truth is a
    // sentence about them — and one they can act on.
    assert.throws(
      () =>
        assertQuotedAmount(32, 40, {
          promoAttempted: true,
          promoRefusal: 'audience_mismatch',
        }),
      (err: unknown) => {
        const e = err as {
          details?: { reason?: string; amount?: number; promoRefusal?: string }
        }
        // `reason` STAYS price_changed — it is the token every mount's recovery
        // branch keys on, and the cause is additive rather than a replacement.
        assert.equal(e.details?.reason, 'price_changed')
        assert.equal(e.details?.promoRefusal, 'audience_mismatch')
        assert.equal(e.details?.amount, 40)
        return true
      }
    )
  })

  it('no promo cause ⇒ no promoRefusal key at all (the price really did move)', () => {
    assert.throws(
      () => assertQuotedAmount(30, 40, { promoAttempted: true, promoRefusal: null }),
      (err: unknown) => {
        const details = (err as { details?: Record<string, unknown> }).details ?? {}
        assert.equal('promoRefusal' in details, false)
        return true
      }
    )
    // …and the pre-existing two-argument shape of the scope object still behaves
    // identically, which is what keeps every call site that has no refusal to
    // report unchanged.
    assert.throws(
      () => assertQuotedAmount(30, 40, WITH_PROMO),
      (err: unknown) => {
        const details = (err as { details?: Record<string, unknown> }).details ?? {}
        assert.equal('promoRefusal' in details, false)
        return true
      }
    )
  })

  it('a named cause never turns a passing quote into a refusal', () => {
    // The cause DESCRIBES a refusal; it must never cause one. A refused code
    // that did not raise the price (the buyer is paying the same or less) still
    // completes — the purchase is never blocked over a code, only over money.
    assert.doesNotThrow(() =>
      assertQuotedAmount(40, 40, { promoAttempted: true, promoRefusal: 'not_applicable' })
    )
    assert.doesNotThrow(() =>
      assertQuotedAmount(40, 32, { promoAttempted: true, promoRefusal: 'not_applicable' })
    )
    assert.doesNotThrow(() =>
      assertQuotedAmount(32, 40, { promoAttempted: false, promoRefusal: 'audience_mismatch' })
    )
  })
})
