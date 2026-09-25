import assert from 'node:assert/strict'
import {
  courseBlockGatedPlanIds,
  courseBlockPlanEdge,
  courseBlockPlanEdgeUpdate,
  courseBlockPlanFacets,
  courseBlockRateChoiceOf,
  courseBlockRatedPlanIds,
  foldOfferingPlanEdgeUpdates,
  offeringPlanEdge,
  offeringRateEffects,
  plansSharingCourseBlockRate,
  rateHasAPriceToApplyTo,
  type CourseBlockEdgeFields,
} from '@linyup/shared'

// THE SCHEDULED COURSE ↔ PLAN EDGE — the third kind on the one edge editor.
//
// Two facets, two plain fields: `includedSubscriptionTypeIds` says who gets it
// FREE, `benefit` says who gets it CHEAPER. They are independent, and reading
// them as mutually exclusive is the commonest way this screen is misunderstood
// on every kind, so the pair is pinned here as it is for the other two.
//
// The rate rule is ONE rule shared by every plan, exactly like a class's. That
// is the hazard the editor's warning covers, and the reason
// `plansSharingCourseBlockRate` exists.
//
// Run with: pnpm --filter @linyup/functions test

const PRICED: CourseBlockEdgeFields = {
  priceAmount: 320,
  includedSubscriptionTypeIds: [],
  benefit: null,
}

describe('a scheduled course carries both facets, but only when it is priced', () => {
  it('bears plans when it has a price', () => {
    assert.deepEqual(courseBlockPlanFacets({ priceAmount: 320 }), { access: true, rate: true })
  })

  it('bears NONE when it is free, which is not a gap', () => {
    // A free course is already open to everybody: "included with Premium" says
    // nothing and a discount reduces nothing. The same answer the online course
    // gives for a tier that bears no plans.
    assert.deepEqual(courseBlockPlanFacets({ priceAmount: null }), { access: false, rate: false })
    assert.deepEqual(courseBlockPlanFacets({ priceAmount: 0 }), { access: false, rate: false })
  })

  it('has a price for a rate to reduce only when priced', () => {
    assert.equal(rateHasAPriceToApplyTo({ kind: 'course_block', doc: PRICED }), true)
    assert.equal(
      rateHasAPriceToApplyTo({ kind: 'course_block', doc: { ...PRICED, priceAmount: null } }),
      false
    )
  })

  it('refuses to write anything at all on a free course', () => {
    const update = courseBlockPlanEdgeUpdate(
      { ...PRICED, priceAmount: null },
      'premium',
      { access: true, rate: false }
    )
    assert.equal(update, null)
  })
})

describe('the two facets are independent', () => {
  it('includes a plan free without touching the rate', () => {
    const update = courseBlockPlanEdgeUpdate(PRICED, 'premium', { access: true, rate: false })
    assert.deepEqual(update?.includedSubscriptionTypeIds, ['premium'])
    // The rate key is ABSENT, not null: an unchanged field is not written at
    // all, which is what keeps a save from clobbering a rule somebody else set
    // between the read and the write.
    assert.ok(!('benefit' in (update ?? {})))
  })

  it('gives a plan a rate without including it', () => {
    const update = courseBlockPlanEdgeUpdate(PRICED, 'basic', { access: false, rate: true }, {
      effect: 'percent_off',
      percent: 20,
      amount: null,
    })
    assert.ok(!('includedSubscriptionTypeIds' in (update ?? {})))
    assert.deepEqual(update?.benefit, {
      subscriptionTypeIds: ['basic'],
      effect: 'percent_off',
      percent: 20,
    })
  })

  it('takes BOTH at once, which is what a limited plan needs', () => {
    // Included free AND a rate is not a contradiction: "included while the
    // allowance lasts, the member rate after that".
    const update = courseBlockPlanEdgeUpdate(PRICED, 'premium', { access: true, rate: true }, {
      effect: 'percent_off',
      percent: 10,
      amount: null,
    })
    assert.deepEqual(update?.includedSubscriptionTypeIds, ['premium'])
    assert.deepEqual((update?.benefit as { subscriptionTypeIds: string[] }).subscriptionTypeIds, [
      'premium',
    ])
  })

  it('reads back exactly what it wrote, from either entry point', () => {
    const doc: CourseBlockEdgeFields = {
      priceAmount: 320,
      includedSubscriptionTypeIds: ['premium'],
      benefit: { subscriptionTypeIds: ['basic'], effect: 'percent_off', percent: 20 },
    }
    assert.deepEqual(courseBlockPlanEdge(doc, 'premium'), { access: true, rate: false })
    assert.deepEqual(courseBlockPlanEdge(doc, 'basic'), { access: false, rate: true })
    // And through the kind-agnostic dispatch the editor actually calls.
    assert.deepEqual(offeringPlanEdge({ kind: 'course_block', doc }, 'basic'), {
      access: false,
      rate: true,
    })
  })
})

describe('a benefit meaning FREE is read as the gate', () => {
  // The resolver honors `included` on a course (COURSE_BLOCK_EFFECTS carries
  // it), so reading it as the rate instead would show a plan in neither column
  // while it was live in pricing: invisible and wrong.
  const legacy: CourseBlockEdgeFields = {
    priceAmount: 320,
    includedSubscriptionTypeIds: [],
    benefit: { subscriptionTypeIds: ['gold'], effect: 'included' },
  }

  it('counts it as access, never as a rate', () => {
    assert.deepEqual(courseBlockGatedPlanIds(legacy), ['gold'])
    assert.deepEqual(courseBlockRatedPlanIds(legacy), [])
    assert.deepEqual(courseBlockPlanEdge(legacy, 'gold'), { access: true, rate: false })
  })

  it('is ABSORBED into the id list on the next write, so nobody is counted twice', () => {
    const update = courseBlockPlanEdgeUpdate(legacy, 'silver', { access: true, rate: false })
    assert.deepEqual(update?.includedSubscriptionTypeIds, ['gold', 'silver'])
    assert.equal(update?.benefit, null, 'the legacy benefit is cleared by the same write')
  })

  it('never becomes the default choice for a fresh rate', () => {
    // On a course "included" is what the gate column says. Offering it in both
    // places is two controls for one fact.
    assert.deepEqual(courseBlockRateChoiceOf(legacy), { effect: 'percent_off' })
    assert.deepEqual(courseBlockRateChoiceOf(PRICED), { effect: 'percent_off' })
  })

  it('and the editor is not OFFERED it', () => {
    assert.deepEqual(offeringRateEffects({ kind: 'course_block', doc: PRICED }), [
      'percent_off',
      'fixed_price',
    ])
  })
})

describe('MANY EDGES ON ONE DOCUMENT fold into a single update', () => {
  it('two plans added in one save produce one list of two, not two lists of one', () => {
    // THE BUG THIS EXISTS FOR, on the kind that meets it hardest: the course
    // pane shows every plan as a row against ONE document, so "set all" is the
    // ordinary case rather than the edge one. Computing each update from the
    // same pre-transaction snapshot meant only the last row survived.
    const update = foldOfferingPlanEdgeUpdates({ kind: 'course_block', doc: PRICED }, [
      { subTypeId: 'premium', next: { access: true, rate: false } },
      { subTypeId: 'gold', next: { access: true, rate: false } },
    ])
    assert.deepEqual(update?.includedSubscriptionTypeIds, ['premium', 'gold'])
  })

  it('a removal in the same save sees the addition before it', () => {
    const doc: CourseBlockEdgeFields = { ...PRICED, includedSubscriptionTypeIds: ['gold'] }
    const update = foldOfferingPlanEdgeUpdates({ kind: 'course_block', doc }, [
      { subTypeId: 'premium', next: { access: true, rate: false } },
      { subTypeId: 'gold', next: { access: false, rate: false } },
    ])
    assert.deepEqual(update?.includedSubscriptionTypeIds, ['premium'])
  })
})

describe('the shared rate rule, and who else a change hits', () => {
  it('names every other plan on the same rule', () => {
    // One rule per course, so "20% off" set from Premium reprices Basic and Gold
    // too. The editor warns BEFORE the save because there is no per-pair slot to
    // fall back on and no undo afterwards.
    const doc: CourseBlockEdgeFields = {
      priceAmount: 320,
      includedSubscriptionTypeIds: [],
      benefit: {
        subscriptionTypeIds: ['premium', 'basic', 'gold'],
        effect: 'percent_off',
        percent: 20,
      },
    }
    assert.deepEqual(plansSharingCourseBlockRate(doc, 'premium'), ['basic', 'gold'])
  })
})

describe('no-op writes are refused', () => {
  it('ticking what is already ticked writes nothing', () => {
    const doc: CourseBlockEdgeFields = { ...PRICED, includedSubscriptionTypeIds: ['premium'] }
    assert.equal(courseBlockPlanEdgeUpdate(doc, 'premium', { access: true, rate: false }), null)
  })

  it('unticking what was never ticked writes nothing', () => {
    assert.equal(courseBlockPlanEdgeUpdate(PRICED, 'premium', { access: false, rate: false }), null)
  })
})
