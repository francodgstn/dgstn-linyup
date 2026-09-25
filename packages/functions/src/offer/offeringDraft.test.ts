import assert from 'node:assert/strict'
import {
  parseOfferingDraft,
  planKeysForActivity,
  OFFERING_DRAFT_LIMITS,
  type OfferingDraft,
} from '@linyup/shared'

// The parser IS the security boundary — the model's output reaches Firestore
// through it and nothing else — so these tests are about what it REFUSES and
// what it silently drops, not about the happy path.

const ok = () => ({
  activities: [{ key: 'yoga', name: 'Yoga Basics' }],
  plans: [{ key: 'unlimited', name: 'Unlimited', prices: [{ amount: 89, recurrence: 'monthly' }] }],
})

describe('parseOfferingDraft', () => {
  it('accepts a minimal well-formed draft', () => {
    const { draft, problems } = parseOfferingDraft(ok())
    assert.deepEqual(problems, [])
    assert.equal(draft!.activities[0].name, 'Yoga Basics')
    assert.equal(draft!.plans[0].prices![0].amount, 89)
  })

  // ── the three constraints the safety argument rests on ────────────────────

  it('DROPS an id the model tried to smuggle in', () => {
    const { draft } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', id: 'existing-activity-id' }],
      plans: [],
    })
    assert.equal(Object.hasOwn(draft!.activities[0], 'id'), false)
  })

  it('DROPS a teamId — the tenant is never the draft to choose', () => {
    const { draft } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', teamId: 'someone-elses-team' }],
      plans: [],
    })
    assert.equal(Object.hasOwn(draft!.activities[0], 'teamId'), false)
  })

  it('DROPS any field the schema does not name', () => {
    const { draft } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', payments: { enabled: true }, base_score: 999 }],
      plans: [],
      contacts: [{ name: 'not a thing this can create' }],
    })
    assert.deepEqual(draft!.activities[0], { key: 'a', name: 'A' })
    assert.equal(Object.hasOwn(draft!, 'contacts'), false)
  })

  it('refuses a link to anything outside the draft', () => {
    const { draft, problems } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', planKeys: ['real-plan-id-from-firestore'] }],
      plans: [{ key: 'p', name: 'P' }],
    })
    assert.equal(draft!.activities[0].planKeys, undefined)
    assert.equal(problems.some((x) => x.code === 'unknown_key'), true)
  })

  // ── enums, money and color ───────────────────────────────────────────────

  it('refuses an unknown activity type rather than defaulting it', () => {
    const { draft, problems } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', type: 'workshop' }],
      plans: [],
    })
    assert.equal(draft!.activities[0].type, undefined)
    assert.equal(problems.some((x) => x.path === 'activities[0].type' && x.code === 'bad_enum'), true)
  })

  it('refuses an unknown recurrence, and the price with it', () => {
    const { draft, problems } = parseOfferingDraft({
      activities: [],
      plans: [{ key: 'p', name: 'P', prices: [{ amount: 10, recurrence: 'fortnightly' }] }],
    })
    assert.equal(draft!.plans[0].prices, undefined)
    assert.equal(problems.some((x) => x.code === 'bad_enum'), true)
  })

  it('refuses negative, NaN and absurd money', () => {
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) {
      const { draft } = parseOfferingDraft({
        activities: [],
        plans: [{ key: 'p', name: 'P', prices: [{ amount, recurrence: 'monthly' }] }],
      })
      assert.equal(draft!.plans[0].prices, undefined, String(amount))
    }
  })

  it('refuses a color that is not a plain hex — it feeds an inline style', () => {
    const { draft, problems } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', color: 'red; background: url(https://evil)' }],
      plans: [],
    })
    assert.equal(draft!.activities[0].color, undefined)
    assert.equal(problems.some((x) => x.code === 'bad_colour'), true)
  })

  // ── caps ──────────────────────────────────────────────────────────────────

  it('caps the number of records one prompt can produce', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `a${i}`, name: `A${i}` }))
    const { draft, problems } = parseOfferingDraft({ activities: many, plans: [] })
    assert.equal(draft!.activities.length, OFFERING_DRAFT_LIMITS.activities)
    assert.equal(problems.some((x) => x.code === 'too_many'), true)
  })

  it('refuses a duplicate key across activities and plans alike', () => {
    const { problems } = parseOfferingDraft({
      activities: [{ key: 'same', name: 'A' }],
      plans: [{ key: 'same', name: 'P' }],
    })
    assert.equal(problems.some((x) => x.code === 'duplicate_key'), true)
  })

  it('returns nothing at all for input that is not an object', () => {
    for (const junk of [null, undefined, 'a string', 42, []]) {
      assert.equal(parseOfferingDraft(junk).draft, null, String(junk))
    }
  })

  it('returns nothing when every record was rejected', () => {
    const { draft, problems } = parseOfferingDraft({ activities: [{ name: 'no key' }], plans: [] })
    assert.equal(draft, null)
    assert.ok(problems.length > 0)
  })
})

describe('planKeysForActivity — either side may express a link', () => {
  const base: OfferingDraft = {
    activities: [
      { key: 'yoga', name: 'Yoga', planKeys: ['unlimited'] },
      { key: 'bjj', name: 'BJJ' },
      { key: 'solo', name: 'Solo' },
    ],
    plans: [
      { key: 'unlimited', name: 'Unlimited', activityKeys: ['bjj'] },
      { key: 'starter', name: 'Starter', activityKeys: ['yoga'] },
    ],
  }

  it('reads a link written from the activity', () => {
    assert.deepEqual(planKeysForActivity(base, 'bjj'), ['unlimited'])
  })

  it('reads a link written from the plan', () => {
    assert.ok(planKeysForActivity(base, 'yoga').includes('starter'))
  })

  it('unions both directions without duplicating', () => {
    assert.deepEqual(planKeysForActivity(base, 'yoga').sort(), ['starter', 'unlimited'])
  })

  it('is empty for an activity nothing points at', () => {
    assert.deepEqual(planKeysForActivity(base, 'solo'), [])
  })
})
