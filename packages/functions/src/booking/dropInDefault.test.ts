import assert from 'node:assert/strict'
import {
  dropInModeOf,
  resolveActivityDropIn,
  sameDropInPrice,
  studioDropInOf,
} from '@linyup/shared'
import { buildActivityPublicProfile } from '../sync/syncActivityPublicProfile'

// THE ONE READER of a class's drop-in price (shared/utils/dropIn.ts), and the
// mirror that carries what it resolves. Run with: pnpm --filter @linyup/functions test

const STUDIO = { enabled: true, priceAmount: 25 }

describe('resolveActivityDropIn — the three answers', () => {
  it('a class that follows the studio takes the studio price', () => {
    assert.deepEqual(
      resolveActivityDropIn({ type: 'class', accessRule: { type: 'members' }, dropIn: { mode: 'studio', enabled: false } }, STUDIO),
      { enabled: true, priceAmount: 25, source: 'studio' }
    )
  })

  it('…and has none when the studio has none', () => {
    for (const studio of [null, undefined, { enabled: false }, { enabled: true }]) {
      assert.deepEqual(
        resolveActivityDropIn({ type: 'class', accessRule: { type: 'members' }, dropIn: { mode: 'studio', enabled: false } }, studio),
        { enabled: false, source: 'studio' }
      )
    }
  })

  it('a custom price wins over the studio', () => {
    assert.deepEqual(
      resolveActivityDropIn(
        { type: 'class', accessRule: { type: 'members' }, dropIn: { mode: 'custom', enabled: true, priceAmount: 30 } },
        STUDIO
      ),
      { enabled: true, priceAmount: 30, source: 'custom' }
    )
  })

  it('a custom class without a price sells nothing — enabled is derived, never copied', () => {
    assert.deepEqual(
      resolveActivityDropIn({ type: 'class', accessRule: { type: 'members' }, dropIn: { mode: 'custom', enabled: true } }, STUDIO),
      { enabled: false, source: 'custom' }
    )
  })

  it('off is off, whatever the studio says', () => {
    assert.deepEqual(
      resolveActivityDropIn(
        { type: 'class', accessRule: { type: 'members' }, dropIn: { mode: 'off', enabled: true, priceAmount: 30 } },
        STUDIO
      ),
      { enabled: false, source: 'off' }
    )
  })

  it('a class on the LEGACY open tier has no door to price — everyone is already in', () => {
    // resolveClassCoverage covers everyone on it before looking at a price, so
    // a drop-in there is inert on the server; nothing may advertise it.
    for (const legacyOpen of [{ accessRule: { type: 'open' as const } }, { isFreeTrial: true }, {}]) {
      assert.deepEqual(
        resolveActivityDropIn(
          { type: 'class', ...legacyOpen, dropIn: { mode: 'custom', enabled: true, priceAmount: 30 } },
          STUDIO
        ),
        { enabled: false, source: 'off' }
      )
    }
    // A class asked the two questions and open to anyone is NOT that case:
    // there the price is exactly what a visitor pays.
    assert.deepEqual(
      resolveActivityDropIn(
        {
          type: 'class',
          accessRule: { type: 'open', audience: 'anyone', requirePlan: false },
          dropIn: { mode: 'studio', enabled: false },
        },
        STUDIO
      ),
      { enabled: true, priceAmount: 25, source: 'studio' }
    )
  })

  it('an appointment never has a drop-in', () => {
    assert.deepEqual(
      resolveActivityDropIn(
        { type: 'appointment', dropIn: { mode: 'custom', enabled: true, priceAmount: 30 } },
        STUDIO
      ),
      { enabled: false, source: 'off' }
    )
  })
})

describe('the pre-2026-09-11 document', () => {
  // No `mode`. A class that named a price keeps it; a class that did not
  // follows the studio — which is what makes the default apply without a
  // click per class.
  it('enabled + priced reads as custom', () => {
    assert.equal(dropInModeOf({ enabled: true, priceAmount: 30 }), 'custom')
    assert.deepEqual(
      resolveActivityDropIn({ type: 'class', accessRule: { type: 'members' }, dropIn: { enabled: true, priceAmount: 30 } }, STUDIO),
      { enabled: true, priceAmount: 30, source: 'custom' }
    )
  })

  it('{ enabled: false }, enabled without a price, and no field at all follow the studio', () => {
    assert.equal(dropInModeOf({ enabled: false }), 'studio')
    assert.equal(dropInModeOf({ enabled: true }), 'studio')
    assert.equal(dropInModeOf(undefined), 'studio')
    assert.equal(dropInModeOf(null), 'studio')
    assert.deepEqual(resolveActivityDropIn({ type: 'class', accessRule: { type: 'members' }, dropIn: { enabled: false } }, STUDIO), {
      enabled: true,
      priceAmount: 25,
      source: 'studio',
    })
    // …and stay exactly what they were while the studio has no default.
    assert.deepEqual(resolveActivityDropIn({ type: 'class', accessRule: { type: 'members' }, dropIn: { enabled: false } }, null), {
      enabled: false,
      source: 'studio',
    })
  })
})

describe('the studio default as stored', () => {
  it('narrows to a price or nothing', () => {
    assert.deepEqual(studioDropInOf({ dropIn: STUDIO }), STUDIO)
    assert.equal(studioDropInOf({ dropIn: { enabled: false, priceAmount: 25 } }), null)
    assert.equal(studioDropInOf({ dropIn: { enabled: true } }), null)
    assert.equal(studioDropInOf({}), null)
    assert.equal(studioDropInOf(undefined), null)
  })

  it('compares by value, so the fan-out can tell a real change from a rewrite', () => {
    assert.ok(sameDropInPrice(STUDIO, { enabled: true, priceAmount: 25 }))
    assert.ok(!sameDropInPrice(STUDIO, { enabled: true, priceAmount: 30 }))
    assert.ok(!sameDropInPrice(STUDIO, null))
    assert.ok(sameDropInPrice(null, null))
  })
})

describe('the activity mirror carries the RESOLVED price', () => {
  const base = { teamId: 't', type: 'class', name: 'MMA', accessRule: { type: 'members' } }

  it('a class that follows the studio mirrors the studio price', () => {
    const mirror = buildActivityPublicProfile({ ...base, dropIn: { enabled: false } }, STUDIO)
    assert.deepEqual(mirror.dropIn, { enabled: true, priceAmount: 25 })
  })

  it('…and no drop-in at all when the studio has none', () => {
    const mirror = buildActivityPublicProfile({ ...base, dropIn: { enabled: false } }, null)
    assert.ok(!('dropIn' in mirror))
  })

  it('a custom price is mirrored as before', () => {
    const mirror = buildActivityPublicProfile(
      { ...base, dropIn: { enabled: true, priceAmount: 30 } },
      STUDIO
    )
    assert.deepEqual(mirror.dropIn, { enabled: true, priceAmount: 30 })
  })

  it('a member rate on a class rides only with a live paid door — the studio default counts', () => {
    const benefit = { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 20 }
    const withStudio = buildActivityPublicProfile(
      { ...base, dropIn: { enabled: false }, memberBenefit: benefit },
      STUDIO
    )
    assert.deepEqual(withStudio.memberBenefit, benefit)
    const without = buildActivityPublicProfile(
      { ...base, dropIn: { enabled: false }, memberBenefit: benefit },
      null
    )
    assert.ok(!('memberBenefit' in without))
  })

  it('an appointment ignores the studio default', () => {
    const mirror = buildActivityPublicProfile(
      { teamId: 't', type: 'appointment', name: 'Coaching', durations: [{ minutes: 60, priceAmount: 80 }] },
      STUDIO
    )
    assert.ok(!('dropIn' in mirror))
  })
})
