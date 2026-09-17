import assert from 'node:assert/strict'
import {
  classAccessChip,
  classAccessFacts,
  classAccessRuleFor,
  type ClassAccessInput,
} from '@linyup/shared'

// WHO MAY BOOK A CLASS, derived from its prices (docs/class-access-derived.md).
// The table in `utils/classAccess.ts` is what these pin, case by case, plus the
// two readings that must NOT change: an included plan decides access, a member
// rate never does.
// Run with: pnpm --filter @linyup/functions test

const STUDIO = { enabled: true, priceAmount: 25 }
const NO_STUDIO = null

/** A class asked the modern questions — no legacy tier to reason about. */
function cls(overrides: Partial<ClassAccessInput> = {}): ClassAccessInput {
  return {
    type: 'class',
    accessRule: { type: 'open', audience: 'anyone', requirePlan: false },
    dropIn: { mode: 'off', enabled: false },
    ...overrides,
  } as ClassAccessInput
}

const included = (ids: string[]): Partial<ClassAccessInput> => ({
  accessRule: {
    type: 'members' as const,
    audience: 'members' as const,
    requirePlan: false,
    subscriptionTypeIds: ids,
  },
})

describe('who may book a class', () => {
  describe('the table', () => {
    it('a drop-in price lets anyone in, with or without plans', () => {
      const paid = classAccessFacts(cls({ dropIn: { mode: 'studio', enabled: false } }), STUDIO)
      assert.equal(paid.dropIn.priceAmount, 25)
      assert.equal(paid.free, false)
      assert.equal(paid.planHoldersOnly, false)
      assert.equal(classAccessChip(paid), 'paid_anyone')

      const withPlan = classAccessFacts(
        cls({ ...included(['premium']), dropIn: { mode: 'custom', enabled: true, priceAmount: 30 } }),
        STUDIO
      )
      assert.equal(withPlan.dropIn.priceAmount, 30)
      assert.equal(withPlan.planHoldersOnly, false)
      assert.deepEqual(withPlan.includedPlanIds, ['premium'])
    })

    it('a plan and no price means plan holders only', () => {
      const f = classAccessFacts(cls(included(['premium'])), STUDIO)
      assert.equal(f.planHoldersOnly, true)
      assert.equal(f.free, false)
      assert.equal(classAccessChip(f), 'plan_holders')
    })

    it('no price and no plan is free', () => {
      const f = classAccessFacts(cls(), STUDIO)
      assert.equal(f.free, true)
      assert.equal(f.planHoldersOnly, false)
      assert.equal(classAccessChip(f), 'free_anyone')
    })

    it('the studio default is the door — a class following it is not free', () => {
      const following = cls({ dropIn: { mode: 'studio', enabled: false } })
      assert.equal(classAccessFacts(following, STUDIO).free, false)
      // …and the same class under a studio with no default has no door at all.
      assert.equal(classAccessFacts(following, NO_STUDIO).free, true)
    })
  })

  describe('a MEMBER PRICE never decides access', () => {
    // The whole point of the split: `memberBenefit` reduces what a holder pays,
    // `accessRule.subscriptionTypeIds` says who may book. A class with a price
    // and a discounting plan stays open to everyone.
    it('a plan on the rate alone leaves the class open', () => {
      const f = classAccessFacts(
        cls({
          dropIn: { mode: 'custom', enabled: true, priceAmount: 25 },
          memberBenefit: { effect: 'percent_off', percentOff: 20, subscriptionTypeIds: ['premium'] },
        } as Partial<ClassAccessInput>),
        STUDIO
      )
      assert.deepEqual(f.includedPlanIds, [])
      assert.equal(f.planHoldersOnly, false)
      assert.equal(classAccessChip(f), 'paid_anyone')
    })

    it('…and does not keep a class off the free state when the door closes', () => {
      const f = classAccessFacts(
        cls({
          dropIn: { mode: 'off', enabled: false },
          memberBenefit: { effect: 'percent_off', percentOff: 20, subscriptionTypeIds: ['premium'] },
        } as Partial<ClassAccessInput>),
        STUDIO
      )
      assert.equal(f.free, true)
    })
  })

  describe('the sign-up switch', () => {
    it('keeps the club case: free for people who signed up, closed to visitors', () => {
      const f = classAccessFacts(
        cls({ accessRule: { type: 'members', audience: 'members', requirePlan: false } }),
        STUDIO
      )
      assert.equal(f.signupRequired, true)
      assert.equal(f.free, true)
      assert.equal(classAccessChip(f), 'free_members')
    })

    it('and rides on a paid class too', () => {
      const f = classAccessFacts(
        cls({
          accessRule: { type: 'members', audience: 'members', requirePlan: false },
          dropIn: { mode: 'studio', enabled: false },
        }),
        STUDIO
      )
      assert.equal(classAccessChip(f), 'paid_members')
    })
  })

  describe('the trial', () => {
    it('is available on anything but a free class', () => {
      assert.equal(classAccessFacts(cls(), STUDIO).trialAvailable, false)
      assert.equal(
        classAccessFacts(cls({ dropIn: { mode: 'studio', enabled: false } }), STUDIO).trialAvailable,
        true
      )
      assert.equal(classAccessFacts(cls(included(['premium'])), STUDIO).trialAvailable, true)
    })
  })

  describe('legacy documents, until the backfill', () => {
    it('a legacy open class is free and sells nothing', () => {
      const f = classAccessFacts(
        { type: 'class', accessRule: { type: 'open' }, dropIn: { enabled: true, priceAmount: 30 } },
        STUDIO
      )
      assert.equal(f.free, true)
      assert.equal(f.dropIn.enabled, false)
    })

    it('a legacy members class keeps its wall, and the studio default is its door', () => {
      // A legacy document names no `dropIn.mode`, so it FOLLOWS the studio
      // (`dropInModeOf`) — shipped with the default itself (#289). Under a studio
      // with a default it is "members pay 25", not "free for members".
      const paid = classAccessFacts({ type: 'class', accessRule: { type: 'members' } }, STUDIO)
      assert.equal(paid.signupRequired, true)
      assert.equal(paid.free, false)
      assert.equal(classAccessChip(paid), 'paid_members')

      const free = classAccessFacts({ type: 'class', accessRule: { type: 'members' } }, NO_STUDIO)
      assert.equal(free.free, true)
      assert.equal(classAccessChip(free), 'free_members')
    })

    it('a legacy subscription class with a door lets a payer in', () => {
      const f = classAccessFacts(
        {
          type: 'class',
          accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
          dropIn: { mode: 'studio', enabled: false },
        },
        STUDIO
      )
      assert.equal(f.signupRequired, false)
      assert.equal(f.planHoldersOnly, false)
      assert.deepEqual(f.includedPlanIds, ['premium'])
    })

    it('…and without one it is plan holders only', () => {
      const f = classAccessFacts(
        {
          type: 'class',
          accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
          dropIn: { mode: 'off', enabled: false },
        },
        STUDIO
      )
      assert.equal(f.planHoldersOnly, true)
      // A legacy document with no `dropIn` at all follows the studio, so the
      // same class is plan-holders-only only where there is no default to follow.
      const noDefault = classAccessFacts(
        { type: 'class', accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] } },
        NO_STUDIO
      )
      assert.equal(noDefault.planHoldersOnly, true)
    })
  })

  describe('an appointment answers nothing here', () => {
    it('the price is its gate', () => {
      const f = classAccessFacts({ type: 'appointment', durations: [{ minutes: 60, priceAmount: 90 }] } as ClassAccessInput, STUDIO)
      assert.equal(f.free, false)
      assert.equal(f.trialAvailable, false)
      assert.equal(f.dropIn.enabled, false)
      assert.deepEqual(f.includedPlanIds, [])
    })
  })

  describe('classAccessRuleFor — what a writer stores', () => {
    it('derives requirePlan from the plans and the door', () => {
      assert.deepEqual(
        classAccessRuleFor({ signupRequired: false, includedPlanIds: ['premium'], paidDoor: false }),
        { type: 'subscription', audience: 'members', requirePlan: true, subscriptionTypeIds: ['premium'] }
      )
      assert.deepEqual(
        classAccessRuleFor({ signupRequired: false, includedPlanIds: ['premium'], paidDoor: true }),
        { type: 'open', audience: 'anyone', requirePlan: false, subscriptionTypeIds: ['premium'] }
      )
    })

    it('a free class with no plans is open, and the switch walls it', () => {
      assert.deepEqual(classAccessRuleFor({ signupRequired: false, includedPlanIds: [], paidDoor: false }), {
        type: 'open',
        audience: 'anyone',
        requirePlan: false,
      })
      assert.deepEqual(classAccessRuleFor({ signupRequired: true, includedPlanIds: [], paidDoor: false }), {
        type: 'members',
        audience: 'members',
        requirePlan: false,
      })
    })

    it('what it stores is what classAccessFacts reads back', () => {
      // The transition's one invariant: no surface may derive one answer while
      // a writer stores another.
      for (const paidDoor of [false, true]) {
        for (const ids of [[], ['premium']]) {
          for (const signupRequired of [false, true]) {
            const accessRule = classAccessRuleFor({ signupRequired, includedPlanIds: ids, paidDoor })
            const facts = classAccessFacts(
              {
                type: 'class',
                accessRule,
                dropIn: paidDoor
                  ? { mode: 'custom', enabled: true, priceAmount: 25 }
                  : { mode: 'off', enabled: false },
              },
              STUDIO
            )
            assert.deepEqual(facts.includedPlanIds, ids)
            assert.equal(facts.planHoldersOnly, ids.length > 0 && !paidDoor)
            assert.equal(facts.free, ids.length === 0 && !paidDoor)
            // The wall is kept — and a plan-required class is walled by construction.
            assert.equal(facts.signupRequired, signupRequired || facts.planHoldersOnly)
          }
        }
      }
    })
  })
})
