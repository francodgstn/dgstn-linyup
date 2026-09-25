import assert from 'node:assert/strict'
import {
  GUEST_SNAPSHOT,
  PROMO_MAX_LIVE_RESERVATIONS,
  resolvePaymentOptions,
  type ContactPaymentSnapshot,
  type PaymentOptionsResult,
  type PaymentTarget,
  type PromoCode,
  type PromoReservation,
} from '@linyup/shared'
import {
  decidePromoCommit,
  decidePromoRelease,
  decidePromoReservation,
  decidePromoSessionAttach,
  instrumentKeyParts,
  promoCallerFrom,
  promoCallerNotAsked,
  promoCheckoutMetadata,
  promoPerIdentityCapExceeded,
  type PromoReservationTicket,
} from './promoCodes'
import { defaultIdempotencyKey } from './checkout'
import { decideAppointmentCheckoutRollback } from '../appointments/checkout'
import { decideAppointmentHoldRelease } from '../appointments/holdRelease'

// Unit tests for the promo RESERVATION LIFECYCLE decisions — the functions-side
// pure halves (promoCode.test.ts covers the shared predicates). Everything here
// is a consequence of ONE design choice, the deterministic reservation key, and
// each block pins a bug that the key made reachable:
//
//   1. the key is minted as soon as a code LOADS, so "a modifier exists" is not
//      the same fact as "a reservation exists";
//   2. the key is shared by every attempt at one purchase, so "delete the entry
//      at this key" is an operation every sibling can perform on every other;
//   3. the appointment session id is deterministic and shared for the same
//      reason, so a loser's rollback can reach a winner's document.
//
// Run with: pnpm --filter @linyup/functions test

const NOW = 1_700_000_000_000
const ts = (ms: number) => ({ toMillis: () => ms }) as never

const CODE = 'AUTUMN25'
const KEY = 'rk_deterministic'
const PROMO_MAX_LIVE = PROMO_MAX_LIVE_RESERVATIONS
/** An attempt's own claim deadline — the instant its Checkout Session was
 *  bounded by, plus the margin. `NOW` is INSIDE it. */
const DEADLINE = NOW + 60_000

function contact(overrides: Partial<ContactPaymentSnapshot> = {}): ContactPaymentSnapshot {
  return {
    authenticated: true,
    joined: true,
    heldUnmeteredTypeIds: [],
    heldCreditTypes: [],
    ...overrides,
  }
}

function reservation(over: Partial<PromoReservation> = {}): PromoReservation {
  return {
    contactId: 'c1',
    identityKey: 'e_aaa',
    instanceId: 'inst_1',
    expires_at: ts(NOW + 60_000),
    amountMajor: 18.75,
    baseAmount: 25,
    targetKey: 'drop_in:s1',
    ...over,
  }
}

function code(over: Partial<PromoCode> = {}): PromoCode {
  return {
    code: CODE,
    teamId: 't1',
    status: 'active',
    effect: 'percent_off',
    percent: 25,
    max_uses: null,
    usage_count: 0,
    applies_to: ['drop_in', 'appointment', 'course', 'product'],
    ...over,
  }
}

const ticket = (over: Partial<PromoReservationTicket> = {}): PromoReservationTicket => ({
  code: CODE,
  reservationKey: KEY,
  identityKey: 'e_aaa',
  instanceId: 'inst_1',
  expiresAtMs: DEADLINE,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────

describe('promoCheckoutMetadata — stamped IFF a reservation was taken', () => {
  /** EXACTLY what every checkout callable does between Stage A and the reserve:
   *  the resolver's verdict — not "a modifier was built" — decides whether a
   *  reservation is taken, and therefore whether a ticket exists at all. */
  function reserveIfWon(
    result: PaymentOptionsResult,
    minted: PromoReservationTicket
  ): PromoReservationTicket | null {
    return result.promo?.status === 'applied' ? minted : null
  }

  const dropIn = (over: Partial<Extract<PaymentTarget, { kind: 'drop_in' }>> = {}): PaymentTarget => ({
    kind: 'drop_in',
    accessRule: { type: 'subscription', subscriptionTypeIds: ['gold'] },
    dropIn: { enabled: true, priceAmount: 25 },
    ...over,
  })
  const promoCtx = { promo: { code: CODE, effect: 'percent_off' as const, percent: 25 } }

  it('a WINNING code stamps all six keys, and the amount is the post-promo one', () => {
    const priced = resolvePaymentOptions(GUEST_SNAPSHOT, dropIn(), promoCtx)
    assert.equal(priced.promo?.status, 'applied')
    const held = reserveIfWon(priced, ticket())
    assert.ok(held)
    // promoInstance + promoExpires are the two halves of SLOT OWNERSHIP: which
    // attempt this session is, and when its claim was due to lapse. The webhook
    // has nothing else to reason from, and without both it cannot tell a late
    // delivery of a payment it owned from a slot a sibling already spent.
    assert.deepEqual(promoCheckoutMetadata(held, 18.75), {
      promoCode: CODE,
      promoReservation: KEY,
      promoIdentity: 'e_aaa',
      promoInstance: 'inst_1',
      promoExpires: String(DEADLINE),
      promoAmount: '18.75',
    })
  })

  it('THE SUPERSEDED CASE: a member whose own benefit beats the code types it anyway', () => {
    // A 50%-off member benefit against a 25%-off public code, on a 25.00 drop-in.
    // The code is valid, in window, in scope — it simply LOSES best-one-wins.
    const priced = resolvePaymentOptions(
      contact({ heldUnmeteredTypeIds: ['silver'] }),
      dropIn({
        benefit: { subscriptionTypeIds: ['silver'], effect: 'percent_off', percent: 50 },
      }),
      promoCtx
    )
    assert.deepEqual(priced.promo, { code: CODE, status: 'superseded', by: 'benefit' })

    // Nothing was reserved, so nothing may be stamped. Stamping here is what
    // made the webhook commit a reservation that never existed: a global use
    // consumed and this member's one allowed use of the campaign permanently
    // burned, for a discount they were never given.
    const held = reserveIfWon(priced, ticket())
    assert.equal(held, null)
    assert.deepEqual(promoCheckoutMetadata(held, 12.5), {})
  })

  it('superseded BY BASE (a fixed_price above list) stamps nothing either', () => {
    const priced = resolvePaymentOptions(GUEST_SNAPSHOT, dropIn(), {
      promo: { code: CODE, effect: 'fixed_price', amount: 30 },
    })
    assert.deepEqual(priced.promo, { code: CODE, status: 'superseded', by: 'base' })
    assert.deepEqual(promoCheckoutMetadata(reserveIfWon(priced, ticket()), 25), {})
  })

  it('an arm that takes no promo at all (class_booking) stamps nothing', () => {
    const priced = resolvePaymentOptions(
      GUEST_SNAPSHOT,
      { kind: 'class_booking', accessRule: { type: 'open' } },
      promoCtx
    )
    assert.notEqual(priced.promo?.status, 'applied')
    assert.deepEqual(promoCheckoutMetadata(reserveIfWon(priced, ticket()), 0), {})
  })

  it('a plain checkout (no code at all) leaves the payload byte-identical', () => {
    assert.deepEqual(promoCheckoutMetadata(null, 25), {})
  })
})

describe('decidePromoRelease — removed only by the instance that wrote it', () => {
  const held = { reservations: { [KEY]: reservation({ instanceId: 'inst_1' }) } }

  it('the owner releases its own entry', () => {
    const out = decidePromoRelease({
      promo: held,
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
    })
    assert.deepEqual(out, { reservations: {} })
  })

  it('A STALE SIBLING IS A NO-OP — the cap must never be exceeded', () => {
    // Attempt A reserved (inst_1), attempt B refreshed the SAME deterministic key
    // (inst_2) and its Stripe session is still payable. A's session then expires
    // and the webhook releases. Without the instance check this deletes B's
    // guard, the slot goes unreserved while B can still be paid, and the code can
    // be taken past max_uses — which Q9 forbids outright.
    const afterRefresh = { reservations: { [KEY]: reservation({ instanceId: 'inst_2' }) } }
    assert.equal(
      decidePromoRelease({
        promo: afterRefresh,
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_1',
      }),
      null
    )
    // …and B can still release its own.
    assert.deepEqual(
      decidePromoRelease({
        promo: afterRefresh,
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_2',
      }),
      { reservations: {} }
    )
  })

  it('a caller with no instance owns nothing', () => {
    assert.equal(
      decidePromoRelease({ promo: held, nowMs: NOW, reservationKey: KEY, instanceId: null }),
      null
    )
  })

  it('a missing key, and an already-expired entry, are both no-ops', () => {
    assert.equal(
      decidePromoRelease({ promo: held, nowMs: NOW, reservationKey: 'other', instanceId: 'inst_1' }),
      null
    )
    const stale = { reservations: { [KEY]: reservation({ expires_at: ts(NOW - 1) }) } }
    assert.equal(
      decidePromoRelease({ promo: stale, nowMs: NOW, reservationKey: KEY, instanceId: 'inst_1' }),
      null
    )
  })

  it('releasing OTHER live entries is untouched — only the named key moves', () => {
    const many = {
      reservations: {
        [KEY]: reservation({ instanceId: 'inst_1' }),
        other: reservation({ identityKey: 'e_bbb', instanceId: 'inst_9' }),
      },
    }
    const out = decidePromoRelease({
      promo: many,
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
    })
    assert.deepEqual(Object.keys(out!.reservations), ['other'])
  })
})

describe('the retry is STILL a refresh — the deterministic key survives the fix', () => {
  const base = {
    teamId: 't1',
    nowMs: NOW,
    scope: { kind: 'drop_in' as const, activityId: 'a1' },
    caller: { contactId: 'c1', email: 'a@b.c', joined: false },
    identityKey: 'e_aaa',
    reservationKey: KEY,
    perIdentityCommitted: 0,
    expectedSessionId: null,
  }

  it('a second attempt at the same purchase REFRESHES and consumes nothing, even at max_uses 1', () => {
    // The whole point of the deterministic key: her own live-but-unpaid
    // reservation must not refuse her permission to pay for it.
    const promo = code({
      max_uses: 1,
      max_uses_per_contact: 1,
      reservations: { [KEY]: reservation({ instanceId: 'inst_1' }) },
    })
    const decision = decidePromoReservation({
      ...base,
      promo,
      reservation: reservation({ instanceId: 'inst_2' }),
    })
    assert.equal(decision.kind, 'refresh')
    assert.deepEqual(Object.keys((decision as { reservations: object }).reservations), [KEY])
  })

  it('the refresh MOVES OWNERSHIP: the newest attempt holds the slot', () => {
    const promo = code({ reservations: { [KEY]: reservation({ instanceId: 'inst_1' }) } })
    const decision = decidePromoReservation({
      ...base,
      promo,
      reservation: reservation({ instanceId: 'inst_2' }),
    })
    const after = (decision as { reservations: Record<string, PromoReservation> }).reservations
    assert.equal(after[KEY].instanceId, 'inst_2')
    // The older attempt's release is now a no-op against the refreshed entry.
    assert.equal(
      decidePromoRelease({
        promo: { reservations: after },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_1',
      }),
      null
    )
  })
})

describe('ONE SLOT BACKS AT MOST ONE PAYABLE SESSION', () => {
  // THE DEFECT THIS BLOCK PINS, and it is the one the ownership rules could not
  // reach on their own. `decidePromoCommit` bounds how many COUNTED uses a slot
  // yields; it runs after the money has moved, so it cannot bound how many
  // DISCOUNTED ORDERS a slot yields. Every retry mints a new Checkout Session
  // against the same entry, Stripe takes money for any session that has not
  // expired, and on the product and course rails a second payment is a second
  // genuine order rather than a duplicate the webhook refunds. So the bound has
  // to sit on the session: the slot names the one session that may be paid, a
  // refresh CLOSES that session before writing anything, and a session that
  // cannot be bound is closed instead of being handed to the buyer.

  const base = {
    teamId: 't1',
    nowMs: NOW,
    scope: { kind: 'product' as const, productId: 'p1' },
    caller: { contactId: 'c1', email: 'a@b.c', joined: false },
    identityKey: 'e_aaa',
    reservationKey: KEY,
    perIdentityCommitted: 0,
  }

  it('a refresh may only proceed against the session it has already closed', () => {
    // The compare-and-set. The close is a network call and therefore outside the
    // transaction, so a sibling can bind a session in between — and refreshing
    // over that leaves TWO payable sessions on one slot.
    const held = { [KEY]: reservation({ instanceId: 'inst_1', sessionId: 'cs_A' }) }

    // We read cs_A, closed cs_A, and cs_A is still what the entry names.
    const ok = decidePromoReservation({
      ...base,
      promo: code({ max_uses: 1, reservations: held }),
      expectedSessionId: 'cs_A',
      reservation: reservation({ instanceId: 'inst_2', sessionId: null }),
    })
    assert.equal(ok.kind, 'refresh')
    assert.equal((ok as { reservations: Record<string, PromoReservation> }).reservations[KEY].sessionId, null)

    // A sibling bound cs_B after our read. We closed cs_A, not cs_B.
    assert.deepEqual(
      decidePromoReservation({
        ...base,
        promo: code({ max_uses: 1, reservations: { [KEY]: reservation({ sessionId: 'cs_B' }) } }),
        expectedSessionId: 'cs_A',
        reservation: reservation({ instanceId: 'inst_2', sessionId: null }),
      }),
      { kind: 'refuse', reason: 'promo_busy' }
    )

    // …and the mirror: we found no session bound, but a sibling has since bound
    // one. Also refused, rather than silently superseding a payable session.
    assert.deepEqual(
      decidePromoReservation({
        ...base,
        promo: code({ max_uses: 1, reservations: { [KEY]: reservation({ sessionId: 'cs_B' }) } }),
        expectedSessionId: null,
        reservation: reservation({ instanceId: 'inst_2', sessionId: null }),
      }),
      { kind: 'refuse', reason: 'promo_busy' }
    )
  })

  it('a mid-flight sibling (reserved, no session yet) can be taken over', () => {
    // Sub-second window, and it is safe BECAUSE the sibling's own bind is
    // instance-guarded: when it finally creates its session the attach fails and
    // that session is closed before any URL is returned.
    const d = decidePromoReservation({
      ...base,
      promo: code({ max_uses: 1, reservations: { [KEY]: reservation({ sessionId: null }) } }),
      expectedSessionId: null,
      reservation: reservation({ instanceId: 'inst_2', sessionId: null }),
    })
    assert.equal(d.kind, 'refresh')
  })

  it('N CONCURRENT PRODUCT SESSIONS: only one can ever be payable at a time', () => {
    // Four attempts at one product purchase. Walked as the code actually runs —
    // read, close, transact, bind — so the property under test is "how many
    // sessions are payable at once", not "how many uses were counted".
    let entry: PromoReservation | null = null
    const payable = new Set<string>()

    for (const [i, instanceId] of ['inst_1', 'inst_2', 'inst_3', 'inst_4'].entries()) {
      const sessionId = `cs_${i}`
      // 1. Read + close whatever the slot is backing (Stripe: 'closed').
      const expectedSessionId = entry?.sessionId ?? null
      if (expectedSessionId) payable.delete(expectedSessionId)
      // 2. Reserve.
      const d = decidePromoReservation({
        ...base,
        promo: code({ max_uses: 1, reservations: entry ? { [KEY]: entry } : {} }),
        expectedSessionId,
        reservation: reservation({ instanceId, sessionId: null }),
      })
      assert.notEqual(d.kind, 'refuse')
      entry = (d as { reservations: Record<string, PromoReservation> }).reservations[KEY]
      // 3. Create the session, then bind it.
      const bound = decidePromoSessionAttach({
        promo: { reservations: { [KEY]: entry } },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId,
        sessionId,
      })
      assert.ok(bound, 'our own fresh reservation must always bind')
      entry = bound!.reservations[KEY]
      payable.add(sessionId)
      assert.equal(payable.size, 1, `after attempt ${i + 1} exactly one session may be paid`)
    }

    // And the survivor is the newest one, which is the only one that can commit.
    assert.deepEqual([...payable], ['cs_3'])
    assert.equal(entry!.instanceId, 'inst_4')
  })

  it('a bind against a slot that moved on returns null — the session must be closed instead', () => {
    // The one ordering the compare-and-set cannot catch: a sibling was already
    // mid-flight when we took the entry, and only discovers it at bind time.
    assert.equal(
      decidePromoSessionAttach({
        promo: { reservations: { [KEY]: reservation({ instanceId: 'inst_2' }) } },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_1',
        sessionId: 'cs_late',
      }),
      null
    )
    // …and the same when the slot is simply gone (lazy expiry, manager lever).
    assert.equal(
      decidePromoSessionAttach({
        promo: { reservations: {} },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_1',
        sessionId: 'cs_late',
      }),
      null
    )
  })

  it('binding never disturbs anything else on the document', () => {
    const other = reservation({ identityKey: 'e_bbb', instanceId: 'inst_x', sessionId: 'cs_x' })
    const out = decidePromoSessionAttach({
      promo: { reservations: { [KEY]: reservation({ instanceId: 'inst_1' }), other } },
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      sessionId: 'cs_mine',
    })
    assert.equal(out!.reservations[KEY].sessionId, 'cs_mine')
    assert.deepEqual(out!.reservations.other, other)
  })

  it('an EXPIRED entry is not ours to bind, whatever the instance says', () => {
    assert.equal(
      decidePromoSessionAttach({
        promo: { reservations: { [KEY]: reservation({ expires_at: ts(NOW - 1) }) } },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_1',
        sessionId: 'cs_1',
      }),
      null
    )
  })
})

describe('decidePromoCommit — ONE SLOT IS SPENT ONCE, whatever the ordering', () => {
  // THE DEFECT THIS BLOCK PINS. The reservation key is deterministic, so a retry
  // refreshes the same entry — but each retry also mints a NEW Checkout Session,
  // and Stripe will take money for any session that has not expired. On the
  // product and course rails a second payment is not a duplicate to refund, it is
  // a second genuine order. So one identity, holding ONE reservation, used to
  // commit a use per completed session: `usage_count` and `PromoRedemption.count`
  // both sailed past their caps with nothing failing anywhere. Q9 is REFUSE,
  // NEVER OVER-ISSUE, so the slot is now a single-use claim spent here.

  it('the owner SPENDS the slot: counts, and clears its entry', () => {
    const out = decidePromoCommit({
      promo: code({ usage_count: 4, reservations: { [KEY]: reservation() } }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(out.counted, true)
    assert.equal(out.lostTo, null)
    assert.equal(out.usageCount, 5)
    assert.equal(out.reservationFound, true)
    assert.equal(out.reservationOwned, true)
    assert.deepEqual(out.reservations, {})
    assert.equal(out.identityKey, 'e_aaa')
  })

  it('A SUPERSEDED SIBLING COUNTS NOTHING, and leaves the newer reservation standing', () => {
    // Attempt B refreshed the entry and its session is still payable. A's session
    // is paid: the money is recorded by the rail, but the slot is B's, so no use
    // is consumed and B's guard is not touched. Counting here is precisely how
    // one reservation used to back two discounted orders.
    const out = decidePromoCommit({
      promo: code({
        usage_count: 4,
        reservations: { [KEY]: reservation({ instanceId: 'inst_2' }) },
      }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(out.counted, false)
    assert.equal(out.lostTo, 'not_ours')
    assert.equal(out.usageCount, null)
    assert.equal(out.overCap, false)
    assert.equal(out.reservationFound, true)
    assert.equal(out.reservationOwned, false)
    assert.deepEqual(Object.keys(out.reservations), [KEY])
  })

  it('THE OTHER ORDERING: the owner already spent the slot, so the sibling finds nothing — and still counts nothing', () => {
    // The hole an ownership check alone leaves open. If B (the owner) is paid
    // first it deletes the entry; A then arrives to an EMPTY map, which used to
    // read as "a late delivery" and counted a second use. Inside A's own claim
    // window an absent entry means the slot was taken, not that it lapsed.
    const out = decidePromoCommit({
      promo: code({ usage_count: 5, reservations: {} }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(out.counted, false)
    assert.equal(out.lostTo, 'removed_early')
    assert.equal(out.usageCount, null)
  })

  it('N CONCURRENT SESSIONS COMMIT EXACTLY ONE USE — in either order', () => {
    // Four attempts at one purchase (Back button, double-click, dropped
    // redirect, changed card). The entry carries the newest instance; the buyer
    // pays every one of the four sessions.
    const instances = ['inst_1', 'inst_2', 'inst_3', 'inst_4']
    const held = { [KEY]: reservation({ instanceId: 'inst_4' }) }

    const spend = (order: string[]) => {
      let usage = 0
      let reservations: Record<string, PromoReservation> = { ...held }
      for (const instanceId of order) {
        const out = decidePromoCommit({
          promo: code({ usage_count: usage, max_uses: 1, reservations }),
          nowMs: NOW,
          reservationKey: KEY,
          instanceId,
          reservationExpiresMs: DEADLINE,
        })
        if (out.counted) {
          usage = out.usageCount!
          reservations = out.reservations
        }
        assert.equal(out.overCap, false, `${instanceId} must never count past max_uses 1`)
      }
      return usage
    }

    assert.equal(spend(instances), 1) // oldest paid first
    assert.equal(spend([...instances].reverse()), 1) // owner paid first
    assert.equal(spend(['inst_2', 'inst_4', 'inst_1', 'inst_3']), 1) // interleaved
  })

  it('a genuinely LATE delivery (our own claim had lapsed) still counts, off the fallbacks', () => {
    // Stripe cannot take money for an expired session, so a payment whose
    // delivery lands after OUR deadline was made while the slot was ours — only
    // the webhook was late. Under-reporting that is the wrong direction.
    const out = decidePromoCommit({
      promo: code({ usage_count: 0 }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: NOW - 1,
      fallbackIdentityKey: 'e_zzz',
      fallbackContactId: 'c9',
      fallbackAmountMajor: 18.75,
    })
    assert.equal(out.counted, true)
    assert.equal(out.lostTo, null)
    assert.equal(out.usageCount, 1)
    assert.equal(out.reservationFound, false)
    assert.equal(out.reservationOwned, false)
    assert.equal(out.identityKey, 'e_zzz')
    assert.equal(out.amountMajor, 18.75)
  })

  it('a session that can prove no instance owns nothing, even with a live entry', () => {
    const out = decidePromoCommit({
      promo: code({ reservations: { [KEY]: reservation() } }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: null,
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(out.counted, false)
    assert.equal(out.lostTo, 'not_ours')
  })
})

describe('the retry that PAYS spends exactly one use — the two halves together', () => {
  // The retry property and the cap invariant are the two things that must hold
  // AT THE SAME TIME, so this walks the whole path rather than either half.
  const base = {
    teamId: 't1',
    nowMs: NOW,
    scope: { kind: 'drop_in' as const, activityId: 'a1' },
    caller: { contactId: 'c1', email: 'a@b.c', joined: false },
    identityKey: 'e_aaa',
    reservationKey: KEY,
    perIdentityCommitted: 0,
    expectedSessionId: null,
  }

  it('reserve → retry (refresh, nothing consumed) → pay once → exactly one use', () => {
    const promo = code({ max_uses: 1, max_uses_per_contact: 1 })

    // 1. First attempt takes the slot.
    const first = decidePromoReservation({
      ...base,
      promo,
      reservation: reservation({ instanceId: 'inst_1' }),
    })
    assert.equal(first.kind, 'take')

    // 2. The Back button. Her own live-but-unpaid reservation must not refuse
    //    her at max_uses 1 — this is the property the deterministic key exists
    //    for, and it is untouched by the commit rule.
    const retry = decidePromoReservation({
      ...base,
      promo: {
        ...promo,
        reservations: (first as { reservations: Record<string, PromoReservation> }).reservations,
      },
      reservation: reservation({ instanceId: 'inst_2' }),
    })
    assert.equal(retry.kind, 'refresh')
    const afterRetry = (retry as { reservations: Record<string, PromoReservation> }).reservations
    assert.equal(Object.keys(afterRetry).length, 1)
    assert.equal(afterRetry[KEY].instanceId, 'inst_2')

    // 3. She pays the second session. One use, and the slot is released.
    const paid = decidePromoCommit({
      promo: { ...promo, reservations: afterRetry },
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_2',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(paid.counted, true)
    assert.equal(paid.usageCount, 1)
    assert.deepEqual(paid.reservations, {})

    // 4. …and the abandoned first session, paid or expired afterwards, adds
    //    nothing to either counter.
    const stale = decidePromoCommit({
      promo: { ...promo, usage_count: 1, reservations: paid.reservations },
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(stale.counted, false)
    assert.equal(stale.usageCount, null)
  })
})

describe('the LATE WEBHOOK, both ways round — and the cap that survives it', () => {
  // The hole the lease could not close, and why the counters are now bounded by
  // a gate rather than by a timer. Stripe retries webhook delivery over HOURS;
  // a reservation lease is measured in minutes. So a session PAID one second
  // before its expiry can have its `checkout.session.completed` land long after
  // the slot lapsed — by which time the slot may have been handed to somebody
  // else, and counted for them.
  const base = {
    teamId: 't1',
    nowMs: NOW,
    scope: { kind: 'drop_in' as const, activityId: 'a1' },
    caller: { contactId: 'c1', email: 'a@b.c', joined: false },
    identityKey: 'e_aaa',
    reservationKey: KEY,
    perIdentityCommitted: 0,
    expectedSessionId: null,
  }

  it('LATE, and nobody took the slot: the payment counts — it was ours when it was made', () => {
    // Stripe cannot take money for an EXPIRED session, so a delivery after our
    // own deadline is a late delivery of a payment made while the session was
    // open. With one payable session per slot, that session was the slot's.
    const out = decidePromoCommit({
      promo: code({ max_uses: 5, usage_count: 0, reservations: {} }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: NOW - 90 * 60_000, // an hour and a half stale
      fallbackIdentityKey: 'e_aaa',
    })
    assert.equal(out.counted, true)
    assert.equal(out.usageCount, 1)
  })

  it('LATE, and the lapsed slot was RE-HANDED and spent: the cap gate refuses the second count', () => {
    // Buyer A pays at expiry−1s. The slot lapses on its backstop, buyer B takes
    // it and pays, and B's commit fills the last use. A's delivery finally
    // arrives. Under the old rule this row counted unconditionally and
    // usage_count went to max_uses + 1 — a cap that reports breaches instead of
    // preventing them. Now it is refused.
    const afterB = code({ max_uses: 1, usage_count: 1, reservations: {} })
    const late = decidePromoCommit({
      promo: afterB,
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_A',
      reservationExpiresMs: NOW - 90 * 60_000,
      fallbackIdentityKey: 'e_aaa',
    })
    assert.equal(late.overCap, true)
    assert.equal(late.counted, false)
    assert.equal(late.usageCount, null)
    // The honest residual, pinned so it cannot be quietly re-described: A was
    // charged the discounted price and keeps the purchase. The COUNTER is what
    // is bounded — never the number of discounts a pathological ordering gave.
    assert.equal(afterB.usage_count, 1)
    // AND THE CAP GATE IS THE RESIDUAL'S ONLY LOG. `lostTo` is null here by
    // construction — the entry is absent AND our own deadline has passed, which
    // is exactly the case that counts — so a doc or comment claiming this
    // ordering is "logged at ERROR at both ends" is false. It was, and this
    // fixture is what stops it coming back.
    assert.equal(late.lostTo, null)
  })

  it('the residual is one extra discount PER OCCURRENCE, not one per campaign', () => {
    // Pinned because "by one" reads like a per-campaign bound and is not one. A
    // lapsed straggler leaves NO mark on usage_count, so its slot is genuinely
    // re-handed and the same shape can repeat — here twice on one 1-use code,
    // and nothing in the mechanism stops a third.
    //
    // What bounds the blast radius is outside this function: the same late event
    // carries the sale's own confirmation, so a delivery regime bad enough to
    // multiply this is one where nothing else is confirming either.
    const promo = code({ max_uses: 1, usage_count: 1, reservations: {} })
    const stragglers = ['inst_A', 'inst_B'].map((instanceId) =>
      decidePromoCommit({
        promo,
        nowMs: NOW,
        reservationKey: KEY,
        instanceId,
        reservationExpiresMs: NOW - 90 * 60_000,
        fallbackIdentityKey: 'e_aaa',
      })
    )
    for (const s of stragglers) {
      assert.equal(s.overCap, true)
      assert.equal(s.counted, false)
      assert.equal(s.lostTo, null)
    }
    // Two ERROR lines, two discounts given, ONE use counted. The counter never
    // moved, which is the half that is bounded hard.
    assert.equal(promo.usage_count, 1)
  })

  it('the manager lever, with a commit already in flight: the sale is recorded, the use is not', () => {
    // releasePromoReservations clears every live entry — the one deliberate
    // exemption from the ownership rule, because a manager clearing a stuck code
    // is an operation no instance owns. A checkout that was holding one of those
    // slots and then pays INSIDE its own window finds nothing at its key, and
    // must not count: the manager has just handed those slots to other buyers.
    const out = decidePromoCommit({
      promo: code({ max_uses: 1, usage_count: 0, reservations: {} }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE, // still inside our own window
    })
    assert.equal(out.counted, false)
    assert.equal(out.lostTo, 'removed_early')
    assert.equal(out.overCap, false)
  })

  it('TWO concurrent redemptions at max_uses 1: the second is refused, in either order', () => {
    // Serialization does the work — both transactions read and write promoRef,
    // so the loser re-reads and sees the winner's entry. This pins the predicate
    // that decides it, which is the half a fixture can reach.
    const first = decidePromoReservation({
      ...base,
      promo: code({ max_uses: 1 }),
      reservation: reservation({ instanceId: 'inst_1', sessionId: null }),
    })
    assert.equal(first.kind, 'take')
    const held = (first as { reservations: Record<string, PromoReservation> }).reservations

    // A DIFFERENT person: different identity ⇒ different reservation key, so
    // this is a second claimant rather than a refresh.
    const second = decidePromoReservation({
      ...base,
      identityKey: 'e_bbb',
      reservationKey: 'rk_other',
      caller: { contactId: 'c2', email: 'b@b.c', joined: false },
      promo: code({ max_uses: 1, reservations: held }),
      reservation: reservation({ identityKey: 'e_bbb', instanceId: 'inst_2', sessionId: null }),
    })
    assert.deepEqual(second, { kind: 'refuse', reason: 'promo_exhausted' })

    // …and once the winner PAYS, the cap is spent rather than merely reserved,
    // so the refusal survives the reservation going away.
    const paid = decidePromoCommit({
      promo: code({ max_uses: 1, reservations: held }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(paid.usageCount, 1)
    assert.deepEqual(
      decidePromoReservation({
        ...base,
        identityKey: 'e_bbb',
        reservationKey: 'rk_other',
        caller: { contactId: 'c2', email: 'b@b.c', joined: false },
        promo: code({ max_uses: 1, usage_count: 1, reservations: paid.reservations }),
        reservation: reservation({ identityKey: 'e_bbb', instanceId: 'inst_2', sessionId: null }),
      }),
      { kind: 'refuse', reason: 'promo_exhausted' }
    )
  })
})

describe('decidePromoReservation — the WHOLE cap decision, one read set', () => {
  const base = {
    teamId: 't1',
    nowMs: NOW,
    scope: { kind: 'drop_in' as const, activityId: 'a1' },
    caller: { contactId: 'c1', email: 'a@b.c', joined: false },
    identityKey: 'e_aaa',
    reservationKey: KEY,
    perIdentityCommitted: 0,
    /** No session was bound when this caller read the document — the ordinary
     *  first attempt. The refresh block below varies it. */
    expectedSessionId: null,
    reservation: reservation({ instanceId: 'inst_new' }),
  }
  const refuse = (d: ReturnType<typeof decidePromoReservation>) =>
    d.kind === 'refuse' ? d.reason : d.kind
  const taken = (d: ReturnType<typeof decidePromoReservation>) =>
    d.kind === 'refuse' ? null : d.reservations

  it('the happy path TAKES, and the written map carries our entry', () => {
    const d = decidePromoReservation({ ...base, promo: code({ max_uses: 50 }) })
    assert.equal(d.kind, 'take')
    assert.deepEqual(Object.keys(taken(d)!), [KEY])
    assert.equal(taken(d)![KEY].instanceId, 'inst_new')
  })

  it('the EXISTENCE ladder: missing, another team, disabled, outside the window', () => {
    assert.equal(refuse(decidePromoReservation({ ...base, promo: null })), 'promo_not_found')
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ teamId: 'other' }) })),
      'promo_not_found'
    )
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ status: 'disabled' }) })),
      'promo_inactive'
    )
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ valid_until: ts(NOW - 1) }) })),
      'promo_expired'
    )
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ valid_from: ts(NOW + 1) }) })),
      'promo_expired'
    )
  })

  it('the IDENTITY gates keep their asymmetry inside the transaction too', () => {
    // A binding maps out as promo_not_found — "this code is not yours" confirms
    // the code is real to whoever guessed it. An audience mismatch names itself.
    assert.equal(
      refuse(
        decidePromoReservation({ ...base, promo: code({ restrict_to_contact_id: 'somebody' }) })
      ),
      'promo_not_found'
    )
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ audience: 'new_contacts' }) })),
      'take'
    )
    assert.equal(
      refuse(
        decidePromoReservation({
          ...base,
          caller: { contactId: 'c1', email: 'a@b.c', joined: true },
          promo: code({ audience: 'new_contacts' }),
        })
      ),
      'promo_audience_mismatch'
    )
  })

  it('the transaction RE-VALIDATES scope and currency from its own read set', () => {
    // Unreachable in normal flow (an inapplicable code never produces a modifier
    // and is never reserved) — this is the tripwire for a definition edited
    // between the loader's read and this one.
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ applies_to: ['course'] }) })),
      'promo_not_applicable'
    )
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ activity_ids: ['a9'] }) })),
      'promo_not_applicable'
    )
    assert.equal(
      refuse(
        decidePromoReservation({
          ...base,
          chargeCurrency: 'EUR',
          promo: code({ effect: 'fixed_price', amount: 19, currency: 'CHF' }),
        })
      ),
      'promo_currency_mismatch'
    )
    // percent_off has no currency, so no guard — the tripwire is fixed_price-only.
    assert.equal(
      refuse(decidePromoReservation({ ...base, chargeCurrency: 'EUR', promo: code() })),
      'take'
    )
  })

  it('REFRESH IS CHECKED FIRST — before BOTH caps and before the busy ceiling', () => {
    // The ordering is the whole correctness argument: a purchase already in
    // flight must never be refused by the reservation it is itself holding, and
    // an exhausted-looking code is exhausted BECAUSE of that reservation.
    const others = Object.fromEntries(
      Array.from({ length: PROMO_MAX_LIVE - 1 }, (_, i) => [
        `other_${i}`,
        reservation({ identityKey: `e_${i}`, instanceId: `inst_o${i}` }),
      ])
    )
    const d = decidePromoReservation({
      ...base,
      promo: code({
        max_uses: 1,
        usage_count: 1,
        max_uses_per_contact: 1,
        reservations: { ...others, [KEY]: reservation({ instanceId: 'inst_1' }) },
      }),
      perIdentityCommitted: 5,
    })
    assert.equal(d.kind, 'refresh')
  })

  it('the GLOBAL cap counts committed AND live — refuse, never over-issue', () => {
    // Q9. Two paid + one in checkout against max_uses 3 leaves nothing.
    assert.equal(
      refuse(
        decidePromoReservation({
          ...base,
          promo: code({
            max_uses: 3,
            usage_count: 2,
            reservations: { someone_else: reservation({ identityKey: 'e_bbb' }) },
          }),
        })
      ),
      'promo_exhausted'
    )
    // …and one fewer paid still fits.
    assert.equal(
      refuse(
        decidePromoReservation({
          ...base,
          promo: code({
            max_uses: 3,
            usage_count: 1,
            reservations: { someone_else: reservation({ identityKey: 'e_bbb' }) },
          }),
        })
      ),
      'take'
    )
  })

  it('an EXPIRED live entry frees its slot inside this very transaction', () => {
    const d = decidePromoReservation({
      ...base,
      promo: code({
        max_uses: 1,
        reservations: {
          lapsed: reservation({ identityKey: 'e_bbb', expires_at: ts(NOW - 1) }),
        },
      }),
    })
    assert.equal(d.kind, 'take')
    // …and the lapsed entry is dropped by the write, not merely ignored.
    assert.deepEqual(Object.keys(taken(d)!), [KEY])
  })

  it('the BUSY ceiling is a different sentence from exhausted, and fires first', () => {
    const many = Object.fromEntries(
      Array.from({ length: PROMO_MAX_LIVE }, (_, i) => [
        `other_${i}`,
        reservation({ identityKey: `e_${i}`, instanceId: `inst_o${i}` }),
      ])
    )
    // Uncapped, so the global arm cannot be what refuses: this is the
    // independent hard ceiling that bounds the document's size.
    assert.equal(
      refuse(decidePromoReservation({ ...base, promo: code({ reservations: many }) })),
      'promo_busy'
    )
  })

  it('the PER-PERSON cap counts this identity’s committed row AND their other live holds', () => {
    assert.equal(
      refuse(
        decidePromoReservation({ ...base, promo: code(), perIdentityCommitted: 1 })
      ),
      'promo_already_used'
    )
    // A live reservation of theirs on a DIFFERENT target counts the same way —
    // the default per-person cap is 1, and it is not a per-target allowance.
    assert.equal(
      refuse(
        decidePromoReservation({
          ...base,
          promo: code({
            reservations: {
              their_other: reservation({ identityKey: 'e_aaa', targetKey: 'drop_in:s2' }),
            },
          }),
        })
      ),
      'promo_already_used'
    )
    // An explicit null is unlimited; the absent field is the default of 1.
    assert.equal(
      refuse(
        decidePromoReservation({
          ...base,
          promo: code({ max_uses_per_contact: null }),
          perIdentityCommitted: 9,
        })
      ),
      'take'
    )
  })
})

describe('decidePromoCommit — the one-writer arithmetic', () => {
  it('usage_count is ABSOLUTE, from the read set — never an increment', () => {
    // The whole point of returning a number rather than a FieldValue: two
    // commits against the same snapshot cannot both land, and what is written is
    // always derived from what was read.
    assert.equal(
      decidePromoCommit({
        promo: code({ usage_count: 41 }),
        nowMs: NOW,
        reservationKey: KEY,
        reservationExpiresMs: NOW - 1,
      }).usageCount,
      42
    )
    assert.equal(
      decidePromoCommit({
        promo: code({}),
        nowMs: NOW,
        reservationKey: KEY,
        reservationExpiresMs: NOW - 1,
      }).usageCount,
      1
    )
  })

  it('THE RESERVATION WINS over the webhook fallbacks for identity', () => {
    // The callable that minted it knew exactly who was buying; the webhook only
    // knows what survived — verifiedMetadataContact returns null once a guest's
    // provisional contact is purged.
    const out = decidePromoCommit({
      promo: code({ reservations: { [KEY]: reservation({ identityKey: 'e_real', contactId: 'c_real', amountMajor: 18.75 }) } }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
      fallbackIdentityKey: 'e_stale',
      fallbackContactId: 'c_stale',
      fallbackAmountMajor: 99,
    })
    assert.equal(out.identityKey, 'e_real')
    assert.equal(out.contactId, 'c_real')
    assert.equal(out.amountMajor, 18.75)
  })

  it('NO identity anywhere ⇒ the global count still moves, the ledger row is skipped', () => {
    const out = decidePromoCommit({
      promo: code({ usage_count: 7 }),
      nowMs: NOW,
      reservationKey: KEY,
      reservationExpiresMs: NOW - 1,
    })
    assert.equal(out.usageCount, 8)
    assert.equal(out.identityKey, null)
    assert.equal(out.contactId, null)
    assert.equal(out.amountMajor, null)
  })

  it('a non-finite fallback amount is not an amount', () => {
    const out = decidePromoCommit({
      promo: code(),
      nowMs: NOW,
      reservationKey: KEY,
      reservationExpiresMs: NOW - 1,
      fallbackAmountMajor: Number.NaN,
    })
    assert.equal(out.amountMajor, null)
  })

  it('an EXPIRED entry at our key is not ours to delete, and reads as not found', () => {
    // The entry lapsed, and so did our own claim on the slot (they are the same
    // instant plus the margin), so this is the late-delivery arm and it counts.
    const out = decidePromoCommit({
      promo: code({ reservations: { [KEY]: reservation({ expires_at: ts(NOW - 1) }) } }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: NOW - 1,
    })
    assert.equal(out.counted, true)
    assert.equal(out.reservationFound, false)
    assert.equal(out.reservationOwned, false)
    assert.deepEqual(out.reservations, {})
  })

  it('OTHER people’s live reservations survive the commit untouched', () => {
    const out = decidePromoCommit({
      promo: code({
        reservations: {
          [KEY]: reservation(),
          other: reservation({ identityKey: 'e_bbb', instanceId: 'inst_9' }),
        },
      }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.deepEqual(Object.keys(out.reservations), ['other'])
  })

  it('the CAP GATE refuses to count past max_uses — even for a slot that IS ours', () => {
    // THIS IS THE THIRD ATTEMPT AT THIS INVARIANT AND THE REASON THE FIELD
    // CHANGED MEANING. It used to count anyway and log ("refusing to count a
    // sale we own is worse than an off-by-one"), which made `usage_count` a
    // number that reported a breach rather than a cap that prevented one. Q9 is
    // refuse, never over-issue, so the gate is now hard: nothing is written.
    // The buyer keeps the purchase they paid for; the campaign does not record a
    // use it has no room for.
    const live = { [KEY]: reservation() }
    const under = decidePromoCommit({
      promo: code({ max_uses: 5, usage_count: 4, reservations: live }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(under.overCap, false)
    assert.equal(under.counted, true)
    assert.equal(under.usageCount, 5) // exactly at the cap is still a sale

    const over = decidePromoCommit({
      promo: code({ max_uses: 5, usage_count: 5, reservations: live }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(over.overCap, true)
    assert.equal(over.counted, false)
    assert.equal(over.usageCount, null)
    // …and NOTHING is written, including the entry: the map comes back intact so
    // the caller's `if (!counted) return` leaves the document untouched.
    assert.deepEqual(Object.keys(over.reservations), [KEY])

    // An uncapped code has no ceiling to breach, however high the count runs.
    assert.equal(
      decidePromoCommit({
        promo: code({ usage_count: 999, reservations: live }),
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_1',
        reservationExpiresMs: DEADLINE,
      }).overCap,
      false
    )
  })

  it('the per-person half of the gate reads the cap EXACTLY as the reserve does', () => {
    // Absent ⇒ the default of 1; explicit null ⇒ unlimited. A gate that
    // disagreed with `promoUsesLeft` about what the cap IS would be the
    // two-answers-to-one-question defect at the other end of the lifecycle.
    assert.equal(promoPerIdentityCapExceeded(code({}), 0), false)
    assert.equal(promoPerIdentityCapExceeded(code({}), 1), true)
    assert.equal(promoPerIdentityCapExceeded(code({ max_uses_per_contact: null }), 999), false)
    assert.equal(promoPerIdentityCapExceeded(code({ max_uses_per_contact: 3 }), 2), false)
    assert.equal(promoPerIdentityCapExceeded(code({ max_uses_per_contact: 3 }), 3), true)
  })

  it('a slot we do NOT hold can never trip overCap — nothing is counted at all', () => {
    const out = decidePromoCommit({
      promo: code({
        max_uses: 5,
        usage_count: 5,
        reservations: { [KEY]: reservation({ instanceId: 'inst_2' }) },
      }),
      nowMs: NOW,
      reservationKey: KEY,
      instanceId: 'inst_1',
      reservationExpiresMs: DEADLINE,
    })
    assert.equal(out.counted, false)
    assert.equal(out.overCap, false)
    assert.equal(out.usageCount, null)
  })
})

describe('the audience axis: "joined" is a property of the EMAIL, not of a document', () => {
  // THE INVARIANT, and the third break of it that this block exists to pin:
  //
  //   A `new_contacts` code is refused whenever ANY ACTIVE contact of the team
  //   under the caller's email has joined — whichever document the rail happens
  //   to be buying as.
  //
  // Broken three times, each a layer deeper: the predicate; then what each rail
  // FED the predicate; then what the resolver DID with what it was fed — it
  // discarded the email evidence whenever the rail held a contact document,
  // which is exactly the household case. So `promoCallerFrom` now takes BOTH
  // halves as required properties and is the only constructor of a gate-bearing
  // caller; `resolvePromoCaller` is the only producer of the evidence.
  const c = (over: Record<string, unknown> = {}) => ({ id: 'c1', email: 'a@b.c', ...over })
  const none: Array<Record<string, unknown> & { id: string }> = []

  it('ANONYMOUS GUEST — no contact, no matches: new', () => {
    assert.deepEqual(promoCallerFrom({ contact: null, emailMatches: none, email: 'a@b.c' }), {
      contactId: null,
      email: 'a@b.c',
      joined: false,
    })
  })

  it('OFF-FUNNEL CONTACT (a shop/form lead with no stage at all): new', () => {
    // The literal reading of "a pre-member stage" would EXCLUDE this person and
    // every anonymous guest — the field is optional and a shop/form/waitlist
    // entry carries no stage — which is the population the axis exists to admit.
    // Hence !joined rather than a stage allow-list.
    assert.deepEqual(
      promoCallerFrom({ contact: null, emailMatches: [c({ entry: 'shop' })] }),
      { contactId: 'c1', email: 'a@b.c', joined: false }
    )
    assert.equal(
      promoCallerFrom({ contact: c({ entry: 'form' }), emailMatches: [c({ entry: 'form' })] })
        .joined,
      false
    )
  })

  it('TRIAL CONTACT (trial_booked / trial_attended): still new', () => {
    for (const stage of ['trial_booked', 'trial_attended']) {
      const held = c({ acquisition_stage: stage })
      assert.equal(promoCallerFrom({ contact: null, emailMatches: [held] }).joined, false)
      assert.equal(promoCallerFrom({ contact: held, emailMatches: [held] }).joined, false)
    }
  })

  it('SIGNED-IN MEMBER: the document the rail holds settles it on its own', () => {
    const member = c({ acquisition_stage: 'joined' })
    // The union only moves false → true, which is why `resolvePromoCaller` may
    // skip its query for an already-joined document and nothing else.
    assert.equal(promoCallerFrom({ contact: member, emailMatches: none }).joined, true)
  })

  it('GUEST FORM, NAME MISMATCH: a joined member booking as "A. Smith" is not new', () => {
    // The drop-in rail's (email + exact first + exact last) match misses, so it
    // holds NO contact document — without the email evidence she reads as a
    // brand-new contact and takes the new-customers-only code.
    const member = c({ id: 'ann', acquisition_stage: 'joined' })
    assert.equal(
      promoCallerFrom({ contact: null, emailMatches: [member], email: 'a@b.c' }).joined,
      true
    )
  })

  it('GUEST FORM, EXACT-NAME MATCH TO A JOINED CONTACT: still not new', () => {
    const member = c({ acquisition_stage: 'joined' })
    assert.equal(promoCallerFrom({ contact: member, emailMatches: [member] }).joined, true)
  })

  it('THE HOUSEHOLD MAILBOX, AND THE HOLE THAT REOPENED IT', () => {
    // One joined, one not. The rail is buying as the NOT-joined document (the
    // exact-name match hit the kid), and the resolver used to return on exactly
    // that — a held document short-circuited the email entirely, so the member's
    // own household walked through the gate. It is the same evasion the
    // name-spelling case was fixed for, one document further along.
    const kid = c({ id: 'kid', acquisition_stage: 'trial_booked' })
    const mum = c({ id: 'mum', acquisition_stage: 'joined' })

    const buyingAsTheKid = promoCallerFrom({ contact: kid, emailMatches: [kid, mum] })
    assert.equal(buyingAsTheKid.joined, true)
    // …and the identity is still the document the rail holds: never-guess only
    // governs contactId, which feeds restrict_to_contact_id.
    assert.equal(buyingAsTheKid.contactId, 'kid')

    // With no held document, contactId follows never-guess and stays null —
    // naming the wrong person there hands somebody else's bound code away.
    const asAGuest = promoCallerFrom({ contact: null, emailMatches: [kid, mum], email: 'a@b.c' })
    assert.equal(asAGuest.joined, true)
    assert.equal(asAGuest.contactId, null)
  })

  it('ARCHIVED and DELETED contacts are not evidence of membership', () => {
    assert.equal(
      promoCallerFrom({
        contact: null,
        emailMatches: [c({ acquisition_stage: 'joined', archived_at: ts(NOW) })],
      }).joined,
      false
    )
    assert.equal(
      promoCallerFrom({
        contact: null,
        emailMatches: [c({ acquisition_stage: 'joined', deleted_at: ts(NOW) })],
      }).joined,
      false
    )
    // An archived joined contact is also not an identity: filtered before the
    // single-match rule, so contactId stays null rather than naming it.
    assert.equal(
      promoCallerFrom({
        contact: null,
        emailMatches: [c({ acquisition_stage: 'joined', deleted_at: ts(NOW) })],
      }).contactId,
      null
    )
  })

  it('THE DROP-IN MINT ORDERING: the matches captured BEFORE the provisional mint are the read set', () => {
    // `createDropInCheckout` mints a provisional contact for an unmatched guest
    // BEFORE the promo loads. A query issued at the promo site would see that
    // brand-new document too — so the rail passes the contacts it fetched first.
    // Pre-mint, a genuine newcomer's evidence is EMPTY, and she is new.
    const preMint = promoCallerFrom({ contact: null, emailMatches: none, email: 'new@b.c' })
    assert.equal(preMint.joined, false)
    assert.equal(preMint.contactId, null)

    // A member on the same mailbox is caught by the same pre-mint read set, and
    // the freshly minted provisional document — which would have made the query
    // ambiguous — cannot dilute it, because it is not in the evidence at all.
    const mum = c({ id: 'mum', acquisition_stage: 'joined' })
    assert.equal(
      promoCallerFrom({ contact: null, emailMatches: [mum], email: 'a@b.c' }).joined,
      true
    )
  })

  it('NO CODE TYPED is not an answer, and says so', () => {
    // The one place a `joined: false` may be built without evidence — and only
    // because every reader of it is unreachable without a code.
    assert.deepEqual(promoCallerNotAsked({ contactId: 'c1', email: 'a@b.c' }), {
      contactId: 'c1',
      email: 'a@b.c',
      joined: false,
    })
    assert.deepEqual(promoCallerNotAsked({}), { contactId: null, email: null, joined: false })
  })
})

describe('decideAppointmentCheckoutRollback — a losing racer never cancels the winner', () => {
  it('THE LOSING RACER: the slot transaction refused us, so the hold is not ours to cancel', () => {
    // `apt_{providerId}_{startMs}` is deterministic and SHARED. When
    // runAppointmentSlotTransaction throws "this time was just taken", the
    // document at that id is the WINNER's live pending_payment hold — canceling
    // it here would take a slot away from somebody who successfully booked it.
    assert.deepEqual(
      decideAppointmentCheckoutRollback({ holdAcquired: false, promoReserved: true }),
      { releaseHold: false, releasePromo: true }
    )
  })

  it('…but the promo reservation IS ours, and a stranded one costs the campaign a use', () => {
    // This is why the slot transaction sits inside the guard at all: two visitors
    // racing one slot with the same code must not cost a use for no sale.
    const { releasePromo } = decideAppointmentCheckoutRollback({
      holdAcquired: false,
      promoReserved: true,
    })
    assert.equal(releasePromo, true)
  })

  it('a failure AFTER the hold was acquired (the Stripe create) releases both', () => {
    assert.deepEqual(decideAppointmentCheckoutRollback({ holdAcquired: true, promoReserved: true }), {
      releaseHold: true,
      releasePromo: true,
    })
  })

  it('no code typed ⇒ nothing to give back on the promo side', () => {
    assert.deepEqual(
      decideAppointmentCheckoutRollback({ holdAcquired: true, promoReserved: false }),
      { releaseHold: true, releasePromo: false }
    )
    assert.deepEqual(
      decideAppointmentCheckoutRollback({ holdAcquired: false, promoReserved: false }),
      { releaseHold: false, releasePromo: false }
    )
  })
})

describe('TWO ROLLBACKS, ONE OWNERSHIP RULE — the losing sibling by the SAME contact', () => {
  // THE DEFECT THIS BLOCK PINS, and it is the appointment-side twin of
  // `decidePromoRelease`. `decideAppointmentCheckoutRollback` answers only "did
  // this attempt ever take the hold?". It cannot answer "does it STILL hold it",
  // because `allowRewriteByHolder: contactId` deliberately lets one contact's
  // second attempt rewrite its own live hold at the shared, deterministic
  // `apt_{providerId}_{startMs}` id — that is the retry path and it is correct.
  //
  //   attempt A takes the hold (booking_token T_A) -> Stripe session A
  //   attempt B rewrites the same hold (booking_token T_B) -> Stripe session B
  //   attempt A now fails -> and, on `holdAcquired` alone, cancels the session
  //   and deletes the booking that B's live, payable session is guarding.
  //
  // The race pre-dates promos; Phase 3 is what made A's failure
  // concurrency-CORRELATED rather than rare, because the promo lifecycle refuses
  // losing attempts by design (`promo_busy` from the compare-and-set, and from a
  // bind whose slot moved on). So the release proves ownership, exactly as the
  // promo release proves it — instanceId there, booking_token here.
  //
  // The rule's OWN fixtures — every proof, every census site — are in
  // appointments/holdRelease.test.ts. This block pins only the symmetry with the
  // promo release, because the two are one design decision.

  const T_A = 'tok_A'
  const T_B = 'tok_B'
  const live = { holdExpiresAtMs: NOW + 60_000, nowMs: NOW }

  it('THE LOSING SIBLING: a newer attempt owns the hold, so the loser cancels nothing', () => {
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...live,
      }),
      { release: false, proof: null }
    )
  })

  it('the ordinary single-attempt failure DOES release — the fix must not strand holds', () => {
    assert.deepEqual(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_A,
        bookingExists: true,
        ...live,
      }),
      { release: true, proof: 'token' }
    )
  })

  it('THE SYMMETRY, side by side: one ordering, both rollbacks, the same answer', () => {
    // A's promo release is a no-op because B refreshed the entry…
    assert.equal(
      decidePromoRelease({
        promo: { reservations: { [KEY]: reservation({ instanceId: 'inst_B' }) } },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId: 'inst_A',
      }),
      null
    )
    // …and A's hold release is a no-op for the same reason, on the same failure.
    assert.equal(
      decideAppointmentHoldRelease({
        bookingToken: T_A,
        storedToken: T_B,
        bookingExists: true,
        ...live,
      }).release,
      false
    )
    // Both flags still read "we took one" — which is precisely why neither may be
    // treated as permission to delete.
    assert.deepEqual(
      decideAppointmentCheckoutRollback({ holdAcquired: true, promoReserved: true }),
      { releaseHold: true, releasePromo: true }
    )
  })
})

describe('the idempotency key names the ATTEMPT, not just the code', () => {
  // THE DEFECT THIS BLOCK PINS. `defaultIdempotencyKey` buckets by MINUTE, and
  // `instrumentKeyParts` used to append only the promo CODE — which is constant
  // across every attempt at one purchase while the request is not: each attempt
  // stamps a fresh `promoInstance` and a freshly derived `promoExpires`. Stripe
  // rejects a reused key whose parameters differ, so a checkout resubmitted
  // inside the same minute failed with a bare `internal` — AND by then the
  // reserve's pre-flight had already closed the buyer's still-live Checkout
  // Session, leaving them with no payable session at all.

  const base = {
    teamId: 't1',
    nowMs: NOW,
    scope: { kind: 'product' as const, productId: 'p1' },
    caller: { contactId: 'c1', email: 'a@b.c', joined: false },
    identityKey: 'e_aaa',
    reservationKey: KEY,
    perIdentityCommitted: 0,
  }

  const gift = (code: string, holdKey: string) => ({ code, holdKey })
  const keyFor = (
    t: PromoReservationTicket | null,
    g?: { code: string; holdKey: string } | null
  ) => defaultIdempotencyKey('dropin', 't1', 's1', 'c1', ...instrumentKeyParts(t, g ?? null))

  it('a plain checkout produces ZERO parts — the legacy key stays byte-identical', () => {
    assert.deepEqual(instrumentKeyParts(null, null), [])
    assert.deepEqual(instrumentKeyParts(undefined, undefined), [])
    assert.equal(keyFor(null), `dropin:t1:s1:c1:${Math.floor(Date.now() / 60_000)}`)
  })

  it('TWO ATTEMPTS AT ONE PURCHASE, ONE MINUTE: same code, same slot, DIFFERENT keys', () => {
    const a = ticket({ instanceId: 'inst_1' })
    const b = ticket({ instanceId: 'inst_2' })
    // Same purchase by construction — the reservation key is deterministic, and
    // that property is load-bearing and unchanged by this fix.
    assert.equal(a.reservationKey, b.reservationKey)
    assert.equal(a.code, b.code)
    assert.notEqual(keyFor(a), keyFor(b))
    assert.deepEqual(instrumentKeyParts(a, null), ['promo=AUTUMN25', 'try=inst_1'])
  })

  it('the SAME attempt retried is the SAME key — Stripe still dedupes a true retry', () => {
    const t = ticket()
    assert.equal(keyFor(t), keyFor(t))
  })

  it('instruments are appended last, never reordered, each normalized once', () => {
    assert.deepEqual(
      instrumentKeyParts(ticket({ instanceId: 'inst_7' }), gift(' gc-abcd ', 'hold_1')),
      ['promo=AUTUMN25', 'try=inst_7', 'gift=GC-ABCD', 'hold=hold_1']
    )
  })

  it('THE SAME DEFECT, ONE INSTRUMENT OVER: a gift card WITHOUT a promo also varies', () => {
    // Phase 3 shipped the attempt marker for the promo only, so a gift-card
    // checkout resubmitted inside its minute bucket sent Stripe the SAME key with
    // a DIFFERENT `giftCardHold` in the metadata — a parameter mismatch, surfaced
    // to the buyer as a bare `internal`. The hold key is minted fresh per attempt
    // exactly as `instanceId` is, so it belongs in the key for exactly the same
    // reason.
    assert.notEqual(
      keyFor(null, gift('gc-abcd', 'hold_1')),
      keyFor(null, gift('gc-abcd', 'hold_2'))
    )
    // …and a TRUE retry (same attempt, same hold) is still one key, so Stripe
    // still dedupes the thing the key exists to dedupe.
    assert.equal(keyFor(null, gift('gc-abcd', 'hold_1')), keyFor(null, gift('gc-abcd', 'hold_1')))
    assert.deepEqual(instrumentKeyParts(null, gift('gc-abcd', 'hold_1')), [
      'gift=GC-ABCD',
      'hold=hold_1',
    ])
  })

  /**
   * A tiny Stripe stand-in with the two behaviors that matter: ONE session per
   * idempotency key, and a REJECTION when a key comes back carrying different
   * parameters. `expire` is what our own pre-flight close does to the session a
   * slot was backing.
   */
  function stripe() {
    const sessions = new Map<string, { expired: boolean; params: string }>()
    const byKey = new Map<string, string>()
    let n = 0
    return {
      create(key: string, params: string): string {
        const seen = byKey.get(key)
        if (seen) {
          if (sessions.get(seen)!.params !== params) {
            throw new Error('idempotency-parameter mismatch')
          }
          return seen // Stripe replays the CACHED session — expired or not.
        }
        const id = `cs_${++n}`
        sessions.set(id, { expired: false, params })
        byKey.set(key, id)
        return id
      },
      expire(id: string) {
        sessions.get(id)!.expired = true
      },
      payable: () => [...sessions].filter(([, s]) => !s.expired).map(([id]) => id),
    }
  }

  it('THE PROPERTY: a visitor who resubmits ends with exactly ONE payable session and NO error', () => {
    // Walked as the rails actually run, twice inside one minute bucket:
    // read -> close the superseded session -> reserve -> create -> bind -> return.
    const api = stripe()
    let entry: PromoReservation | null = null
    let handed: string | null = null
    let errors = 0

    for (const instanceId of ['inst_1', 'inst_2']) {
      const t = ticket({ instanceId })
      // 1. Pre-flight: close whatever this slot is currently backing.
      const expectedSessionId = entry?.sessionId ?? null
      if (expectedSessionId) api.expire(expectedSessionId)
      // 2. Reserve — a refresh on the second pass, consuming nothing.
      const d = decidePromoReservation({
        ...base,
        promo: code({ max_uses: 1, reservations: entry ? { [KEY]: entry } : {} }),
        expectedSessionId,
        reservation: reservation({ instanceId, sessionId: null }),
      })
      assert.notEqual(d.kind, 'refuse')
      entry = (d as { reservations: Record<string, PromoReservation> }).reservations[KEY]
      // 3. Create the Stripe session. The metadata varies per attempt — that is
      //    the parameter set the key has to keep up with.
      const params = JSON.stringify(promoCheckoutMetadata(t, 18.75))
      let sessionId: string
      try {
        sessionId = api.create(keyFor(t), params)
      } catch {
        errors += 1
        continue
      }
      // 4. Bind, then hand the URL to the buyer.
      const bound = decidePromoSessionAttach({
        promo: { reservations: { [KEY]: entry } },
        nowMs: NOW,
        reservationKey: KEY,
        instanceId,
        sessionId,
      })
      assert.ok(bound, 'our own fresh reservation must always bind')
      entry = bound.reservations[KEY]
      handed = sessionId
    }

    assert.equal(errors, 0, 'no attempt may fail at Stripe')
    assert.equal(handed, 'cs_2')
    assert.deepEqual(api.payable(), [handed], 'exactly one payable session, and the buyer holds it')
    assert.equal(entry!.instanceId, 'inst_2')
  })

  it('…and why FREEZING the instance inside the bucket cannot be the fix', () => {
    // The rejected alternative: keep the instance out of the key and reuse it
    // within a minute so the request is byte-identical. Stripe then replays the
    // CACHED response — which is the session the pre-flight has just expired. The
    // key stops mismatching and the buyer is handed a dead link instead:
    // sessionless by a quieter route, which is the outcome that had to be ruled
    // out. (And the instance is not even the only per-attempt parameter: the
    // window instant is derived afresh at every attempt too.)
    const api = stripe()
    const frozenKey = 'dropin:t1:s1:c1:promo=AUTUMN25:0'
    const frozenParams = 'identical'

    const first = api.create(frozenKey, frozenParams)
    api.expire(first) // the second attempt's pre-flight closes it
    const second = api.create(frozenKey, frozenParams)

    assert.equal(second, first, 'an idempotent replay returns the cached session')
    assert.deepEqual(api.payable(), [], 'and it is dead — the buyer has nothing to pay')
  })
})
