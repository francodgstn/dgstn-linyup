import assert from 'node:assert/strict'
import {
  PROMO_CODE_LIMITS,
  PROMO_DEFAULT_MAX_USES_PER_CONTACT,
  PROMO_MAX_LIVE_RESERVATIONS,
  getPromoCodeLimits,
  isValidPromoCodeFormat,
  looksLikeGiftCardCode,
  normalizeRedemptionCode,
  promoAllowsCaller,
  promoAppliesTo,
  promoAudienceMatches,
  promoIdentityKey,
  promoLiveReservations,
  promoModifier,
  promoReservationKey,
  promoUsesLeft,
  promoWindowOpen,
  type PromoCode,
  type PromoReservation,
} from '@linyup/shared'
import { sha256Hex } from '../utils/crypto'

// Unit tests for the PURE promo helpers (Wave 3 Phase 3, P3-A + P3-B). These are
// the seam the reserve transaction, the preview callable and the admin list all
// lean on — every boundary answered here is answered ONCE.
// Run with: pnpm --filter @linyup/functions test

const ts = (ms: number) => ({ toMillis: () => ms }) as never

const NOW = 1_700_000_000_000

function reservation(over: Partial<PromoReservation> & { expiresAtMs: number }): PromoReservation {
  return {
    contactId: over.contactId ?? 'c1',
    identityKey: over.identityKey ?? 'e_aaa',
    // WHICH ATTEMPT owns the entry. Irrelevant to the cap predicates below (they
    // only count), load-bearing for release/commit — see promoLifecycle.test.ts.
    instanceId: over.instanceId ?? 'inst_1',
    expires_at: ts(over.expiresAtMs),
    amountMajor: over.amountMajor ?? 30,
    baseAmount: over.baseAmount ?? 40,
    targetKey: over.targetKey ?? 'drop_in:s1',
  }
}

function code(over: Partial<PromoCode> = {}): PromoCode {
  return {
    code: 'AUTUMN25',
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

// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeRedemptionCode (the ONE code normalizer)', () => {
  it('trims and uppercases, and is idempotent', () => {
    assert.equal(normalizeRedemptionCode('  autumn25 '), 'AUTUMN25')
    assert.equal(normalizeRedemptionCode('gc-abcd-1234'), 'GC-ABCD-1234')
    assert.equal(normalizeRedemptionCode(normalizeRedemptionCode(' x ')), 'X')
  })
  it('KEEPS hyphens — folding them would collide two distinct codes on one doc id', () => {
    assert.equal(normalizeRedemptionCode('SUMMER-26'), 'SUMMER-26')
    assert.notEqual(normalizeRedemptionCode('SUMMER-26'), normalizeRedemptionCode('SUMMER26'))
  })
})

describe('promo code format', () => {
  it('accepts 3–24 uppercase alphanumerics and hyphens, normalizing first', () => {
    assert.equal(isValidPromoCodeFormat('summer26'), true)
    assert.equal(isValidPromoCodeFormat('  autumn-25  '), true)
    assert.equal(isValidPromoCodeFormat('A1B'), true)
    assert.equal(isValidPromoCodeFormat('A'.repeat(24)), true)
  })
  it('refuses too short, too long, a leading hyphen, and anything else', () => {
    assert.equal(isValidPromoCodeFormat('AB'), false)
    assert.equal(isValidPromoCodeFormat('A'.repeat(25)), false)
    assert.equal(isValidPromoCodeFormat('-SUMMER'), false)
    assert.equal(isValidPromoCodeFormat('SUM MER'), false)
    assert.equal(isValidPromoCodeFormat('SUMMER!'), false)
    assert.equal(isValidPromoCodeFormat(''), false)
  })
  it('a gift card pasted into the promo field is recognized, not just "invalid"', () => {
    assert.equal(looksLikeGiftCardCode(' gc-abcd-1234 '), true)
    assert.equal(looksLikeGiftCardCode('SUMMER26'), false)
    // …and it is a well-formed promo string, which is exactly why the distinct
    // answer matters: format alone would let it through.
    assert.equal(isValidPromoCodeFormat('GC-ABCD-1234'), true)
  })
})

describe('promoWindowOpen', () => {
  it('both ends absent ⇒ always open', () => {
    assert.equal(promoWindowOpen({}, NOW), true)
  })
  it('before valid_from is closed; AT valid_from is open (inclusive)', () => {
    const p = { valid_from: ts(NOW) }
    assert.equal(promoWindowOpen(p, NOW - 1), false)
    assert.equal(promoWindowOpen(p, NOW), true)
    assert.equal(promoWindowOpen(p, NOW + 1), true)
  })
  it('AT valid_until is open; after it is closed (inclusive)', () => {
    const p = { valid_until: ts(NOW) }
    assert.equal(promoWindowOpen(p, NOW - 1), true)
    assert.equal(promoWindowOpen(p, NOW), true)
    assert.equal(promoWindowOpen(p, NOW + 1), false)
  })
  it('null ends behave exactly like absent ones', () => {
    assert.equal(promoWindowOpen({ valid_from: null, valid_until: null }, NOW), true)
  })
  it('a closed window with both ends set', () => {
    const p = { valid_from: ts(NOW - 1000), valid_until: ts(NOW + 1000) }
    assert.equal(promoWindowOpen(p, NOW - 1001), false)
    assert.equal(promoWindowOpen(p, NOW), true)
    assert.equal(promoWindowOpen(p, NOW + 1001), false)
  })
})

describe('promoLiveReservations — THE liveness predicate (lazy expiry, no sweep)', () => {
  it('drops expired entries and KEEPS THE KEYS of live ones', () => {
    const p = {
      reservations: {
        live: reservation({ expiresAtMs: NOW + 60_000 }),
        stale: reservation({ expiresAtMs: NOW - 1 }),
      },
    }
    const out = promoLiveReservations(p, NOW)
    assert.deepEqual(Object.keys(out), ['live'])
  })
  it('an entry expiring exactly NOW is NOT live (strictly greater, as holds are)', () => {
    const p = { reservations: { a: reservation({ expiresAtMs: NOW }) } }
    assert.deepEqual(Object.keys(promoLiveReservations(p, NOW)), [])
  })
  it('absent map ⇒ empty', () => {
    assert.deepEqual(promoLiveReservations({}, NOW), {})
  })
  it('an UNDATEABLE entry is treated as expired, so it cannot strand a use forever', () => {
    const p = { reservations: { broken: { contactId: 'c1' } as never } }
    assert.deepEqual(promoLiveReservations(p, NOW), {})
  })
})

describe('promoUsesLeft — the WHOLE cap boundary, both halves, one expression', () => {
  it('uncapped on both axes ⇒ Infinity, and the live count is still reported', () => {
    const p = code({
      max_uses: null,
      max_uses_per_contact: null,
      reservations: { a: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_other' }) },
    })
    const left = promoUsesLeft(p, NOW, 'e_mine', 0)
    assert.equal(left.global, Infinity)
    assert.equal(left.perIdentity, Infinity)
    assert.equal(left.liveTotal, 1)
  })

  it('global = max_uses − committed − LIVE reservations (a reservation consumes a use)', () => {
    const p = code({
      max_uses: 10,
      usage_count: 3,
      max_uses_per_contact: null,
      reservations: {
        a: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_a' }),
        b: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_b' }),
      },
    })
    assert.equal(promoUsesLeft(p, NOW, 'e_mine', 0).global, 5)
  })

  it('EXPIRED reservations do not consume a use', () => {
    const p = code({
      max_uses: 1,
      usage_count: 0,
      max_uses_per_contact: null,
      reservations: { dead: reservation({ expiresAtMs: NOW - 1, identityKey: 'e_a' }) },
    })
    const left = promoUsesLeft(p, NOW, 'e_mine', 0)
    assert.equal(left.global, 1)
    assert.equal(left.liveTotal, 0)
  })

  it('the last use held by somebody else refuses the next caller (global <= 0)', () => {
    const p = code({
      max_uses: 1,
      usage_count: 0,
      max_uses_per_contact: null,
      reservations: { theirs: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_them' }) },
    })
    assert.equal(promoUsesLeft(p, NOW, 'e_mine', 0).global, 0)
  })

  it('an absent per-contact cap defaults to once per person', () => {
    assert.equal(PROMO_DEFAULT_MAX_USES_PER_CONTACT, 1)
    const p = code({ max_uses: 100 })
    assert.equal(promoUsesLeft(p, NOW, 'e_mine', 0).perIdentity, 1)
    assert.equal(promoUsesLeft(p, NOW, 'e_mine', 1).perIdentity, 0)
  })

  it('explicit null per-contact cap ⇒ unlimited (distinct from absent)', () => {
    const p = code({ max_uses: 100, max_uses_per_contact: null })
    assert.equal(promoUsesLeft(p, NOW, 'e_mine', 7).perIdentity, Infinity)
  })

  it('perIdentity counts only THIS identity’s live reservations', () => {
    const p = code({
      max_uses: 100,
      max_uses_per_contact: 2,
      reservations: {
        mine: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_mine' }),
        theirs: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_them' }),
      },
    })
    const left = promoUsesLeft(p, NOW, 'e_mine', 0)
    assert.equal(left.perIdentity, 1) // 2 − 0 committed − 1 of mine
    assert.equal(left.global, 98)
    assert.equal(left.liveTotal, 2)
  })

  it('THE RETRY: my own reservation for the target I am buying does not refuse me', () => {
    // Same person, same code, same target, second attempt. Without the
    // exclusion her own live-but-unpaid reservation reads as "already used" for
    // a purchase she never completed — and, with max_uses: 1, as "exhausted"
    // too. Both caps must see straight through it.
    const key = 'k_mine'
    const p = code({
      max_uses: 1,
      usage_count: 0,
      reservations: { [key]: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_mine' }) },
    })
    const blind = promoUsesLeft(p, NOW, 'e_mine', 0)
    assert.equal(blind.global, 0)
    assert.equal(blind.perIdentity, 0)

    const retry = promoUsesLeft(p, NOW, 'e_mine', 0, key)
    assert.equal(retry.global, 1)
    assert.equal(retry.perIdentity, 1)
    assert.equal(retry.liveTotal, 0)
  })

  it('excluding a key that is not mine is not a way to smuggle a use', () => {
    // The exclusion is keyed on (code|identity|target), so a caller can only
    // ever name their OWN reservation — but assert the arithmetic anyway.
    const p = code({
      max_uses: 2,
      reservations: {
        a: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_a' }),
        b: reservation({ expiresAtMs: NOW + 60_000, identityKey: 'e_b' }),
      },
    })
    assert.equal(promoUsesLeft(p, NOW, 'e_a', 0, 'a').global, 1)
  })

  it('the live ceiling is a SEPARATE limit from the cap', () => {
    const reservations: Record<string, PromoReservation> = {}
    for (let i = 0; i < PROMO_MAX_LIVE_RESERVATIONS; i++) {
      reservations[`k${i}`] = reservation({ expiresAtMs: NOW + 60_000, identityKey: `e_${i}` })
    }
    const p = code({ max_uses: null, max_uses_per_contact: null, reservations })
    const left = promoUsesLeft(p, NOW, 'e_new', 0)
    assert.equal(left.global, Infinity) // uncapped — yet…
    assert.equal(left.liveTotal, PROMO_MAX_LIVE_RESERVATIONS) // …busy
  })
})

describe('promoAppliesTo — scope', () => {
  it('the rail must be listed', () => {
    const p = code({ applies_to: ['course'] })
    assert.equal(promoAppliesTo(p, { kind: 'course', courseId: 'c1' }), true)
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'a1' }), false)
    assert.equal(promoAppliesTo(p, { kind: 'product', productId: 'p1' }), false)
    assert.equal(promoAppliesTo(p, { kind: 'appointment', activityId: 'a1' }), false)
  })

  it('an absent/null/empty allow-list permits every entity of the kind', () => {
    for (const activity_ids of [undefined, null, []]) {
      const p = code({ applies_to: ['drop_in'], activity_ids })
      assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'anything' }), true)
      assert.equal(promoAppliesTo(p, { kind: 'drop_in' }), true)
    }
  })

  it('a non-empty allow-list permits only its members', () => {
    const p = code({ applies_to: ['drop_in'], activity_ids: ['a1', 'a2'] })
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'a2' }), true)
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'a3' }), false)
  })

  it('a narrowed code refuses a target that cannot name itself — unknown is not in scope', () => {
    const p = code({ applies_to: ['drop_in'], activity_ids: ['a1'] })
    assert.equal(promoAppliesTo(p, { kind: 'drop_in' }), false)
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: null }), false)
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: '' }), false)
  })

  it('activity_ids narrows appointments too — both rails are activities', () => {
    const p = code({ applies_to: ['appointment'], activity_ids: ['a1'] })
    assert.equal(promoAppliesTo(p, { kind: 'appointment', activityId: 'a1' }), true)
    assert.equal(promoAppliesTo(p, { kind: 'appointment', activityId: 'a9' }), false)
  })

  it('courses and products narrow on their own lists, not each other’s', () => {
    const p = code({
      applies_to: ['course', 'product'],
      course_ids: ['co1'],
      product_ids: ['pr1'],
    })
    assert.equal(promoAppliesTo(p, { kind: 'course', courseId: 'co1' }), true)
    assert.equal(promoAppliesTo(p, { kind: 'course', courseId: 'pr1' }), false)
    assert.equal(promoAppliesTo(p, { kind: 'product', productId: 'pr1' }), true)
    assert.equal(promoAppliesTo(p, { kind: 'product', productId: 'co1' }), false)
  })

  it('THE TRIAL DOOR never takes a promo, whatever the code allows', () => {
    const p = code({ applies_to: ['drop_in'], activity_ids: null })
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'a1' }), true)
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'a1', isTrial: true }), false)
    // …and false is only for `true`, never for an absent flag.
    assert.equal(promoAppliesTo(p, { kind: 'drop_in', activityId: 'a1', isTrial: false }), true)
  })
})

describe('promoAudienceMatches — the audience axis', () => {
  it('absent audience behaves exactly like "all"', () => {
    assert.equal(promoAudienceMatches({}, { joined: true }), true)
    assert.equal(promoAudienceMatches({ audience: 'all' }, { joined: true }), true)
    assert.equal(promoAudienceMatches({}, { joined: false }), true)
  })

  it('new_contacts admits everyone who has not joined and refuses members', () => {
    const p = { audience: 'new_contacts' as const }
    assert.equal(promoAudienceMatches(p, { joined: false }), true) // guest / lead / mid-trial
    assert.equal(promoAudienceMatches(p, { joined: true }), false) // a member
  })

  it('is the reason a member cannot spend an acquisition campaign', () => {
    // The failure this axis exists to prevent: a member holding a 10% benefit
    // takes the better 20% flyer code, and 50 uses evaporate acquiring nobody.
    const flyer = code({ audience: 'new_contacts', max_uses: 50, percent: 20 })
    assert.equal(promoAppliesTo(flyer, { kind: 'drop_in', activityId: 'a1' }), true)
    assert.equal(promoAudienceMatches(flyer, { joined: true }), false)
  })
})

describe('promoAllowsCaller — both identity gates, one expression', () => {
  it('an unbound, all-audience code is for everyone', () => {
    assert.deepEqual(promoAllowsCaller(code(), { contactId: 'c1', joined: true }), { ok: true })
    assert.deepEqual(promoAllowsCaller(code(), { joined: false }), { ok: true })
  })

  it('a bound code admits its owner and refuses everyone else', () => {
    const p = code({ restrict_to_contact_id: 'c_owner' })
    assert.deepEqual(promoAllowsCaller(p, { contactId: 'c_owner', joined: true }), { ok: true })
    assert.deepEqual(promoAllowsCaller(p, { contactId: 'c_other', joined: true }), {
      ok: false,
      reason: 'restricted_to_other_contact',
    })
  })

  it('a bound code refuses an ANONYMOUS caller — an unnamed caller is not that person', () => {
    const p = code({ restrict_to_contact_id: 'c_owner' })
    assert.deepEqual(promoAllowsCaller(p, { joined: false }), {
      ok: false,
      reason: 'restricted_to_other_contact',
    })
    assert.deepEqual(promoAllowsCaller(p, { contactId: null, joined: false }), {
      ok: false,
      reason: 'restricted_to_other_contact',
    })
  })

  it('null/absent restrict_to_contact_id binds nobody', () => {
    for (const restrict_to_contact_id of [undefined, null]) {
      assert.deepEqual(
        promoAllowsCaller(code({ restrict_to_contact_id }), { contactId: 'anyone', joined: true }),
        { ok: true }
      )
    }
  })

  it('the audience gate refuses a member and admits a newcomer', () => {
    const p = code({ audience: 'new_contacts' })
    assert.deepEqual(promoAllowsCaller(p, { contactId: 'c1', joined: false }), { ok: true })
    assert.deepEqual(promoAllowsCaller(p, { contactId: 'c1', joined: true }), {
      ok: false,
      reason: 'audience_mismatch',
    })
  })

  it('BINDING WINS over audience — the secretive refusal must never be pre-empted', () => {
    // A code both bound to somebody else AND new-contacts-only must not tell a
    // stranger "this is for new customers", which would confirm it exists.
    const p = code({ restrict_to_contact_id: 'c_owner', audience: 'new_contacts' })
    assert.deepEqual(promoAllowsCaller(p, { contactId: 'c_other', joined: true }), {
      ok: false,
      reason: 'restricted_to_other_contact',
    })
  })
})

describe('promoModifier — the already-qualified resolver input', () => {
  it('carries the canonical code and only the field its effect uses', () => {
    assert.deepEqual(
      promoModifier({ code: ' autumn25 ', effect: 'percent_off', percent: 25 }),
      { code: 'AUTUMN25', effect: 'percent_off', percent: 25 }
    )
    assert.deepEqual(promoModifier({ code: 'FLAT10', effect: 'fixed_price', amount: 10 }), {
      code: 'FLAT10',
      effect: 'fixed_price',
      amount: 10,
    })
  })
  it('omits an absent value rather than emitting undefined', () => {
    const m = promoModifier({ code: 'X1Y', effect: 'percent_off' })
    assert.deepEqual(Object.keys(m).sort(), ['code', 'effect'])
  })
})

describe('promoIdentityKey — what the per-person cap actually binds to', () => {
  it('one key for one email, however it was typed', () => {
    const a = promoIdentityKey({ email: 'Ann@Example.COM', contactId: 'c1' }, sha256Hex)
    const b = promoIdentityKey({ email: '  ann@example.com ', contactId: 'c2' }, sha256Hex)
    assert.equal(a, b)
  })

  it('binds ACROSS the name-spelling evasion and across a recreated contact', () => {
    // "Ann Smith" and "A. Smith" on the same mailbox mint two contact documents
    // on the guest drop-in rail; the cap must see one person.
    const first = promoIdentityKey({ email: 'ann@x.com', contactId: 'contact_ann_smith' }, sha256Hex)
    const second = promoIdentityKey({ email: 'ann@x.com', contactId: 'contact_a_smith' }, sha256Hex)
    assert.equal(first, second)
  })

  it('different emails are different identities', () => {
    assert.notEqual(
      promoIdentityKey({ email: 'a@x.com', contactId: 'c1' }, sha256Hex),
      promoIdentityKey({ email: 'b@x.com', contactId: 'c1' }, sha256Hex)
    )
  })

  it('falls back to the contact when there is no email, and the two kinds never collide', () => {
    const c = promoIdentityKey({ contactId: 'c1' }, sha256Hex)
    assert.equal(c, 'c_c1')
    assert.equal(promoIdentityKey({ email: '', contactId: 'c1' }, sha256Hex), 'c_c1')
    assert.equal(promoIdentityKey({ email: null, contactId: 'c1' }, sha256Hex), 'c_c1')
    assert.ok(promoIdentityKey({ email: 'a@x.com', contactId: 'c1' }, sha256Hex).startsWith('e_'))
  })

  it('is a doc-id-safe hex string, and does not leak the email', () => {
    const k = promoIdentityKey({ email: 'ann@example.com', contactId: 'c1' }, sha256Hex)
    assert.match(k, /^e_[0-9a-f]{32}$/)
    assert.equal(k.includes('ann'), false)
    assert.equal(k.includes('@'), false)
  })
})

describe('promoReservationKey — deterministic, which is what makes a retry a refresh', () => {
  const base = { code: 'AUTUMN25', identityKey: 'e_abc', targetKey: 'drop_in:s1' }

  it('the same person, code and target always produce the same key', () => {
    assert.equal(promoReservationKey(base, sha256Hex), promoReservationKey(base, sha256Hex))
  })

  it('a differently-typed code is the same reservation', () => {
    assert.equal(
      promoReservationKey({ ...base, code: ' autumn25' }, sha256Hex),
      promoReservationKey(base, sha256Hex)
    )
  })

  it('a different TARGET is a different reservation (one per person per target)', () => {
    assert.notEqual(
      promoReservationKey({ ...base, targetKey: 'drop_in:s2' }, sha256Hex),
      promoReservationKey(base, sha256Hex)
    )
  })

  it('a different person, and a different code, are different reservations', () => {
    assert.notEqual(
      promoReservationKey({ ...base, identityKey: 'e_zzz' }, sha256Hex),
      promoReservationKey(base, sha256Hex)
    )
    assert.notEqual(
      promoReservationKey({ ...base, code: 'SPRING10' }, sha256Hex),
      promoReservationKey(base, sha256Hex)
    )
  })

  it('is safe as a Firestore map key / FieldPath segment', () => {
    assert.match(promoReservationKey(base, sha256Hex), /^[0-9a-f]{32}$/)
  })

  it('the separator is not forgeable by stuffing it into a component', () => {
    // A bare `a|b|c` preimage would hash these two DIFFERENT purchases to one
    // key and merge their reservations. Reachable: targetKey embeds a product's
    // client-generated variantId. Hence the length-prefixed encoding.
    assert.notEqual(
      promoReservationKey({ code: 'AB1', identityKey: 'x|y', targetKey: 't' }, sha256Hex),
      promoReservationKey({ code: 'AB1', identityKey: 'x', targetKey: 'y|t' }, sha256Hex)
    )
    assert.notEqual(
      promoReservationKey(
        { code: 'AB1', identityKey: 'e_a', targetKey: 'product:p1:v|x' },
        sha256Hex
      ),
      promoReservationKey(
        { code: 'AB1', identityKey: 'e_a', targetKey: 'product:p1:v' },
        sha256Hex
      )
    )
  })
})

describe('PROMO_CODE_LIMITS — creation caps, expressed as data', () => {
  it('free and coach get none; studio 20; organization 100', () => {
    assert.deepEqual(PROMO_CODE_LIMITS, {
      free: { maxActiveCodes: 0 },
      coach: { maxActiveCodes: 0 },
      studio: { maxActiveCodes: 20 },
      organization: { maxActiveCodes: 100 },
    })
  })
  it('an unknown/absent plan is treated as free', () => {
    assert.equal(getPromoCodeLimits(null).maxActiveCodes, 0)
    assert.equal(getPromoCodeLimits('studio').maxActiveCodes, 20)
  })
})
