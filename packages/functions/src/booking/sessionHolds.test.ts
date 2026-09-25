import assert from 'node:assert/strict'
import {
  bookingHoldsSeat,
  bookingSeatTakenUp,
  confirmClearedHoldFields,
  countHoldingSeats,
  isExpiredWaitlistClaim,
  isUnclaimedClaimHold,
  seatFreedEdge,
  seatsFree,
} from '@linyup/shared'

// Unit tests for THE capacity predicate (@linyup/shared types/session.ts).
// trackBookings' recount and bookSession's "fully booked" refusal both call it,
// so a disagreement here is either an oversell or a customer locked out of a
// free seat. Pure — no Firestore. Run: pnpm --filter @linyup/functions test

const ts = (ms: number) => ({ toMillis: () => ms }) as never

const now = 1_000_000

/** A stand-in for a QueryDocumentSnapshot — id + data(), which is all the seat
 *  counter reads. */
const snap = (id: string, data: Record<string, unknown>) => ({ id, data: () => data })

describe('bookingHoldsSeat', () => {
  it('an ABSENT status is pending and still holds a seat', () => {
    assert.equal(bookingHoldsSeat({}, now), true)
  })

  it('pending/confirmed hold; cancelled/no_show/rebooked do not', () => {
    assert.equal(bookingHoldsSeat({ status: 'pending' }, now), true)
    assert.equal(bookingHoldsSeat({ status: 'confirmed' }, now), true)
    assert.equal(bookingHoldsSeat({ status: 'cancelled' }, now), false)
    assert.equal(bookingHoldsSeat({ status: 'no_show' }, now), false)
    // 'rebooked' means the seat moved to another session.
    assert.equal(bookingHoldsSeat({ status: 'rebooked' }, now), false)
  })

  it('a LIVE unpaid drop-in hold holds its seat', () => {
    const b = { status: 'pending', payment_status: 'required', expires_at: ts(now + 60_000) }
    assert.equal(bookingHoldsSeat(b, now), true)
  })

  it('a LAPSED unpaid drop-in hold releases its seat (the stale-full bug)', () => {
    const b = { status: 'pending', payment_status: 'required', expires_at: ts(now - 1) }
    assert.equal(bookingHoldsSeat(b, now), false)
  })

  it('a PAID booking holds its seat regardless of expires_at', () => {
    const b = { status: 'confirmed', payment_status: 'paid', expires_at: ts(now - 60_000) }
    assert.equal(bookingHoldsSeat(b, now), true)
  })

  it('expires_at without payment_status: required is not a hold', () => {
    assert.equal(bookingHoldsSeat({ status: 'pending', expires_at: ts(now - 1) }, now), true)
  })

  it('a lapsed waitlist claim releases its seat', () => {
    const live = { waitlist_claim: true, claim_expires_at: ts(now + 1) }
    const lapsed = { waitlist_claim: true, claim_expires_at: ts(now) }
    assert.equal(bookingHoldsSeat(live, now), true)
    assert.equal(bookingHoldsSeat(lapsed, now), false)
  })

  // The claim deadline only ever frees a seat that is STILL waiting to be
  // claimed. A settled booking that kept the flag — because whoever confirmed it
  // did not clear it — must hold its seat forever, or the recount frees it, the
  // promoter offers it again, and eleven people turn up for ten places.
  it('a CONFIRMED booking still carrying a lapsed claim keeps its seat', () => {
    const b = { status: 'confirmed', waitlist_claim: true, claim_expires_at: ts(now - 60_000) }
    assert.equal(bookingHoldsSeat(b, now), true)
  })

  it('a PAID claim keeps its seat past the deadline — money moved for it', () => {
    const paid = { waitlist_claim: true, payment_status: 'paid', claim_expires_at: ts(now - 1) }
    // Full-cover gift card: no Stripe session at all, settled the same way.
    const card = {
      waitlist_claim: true,
      payment_status: 'gift_card',
      claim_expires_at: ts(now - 1),
    }
    assert.equal(bookingHoldsSeat(paid, now), true)
    assert.equal(bookingHoldsSeat(card, now), true)
  })

  it('an UNCLAIMED lapsed claim is still the one case that frees a seat', () => {
    // Explicit 'pending' (what the promoter writes) and absent status alike.
    assert.equal(
      bookingHoldsSeat({ status: 'pending', waitlist_claim: true, claim_expires_at: ts(now) }, now),
      false
    )
    assert.equal(bookingHoldsSeat({ waitlist_claim: true, claim_expires_at: ts(now) }, now), false)
  })

  it('a lapsed PAID claim awaiting payment frees its seat — the money never landed', () => {
    // `payment_status: 'required'` is the claim mid-checkout; expires_at and
    // claim_expires_at are the same instant, so both rules agree.
    const b = {
      status: 'pending',
      waitlist_claim: true,
      payment_status: 'required',
      expires_at: ts(now),
      claim_expires_at: ts(now),
    }
    assert.equal(bookingHoldsSeat(b, now), false)
  })
})

describe('countHoldingSeats', () => {
  it('counts only the documents that hold a seat', () => {
    const docs = [
      snap('a', { status: 'confirmed' }),
      snap('b', {}), // absent status = pending
      snap('c', { status: 'cancelled' }),
      snap('d', { status: 'no_show' }),
      snap('e', { status: 'pending', payment_status: 'required', expires_at: ts(now - 1) }),
    ]
    assert.equal(countHoldingSeats(docs, now), 2)
  })

  it('excludeId drops the caller own booking — the seat they are replacing', () => {
    const docs = [snap('a', { status: 'confirmed' }), snap('me', { status: 'pending' })]
    assert.equal(countHoldingSeats(docs, now), 2)
    assert.equal(countHoldingSeats(docs, now, 'me'), 1)
  })

  it('excludeId on a doc that holds nothing changes nothing', () => {
    const docs = [snap('a', { status: 'confirmed' }), snap('me', { status: 'cancelled' })]
    assert.equal(countHoldingSeats(docs, now, 'me'), 1)
  })

  it('an empty session counts zero', () => {
    assert.equal(countHoldingSeats([], now), 0)
  })

  it('a settled claim that kept its flags is counted, an unclaimed lapsed one is not', () => {
    // The oversell this pair guards: both documents look identical to a bare
    // `isExpiredWaitlistClaim`, and only one of them is a seat going spare.
    const docs = [
      snap('settled', {
        status: 'confirmed',
        waitlist_claim: true,
        claim_expires_at: ts(now - 1),
      }),
      snap('unclaimed', {
        status: 'pending',
        waitlist_claim: true,
        claim_expires_at: ts(now - 1),
      }),
    ]
    assert.equal(countHoldingSeats(docs, now), 1)
  })

  it('one clock for the whole pass: a hold expiring at nowMs is already free', () => {
    const docs = [
      snap('a', { status: 'pending', payment_status: 'required', expires_at: ts(now) }),
      snap('b', { status: 'pending', payment_status: 'required', expires_at: ts(now + 1) }),
    ]
    assert.equal(countHoldingSeats(docs, now), 1)
  })
})

describe('seatsFree', () => {
  it('an uncapped session is never full', () => {
    assert.equal(seatsFree(undefined, 99), Infinity)
    assert.equal(seatsFree(null, 0), Infinity)
    // A cap of 0 or less reads as ABSENT, matching every max_participants read.
    assert.equal(seatsFree(0, 5), Infinity)
    assert.equal(seatsFree(-3, 5), Infinity)
  })

  it('the last seat is free until it is taken', () => {
    assert.equal(seatsFree(10, 9), 1)
    assert.equal(seatsFree(10, 10), 0)
  })

  it('an oversold session reports negative, never clamps to zero', () => {
    // The gate tests `<= 0`, and hiding an oversell behind 0 would make a
    // recovered miscount look like an exactly-full class.
    assert.equal(seatsFree(10, 12), -2)
  })
})

describe('seatFreedEdge', () => {
  const full = { max_participants: 10, bookings_count: 10 }
  const room = { max_participants: 10, bookings_count: 9 }

  it('fires exactly once, on the full → has-room transition', () => {
    assert.equal(seatFreedEdge(full, room), true)
    // The promotion transaction writes the session again with the seats retaken;
    // this second pass must not re-enter the promoter.
    assert.equal(seatFreedEdge(room, full), false)
    assert.equal(seatFreedEdge(room, room), false)
    assert.equal(seatFreedEdge(full, full), false)
  })

  it('an oversold class that comes back under the cap has freed a seat', () => {
    assert.equal(seatFreedEdge({ max_participants: 10, bookings_count: 12 }, room), true)
    // …but only once it actually has room.
    assert.equal(
      seatFreedEdge({ max_participants: 10, bookings_count: 12 }, { max_participants: 10, bookings_count: 11 }),
      false
    )
  })

  it('raising the cap frees seats without a booking changing', () => {
    assert.equal(seatFreedEdge(full, { max_participants: 15, bookings_count: 10 }), true)
  })

  it('an uncapped session never fires — it was never full', () => {
    assert.equal(seatFreedEdge({ bookings_count: 40 }, { bookings_count: 39 }), false)
    // Removing the cap altogether is a capacity raise like any other.
    assert.equal(seatFreedEdge(full, { bookings_count: 10 }), true)
  })

  it('a canceled session has no seat to hand on', () => {
    assert.equal(seatFreedEdge(full, { ...room, status: 'cancelled' }), false)
  })

  it('creation and deletion are not edges', () => {
    assert.equal(seatFreedEdge(null, room), false)
    assert.equal(seatFreedEdge(full, null), false)
    assert.equal(seatFreedEdge(undefined, undefined), false)
  })

  it('an absent bookings_count reads as zero', () => {
    assert.equal(seatFreedEdge(full, { max_participants: 10 }), true)
  })
})

describe('isUnclaimedClaimHold', () => {
  it('only a claim hold qualifies — an ordinary booking is never releasable', () => {
    assert.equal(isUnclaimedClaimHold({}), false)
    assert.equal(isUnclaimedClaimHold({ status: 'pending' }), false)
    assert.equal(isUnclaimedClaimHold(null), false)
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true }), true)
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, status: 'pending' }), true)
  })

  it('a claim that was TAKEN UP is not releasable — deleting it destroys a paid seat', () => {
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, status: 'confirmed' }), false)
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, payment_status: 'paid' }), false)
    // Full-cover gift card: confirmed with no Stripe session at all.
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, payment_status: 'gift_card' }), false)
  })

  it('an already-RESOLVED claim is not a hold either — releasing it decrements twice', () => {
    // Whoever cancelled/no-showed/rebooked it already gave the seat back and
    // already moved the contact's pending counter.
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, status: 'cancelled' }), false)
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, status: 'no_show' }), false)
    assert.equal(isUnclaimedClaimHold({ waitlist_claim: true, status: 'rebooked' }), false)
  })

  it('is clock-free — lapsing is a separate question from being unclaimed', () => {
    const lapsed = { waitlist_claim: true, claim_expires_at: ts(now - 1) }
    assert.equal(isUnclaimedClaimHold(lapsed), true)
    assert.equal(isExpiredWaitlistClaim(lapsed, now), true)
    // Awaiting payment: the money has not landed, so the seat is still the
    // queue's to reclaim.
    assert.equal(
      isUnclaimedClaimHold({ waitlist_claim: true, payment_status: 'required' }),
      true
    )
  })
})

describe('isExpiredWaitlistClaim', () => {
  it('inert on today’s bookings — no waitlist_claim field', () => {
    assert.equal(isExpiredWaitlistClaim({}, now), false)
    assert.equal(isExpiredWaitlistClaim({ claim_expires_at: ts(now - 1) }, now), false)
  })

  it('needs BOTH the flag and a passed deadline', () => {
    assert.equal(isExpiredWaitlistClaim({ waitlist_claim: true }, now), false)
    assert.equal(isExpiredWaitlistClaim({ waitlist_claim: true, claim_expires_at: ts(now + 1) }, now), false)
    assert.equal(isExpiredWaitlistClaim({ waitlist_claim: true, claim_expires_at: ts(now) }, now), true)
  })
})

describe('bookingSeatTakenUp', () => {
  // The release path's question is NOT "does this document occupy a seat" but
  // "is this person in the class" — the answer decides whether a waitlist entry
  // is closed as 'claimed' (silently) or as 'expired' (with the mail that says
  // the offer lapsed). Both directions have reached real people.

  it('a person who booked the class directly IS in it — no status, no payment', () => {
    // bookSession full-replaces the claim hold; on a class with
    // `autoConfirm: false` the replacement carries no status field at all.
    // Reading this as "not taken up" deleted nothing but told somebody who has
    // a seat that their place was not claimed in time.
    assert.equal(bookingSeatTakenUp({}, now), true)
    assert.equal(bookingSeatTakenUp({ status: 'pending' }, now), true)
  })

  it('a live UNPAID drop-in hold is NOT — it holds the seat, it settles nothing', () => {
    // The offer holder abandoned the claim link and opened an ordinary drop-in
    // checkout instead (which drops `waitlist_claim`), then never paid. Calling
    // that 'claimed' swallows the offer-expired mail for someone who is not in
    // the class.
    const liveHold = { payment_status: 'required', expires_at: ts(now + 10 * 60_000) }
    assert.equal(bookingHoldsSeat(liveHold, now), true)
    assert.equal(bookingSeatTakenUp(liveHold, now), false)
  })

  it('but a CONFIRMED booking is in the class whatever its payment markers say', () => {
    // A coach confirming somebody at the door is the studio deciding they are
    // in; a stranded `payment_status` must not demote that.
    assert.equal(
      bookingSeatTakenUp(
        { status: 'confirmed', payment_status: 'required', expires_at: ts(now + 60_000) },
        now
      ),
      true
    )
  })

  it('paid, gift-card and settled claims are taken up; released seats are not', () => {
    assert.equal(bookingSeatTakenUp({ payment_status: 'paid' }, now), true)
    assert.equal(bookingSeatTakenUp({ status: 'confirmed', payment_status: 'gift_card' }, now), true)
    // Nothing there, or the seat already went back to the pool.
    assert.equal(bookingSeatTakenUp(undefined, now), false)
    assert.equal(bookingSeatTakenUp({ status: 'cancelled' }, now), false)
    assert.equal(bookingSeatTakenUp({ status: 'no_show' }, now), false)
    assert.equal(bookingSeatTakenUp({ status: 'rebooked' }, now), false)
    // A LAPSED unpaid hold does not even hold the seat any more.
    assert.equal(
      bookingSeatTakenUp({ payment_status: 'required', expires_at: ts(now - 1) }, now),
      false
    )
  })
})

describe('confirmClearedHoldFields', () => {
  // What a staff confirm (bookings list, session detail, checkInContact,
  // selfCheckIn) must take off the document. One patch, four surfaces.
  const DEL = '<delete>'

  it('clears the two claim fields on an ordinary booking — a no-op when absent', () => {
    assert.deepEqual(confirmClearedHoldFields({}, DEL), {
      waitlist_claim: DEL,
      claim_expires_at: DEL,
    })
  })

  it('leaves an ordinary drop-in hold’s payment markers alone', () => {
    // Pre-existing and deliberately untouched: whether confirming an abandoned
    // drop-in hold at the door should waive the payment is a product decision,
    // not this patch's to make.
    assert.deepEqual(
      confirmClearedHoldFields({ payment_status: 'required', expires_at: ts(now + 60_000) }, DEL),
      { waitlist_claim: DEL, claim_expires_at: DEL }
    )
  })

  it('clears ALL FOUR on a claim hold that was mid-payment', () => {
    // The shape this phase introduced. Leaving `payment_status`/`expires_at`
    // behind frees the confirmed seat again at the deadline (bookingHoldsSeat →
    // seatFreedEdge → the promoter re-offers it) and puts the booking in
    // releaseExpiredBookingHolds' 02:00 delete query.
    const patch = confirmClearedHoldFields(
      {
        status: 'pending',
        waitlist_claim: true,
        claim_expires_at: ts(now + 60_000),
        payment_status: 'required',
        expires_at: ts(now + 60_000),
      },
      DEL
    )
    assert.deepEqual(patch, {
      waitlist_claim: DEL,
      claim_expires_at: DEL,
      payment_status: DEL,
      expires_at: DEL,
    })
  })

  it('never clears a payment that LANDED', () => {
    // A paid claim is settled by the webhook (payment_status: 'paid', claim
    // fields already gone). If one is confirmed again at the door, deleting
    // 'paid' would lose the only marker saying money moved.
    assert.deepEqual(
      confirmClearedHoldFields({ waitlist_claim: true, payment_status: 'paid' }, DEL),
      { waitlist_claim: DEL, claim_expires_at: DEL }
    )
  })

  it('the settled document is a seat that never expires again', () => {
    const hold = {
      status: 'pending' as const,
      waitlist_claim: true,
      claim_expires_at: ts(now + 60_000),
      payment_status: 'required',
      expires_at: ts(now + 60_000),
    }
    // Apply the patch the way a Firestore update would, with `undefined` for
    // the delete sentinel — which every predicate reads as an absent field.
    const settled = { ...hold, status: 'confirmed', ...confirmClearedHoldFields(hold, undefined) }
    assert.equal(bookingHoldsSeat(settled, now + 48 * 60 * 60_000), true)
    assert.equal(bookingSeatTakenUp(settled, now + 48 * 60 * 60_000), true)
  })
})
