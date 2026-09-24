import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GUEST_SNAPSHOT,
  resolvePaymentOptions,
  type ContactPaymentSnapshot,
  type PaymentTarget,
} from '@linyup/shared'

// WHO THE APPOINTMENT RAIL THINKS IT IS TALKING TO — and what that is worth in
// money. Run with: pnpm --filter @linyup/functions test
//
// The defect these pin: `AppointmentPicker.tsx` referenced `usePublicContactAuth`
// zero times while the provider wrapped it and the contact session's ID token
// rode on every callable it made. Three consequences, and only the first is the
// one the bug report noticed:
//
//   1. the screen quoted a member the GUEST price and then Stripe charged the
//      member price — wrong in the customer's favour, self-correcting at the
//      payment page, a display bug;
//   2. a COVERED member was routed into `createAppointmentCheckout`, which
//      refuses `{ reason: 'covered' }` by design, and the picker rendered that
//      refusal as "This slot is no longer available." — a false sentence and a
//      hard stop for the studio's own subscribers;
//   3. a signed-in contact typing somebody else's details into the guest form
//      booked it for THEMSELVES, silently, because the server prefers the
//      session over the body.
//
// What made all three possible is one fact that must not drift: the SERVER
// resolves the contact session FIRST, before `authenticatedContactId` and before
// `contactDetails`. The screen has to derive the same caller from the same
// precedence, and these tests hold both halves against their source.

const APPOINTMENTS = __dirname
const PICKER = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'web',
  'src',
  'app',
  '[locale]',
  '(public)',
  'public',
  '[slug]',
  'appointments',
  'AppointmentPicker.tsx'
)

/** Strip comments so a grep cannot match prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const picker = () => stripComments(readFileSync(PICKER, 'utf8'))
/** The shared caller model, which this rail's identity moved into when the
 *  class funnel started sharing it (plan section 4). */
const CALLER_MODEL = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'web',
  'src',
  'components',
  'booking',
  'identity',
  'bookingCaller.ts'
)
const caller = () => stripComments(readFileSync(CALLER_MODEL, 'utf8'))
const fn = (rel: string) => stripComments(readFileSync(join(APPOINTMENTS, rel), 'utf8'))

describe('THE APPOINTMENT RAIL PRICES THE CALLER IT ACTUALLY HAS', () => {
  const duration = { minutes: 60, priceAmount: 100 }
  const discount40 = {
    subscriptionTypeIds: ['gold'],
    kind: 'discount' as const,
    discountPercent: 40,
  }
  const included = { subscriptionTypeIds: ['gold'], kind: 'included' as const }
  type AppointmentTarget = Extract<PaymentTarget, { kind: 'appointment' }>
  const target = (
    benefit: AppointmentTarget['benefit'],
    over: Partial<AppointmentTarget> = {}
  ): PaymentTarget => ({ kind: 'appointment', duration, benefit, ...over })

  /**
   * The snapshot the PICKER builds, per `clientPaymentSnapshot`'s documented
   * contract (apps/web/src/lib/paymentSnapshot.ts): an unauthenticated caller is
   * `GUEST_SNAPSHOT` verbatim; an authenticated one reports every held id as
   * unmetered and `joined` true. The wiring test below is what keeps the picker
   * actually feeding it the signed-in contact's types rather than `[]`.
   */
  const member = (held: string[]): ContactPaymentSnapshot => ({
    authenticated: true,
    joined: true,
    heldUnmeteredTypeIds: held,
    heldCreditTypes: [],
  })

  it('a signed-in member is quoted THEIR price; the same slot quotes a guest the base', () => {
    const asGuest = resolvePaymentOptions(GUEST_SNAPSHOT, target(discount40))
    const asMember = resolvePaymentOptions(member(['gold']), target(discount40))

    assert.deepEqual(asGuest.options, [{ type: 'pay', amount: 100, source: 'base' }])
    assert.deepEqual(asMember.options, [
      {
        type: 'pay',
        amount: 60,
        source: 'base',
        appliedBenefit: { subscriptionTypeId: 'gold', effect: 'percent_off', baseAmount: 100 },
      },
    ])
    // The whole defect in one line: the two answers differ, so which snapshot the
    // screen builds decides which number a member reads.
    assert.notEqual(
      (asGuest.options[0] as { amount: number }).amount,
      (asMember.options[0] as { amount: number }).amount
    )
  })

  it('an `included` benefit puts the member on the FREE door, not a cheaper paid one', () => {
    // This is the row behind consequence 2. `createAppointmentCheckout` refuses
    // anything that is not `pay`, so quoting this caller as a guest sent them
    // through a door the server is obliged to close.
    const asMember = resolvePaymentOptions(member(['gold']), target(included))
    assert.equal(asMember.options[0]?.type, 'covered')
    assert.equal(resolvePaymentOptions(GUEST_SNAPSHOT, target(included)).options[0]?.type, 'pay')
  })

  it('a member holding an unlisted type still pays base — a benefit is data, never implied', () => {
    assert.deepEqual(resolvePaymentOptions(member(['silver']), target(discount40)).options, [
      { type: 'pay', amount: 100, source: 'base' },
    ])
  })

  it('an unpriced duration is free for everyone — no benefit needed and none consulted', () => {
    const unpriced = target(discount40, { duration: { minutes: 60 } })
    assert.equal(resolvePaymentOptions(GUEST_SNAPSHOT, unpriced).options[0]?.type, 'covered')
    assert.equal(resolvePaymentOptions(member(['gold']), unpriced).options[0]?.type, 'covered')
  })
})

describe('THE PICKER FEEDS THE RESOLVER THE SIGNED-IN CONTACT', () => {
  it('it reads the contact session at all', () => {
    assert.match(
      picker(),
      /usePublicContactAuth\(\)/,
      'the provider wraps this surface from the team-root layout and its token is on ' +
        'every callable the file makes; not reading it is not neutrality, it is a wrong answer'
    )
  })

  it('the caller is DERIVED every render, session first — the server\'s own precedence', () => {
    assert.match(
      picker(),
      /const caller = resolveBookingCaller\(\{/,
      'it must be derived, not stored, or a sign-in through the corner pill leaves ' +
        'the screen one render behind the server'
    )
    // The order itself is the shared model's now, so it is asserted there.
    assert.match(
      caller(),
      /if \(isAuthenticated && sessionContact\) \{[\s\S]*?return \{\s*kind: 'session'/,
      'session must outrank an OTP result because it outranks it in ' +
        'resolveAppointmentCaller, which returns from the session branch before it ' +
        'reads authenticatedContactId or contactDetails'
    )
    assert.match(caller(), /return verified \?\? GUEST/)
  })

  it('the snapshot is built from the caller, so a member is never quoted as a guest', () => {
    const src = picker()
    const quote = src.slice(src.indexOf('const quote = (c: BookingCaller)'))
    assert.ok(quote.length > 0, 'the one price computation must take the caller')
    const snapshot = quote.slice(0, quote.indexOf('promoApplied'))
    assert.match(snapshot, /authenticated:\s*c\.kind !== 'guest'/)
    assert.match(snapshot, /heldSubscriptionTypeIds:\s*heldOf\(c\)/)
  })

  it('a contact session sends NO identity in the body — the token is the proof', () => {
    const src = caller()
    const body = src.slice(src.indexOf('export function bodyIdentity('), src.indexOf('export function waiverIdentity('))
    assert.match(
      body,
      /if \(caller\.kind === 'session'\) return \{\}/,
      'sending contactDetails alongside a session is a lie: resolveAppointmentCaller ' +
        'returns from the session branch before it ever reads them'
    )
  })

  it('the covered refusal is answered, not printed as "this slot is gone"', () => {
    const src = picker()
    assert.equal(
      (src.match(/reason === 'covered'/g) ?? []).length,
      2,
      'both paid submits — the guest form and the member CTA — must recognise a ' +
        "`covered` refusal and walk through the free door instead of ending the booking"
    )
  })
})

describe('AND WHEN THE CALLER MOVES, EVERYTHING SAID TO THE OLD ONE GOES WITH IT', () => {
  // Deriving the caller correctly is only half of it. The identity can change
  // WHILE the booking step is open — the corner sign-in pill belongs to the
  // provider that wraps this page — and everything the screen had already said
  // or captured was quoted for whoever was here before. Each of these was a way
  // for one person's figure, code or typed details to be shown to, or submitted
  // by, another.

  it('the error sentence is SCOPED to an identity, not cleared by an effect', () => {
    const src = picker()
    assert.match(
      src,
      /errorState\.identity === identityKey \|\| errorState\.identity === ANY_IDENTITY/,
      'these sentences NAME A PRICE ("…the price without the code is CHF 40.00"). An ' +
        'effect clears one render too late, so the guest sentence renders once on the ' +
        'member screen — above a button charging a different number. The one exception ' +
        'is the transition\'s OWN sentence, which is true for whoever is here now'
    )
    assert.match(
      src,
      /setErrorState\(text === null \? null : \{ identity: identityKey, text \}\)/,
      'the sentence must be stamped by the render that composed it, so a sign-in during ' +
        'a round trip retires it rather than stranding it on the member who arrived'
    )
  })

  it('a captured submit carries WHOSE it is, and the resume refuses a mixture', () => {
    const src = picker()
    // The consent screen pauses a submit for as long as it takes to read a
    // waiver. `pending.caller` / `pending.values.email` are from then; the
    // price, the body identity and the acceptances are re-derived at resume.
    assert.match(src, /const pending = pendingBook/)
    assert.match(
      src,
      /if \(pending\.identity !== identityKey\) \{/,
      'resuming a capture taken under another identity submits half of one person and ' +
        'half of another'
    )
    // Stamped from the SUBJECT on the member-free arm: that record is created in
    // the same async block as the caller, so the render carrying the new
    // identity may not have committed when it is stored.
    assert.match(src, /identity: callerKey\(verifiedCaller\), kind: 'memberFree'/)
  })

  it('an applied promo is retired with the identity that applied it', () => {
    const src = picker()
    const effect = src.slice(src.indexOf('const identityRef = useRef(identityKey)'))
    const body = effect.slice(0, effect.indexOf('}, ['))
    assert.match(
      body,
      /setPromoApplied\(null\)/,
      '`previewPromoCode` resolves its caller from a contact session and nothing else, so ' +
        'a code quoted anonymously and carried onto a member screen is re-priced by the ' +
        'client for an audience the server will judge differently'
    )
    assert.match(body, /if \(droppedSubmit\) setPendingBook\(null\)/)
    assert.match(
      body,
      /setNotice\(t\('identityChangedPromo'\)\)/,
      'a control that empties itself without a word is the same defect as the sentence ' +
        'this rule exists to clear'
    )
  })

  it('the member price is re-resolved live, not read off the 7-day session snapshot', () => {
    const src = picker()
    assert.match(
      src,
      /const liveHeld = contactRecord\.data \? heldSubscriptionTypeIds\(contactRecord\.data\) : null/,
      'the persisted session carries ONE `subscription_type_id`, frozen at sign-in and ' +
        'never refreshed for seven days. On this rail that value is the PRICE, and the ' +
        'divergence points the unsafe way: the screen quotes a benefit the member no ' +
        'longer holds and the server charges the real figure'
    )
    // The live read has to REACH the caller, which is what prices the booking.
    assert.match(src, /resolveBookingCaller\(\{[^}]*\bliveHeld\b/)
    // The fallback direction matters: a FAILED read is not an empty entitlement.
    // The rule moved to the shared module when the class funnel started sharing
    // it, so it is checked THERE rather than dropped.
    assert.match(
      caller(),
      /if \(liveHeld\) return liveHeld\s*\n\s*return sessionContact\?\.subscription_type_id/,
      'heldFrom must prefer the live union and fall back to the frozen slot, never ' +
        'the other way round'
    )
    assert.match(
      src,
      /const heldPending = caller\.kind === 'session' && hasAnyPrice && !heldSettled/,
      'the CTA must not offer a figure derived from the stale value while the live ' +
        'answer is still in flight'
    )
  })

  it('the `payment_required` race says WHY the button became a charge', () => {
    const src = picker()
    assert.match(src, /const showsRacePrice = /)
    assert.match(
      src,
      /showsRacePrice && \(/,
      'the CTA turns from "Confirm booking" into "Pay CHF X" under the member\'s hands; ' +
        'the figure is the server\'s, so the reason has to be stated too'
    )
  })
})

describe('THE SERVER PREFERS THE SESSION, AND THAT IS WHAT SAVES THE MONEY QUESTIONS', () => {
  // The three questions the defect entry left open all turn on this ordering.
  // None of them was exploitable, and each stays that way only while the order
  // below holds — so the order is asserted rather than remembered.

  it('resolveAppointmentCaller answers from the session BEFORE it reads the body', () => {
    const src = fn('booking.ts')
    const resolver = src.slice(src.indexOf('export async function resolveAppointmentCaller'))
    const session = resolver.indexOf('if (sessionAuthenticated)')
    const otp = resolver.indexOf('if (authenticated)')
    const guest = resolver.indexOf('const cd = data.contactDetails')
    assert.ok(session > -1 && otp > -1 && guest > -1)
    assert.ok(
      session < otp && otp < guest,
      'session → verified code → typed details. Any other order lets a request body ' +
        'name a caller the token contradicts'
    )
  })

  it('the promo audience gate is resolved from the CALLER, never from what was typed', () => {
    // Q2 (can a member take a `new_contacts` code here?) and Q3 (does the
    // per-contact cap reset?) are both closed by these two arguments: on a
    // session the contact IS the session contact and `sanitized.email` IS that
    // contact's address, so `joined` and the identity key are the member's.
    const src = fn('checkout.ts')
    const call = src.slice(src.indexOf('resolvePromoCaller({'))
    const args = call.slice(0, call.indexOf('})'))
    assert.match(args, /contact:\s*caller\.authenticatedContact/)
    assert.match(args, /email:\s*caller\.sanitized\.email/)
    assert.equal(
      args.includes('data.contactDetails'),
      false,
      'resolving the promo caller from the typed address would hand a long-standing ' +
        'member a new-customers-only code, and a fresh per-contact allowance with it'
    )
  })

  it('the price the caller is charged comes from the caller\'s own snapshot', () => {
    const src = fn('checkout.ts')
    const block = src.slice(src.indexOf('const snapshot ='), src.indexOf('const promoTarget'))
    assert.match(block, /caller\.authenticatedContact/)
    assert.match(block, /loadContactPaymentSnapshot/)
    assert.match(block, /GUEST_SNAPSHOT/)
  })
})
