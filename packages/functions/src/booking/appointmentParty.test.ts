import assert from 'node:assert/strict'
import {
  DURATION_PARTY_MAX,
  GUEST_SNAPSHOT,
  PARTICIPANT_NAME_MAX,
  appointmentPriceRange,
  normalizePartyRequest,
  resolveDurationParty,
  resolvePaymentOptions,
  type ContactPaymentSnapshot,
  type PaymentOptionsResult,
  type PaymentTarget,
  type PromoModifier,
} from '@linyup/shared'
import {
  partyBookingFields,
  partyCheckoutMetadata,
  partyFromCheckoutMetadata,
  partyKeyParts,
  readAppointmentParty,
  readStaffAppointmentParty,
} from '../appointments/party'

// A PARTY books an appointment length together and pays per person
// (types/activity.ts `ActivityDuration.party`; decisions in docs/appointments.md
// "Priced per person"). The booker's place takes their member price and the
// promo; every companion place pays list with the promo only.

const contact = (over: Partial<ContactPaymentSnapshot> = {}): ContactPaymentSnapshot => ({
  authenticated: true,
  joined: true,
  heldUnmeteredTypeIds: [],
  heldCreditTypes: [],
  ...over,
})

// "I come with another person, CHF 75 each", for 2 to 5 people.
const partyLength = { minutes: 45, priceAmount: 75, party: { min: 2, max: 5 } }
const t = (over: Partial<Extract<PaymentTarget, { kind: 'appointment' }>> = {}): PaymentTarget => ({
  kind: 'appointment',
  duration: partyLength,
  benefit: null,
  ...over,
})
const pay = (amount: number, extra: Record<string, unknown> = {}): PaymentOptionsResult => ({
  options: [{ type: 'pay', amount, source: 'base', ...extra } as never],
  denial: null,
})
const memberRate = { subscriptionTypeIds: ['silver'], effect: 'percent_off' as const, percent: 20 }
const CODE = 'AUTUMN25'
const pct = (percent: number): PromoModifier => ({ code: CODE, effect: 'percent_off', percent })

describe('resolveDurationParty: the one reader of a length party', () => {
  it('reads a well-formed party', () => {
    assert.deepEqual(resolveDurationParty(partyLength), { min: 2, max: 5 })
  })
  it('a length with no party, or 1..1, is booked by one person', () => {
    assert.equal(resolveDurationParty({ minutes: 45, priceAmount: 110 }), null)
    assert.equal(resolveDurationParty({ minutes: 45, party: { min: 1, max: 1 } }), null)
  })
  it('clamps to the bounds and refuses what cannot be a party', () => {
    assert.deepEqual(resolveDurationParty({ minutes: 45, party: { min: 0, max: 99 } }), {
      min: 1,
      max: DURATION_PARTY_MAX,
    })
    assert.equal(resolveDurationParty({ minutes: 45, party: { min: 4, max: 3 } }), null)
    assert.equal(resolveDurationParty({ minutes: 45, party: { min: 1.5, max: 3 } }), null)
  })
  it('a benefit-only length has no party: nothing would cover the people brought along', () => {
    assert.equal(
      resolveDurationParty({ minutes: 45, priceAmount: 75, benefitOnly: true, party: { min: 2, max: 3 } }),
      null
    )
  })
})

describe('normalizePartyRequest: one check for the picker and every callable', () => {
  it('a party within bounds with one name per companion is accepted, names trimmed', () => {
    assert.deepEqual(normalizePartyRequest(partyLength, { people: 3, participants: [' Ana ', 'Ben'] }), {
      ok: true,
      people: 3,
      participants: ['Ana', 'Ben'],
    })
  })
  it('refuses a size outside the party, or a missing or blank name', () => {
    assert.deepEqual(normalizePartyRequest(partyLength, { people: 6, participants: [] }), {
      ok: false,
      reason: 'party_size',
    })
    assert.deepEqual(normalizePartyRequest(partyLength, { people: 3, participants: ['Ana'] }), {
      ok: false,
      reason: 'participant_names',
    })
    assert.deepEqual(normalizePartyRequest(partyLength, { people: 2, participants: ['  '] }), {
      ok: false,
      reason: 'participant_names',
    })
  })
  it('caps a name at the stored length', () => {
    const r = normalizePartyRequest(partyLength, { people: 2, participants: ['x'.repeat(200)] })
    assert.equal(r.ok && r.participants[0].length, PARTICIPANT_NAME_MAX)
  })
  it('an old client that names no party is refused by name on a length that cannot be booked alone', () => {
    assert.deepEqual(normalizePartyRequest(partyLength, {}), { ok: false, reason: 'party_required' })
  })
  it('...and booked alone on a length that can be', () => {
    const aloneOrPair = { minutes: 45, priceAmount: 75, party: { min: 1, max: 2 } }
    assert.deepEqual(normalizePartyRequest(aloneOrPair, {}), { ok: true, people: 1, participants: [] })
  })
  it('a solo length refuses a party rather than dropping the names on the floor', () => {
    const solo = { minutes: 45, priceAmount: 110 }
    assert.deepEqual(normalizePartyRequest(solo, {}), { ok: true, people: 1, participants: [] })
    assert.deepEqual(normalizePartyRequest(solo, { people: 2, participants: ['Ana'] }), {
      ok: false,
      reason: 'no_party',
    })
  })
})

describe('resolvePaymentOptions: appointment party (priced per person)', () => {
  const rows: {
    name: string
    snapshot: ContactPaymentSnapshot
    target: PaymentTarget
    promo?: PromoModifier
    expected: PaymentOptionsResult
  }[] = [
    {
      name: 'a guest party of two pays two list places',
      snapshot: GUEST_SNAPSHOT,
      target: t({ people: 2 }),
      expected: pay(150, { party: { people: 2, unitAmount: 75 } }),
    },
    {
      name: 'a party of one is a solo booking at the per-person price, with no party record',
      snapshot: GUEST_SNAPSHOT,
      target: t({ people: 1 }),
      expected: pay(75),
    },
    {
      name: 'people on a length that is not a party is ignored: one booking, one price',
      snapshot: GUEST_SNAPSHOT,
      target: t({ duration: { minutes: 45, priceAmount: 110 }, people: 3 }),
      expected: pay(110),
    },
    {
      name: 'the booker takes their member price, the companion pays list',
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: t({ people: 2, benefit: memberRate }),
      expected: pay(135, {
        appliedBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off', baseAmount: 150 },
        party: { people: 2, unitAmount: 75 },
      }),
    },
    {
      name: "a plan that includes the length covers the booker's place only, and says so",
      snapshot: contact({ heldUnmeteredTypeIds: ['gold'] }),
      target: t({ people: 3, benefit: { subscriptionTypeIds: ['gold'], effect: 'included' } }),
      expected: pay(150, { party: { people: 3, unitAmount: 75, bookerCoveredBy: 'gold' } }),
    },
    {
      name: 'a credit pack does not pay for a party: no mixed tender, the booker pays list',
      snapshot: contact({ heldCreditTypes: [{ subscriptionTypeId: 'pack10', remaining: 3 }] }),
      target: t({ people: 2, benefit: { subscriptionTypeIds: ['pack10'], effect: 'included' } }),
      expected: pay(150, { party: { people: 2, unitAmount: 75 } }),
    },
    {
      name: 'an unpriced party length is free for everyone, whatever the party',
      snapshot: GUEST_SNAPSHOT,
      target: t({ duration: { minutes: 45, party: { min: 2, max: 5 } }, people: 4 }),
      expected: { options: [{ type: 'covered', via: { reason: 'unpriced' } }], denial: null },
    },
    {
      name: 'a promo lowers every place: 20% off two places of 75',
      snapshot: GUEST_SNAPSHOT,
      target: t({ people: 2 }),
      promo: pct(20),
      expected: {
        ...pay(120, {
          appliedPromo: { code: CODE, effect: 'percent_off', baseAmount: 150 },
          party: { people: 2, unitAmount: 75 },
        }),
        promo: { code: CODE, status: 'applied' },
      },
    },
    {
      name: "the booker's better member price stands, the code lowers the companion, and the plan rides along",
      snapshot: contact({ heldUnmeteredTypeIds: ['silver'] }),
      target: t({ people: 2, benefit: memberRate }),
      promo: pct(10),
      expected: {
        // booker 60 (member 20% beats the 10% code), companion 67.50
        ...pay(127.5, {
          appliedPromo: {
            code: CODE,
            effect: 'percent_off',
            baseAmount: 150,
            supersededBenefit: { subscriptionTypeId: 'silver', effect: 'percent_off' },
          },
          party: { people: 2, unitAmount: 75 },
        }),
        promo: { code: CODE, status: 'applied' },
      },
    },
  ]
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(
        resolvePaymentOptions(row.snapshot, row.target, row.promo ? { promo: row.promo } : undefined),
        row.expected
      )
    })
  }
})

describe('appointments/party.ts: what the rails write and carry', () => {
  it('a solo booking writes nothing and carries nothing, so its documents and key are unchanged', () => {
    const solo = { people: 1, participants: [] }
    assert.deepEqual(partyBookingFields(solo), {})
    assert.deepEqual(partyCheckoutMetadata(solo), {})
    assert.deepEqual(partyKeyParts(solo), [])
  })
  it('the party a payment bought survives the round trip through Stripe metadata', () => {
    const party = { people: 3, participants: ['Ana', 'Ben'] }
    const md = partyCheckoutMetadata(party)
    assert.deepEqual(md, { people: '3', participant1: 'Ana', participant2: 'Ben' })
    assert.deepEqual(partyFromCheckoutMetadata(md), party)
  })
  it('a solo purchase, or one made before parties existed, reads back as no party', () => {
    assert.equal(partyFromCheckoutMetadata({}), null)
    assert.equal(partyFromCheckoutMetadata({ people: '1' }), null)
    assert.equal(partyFromCheckoutMetadata({ people: 'lots' }), null)
  })
  it('a different party size or different names makes a different key, so a re-priced retry is not refused', () => {
    const a = partyKeyParts({ people: 2, participants: ['Ana'] })
    assert.notDeepEqual(a, partyKeyParts({ people: 3, participants: ['Ana', 'Ben'] }))
    assert.notDeepEqual(a, partyKeyParts({ people: 2, participants: ['Bea'] }))
    assert.deepEqual(a, partyKeyParts({ people: 2, participants: ['Ana'] }))
  })
  it('the studio books the smallest party by default and may leave names out', () => {
    assert.deepEqual(readStaffAppointmentParty(partyLength, {}), { people: 2, participants: [] })
    assert.deepEqual(readStaffAppointmentParty(partyLength, { people: 4, participants: ['Ana', ' '] }), {
      people: 4,
      participants: ['Ana'],
    })
    assert.throws(() => readStaffAppointmentParty(partyLength, { people: 9 }), /cannot book/)
  })
  it('the booking callables refuse a bad party by name', () => {
    assert.throws(
      () => readAppointmentParty(partyLength, {}),
      (err: { details?: { reason?: string } }) => err.details?.reason === 'party_required'
    )
  })
})

describe('appointmentPriceRange: one unit per answer', () => {
  it('every sold length per person: the figures stay per person and say so', () => {
    assert.deepEqual(appointmentPriceRange([partyLength]), { kind: 'one', amount: 75, perPerson: true })
  })
  it('a mix is counted per booking: a per-person length at its smallest party', () => {
    // 110 solo beside 75 x 2 = 150 for the smallest pair
    assert.deepEqual(
      appointmentPriceRange([{ minutes: 45, priceAmount: 110 }, partyLength]),
      { kind: 'range', min: 110, max: 150 }
    )
  })
})
