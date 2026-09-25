import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CANCELING A LINK-MODE APPOINTMENT (decision 16) — source assertions on the
// ordering the callable rests on.
//
// Same technique and same reasoning as deskSettlement.test.ts: the property is
// about ORDER inside a handler that takes the Admin SDK, a live Stripe client
// and firebase-functions, and reversing it is invisible to every behavioral
// test in this package.
//
// The defect: a manager cancels a link-mode appointment, the emailed Checkout
// Session stays payable for the rest of its seven days, the client pays it, and
// `handleAppointmentCheckout`'s case 3 RE-ACQUIRES the canceled session and
// confirms the booking. Somebody arrives to a locked door.

const SRC = join(__dirname, '..')

/** LF-normalized: CRLF on Windows, LF on CI, and these patterns span lines. */
function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

describe('cancelAppointmentSlot — the ordering that makes the cancellation safe', () => {
  const src = read('appointments/cancelSlot.ts')
  const handler = src.slice(src.indexOf('export const cancelAppointmentSlot'))

  it('closes the Stripe session BEFORE it cancels — the reverse of markAppointmentPaid', () => {
    // The two are right for opposite reasons. `checkout.session.expired` (census
    // site 3 of the appointment-hold release) carries this hold's own booking
    // token, so its ownership proof succeeds either way — but what it DOES is
    // cancel the session and delete the booking. For a settlement that is an
    // undo, so `markAppointmentPaid` settles first. For a cancellation it is the
    // same end state, so the two writers commute; what does NOT commute is a
    // PAYMENT arriving between a cancel write and a successful close, which is
    // the defect this callable exists to close.
    const closeAt = handler.indexOf('closeTeamCheckoutSession')
    const cancelAt = handler.indexOf('db.runTransaction')
    assert.ok(closeAt > 0, 'the Stripe close is gone')
    assert.ok(cancelAt > 0, 'the cancel transaction is gone')
    assert.ok(
      closeAt < cancelAt,
      'cancelAppointmentSlot must close the Checkout Session before it cancels the session — ' +
        'canceling first leaves a window in which a payment re-acquires the canceled slot'
    )
  })

  it('refuses the cancellation when the close reports the link was already PAID', () => {
    const paidBranch = handler.indexOf("linkOutcome === 'paid'")
    const cancelAt = handler.indexOf('db.runTransaction')
    assert.ok(paidBranch > 0, "the 'paid' close outcome is no longer handled")
    assert.ok(
      paidBranch < cancelAt,
      'the already-paid branch must return before the cancel transaction — canceling a ' +
        'just-paid appointment keeps the money with nothing said about it'
    )
    assert.match(handler, /paid_in_window/)
  })

  it('reports a close it could not prove, rather than flattening it into success', () => {
    // `failed` is not `closed`: the link may still be payable, and the manager
    // is the only one who can expire it in their own Stripe dashboard.
    assert.match(handler, /linkStillOpen: linkOutcome === 'failed'/)
  })

  it('only consults Stripe for a hold that is still awaiting its payment', () => {
    // A settled session's stored id names a spent Checkout Session, which would
    // answer `paid` and refuse a cancellation that has nothing to do with a link.
    assert.match(handler, /const awaitingPayment =[\s\S]{0,120}payment_pending === true/)
    assert.match(handler, /if \(awaitingPayment && checkoutSessionId\)/)
  })

  it('leaves a CONFIRMED booking standing and deletes only an unconfirmed hold', () => {
    assert.match(handler, /freshBooking\.data\(\)\?\.status !== 'confirmed'/)
  })

  it('keeps the gate the client write had — capability + coach own-scope, not the manager role', () => {
    // Moving a client write behind a callable swaps the rules for whatever the
    // callable checks. `assertManager` would read as the safe choice here and is
    // not: it would take the cancel button away from every coach who has been
    // canceling their own appointments all along.
    assert.match(handler, /requireCapability\(uid, teamId, 'schedule\.manage'\)/)
    assert.match(handler, /callerIsAllScoped\(uid, teamId\)/)
    // The CALL, not the word — the gate comment names `assertManager` to explain
    // why it is not used, and a check that could not tell those apart would be a
    // test that fails on its own documentation.
    assert.ok(
      !/await assertManager\(/.test(handler),
      'a manager-role gate here narrows who may cancel an appointment — see the gate comment'
    )
  })
})

describe('the appointment-hold release census still names this callable', () => {
  it('holdRelease.ts enumerates cancelAppointmentSlot', () => {
    // It cancels a session and deletes a booking, so two of the census recipe's
    // three greps find it — which is exactly the condition for having to justify
    // itself in that header rather than anywhere else.
    const census = read('appointments/holdRelease.ts')
    const header = census.slice(0, census.indexOf('import * as admin'))
    assert.ok(
      header.includes('cancelAppointmentSlot'),
      'a site that cancels an appointment session must be enumerated in the holdRelease.ts census'
    )
  })
})
