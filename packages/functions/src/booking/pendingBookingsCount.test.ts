import assert from 'node:assert/strict'
import { holdWriteCountDelta, replacedBookingWasCounted } from './index'

// `contacts/{id}.pending_bookings_count` is a per-DOCUMENT ledger over
// `sessions/{sessionId}/bookings/{contactId}`: whoever puts a document into a
// COUNTED state adds one, whoever takes it out of that state gives one back.
// Both writers below full-REPLACE the caller's own document, so each has to know
// what the document it is standing on was, and what it will be afterwards.
// Getting it wrong is silent in both directions: too broad leaves a real
// person's counter permanently high, too narrow drives it negative. Pure — no
// Firestore.
//
// This table is the whole decision. It has been re-derived four times because it
// was reasoned about one shape at a time; the point of writing it out is that no
// row can be changed without looking at the others.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH DOCUMENTS OWN A COUNT
// ─────────────────────────────────────────────────────────────────────────────
//
//   plain drop-in hold      NO   `createDropInCheckout` never counted it,
//   (payment_status:             `expirePendingBookings` deletes it without a
//    'required', no               decrement, and the Connect webhook confirms it
//    waitlist_claim)              without one. Uncounted for its whole life.
//
//   waitlist claim hold     YES  `promoteWaitlist` counts it when it mints the
//   (waitlist_claim: true)       offer; `releaseWaitlistOffer` gives it back
//                                when the offer lapses (and only paired with a
//                                delete it made itself).
//
//   settled free claim      YES  `claimWaitlistSeat` clears the claim markers
//   (markers cleared)            and moves NO counter — the offer's count simply
//                                carries on. This is the shape that reads as
//                                "ordinary pending booking", which is exactly
//                                why `replacedBookingWasCounted` cannot test
//                                `waitlist_claim`.
//
//   ordinary pending        YES  `bookSession` counts it after the commit.
//   booking
//
//   rebooked-in booking     YES  `rebookSession` does its own counting at the
//   (rebooked_from)              point of creation — its two origins are
//                                indistinguishable afterwards.
//
//   canceled / no_show /   NO   Every one of those transitions handed the count
//   rebooked-away                back (cancelBooking, markNoShowBookings, the
//                                admin bookings page, rebookSession).
//
//   confirmed               ??   Ambiguous, and deliberately never asked: it
//                                means "counted, booked" on an auto-confirming
//                                session and "released at check-in" everywhere
//                                else. Both seams below refuse it outright.
//
// ─────────────────────────────────────────────────────────────────────────────
// SEAM 1 — bookSession's replacing write  (`replacedBookingWasCounted`)
// ─────────────────────────────────────────────────────────────────────────────
// Its duplicate guard admits ONLY `status === 'pending'` — `bookSession`'s
// `already-exists` refusal, written twice (the authenticated branch and the
// guest `exactMatch` branch), and an absent status is refused too — so every
// shape that reaches this seam is a live pending booking and the status carries
// no information here. The post-commit `+1` fires when the answer is `false`.
//
//   replaced document              | owns a count | wasCounted | +1 after commit
//   -------------------------------|--------------|------------|----------------
//   (none)                         |      –       |   false    |      yes
//   plain drop-in hold             |      no      |   false    |      yes
//   waitlist claim hold            |      yes     |   true     |      no
//   paid waitlist claim hold       |      yes     |   true     |      no
//   settled free claim             |      yes     |   true     |      no
//   ordinary pending booking       |      yes     |   true     |      no
//   rebooked-in booking            |      yes     |   true     |      no
//   canceled / no_show / rebooked |  UNREACHABLE — 'already-exists'
//   confirmed                      |  UNREACHABLE — 'already-exists'
//
// ─────────────────────────────────────────────────────────────────────────────
// SEAM 2 — createDropInCheckout's hold write  (`holdWriteCountDelta`)
// ─────────────────────────────────────────────────────────────────────────────
// A LOOSER guard: it blocks only a `participants` doc and a `confirmed` booking
// (`dropIn.ts`, "already registered"), so a DISPOSED document reaches this seam
// and must not be decremented a second time. That is the one asymmetry between
// the two functions, and the reason this one reads `status`.
//
// The write leaves behind a claim hold when a `waitlistToken` resolved to a live
// offer, and a plain drop-in hold otherwise:
//
//   replaced document              | owns a count | → plain hold | → claim hold
//   -------------------------------|--------------|--------------|-------------
//   (none)                         |      no      |       0      |      +1
//   plain drop-in hold             |      no      |       0      |      +1
//   waitlist claim hold            |      yes     |      -1      |       0
//   paid waitlist claim hold       |      yes     |      -1      |       0
//   settled free claim             |      yes     |      -1      |       0
//   ordinary pending booking       |      yes     |      -1      |       0
//   rebooked-in booking            |      yes     |      -1      |       0
//   canceled                      |      no      |       0      |      +1
//   no_show                        |      no      |       0      |      +1
//   rebooked (away)                |      no      |       0      |      +1
//   confirmed                      |  UNREACHABLE (guard) — moves nothing
//
// The `-1` row is the bug this seam was given: an offer holder who abandons the
// claim link and buys through the ordinary form turns a COUNTED claim hold into
// an UNCOUNTED plain drop-in hold, and the promoter's `+1` is left attached to a
// document every later reader treats as uncounted — double-counted by a later
// `bookSession`, or stranded forever when `expirePendingBookings` deletes it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER WRITERS, for completeness — none of them is a replacing seam
// ─────────────────────────────────────────────────────────────────────────────
//   createDropInCheckout, FULL-COVER gift card → writes a CONFIRMED booking and
//     moves NOTHING, deliberately unchanged: it settles exactly as
//     `handleDropInCheckout` does, and that path has never maintained this
//     counter either (spec §0.4 N2). A counted claim hold therefore stays
//     counted through the confirm (as a paid claim does) and an uncounted
//     drop-in hold stays uncounted (as a paid drop-in does). Closing N2 means
//     changing BOTH settle paths in one commit; it is not this phase.
//   promoteWaitlist       +1 with the hold it mints.
//   releaseWaitlistOffer  -1, and only paired with a delete it made itself.
//   claimWaitlistSeat      0 — settling a hold moves no number.
//   rebookSession         its own delta at the point of creation.

describe('replacedBookingWasCounted (seam 1 — bookSession)', () => {
  it('nothing to replace — the write is a new booking and must be counted', () => {
    assert.equal(replacedBookingWasCounted(undefined), false)
    assert.equal(replacedBookingWasCounted(null), false)
  })

  it('a plain drop-in payment hold was NEVER counted — count it now', () => {
    // createDropInCheckout writes payment_status 'required' and, for a plain
    // hold, moves no contact counter; skipping here would drive it negative.
    assert.equal(replacedBookingWasCounted({ payment_status: 'required' }), false)
  })

  it('a waitlist claim hold was counted by the promoter — do not count it twice', () => {
    assert.equal(replacedBookingWasCounted({ waitlist_claim: true }), true)
  })

  it('a PAID waitlist claim hold carries payment_status too, and was still counted', () => {
    // createDropInCheckout re-writes the claim markers on a payable claim, so
    // this shape looks like a drop-in hold apart from `waitlist_claim`.
    assert.equal(
      replacedBookingWasCounted({ payment_status: 'required', waitlist_claim: true }),
      true
    )
  })

  it('a SETTLED free claim carries no claim flag at all and was still counted', () => {
    // The claim settle deletes `waitlist_claim`, which is exactly why reading
    // that flag was too narrow: this is the shape that double-counted.
    assert.equal(replacedBookingWasCounted({}), true)
  })

  it('an ordinary pending booking (a reverted confirmation) was counted', () => {
    assert.equal(replacedBookingWasCounted({ payment_status: 'paid' }), true)
  })

  it('a seat rebookSession moved here was counted BY rebookSession', () => {
    // The document it writes carries `rebooked_from` and no payment markers, so
    // it reads as an ordinary pending booking — which is the whole point. Its
    // two origins (a live pending booking whose count carries over, versus a
    // no_show or a checked-in participant whose count had already been given
    // back) are indistinguishable from here, so counting it here would be right
    // for one and a permanent +1 for the other. rebookSession settles it at the
    // point of creation instead; this must stay `true` or that seat is counted
    // twice.
    assert.equal(replacedBookingWasCounted({ rebooked_from: 'sessionA' }), true)
    assert.equal(
      replacedBookingWasCounted({ rebooked_from: 'sessionA', payment_status: 'paid' }),
      true
    )
  })

  it('ignores `status` — every shape that reaches this seam is pending', () => {
    // The guard admits nothing else, so adding the field must change nothing
    // here. The hold seam below is the one that has to read it.
    assert.equal(replacedBookingWasCounted({ status: 'pending' }), true)
    assert.equal(
      replacedBookingWasCounted({ status: 'pending', payment_status: 'required' }),
      false
    )
  })
})

describe('holdWriteCountDelta (seam 2 — createDropInCheckout writes a hold)', () => {
  const PLAIN_HOLD = { status: 'pending', payment_status: 'required' }
  const CLAIM_HOLD = { status: 'pending', waitlist_claim: true }
  const PAID_CLAIM_HOLD = { status: 'pending', payment_status: 'required', waitlist_claim: true }
  const SETTLED_CLAIM = { status: 'pending' }
  const REBOOKED_IN = { status: 'pending', rebooked_from: 'sessionA' }

  it('a fresh drop-in hold on an empty slot moves nothing', () => {
    assert.equal(holdWriteCountDelta(undefined, false), 0)
    assert.equal(holdWriteCountDelta(null, false), 0)
  })

  it('a fresh CLAIM hold with no predecessor is counted here', () => {
    // Reachable: an admin (or a sweep) deleted the promoter's hold while the
    // entry was still `offered`, and the claim link then re-creates it. The
    // document becomes a counted claim hold, so the count has to exist.
    assert.equal(holdWriteCountDelta(undefined, true), 1)
  })

  it('re-writing one plain drop-in hold over another moves nothing', () => {
    assert.equal(holdWriteCountDelta(PLAIN_HOLD, false), 0)
  })

  it('THE BUG: a claim hold overwritten by an ordinary drop-in hold gives the count back', () => {
    // The offer holder abandoned the claim link and bought through the public
    // form. Without the -1 the promoter's +1 is stranded on a document that
    // every later reader — `replacedBookingWasCounted`, `expirePendingBookings`,
    // the Connect webhook — treats as an uncounted plain hold.
    assert.equal(holdWriteCountDelta(CLAIM_HOLD, false), -1)
    assert.equal(holdWriteCountDelta(PAID_CLAIM_HOLD, false), -1)
  })

  it('a settled free claim / ordinary pending booking overwritten by a hold gives it back too', () => {
    // Same reason, one step further along: whatever counted the document that
    // was standing here, the thing left behind is an uncounted drop-in hold.
    assert.equal(holdWriteCountDelta(SETTLED_CLAIM, false), -1)
    assert.equal(holdWriteCountDelta(REBOOKED_IN, false), -1)
  })

  it('the mirror: a plain hold re-written as a CLAIM hold is counted', () => {
    // Someone who opened an ordinary drop-in checkout and then went back to
    // their claim link. Uncounted → counted, so +1.
    assert.equal(holdWriteCountDelta(PLAIN_HOLD, true), 1)
  })

  it('re-writing a claim hold as a claim hold (the ordinary claim) moves nothing', () => {
    assert.equal(holdWriteCountDelta(CLAIM_HOLD, true), 0)
    assert.equal(holdWriteCountDelta(PAID_CLAIM_HOLD, true), 0)
    assert.equal(holdWriteCountDelta(SETTLED_CLAIM, true), 0)
  })

  it('a DISPOSED document owns no count — never decrement it a second time', () => {
    // This is what makes the two seams differ. bookSession refuses these with
    // 'already-exists'; createDropInCheckout does not, and cancelBooking /
    // markNoShowBookings / rebookSession already gave the count back. Treating
    // them like a live pending booking would drive a real person negative — the
    // exact failure the ledger is written to avoid.
    for (const status of ['cancelled', 'no_show', 'rebooked']) {
      assert.equal(holdWriteCountDelta({ status }, false), 0, status)
      assert.equal(holdWriteCountDelta({ status }, true), 1, status)
    }
  })

  it('a confirmed booking is unreachable here and moves nothing either way', () => {
    // The already-registered guard refuses it. 'confirmed' is the one status
    // whose count cannot be inferred from the document alone (booked-and-counted
    // on an auto-confirming session, released at check-in everywhere else), so
    // if it ever did arrive the safe answer is to move nothing.
    assert.equal(holdWriteCountDelta({ status: 'confirmed' }, false), 0)
    assert.equal(holdWriteCountDelta({ status: 'confirmed', payment_status: 'paid' }, true), 0)
  })
})
