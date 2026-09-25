import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE COUNTS IN THE COMMENTS, ASSERTED AGAINST THE SOURCE.
//
// Wave 3 Phase 3 shipped comments asserting how many full-cover branches exist,
// and one of them said "two" TWICE — corrected once in connect/promoCodes.ts and
// left wrong in connect/giftCards.ts, because a correction applied to the sibling
// claim does not travel to the copy. A number written in prose has no gate behind
// it; this file is that gate.
//
// It deliberately reads the TypeScript SOURCE rather than importing the modules:
// importing connect/payments.ts pulls in firebase-functions and the Stripe
// client, and the claim under test is about CALL SITES, which is a property of
// the text. The claims it pins say, in as many words:
//
//   • connect/giftCards.ts, commitGiftCardDrawdown's DO-NOT-ADD-A-RIDER note —
//     "the THREE full-cover branches … createDropInCheckout,
//     createProductCheckout and createCourseCheckout. There is no fourth";
//   • connect/giftCards.ts, commitGiftCardDrawdown's docblock — "the
//     partial-redemption webhook and all three full-cover callables";
//   • connect/promoCodes.ts, header invariant 2 — the same three, named.
//
// ── AND WHY THE REST OF THE PHASE'S COUNTS ARE HERE TOO ─────────────────────
//
// Six review rounds of Wave 3 Phase 3 shipped a false count in EVERY round, and
// each round's fix was a new number rather than a different KIND of claim. The
// numbers that survive in prose are now only the ones that NAME their members
// beside them; the rest were deleted, replaced by a pointer to the one file or
// section that owns the list, or moved here. This file is where a count is
// allowed to be a bare number, because here it is executable.
//
// The rule the phase leaves behind: a claim about a COUNT, a CALL-SITE LIST, a
// PRECONDITION or an INVARIANT must be checkable without counting. Prefer
// pointing at the owner (appointments/holdRelease.ts owns the appointment-hold
// census; docs/promo-codes.md owns the promo-reservation census and the mount
// table). Where a count really is load-bearing, add it below.
//
// Run with: pnpm --filter @linyup/functions test

const SRC = join(__dirname, '..')
/** The worktree root: SRC → packages/functions → packages → root. Needed because
 *  two of the censuses below span the functions/web boundary, which is exactly
 *  where a correction stops travelling. */
const ROOT = join(SRC, '..', '..', '..')

/** Line endings normalised: the working tree is checked out LF on CI and CRLF on
 *  Windows, and a claim spanning a comment line break must match on both. */
function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** Same, for a path relative to the worktree root. */
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** CODE only. A census header that documents its own grep recipe contains the
 *  string `releaseAppointmentHold(` in prose, and counting that as a call site is
 *  precisely the confusion this file exists to remove. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Call sites only — a `function NAME(` definition is excluded, and a bare
 *  mention in prose or an import has no parenthesis after it. */
function countCalls(source: string, name: string): number {
  const re = new RegExp(`(?<!function\\s)\\b${name}\\(`, 'g')
  return (source.match(re) ?? []).length
}

describe('THE FULL-COVER BRANCHES ARE THREE — asserted, not asserted in prose', () => {
  const dropIn = read('booking/dropIn.ts')
  const payments = read('connect/payments.ts')
  const appointmentCheckout = read('appointments/checkout.ts')
  const webhook = read('connect/webhook.ts')
  const giftCards = read('connect/giftCards.ts')
  const promoCodes = read('connect/promoCodes.ts')

  it('a gift card can FULLY COVER a purchase on exactly three rails', () => {
    // One per rail that takes a gift card at all. The residual>0 path on each of
    // those rails commits through the webhook instead, which is the fourth
    // commitGiftCardDrawdown call site and NOT a full-cover branch.
    assert.equal(countCalls(dropIn, 'commitGiftCardDrawdown'), 1, 'createDropInCheckout')
    assert.equal(countCalls(payments, 'commitGiftCardDrawdown'), 2, 'product + course')
    assert.equal(countCalls(webhook, 'commitGiftCardDrawdown'), 1, 'the partial-redemption webhook')
    assert.equal(
      countCalls(appointmentCheckout, 'commitGiftCardDrawdown'),
      0,
      'appointments take no gift card, so that rail has no full-cover branch'
    )
  })

  it('the promo commits alongside each of them — three, and no fourth', () => {
    // The rule this pins: a promo can never ride on commitGiftCardDrawdown (it
    // returns early for an empty or comped card, and runs only when a gift-card
    // code was supplied at all), so every full-cover branch commits its promo
    // SEPARATELY and every one of them must remember to.
    assert.equal(countCalls(dropIn, 'commitPromoRedemption'), 1, 'createDropInCheckout')
    assert.equal(countCalls(payments, 'commitPromoRedemption'), 2, 'product + course')
    assert.equal(countCalls(appointmentCheckout, 'commitPromoRedemption'), 0)
    // The webhook never calls it directly — it goes through
    // commitPromoFromMetadata at each per-kind CONFIRM point, which is what keeps
    // "a use is consumed by a completed sale, never by an attempt" true.
    assert.equal(countCalls(webhook, 'commitPromoRedemption'), 0)
    // One per per-kind confirm point: drop-in, appointment, an appointment
    // basket, product, course, and the scheduled course. A number is allowed
    // here because here it is executable, which is the whole point of this file.
    assert.equal(countCalls(webhook, 'commitPromoFromMetadata'), 6, 'the six confirm points')
  })

  it('and every comment that states the count says THREE', () => {
    const riderNote = giftCards.slice(giftCards.indexOf('DO NOT ADD A RIDER HERE'))
    assert.ok(riderNote.includes('THREE full-cover'), 'giftCards.ts rider note must say THREE')
    assert.ok(
      !/\btwo full-cover\b/i.test(giftCards),
      'giftCards.ts must not claim two full-cover branches anywhere'
    )
    // Wrapped across a comment line break in the source, hence the tolerant match.
    assert.ok(
      /all three\s+\*?\s*full-cover callables/.test(giftCards),
      "commitGiftCardDrawdown's docblock must say all three"
    )
    assert.ok(
      !/\btwo\s+gift-card full-cover\b/i.test(promoCodes),
      'promoCodes.ts must not claim two gift-card full-cover branches'
    )
    assert.ok(
      /THREE\s+\/\/\s+gift-card full-cover branches/.test(promoCodes),
      'promoCodes.ts header invariant 2 must say THREE'
    )
    // …and each of the three is NAMED there, which is what makes the claim
    // checkable without counting.
    for (const name of ['createDropInCheckout', 'createProductCheckout', 'createCourseCheckout']) {
      assert.ok(promoCodes.includes(name), `promoCodes.ts header must name ${name}`)
      assert.ok(giftCards.includes(name), `giftCards.ts rider note must name ${name}`)
    }
  })
})

describe('THE APPOINTMENT-HOLD RELEASE CENSUS — the sites, against its own list', () => {
  // appointments/holdRelease.ts OWNS this census. Nothing else may restate it,
  // so what is asserted here is that the file's list still covers the code:
  // every caller of the shared executor appears in the header, and no caller has
  // appeared anywhere the header does not mention. The bug this replaces was a
  // release fixed at two sites and missed at the third for two rounds, under a
  // comment at the third claiming it followed the first.
  const OWNERS: Record<string, string> = {
    'appointments/checkout.ts': 'createAppointmentCheckout',
    'appointments/staffBooking.ts': 'createStaffAppointment',
    'connect/webhook.ts': 'handleCheckoutExpired',
    'appointments/window.ts': 'bookAppointment',
  }
  const holdRelease = read('appointments/holdRelease.ts')

  it('every caller of releaseAppointmentHold is one the census names', () => {
    for (const [file, fn] of Object.entries(OWNERS)) {
      assert.equal(
        countCalls(code(read(file)), 'releaseAppointmentHold'),
        1,
        `${file} calls the shared executor exactly once`
      )
      assert.ok(holdRelease.includes(fn), `the census must name ${fn}`)
    }
    // The executor does not call itself; only its own header mentions it, in the
    // grep recipe the last test pins.
    assert.equal(countCalls(code(holdRelease), 'releaseAppointmentHold'), 0)
  })

  it('…and no FOURTH caller has appeared without a census entry', () => {
    // The failure mode this catches is a new rail (or a new webhook branch)
    // wiring itself into the executor correctly and never being added to the
    // list — which reads as safe and quietly makes the census wrong.
    const searched = [
      'appointments/checkout.ts',
      'appointments/staffBooking.ts',
      'appointments/booking.ts',
      // The free path. It had no caller until a basket had to give back holds
      // it took, and it was not searched, so a caller there would have passed.
      'appointments/window.ts',
      'appointments/basket.ts',
      'connect/webhook.ts',
      'connect/payments.ts',
      'booking/dropIn.ts',
      'booking/index.ts',
      'dailyTasks/expirePendingBookings.ts',
      'sessions/index.ts',
    ]
    const callers = searched.filter((f) => countCalls(code(read(f)), 'releaseAppointmentHold') > 0)
    assert.deepEqual(callers.sort(), Object.keys(OWNERS).sort())
  })

  it('the census carries a re-derivation recipe that finds the sites it routes', () => {
    // The recipe used to grep only for direct writes (`status: 'cancelled'` and
    // `collection('bookings')`), which finds every site that DIVERGES from the
    // executor and none of the ones the file exists for.
    assert.ok(
      holdRelease.includes('grep -rn "releaseAppointmentHold("'),
      'the recipe must find the sites routed through this file'
    )
  })
})

describe('THE PROMO MOUNTS — renders and surfaces, counted separately', () => {
  // docs/promo-codes.md → "The mounts" is the table; the mounts themselves say
  // "every mount" and carry no tally. Both numbers are pinned because the
  // helpers are per RENDER and the copy namespace is per SURFACE, and two
  // surface comments said "three" while there were four renders.
  const SURFACES = [
    'apps/web/src/app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx',
    'apps/web/src/app/[locale]/(public)/public/[slug]/shop/ShopHome.tsx',
    'apps/web/src/components/booking/appointment/SlotBookingForm.tsx',
  ]

  it('four renders across three surfaces, and the appointment picker holds two', () => {
    const renders = SURFACES.map((f) => (readRoot(f).match(/<PromoCodeField\b/g) ?? []).length)
    assert.deepEqual(renders, [1, 1, 2], 'BookingForm, ShopHome, SlotBookingForm')
    assert.equal(
      renders.reduce((a, b) => a + b, 0),
      4
    )
  })

  it('no surface renders the field without going through the shared helpers', () => {
    // The recovery branches fork the moment one surface hand-rolls the sentence
    // or the accepted-price scope, which is how a guest's 40.00 got re-sent on a
    // member screen quoting 24.00.
    for (const f of SURFACES) {
      const src = readRoot(f)
      assert.ok(src.includes('useAcceptedPrice'), `${f} must use the shared accepted-price scope`)
      assert.ok(src.includes('priceChangedMessage'), `${f} must use the shared recovery sentence`)
    }
  })
})

describe('THE GIFT-CARD HOLD KEY is minted by the caller, at each rail that takes one', () => {
  it('three mint sites, one per gift-card rail, all BEFORE any Stripe session', () => {
    // shared/types/giftCard.ts states this as a PRECONDITION ("it is NOT the
    // Stripe Checkout Session id, and cannot be"), and that file drifted from
    // the functions-side header once already. Named there, counted here.
    //
    // `generateSecureToken(16)` is the hold key specifically — the bare
    // `generateSecureToken()` beside it on the drop-in rail is the appointment
    // /booking token, a different instrument on the same line of code.
    const mints = (rel: string) =>
      (code(read(rel)).match(/generateSecureToken\(16\)/g) ?? []).length
    assert.equal(mints('booking/dropIn.ts'), 1, 'drop-in')
    assert.equal(mints('connect/payments.ts'), 2, 'product + course')
    assert.equal(mints('appointments/checkout.ts'), 0, 'appointments take no gift card')
  })
})
