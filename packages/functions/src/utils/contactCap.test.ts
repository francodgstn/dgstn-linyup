import * as assert from 'node:assert'
import { PLAN_PRICING } from '@linyup/shared'
import { underHardContactCap } from './contactCap'

describe('underHardContactCap', () => {
  const freeCap = PLAN_PRICING.free.includedContacts!

  it('blocks the free plan at its included-contacts cap', () => {
    assert.strictEqual(underHardContactCap('free', freeCap - 1), true)
    assert.strictEqual(underHardContactCap('free', freeCap), false)
    assert.strictEqual(underHardContactCap('free', freeCap + 5), false)
  })

  it('never blocks soft-capped paid plans', () => {
    for (const plan of ['coach', 'studio', 'organization'] as const) {
      assert.strictEqual(underHardContactCap(plan, 10_000), true)
    }
  })

  it('confirmed count excludes provisional registrations (caller subtracts)', () => {
    // At-cap actives of which 3 are provisional → still under the cap.
    assert.strictEqual(underHardContactCap('free', freeCap + 3 - 3 - 3), true)
    assert.strictEqual(underHardContactCap('free', freeCap - 3), true)
  })
})
