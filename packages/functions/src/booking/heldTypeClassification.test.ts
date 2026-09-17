import assert from 'node:assert/strict'
import type { SubscriptionPrice } from '@linyup/shared'
import { heldTypeIsUnmetered } from './access'

// Is holding a plan of this type unmetered access, or credit-metered? Decided by
// the prices the contact's plan-list ENTRIES carry (docs/multi-plan-holdings.md,
// phase 3) — every held plan by the price it was given, where the loader used to
// read only the legacy slot's price.

const price = (p: Partial<SubscriptionPrice> & { id: string }): SubscriptionPrice =>
  ({ amount: 90, recurrence: 'monthly', ...p }) as SubscriptionPrice

const MIXED = [price({ id: 'monthly' }), price({ id: 'ten', recurrence: 'one_time', credits: 10 })]

describe('heldTypeIsUnmetered', () => {
  it('a type with no credit price is unmetered, whatever is held', () => {
    assert.equal(heldTypeIsUnmetered([price({ id: 'monthly' })], []), true)
    assert.equal(heldTypeIsUnmetered([], ['anything']), true)
  })

  it('a held non-credit price is unmetered; a held credit price alone is metered', () => {
    assert.equal(heldTypeIsUnmetered(MIXED, ['monthly']), true)
    assert.equal(heldTypeIsUnmetered(MIXED, ['ten']), false)
  })

  it('holding BOTH prices of one type is unmetered — the plan covers, the pack is extra', () => {
    assert.equal(heldTypeIsUnmetered(MIXED, ['ten', 'monthly']), true)
  })

  it('no held price known: lenient, unless the type sells only credits', () => {
    assert.equal(heldTypeIsUnmetered(MIXED, []), true)
    assert.equal(heldTypeIsUnmetered(MIXED, ['retired-price']), true)
    assert.equal(heldTypeIsUnmetered([price({ id: 'ten', credits: 10 })], []), false)
  })

  it('an inactive price is not a price', () => {
    const retiredPlan = [price({ id: 'monthly', active: false }), price({ id: 'ten', credits: 10 })]
    assert.equal(heldTypeIsUnmetered(retiredPlan, ['monthly']), false)
  })
})
