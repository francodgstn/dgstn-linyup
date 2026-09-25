import assert from 'node:assert/strict'
import { decideAppointmentHoldRelease } from './holdRelease'
import { decideAppointmentCheckoutRollback } from './checkout'

// THE APPOINTMENT HOLD OWNERSHIP RULE — one fixture block per CENSUS SITE.
//
// The census lives in holdRelease.ts's module header — that file OWNS the list,
// and this one does not restate it. The sites that address a hold by its shared,
// deterministic id (`apt_{provider}_{startMs}`) all call
// `releaseAppointmentHold`, which applies this predicate inside the transaction
// that deletes. The sites that legitimately diverge get a block here too, by
// pinning the PROOF each of them relies on, because "this site is safe by
// construction" is exactly the kind of claim that rots.
//
// THE BUG THIS FILE EXISTS FOR was fixed at two of the three shared-address sites
// and missed at the third for two rounds: `handleCheckoutExpired` canceled the
// session and deleted the booking on PRESENCE alone. Phase 3 then made that fire
// seconds after a retry instead of ~31 minutes later, because a promo refresh
// expires the superseded Checkout Session at Stripe.
//
// Run with: pnpm --filter @linyup/functions test

const NOW = 1_700_000_000_000
const T_A = 'tok_A'
const T_B = 'tok_B'

/** A public-rail hold: 30 minutes out, still live. */
const liveDeadline = { holdExpiresAtMs: NOW + 30 * 60_000, nowMs: NOW }
/** The same hold, past its own deadline. */
const lapsedDeadline = { holdExpiresAtMs: NOW - 60_000, nowMs: NOW }
/** The staff payment-link rail: deliberately no deadline at all. */
const noDeadline = { holdExpiresAtMs: null, nowMs: NOW }

describe('the proof ladder — token first, and a token-holder never falls through', () => {
  it('TOKEN: the attempt that wrote the booking may release it', () => {
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_A,
        bookingExists: true,
        ...liveDeadline,
      }),
      { release: true, proof: 'token' }
    )
  })

  it('THE LOSING SIBLING: a newer attempt owns the hold, so the loser releases nothing', () => {
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...liveDeadline,
      }),
      { release: false, proof: null }
    )
  })

  it('a token-holder is judged on the TOKEN ALONE — no fallback to the weaker proofs', () => {
    // The decisive ordering property. If a mismatched token fell through to the
    // deadline or the exclusivity proof, the losing sibling would get a second
    // chance to cancel the winner on exactly the rails where the winner is most
    // exposed: a staff hold (no deadline) and a hold whose deadline has passed
    // while its Stripe session is still being paid.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...noDeadline,
      }),
      { release: false, proof: null }
    )
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...lapsedDeadline,
      }),
      { release: false, proof: null }
    )
  })

  it('a booking that is GONE is not ours — over-hold, never over-cancel', () => {
    // The winner may already have confirmed and rewritten it. There is nothing
    // for the token to be compared against, so the DOCUMENT's own proof decides:
    // on the public rail that is the deadline, and a live deadline refuses.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: null,
        bookingExists: false,
        ...liveDeadline,
      }),
      { release: false, proof: null }
    )
    // …and a document carrying no token at all proves nothing either way, so it
    // lands on the same branch.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: null,
        bookingExists: true,
        ...liveDeadline,
      }),
      { release: false, proof: null }
    )
  })

  it('PRECEDENCE, NOT EXCLUSION: the right token never leaves a caller worse off', () => {
    // The asymmetry this pins. Two callers reach the same document; one presents
    // the correct token and one presents none. The token-holder must get AT
    // LEAST what the other gets — the token is evidence, and evidence cannot
    // subtract. It used to: a token-holder meeting a missing booking was refused
    // outright while a tokenless caller was released.
    for (const rail of [lapsedDeadline, noDeadline]) {
      for (const booking of [
        { bookingExists: false, storedToken: null },
        { bookingExists: true, storedToken: null },
      ]) {
        const withToken = decideAppointmentHoldRelease({ bookingToken: T_A, ...booking, ...rail })
        const without = decideAppointmentHoldRelease({ bookingToken: null, ...booking, ...rail })
        assert.deepEqual(withToken, without)
      }
    }
    // …and it still refuses where the token can actually be compared and loses.
    assert.equal(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...noDeadline,
      }).release,
      false
    )
  })

  it('DEADLINE: a caller with no token may release a hold that has LAPSED', () => {
    // A lapsed hold belongs to nobody: runAppointmentSlotTransaction REPLACES the
    // session document, so whoever took this hold over wrote the deadline now on
    // it — and a deadline in the past proves no live attempt holds it.
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...lapsedDeadline }),
      { release: true, proof: 'deadline' }
    )
  })

  it('…and may NOT release one that is still live', () => {
    // This is the whole third-site fix for a Checkout Session created before the
    // metadata carried a token: a promo refresh expires the superseded session at
    // Stripe, so its expiry event arrives while the retry's hold is live.
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...liveDeadline }),
      { release: false, proof: null }
    )
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: '', bookingExists: true, ...liveDeadline }),
      { release: false, proof: null }
    )
  })

  it('EXCLUSIVITY: a hold that STILL presents no deadline has not changed hands', () => {
    // The staff payment-link rail writes no hold_expires_at (so the daily sweep
    // leaves its 7-day link alone). It is also the rail whose ONLY release path
    // is checkout.session.expired, so refusing here would strand the slot forever.
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...noDeadline }),
      { release: true, proof: 'exclusive' }
    )
  })

  it('…and a deadline-less hold IS reachable, which is why the proof is about the DOCUMENT', () => {
    // The tempting-but-false version of the argument is "nothing can rewrite a
    // staff hold". Something can: the same client booking the same slot through
    // the public checkout passes `allowRewriteByHolder: contactId`, and a staff
    // hold satisfies every condition for that reuse. What saves the proof is that
    // the rewrite REPLACES the session document and installs a hold_expires_at,
    // so the takeover is decided by the DEADLINE branch — and a live deadline
    // refuses.
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...liveDeadline }),
      { release: false, proof: null }
    )
  })
})

describe('census site 1 — createAppointmentCheckout rollback', () => {
  it('the losing racer never got the hold, so it cancels nothing', () => {
    // decideAppointmentCheckoutRollback answers only "did this attempt take it";
    // the predicate above answers "does it still hold it". Both are needed.
    assert.deepEqual(decideAppointmentCheckoutRollback({ holdAcquired: false, promoReserved: true }), {
      releaseHold: false,
      releasePromo: true,
    })
  })

  it('a failure after the hold was acquired releases it — under the token check', () => {
    const { releaseHold } = decideAppointmentCheckoutRollback({
      holdAcquired: true,
      promoReserved: false,
    })
    assert.equal(releaseHold, true)
    // …and this rail ALWAYS has its own token, so it never uses a weaker proof.
    assert.equal(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_A,
        bookingExists: true,
        ...liveDeadline,
      }).proof,
      'token'
    )
  })
})

describe('census site 2 — createStaffAppointment payment-link catch', () => {
  it('releases its own hold by token', () => {
    // It writes booking_token like every other rail, so the shared executor gets
    // the primary proof — even though this rail carries no deadline.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_A,
        bookingExists: true,
        ...noDeadline,
      }),
      { release: true, proof: 'token' }
    )
  })

  it('THE STRANDED SLOT: a token-holder whose booking is GONE still releases here', () => {
    // The rail with no deadline and no sweep. `hold_expires_at` is deliberately
    // absent (so the daily sweep leaves a 7-day payment link alone), which means
    // this rail's ONLY other release path is checkout.session.expired — and if
    // BOTH of them refuse, the provider's slot is never given back at all.
    //
    // A booking can be missing here for ordinary reasons: a manager deleted it
    // straight from the admin UI (firestore.rules permits that under
    // `schedule.manage`), or a later cancellation removed it. Refusing then made
    // presenting the correct token strictly worse than presenting none — the
    // caller below released the very same document.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: null,
        bookingExists: false,
        ...noDeadline,
      }),
      { release: true, proof: 'exclusive' }
    )
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: null,
        storedToken: null,
        bookingExists: false,
        ...noDeadline,
      }),
      { release: true, proof: 'exclusive' }
    )
    // The session is still canceled even though there is no booking to delete —
    // releaseAppointmentHold writes the session and deletes the booking only
    // `if (bSnap.exists)`, which is what makes this outcome useful rather than a
    // no-op that leaves `status: 'pending_payment'` standing forever.
  })

  it('THE BUG IT USED TO HAVE: the client\'s own public retry rewrites this hold', () => {
    // createAppointmentCheckout passes `allowRewriteByHolder: contactId`, so the
    // same client booking themselves at the same slot rewrites the staff hold in
    // place. This catch used to cancel on presence, killing the live, payable
    // session that retry had just been handed.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...noDeadline,
      }),
      { release: false, proof: null }
    )
  })
})

describe('census site 3 — handleCheckoutExpired (the one missed twice)', () => {
  it('an expiry for a SUPERSEDED session releases nothing', () => {
    // md.bookingToken is the superseded attempt's; the document carries the
    // retry's. Phase 3's promo refresh expires the old session at Stripe, so this
    // event now arrives seconds after the retry rather than ~31 minutes later.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...liveDeadline,
      }),
      { release: false, proof: null }
    )
  })

  it('an ordinary abandoned checkout still releases promptly', () => {
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_A,
        bookingExists: true,
        ...lapsedDeadline,
      }),
      { release: true, proof: 'token' }
    )
  })

  it('a session created before the token was stamped falls to the named fallbacks', () => {
    // Public rail, no token in metadata: the expiry lands after the deadline, so
    // the deadline proof carries it…
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...lapsedDeadline }),
      { release: true, proof: 'deadline' }
    )
    // …but an EARLY expiry (a retry closed the old session at Stripe) does not.
    assert.equal(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...liveDeadline })
        .release,
      false
    )
    // Staff rail, no token in metadata: exclusivity carries it, which is what
    // stops a 7-day payment link stranding its slot forever.
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...noDeadline }),
      { release: true, proof: 'exclusive' }
    )
  })
})

describe('census sites 4-7 — the divergences, and the proof each one rests on', () => {
  it('4 + 5: the daily sweep and the stale-booking reclaim are DEADLINE-addressed', () => {
    // expirePendingBookings queries status == 'pending_payment' AND
    // hold_expires_at <= now; runAppointmentSlotTransaction reclaims only a
    // canceled session or a lapsed hold. Both are the deadline proof applied by
    // a query rather than by a read — which this predicate agrees with, and which
    // is why neither is routed through releaseAppointmentHold.
    assert.deepEqual(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...lapsedDeadline }),
      { release: true, proof: 'deadline' }
    )
    // The same query can never match a live hold, so the sweep can never take one
    // from an attempt that still owns it.
    assert.equal(
      decideAppointmentHoldRelease({ bookingToken: null, bookingExists: true, ...liveDeadline })
        .release,
      false
    )
  })

  it('6: cancelBooking is TOKEN-addressed by construction', () => {
    // Its input IS the booking_token and it finds the booking by querying for it,
    // so it cannot address a document it does not own — the same proof as sites
    // 1-3, arrived at from the other end. Pinned as the identity case.
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_A,
        bookingExists: true,
        ...liveDeadline,
      }),
      { release: true, proof: 'token' }
    )
  })

  it('7: cancelSession is the ONE deliberate exemption', () => {
    // The manager clearing a slot is precisely the operation no attempt owns —
    // the twin of releasePromoReservations on the promo side. Recorded here as
    // the boundary of this rule rather than as a case it decides: nothing in this
    // predicate is consulted, and that is the point.
    assert.equal(typeof decideAppointmentHoldRelease, 'function')
  })
})
