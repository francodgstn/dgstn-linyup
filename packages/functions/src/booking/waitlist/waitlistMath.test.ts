import assert from 'node:assert/strict'
import {
  bookingHoldsSeat,
  clearedClaimHoldFields,
  isUnclaimedClaimHold,
  type SeatHold,
} from '@linyup/shared'
import {
  WAITLIST_DEFAULT_CLAIM_MINUTES,
  WAITLIST_MIN_WINDOW_MINUTES,
  WAITLIST_QUEUE_SCAN_LIMIT,
  isSessionCancelled,
  offerWasDelivered,
  resolveClaimCheckoutWindow,
  resolveClaimWindow,
  selectOfferHeads,
  waitlistQueueCap,
} from './constants'
import { isWithinSmsSendingHours, nextSmsWindowOpen } from '../../utils/sms'

// The two decisions the promoter cannot get wrong: how long a claim stays
// claimable (get it wrong and a seat is either unreachable or held past the
// cutoff), and how long a queue may get. Pure — no Firestore.
// Run: pnpm --filter @linyup/functions test

const MIN = 60_000
const HOUR = 60 * MIN
const now = Date.UTC(2026, 5, 15, 10, 0, 0) // a Monday, 12:00 Europe/Zurich

describe('waitlistQueueCap', () => {
  it('is twice the seats, with a floor so a tiny class still has a queue', () => {
    assert.equal(waitlistQueueCap(30), 60)
    assert.equal(waitlistQueueCap(10), 20)
    // 8 seats → 16, below the floor.
    assert.equal(waitlistQueueCap(8), 20)
  })

  it('an absent or nonsense cap falls back to the floor', () => {
    assert.equal(waitlistQueueCap(undefined), 20)
    assert.equal(waitlistQueueCap(null), 20)
    assert.equal(waitlistQueueCap(0), 20)
    assert.equal(waitlistQueueCap(-5), 20)
  })

  it('never exceeds what the join transaction can actually COUNT', () => {
    // The cap is enforced against a read limited to WAITLIST_QUEUE_SCAN_LIMIT.
    // A cap above that can never be reached by the observed count, so the check
    // silently stops binding and waitlist_count freezes at the limit.
    assert.equal(waitlistQueueCap(100), 200, 'the boundary: 100 seats × 2 is exactly the limit')
    assert.equal(waitlistQueueCap(101), 200, 'one seat past the boundary must NOT give 202')
    assert.equal(waitlistQueueCap(5000), 200)
    // …and the clamp is the scan limit itself, not a hard-coded twin of it.
    assert.ok(
      waitlistQueueCap(Number.MAX_SAFE_INTEGER) <= WAITLIST_QUEUE_SCAN_LIMIT,
      'the cap must never exceed the scan limit'
    )
  })
})

describe('resolveClaimWindow', () => {
  const base = {
    nowMs: now,
    claimStartMs: now,
    sessionStartMs: now + 48 * HOUR,
  }

  it('a class days away gets the full configured window', () => {
    const w = resolveClaimWindow({ ...base, claimMinutes: 120 })
    assert.equal(w.expiresAtMs, now + 2 * HOUR)
    assert.equal(w.minutesLeft, 120)
    assert.equal(w.offerable, true)
  })

  it('an absent or nonsense setting falls back to the default', () => {
    for (const claimMinutes of [undefined, null, 0, -30]) {
      const w = resolveClaimWindow({ ...base, claimMinutes })
      assert.equal(w.minutesLeft, WAITLIST_DEFAULT_CLAIM_MINUTES)
    }
  })

  it('the booking cutoff is a hard clamp — a claim can never outlive it', () => {
    // Class in 90 minutes, booking closes 60 minutes before it ⇒ 30 minutes of
    // window, whatever the 2-hour setting says.
    const w = resolveClaimWindow({
      nowMs: now,
      claimStartMs: now,
      sessionStartMs: now + 90 * MIN,
      cutoffMinutes: 60,
      claimMinutes: 120,
    })
    assert.equal(w.expiresAtMs, now + 30 * MIN)
    assert.equal(w.minutesLeft, 30)
    // …and 30 is under the floor, so the seat is not offered at all: it stays
    // visibly free for the walk-in door.
    assert.equal(w.offerable, false)
  })

  it('the session start clamps even with no cutoff configured', () => {
    const w = resolveClaimWindow({
      nowMs: now,
      claimStartMs: now,
      sessionStartMs: now + 45 * MIN,
      claimMinutes: 120,
    })
    assert.equal(w.expiresAtMs, now + 45 * MIN)
    assert.equal(w.offerable, true)
  })

  it('the floor is inclusive — exactly enough window is still offered', () => {
    const w = resolveClaimWindow({
      nowMs: now,
      claimStartMs: now,
      sessionStartMs: now + WAITLIST_MIN_WINDOW_MINUTES * MIN,
    })
    assert.equal(w.minutesLeft, WAITLIST_MIN_WINDOW_MINUTES)
    assert.equal(w.offerable, true)
  })

  it('a deferred START shortens what is LEFT, because both are measured from now', () => {
    // Seat freed at 23:10 for a class tomorrow evening: the window opens at
    // 08:00, so nine hours of it have already passed by the time it is usable —
    // minutesLeft counts from now, which is what the floors are tested against.
    const w = resolveClaimWindow({
      nowMs: now,
      claimStartMs: now + 9 * HOUR,
      sessionStartMs: now + 30 * HOUR,
      claimMinutes: 120,
    })
    assert.equal(w.expiresAtMs, now + 11 * HOUR)
    assert.equal(w.minutesLeft, 11 * 60)
    assert.equal(w.offerable, true)
  })

  it('a window that already closed is never offerable', () => {
    const w = resolveClaimWindow({
      nowMs: now,
      claimStartMs: now,
      sessionStartMs: now - HOUR,
    })
    assert.equal(w.minutesLeft, -60)
    assert.equal(w.offerable, false)
  })
})

describe('selectOfferHeads', () => {
  // Ids stand in for waitlist entries; the caller has already filtered out
  // anyone who is not waiting or who already holds a seat.
  const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  /** The contact documents that still exist. */
  const alive =
    (...ids: string[]) =>
    (c: { id: string }) =>
      ids.includes(c.id)

  it('takes the head of the queue, never more than the room available', () => {
    assert.deepEqual(selectOfferHeads(queue, 1).heads, [{ id: 'a' }])
    assert.deepEqual(selectOfferHeads(queue, 2).heads, [{ id: 'a' }, { id: 'b' }])
    // More room than waiters offers to everyone waiting and stops.
    assert.deepEqual(selectOfferHeads(queue, 10).heads, queue)
    // Nothing is dropped when every contact is still there.
    assert.deepEqual(selectOfferHeads(queue, 10).dropped, [])
  })

  it('offers nothing when there is no room — the oversell guard', () => {
    assert.deepEqual(selectOfferHeads(queue, 0).heads, [])
    assert.deepEqual(selectOfferHeads(queue, -1).heads, [])
    // Including for a pinned admin request: "Offer now" may skip the ORDER,
    // never the seat count.
    assert.deepEqual(selectOfferHeads(queue, 0, 'b').heads, [])
  })

  it('pins exactly one head, out of queue order', () => {
    assert.deepEqual(selectOfferHeads(queue, 3, 'c').heads, [{ id: 'c' }])
    // One seat of room, and the pinned person is not the front of the queue.
    assert.deepEqual(selectOfferHeads(queue, 1, 'b').heads, [{ id: 'b' }])
  })

  it('refuses a pinned head that is not a candidate', () => {
    // The caller filters out anyone already holding a seat, so an id missing
    // here means exactly that — and offering would overwrite their booking with
    // an unclaimed hold.
    assert.deepEqual(selectOfferHeads(queue, 3, 'zz').heads, [])
    assert.deepEqual(selectOfferHeads([], 3, 'a').heads, [])
  })

  it('passes OVER a dead head instead of wedging the queue behind it', () => {
    // THE regression. One seat frees (room 1) and the person at the front had
    // their contact hard-deleted — a waitlist-born provisional contact reaped by
    // purgeProvisionalContacts. Filtering after the slice made this pass select
    // the corpse, offer nothing and write nothing, so every trigger and every
    // hourly backstop re-picked it and everybody behind waited forever.
    const { heads, dropped } = selectOfferHeads(queue, 1, null, alive('b', 'c'))
    assert.deepEqual(heads, [{ id: 'b' }])
    // …and the dead entry is reported so the caller can close it out. Without
    // that it is re-read on every single pass for the life of the class.
    assert.deepEqual(dropped, [{ id: 'a' }])
  })

  it('reports every dead candidate, not just the ones in front of the head', () => {
    // The whole queue is scanned, so one pass heals the whole queue.
    const { heads, dropped } = selectOfferHeads(queue, 2, null, alive('b'))
    assert.deepEqual(heads, [{ id: 'b' }])
    assert.deepEqual(dropped, [{ id: 'a' }, { id: 'c' }])
  })

  it('still fills every free seat when a dead entry is in the way', () => {
    // Two seats, four waiters, the second of whom is gone: both seats are
    // offered. Filtering after the slice made this pass offer ONE.
    const longer = [...queue, { id: 'd' }]
    const { heads, dropped } = selectOfferHeads(longer, 2, null, alive('a', 'c', 'd'))
    assert.deepEqual(heads, [{ id: 'a' }, { id: 'c' }])
    assert.deepEqual(dropped, [{ id: 'b' }])
  })

  it('a PINNED head whose contact is gone is refused, not offered to', () => {
    // "Offer now" skips the queue order, never a safety check: writing a hold
    // for a contact that no longer exists throws inside the transaction and
    // takes every other offer in the pass down with it.
    const { heads, dropped } = selectOfferHeads(queue, 3, 'a', alive('b', 'c'))
    assert.deepEqual(heads, [])
    // The caller distinguishes "gone" from "not waiting" by this list.
    assert.deepEqual(dropped, [{ id: 'a' }])
  })
})

describe('clearedClaimHoldFields', () => {
  const ts = (ms: number) => ({ toMillis: () => ms })
  /** What a claimant who opened the pay screen and then abandoned Stripe is
   *  sitting on: the promoter's hold, rewritten by createDropInCheckout. */
  const paidClaimHold: SeatHold = {
    status: 'pending',
    waitlist_claim: true,
    claim_expires_at: ts(now + HOUR),
    payment_status: 'required',
    expires_at: ts(now + HOUR),
  }
  /** The free settle, exactly as claimWaitlistSeat writes it. */
  const settle = (hold: SeatHold): SeatHold => ({
    ...hold,
    status: 'confirmed',
    ...clearedClaimHoldFields(undefined),
  })

  it('a settled claim keeps its seat forever, whatever hold it grew out of', () => {
    const settled = settle(paidClaimHold)
    assert.equal(isUnclaimedClaimHold(settled), false)
    assert.equal(bookingHoldsSeat(settled, now), true)
    // Long past BOTH deadlines. Leaving `payment_status: 'required'` behind made
    // the recount free this seat at `expires_at`, and seatFreedEdge then handed
    // a confirmed, covered person's seat to the next in the queue.
    assert.equal(bookingHoldsSeat(settled, now + 48 * HOUR), true)
  })

  it('and is not matched by releaseExpiredBookingHolds’ delete query', () => {
    // That sweep selects on `payment_status == 'required' && expires_at <= now`
    // across the bookings collection group and HARD-deletes what it finds.
    // Either field surviving the settle destroys a confirmed booking at 02:00.
    const settled = settle(paidClaimHold)
    assert.equal(settled.payment_status, undefined)
    assert.equal(settled.expires_at, undefined)
  })

  it('clears the ordinary free hold too, where two of the four are absent', () => {
    const settled = settle({
      status: 'pending',
      waitlist_claim: true,
      claim_expires_at: ts(now + HOUR),
    })
    assert.equal(settled.waitlist_claim, undefined)
    assert.equal(settled.claim_expires_at, undefined)
    assert.equal(bookingHoldsSeat(settled, now + 48 * HOUR), true)
  })
})

describe('resolveClaimCheckoutWindow', () => {
  // Stripe's own bounds, passed in by createDropInCheckout so this stays pure.
  const bounds = { minMinutes: 31, maxMinutes: 24 * 60 }
  const sec = (ms: number) => Math.floor(ms / 1000)

  it('the Stripe session dies with the hold, never after it', () => {
    const claimExpiresAtMs = now + 2 * HOUR
    const w = resolveClaimCheckoutWindow({ nowMs: now, claimExpiresAtMs, ...bounds })
    assert.equal(w.payable, true)
    assert.equal(w.expiresAtEpochSeconds, sec(claimExpiresAtMs))
  })

  it('refuses under Stripe’s floor — the offer is about to expire', () => {
    const under = resolveClaimCheckoutWindow({
      nowMs: now,
      claimExpiresAtMs: now + 30 * MIN,
      ...bounds,
    })
    assert.equal(under.payable, false)
    // Exactly at the floor is still payable; the floor is what Stripe accepts.
    const exact = resolveClaimCheckoutWindow({
      nowMs: now,
      claimExpiresAtMs: now + 31 * MIN,
      ...bounds,
    })
    assert.equal(exact.payable, true)
  })

  it('an already-dead window is never payable', () => {
    const w = resolveClaimCheckoutWindow({ nowMs: now, claimExpiresAtMs: now - MIN, ...bounds })
    assert.equal(w.payable, false)
  })

  it('clamps DOWN at Stripe’s 24-hour ceiling, never up', () => {
    // A studio may set a claim window of three days on a class a week out.
    // Stripe rejects an expiry past 24 hours outright, and the safe direction is
    // a checkout that dies BEFORE the hold: the seat stays held either way.
    const w = resolveClaimCheckoutWindow({
      nowMs: now,
      claimExpiresAtMs: now + 72 * HOUR,
      ...bounds,
    })
    assert.equal(w.payable, true)
    assert.equal(w.expiresAtEpochSeconds, sec(now + 24 * HOUR))
  })
})

describe('nextSmsWindowOpen', () => {
  /** Local hour in Europe/Zurich, which is what the quiet-hours rule is in. */
  const zurichHour = (d: Date) =>
    Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric', hour12: false, timeZone: 'Europe/Zurich',
      }).format(d)
    )

  it('inside the window it is now — the offer is not deferred at all', () => {
    const midday = new Date(Date.UTC(2026, 5, 15, 10, 0, 0)) // 12:00 Zurich
    assert.equal(isWithinSmsSendingHours(midday), true)
    assert.equal(nextSmsWindowOpen(midday).getTime(), midday.getTime())
  })

  it('late at night the window opens at 08:00 the NEXT morning', () => {
    const lateEvening = new Date(Date.UTC(2026, 5, 15, 21, 10, 0)) // 23:10 Zurich
    assert.equal(isWithinSmsSendingHours(lateEvening), false)
    const open = nextSmsWindowOpen(lateEvening)
    assert.equal(zurichHour(open), 8)
    assert.ok(open.getTime() > lateEvening.getTime())
    // Next morning, not the one nine hours further on.
    assert.ok(open.getTime() - lateEvening.getTime() < 12 * HOUR)
  })

  it('before dawn the window opens the SAME morning', () => {
    const beforeDawn = new Date(Date.UTC(2026, 5, 15, 3, 30, 0)) // 05:30 Zurich
    const open = nextSmsWindowOpen(beforeDawn)
    assert.equal(zurichHour(open), 8)
    assert.ok(open.getTime() - beforeDawn.getTime() < 3 * HOUR)
  })

  it('rolls over a month boundary', () => {
    // 23:30 Zurich on 31 January → 08:00 on 1 February.
    const monthEnd = new Date(Date.UTC(2026, 0, 31, 22, 30, 0))
    const open = nextSmsWindowOpen(monthEnd)
    assert.equal(zurichHour(open), 8)
    assert.ok(open.getTime() > monthEnd.getTime())
    assert.ok(open.getTime() - monthEnd.getTime() < 12 * HOUR)
  })

  it('lands on 08:00 LOCAL across the DST change, not on a fixed UTC offset', () => {
    // Zurich is UTC+1 in winter and UTC+2 in summer; both must give local 08:00.
    const winterNight = new Date(Date.UTC(2026, 0, 10, 23, 0, 0))
    const summerNight = new Date(Date.UTC(2026, 6, 10, 23, 0, 0))
    assert.equal(zurichHour(nextSmsWindowOpen(winterNight)), 8)
    assert.equal(zurichHour(nextSmsWindowOpen(summerNight)), 8)
  })
})

describe('offerWasDelivered', () => {
  it('an ordinary send is a delivery', () => {
    assert.equal(offerWasDelivered({ providerMessageId: 'brevo-1' }), true)
    // Test mode still puts the mail in somebody's inbox.
    assert.equal(offerWasDelivered({ providerMessageId: 'brevo-2', testMode: true }), true)
  })

  it('a skipped send reached NOBODY — the seat has to go back', () => {
    // Suppressed address, `silent`/`allowlist` tenant policy, synthetic seed
    // recipient, MAIL_ENABLED=false: every one of these returns rather than
    // throwing, which is exactly how the offer used to vanish in silence.
    assert.equal(offerWasDelivered({ skipped: true }), false)
    assert.equal(offerWasDelivered({ skipped: true, testMode: true }), false)
  })

  it('a skipped send WITH a provider id is the one that already went out', () => {
    // The idempotency ledger reporting a redelivery of the same keyed send.
    // Releasing this seat would take it off somebody holding a live claim link.
    assert.equal(offerWasDelivered({ skipped: true, providerMessageId: 'brevo-3' }), true)
  })
})

describe('isSessionCancelled', () => {
  it('recognizes the standalone cancellation', () => {
    assert.equal(isSessionCancelled({ status: 'cancelled' }), true)
  })

  it('recognizes a canceled OCCURRENCE of a series, which carries no status', () => {
    // cancelSession's `markAsException` branch: allowBooking and status are left
    // exactly as they were, so a status-only test reads this class as bookable.
    assert.equal(isSessionCancelled({ isException: true, exceptionType: 'cancelled' }), true)
  })

  it('leaves a MODIFIED occurrence alone — it still runs', () => {
    assert.equal(isSessionCancelled({ isException: true, exceptionType: 'modified' }), false)
  })

  it('an ordinary session is not canceled', () => {
    assert.equal(isSessionCancelled({}), false)
    assert.equal(isSessionCancelled({ status: 'confirmed', isException: false }), false)
    // The exception flag alone means nothing without the type.
    assert.equal(isSessionCancelled({ isException: true }), false)
  })
})
