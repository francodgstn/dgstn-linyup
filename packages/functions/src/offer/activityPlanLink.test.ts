import assert from 'node:assert/strict'
import {
  activityPlanEdge,
  activityPlanEdgeUpdate,
  activityRateChoiceOf,
  gatedPlanIds,
  plansSharingRate,
  ratedPlanIds,
  coursePlanEdge,
  coursePlanEdgeUpdate,
  activityPlanFacets,
  foldOfferingPlanEdgeUpdates,
  coursePlanFacets,
  courseGatedPlanIds,
  anyRatedPlanIds,
  benefitOpensDoorAt,
  offeringRateEffects,
  offeringRateLengths,
  rateHasAPriceToApplyTo,
  plansSharingCourseRate,
  type ActivityEdgeFields,
  type CourseEdgeFields,
} from '@linyup/shared'

// The activity ↔ plan edge, which the catalogue page edits from BOTH directions.
// The headline test is `same edge, either direction`; every other case here
// exists because getting it wrong shipped once already.
// Run with: pnpm --filter @linyup/functions test

function cls(overrides: Partial<ActivityEdgeFields> = {}): ActivityEdgeFields {
  return { type: 'class', ...overrides } as ActivityEdgeFields
}

function appt(overrides: Partial<ActivityEdgeFields> = {}): ActivityEdgeFields {
  return { type: 'appointment', ...overrides } as ActivityEdgeFields
}

const OFF = { access: false, rate: false }

describe('the activity ↔ plan edge', () => {
  describe('same edge, either direction', () => {
    // THE PROPERTY THE CATALOGUE EXISTS TO GUARANTEE. Both directions call this
    // one function with the same arguments, so what this really pins is that no
    // second write path has grown back beside it.
    it('gating a class produces one document regardless of which side asked', () => {
      const fresh = cls()
      const fromActivity = activityPlanEdgeUpdate(fresh, 'premium', { access: true, rate: false })
      const fromPlan = activityPlanEdgeUpdate(fresh, 'premium', { access: true, rate: false })
      assert.deepEqual(fromActivity, fromPlan)
      // A document with no rule at all is a legacy OPEN class; the write
      // upgrades it to the two-field shape and adds the plan — who may book
      // is untouched, which is the whole point of the pair.
      assert.deepEqual(fromActivity, {
        accessRule: {
          type: 'open',
          audience: 'anyone',
          requirePlan: false,
          subscriptionTypeIds: ['premium'],
        },
        isFreeTrial: true,
      })
    })

    it('setting a rate on an appointment produces one document either way', () => {
      const fresh = appt({ memberBenefit: { subscriptionTypeIds: ['basic'], effect: 'included' } })
      const rate = { effect: 'percent_off' as const, percent: 20 }
      const fromActivity = activityPlanEdgeUpdate(fresh, 'premium', { access: false, rate: true }, rate)
      const fromPlan = activityPlanEdgeUpdate(fresh, 'premium', { access: false, rate: true }, rate)
      assert.deepEqual(fromActivity, fromPlan)
      assert.deepEqual(fromActivity, {
        memberBenefit: {
          subscriptionTypeIds: ['basic', 'premium'],
          effect: 'percent_off',
          percent: 20,
        },
      })
    })
  })

  describe('the two facets are independent', () => {
    // A single "linked" boolean could not express this, and quietly picked one
    // of the two fields to write.
    it('a class can be gated to a plan AND give it a rate, in one write', () => {
      const update = activityPlanEdgeUpdate(cls(), 'premium', { access: true, rate: true }, {
        effect: 'percent_off',
        percent: 25,
      })
      assert.deepEqual(update, {
        memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 25 },
        accessRule: {
          type: 'open',
          audience: 'anyone',
          requirePlan: false,
          subscriptionTypeIds: ['premium'],
        },
        isFreeTrial: true,
      })
    })

    it('dropping the gate leaves the rate standing', () => {
      const fresh = cls({
        accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
        memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 25 },
      })
      const update = activityPlanEdgeUpdate(fresh, 'premium', { access: false, rate: true })
      assert.deepEqual(update, {
        accessRule: { type: 'subscription', audience: 'members', requirePlan: true },
        isFreeTrial: false,
      })
      assert.ok(!(update && 'memberBenefit' in update), 'the rate was not asked to change')
    })

    it('dropping the rate leaves the gate standing', () => {
      const fresh = cls({
        accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
        memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 25 },
      })
      const update = activityPlanEdgeUpdate(fresh, 'premium', { access: true, rate: false })
      assert.deepEqual(update, { memberBenefit: null })
    })
  })

  describe('an appointment has no access gate', () => {
    // The UX-69 regression guard. The price is the gate, so a tick from the plan
    // side that landed on `accessRule` would invent a gate no booking path reads.
    it('never grows an accessRule, even when access is asked for', () => {
      const update = activityPlanEdgeUpdate(appt(), 'premium', { access: true, rate: true })
      assert.ok(update)
      assert.ok(!('accessRule' in update), 'appointment must not grow an accessRule')
      assert.ok(!('isFreeTrial' in update), 'and must not be stamped as a non-trial')
      assert.equal(
        (update.memberBenefit as { subscriptionTypeIds: string[] }).subscriptionTypeIds[0],
        'premium'
      )
    })

    it('reports access as false however the document is shaped', () => {
      assert.deepEqual(activityPlanEdge(appt(), 'premium'), { access: false, rate: false })
      assert.deepEqual(gatedPlanIds(appt()), [])
    })

    it('clears the rule outright when the last plan comes off it', () => {
      // null, not an empty rule: an empty id list means NO benefit, and a rule
      // with no holders is still a rule the resolver has to consider.
      const fresh = appt({ memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'included' } })
      assert.deepEqual(activityPlanEdgeUpdate(fresh, 'premium', OFF), { memberBenefit: null })
    })

    it('keeps the stored effect when a plan comes off, ignoring any draft', () => {
      // A row whose controls were hidden can still be carrying a draft. Writing
      // it would reprice whoever STAYS on the rule, which is not what removing a
      // different plan asked for.
      const fresh = appt({
        memberBenefit: {
          subscriptionTypeIds: ['basic', 'premium'],
          effect: 'percent_off',
          percent: 15,
        },
      })
      const update = activityPlanEdgeUpdate(fresh, 'premium', OFF, {
        effect: 'fixed_price',
        amount: 99,
      })
      assert.deepEqual(update, {
        memberBenefit: { subscriptionTypeIds: ['basic'], effect: 'percent_off', percent: 15 },
      })
    })
  })

  describe('a class gate', () => {
    it('still requires a plan when the last plan is removed — never widens', () => {
      // The studio said only plan holders may book. Dropping the last plan is
      // not them changing their mind about that: the door stays as it was and
      // the pricing page's health check names the empty list. (It used to fall
      // back to `members`, which silently let every member in.)
      const fresh = cls({ accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] } })
      assert.deepEqual(activityPlanEdgeUpdate(fresh, 'premium', OFF), {
        accessRule: { type: 'subscription', audience: 'members', requirePlan: true },
        isFreeTrial: false,
      })
    })

    it('keeps the remaining plans when one of several is removed', () => {
      const fresh = cls({
        accessRule: { type: 'subscription', subscriptionTypeIds: ['basic', 'premium', 'gold'] },
      })
      assert.deepEqual(activityPlanEdgeUpdate(fresh, 'premium', OFF), {
        accessRule: {
          type: 'subscription',
          audience: 'members',
          requirePlan: true,
          subscriptionTypeIds: ['basic', 'gold'],
        },
        isFreeTrial: false,
      })
    })

    it('a legacy subscription class WITH a drop-in was already open to a paying stranger', () => {
      // The old tier let anyone buy in once a price existed; the upgrade says
      // so out loud rather than pretending the wall was there.
      const fresh = cls({
        accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
        dropIn: { enabled: true, priceAmount: 25 },
      })
      assert.deepEqual(activityPlanEdgeUpdate(fresh, 'gold', { access: true, rate: false }), {
        accessRule: {
          type: 'open',
          audience: 'anyone',
          requirePlan: false,
          subscriptionTypeIds: ['premium', 'gold'],
        },
        isFreeTrial: true,
      })
    })

    it('a legacy members class keeps its wall when a plan is ticked included', () => {
      // THE BUG, on an un-migrated document: this used to write
      // `{type:'subscription'}`, which a drop-in price then read as open.
      const fresh = cls({
        accessRule: { type: 'members' },
        dropIn: { enabled: true, priceAmount: 25 },
      })
      assert.deepEqual(activityPlanEdgeUpdate(fresh, 'premium', { access: true, rate: false }), {
        accessRule: {
          type: 'members',
          audience: 'members',
          requirePlan: false,
          subscriptionTypeIds: ['premium'],
        },
        isFreeTrial: false,
      })
    })
  })

  describe('a class asked the two questions', () => {
    // The pricing form writes `audience` + `requirePlan`; `type` is only their
    // projection. Until 2026-09-10 the edge rebuilt `accessRule` from the id
    // list alone, and "members only" with a drop-in price came back as OPEN.
    const membersNoPlan = {
      type: 'members' as const,
      audience: 'members' as const,
      requirePlan: false,
    }

    it('keeps who may book when a plan is ticked included', () => {
      const fresh = cls({
        accessRule: membersNoPlan,
        dropIn: { enabled: true, priceAmount: 25 },
      })
      const update = activityPlanEdgeUpdate(fresh, 'premium', { access: true, rate: false })
      assert.deepEqual(update, {
        accessRule: { ...membersNoPlan, subscriptionTypeIds: ['premium'] },
        isFreeTrial: false,
      })
    })

    it('keeps the legacy isFreeTrial flag in step with the pair, as the form does', () => {
      const anyone = { type: 'open' as const, audience: 'anyone' as const, requirePlan: false }
      const update = activityPlanEdgeUpdate(cls({ accessRule: anyone }), 'premium', {
        access: true,
        rate: false,
      })
      assert.equal(update?.isFreeTrial, true)
    })

    it('reads the list whatever the display tier says', () => {
      assert.deepEqual(
        gatedPlanIds(cls({ accessRule: { ...membersNoPlan, subscriptionTypeIds: ['premium'] } })),
        ['premium']
      )
      assert.deepEqual(
        gatedPlanIds(
          cls({
            accessRule: {
              type: 'open',
              audience: 'anyone',
              requirePlan: false,
              subscriptionTypeIds: ['premium'],
            },
          })
        ),
        ['premium']
      )
    })

    it('keeps the pair when the last plan comes off, dropping only the list', () => {
      const fresh = cls({
        accessRule: { ...membersNoPlan, subscriptionTypeIds: ['premium'] },
      })
      const update = activityPlanEdgeUpdate(fresh, 'premium', OFF)
      assert.deepEqual(update, { accessRule: membersNoPlan, isFreeTrial: false })
    })

    it('a plan required stays required, and its tier stays subscription', () => {
      const planRequired = {
        type: 'subscription' as const,
        audience: 'members' as const,
        requirePlan: true,
        subscriptionTypeIds: ['premium'],
      }
      const update = activityPlanEdgeUpdate(cls({ accessRule: planRequired }), 'gold', {
        access: true,
        rate: false,
      })
      assert.deepEqual(update, {
        accessRule: { ...planRequired, subscriptionTypeIds: ['premium', 'gold'] },
        isFreeTrial: false,
      })
    })

    it('open to anyone with a drop-in price offers both facets', () => {
      assert.deepEqual(
        activityPlanFacets({
          type: 'class',
          accessRule: { type: 'open', audience: 'anyone', requirePlan: false },
        }),
        { access: true, rate: true }
      )
    })
  })

  describe('no-op writes are refused', () => {
    it('returns null when both facets are already as asked', () => {
      const fresh = cls({ accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] } })
      assert.equal(activityPlanEdgeUpdate(fresh, 'premium', { access: true, rate: false }), null)
    })

    it('returns null when there is nothing to remove', () => {
      assert.equal(activityPlanEdgeUpdate(cls(), 'premium', OFF), null)
    })

    it('returns null for an appointment already carrying that exact rule', () => {
      const fresh = appt({
        memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 20 },
      })
      assert.equal(
        activityPlanEdgeUpdate(fresh, 'premium', { access: false, rate: true }, {
          effect: 'percent_off',
          percent: 20,
        }),
        null
      )
    })

    it('still writes when only the RATE VALUE changed on an already-rated plan', () => {
      const fresh = appt({
        memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 20 },
      })
      assert.deepEqual(
        activityPlanEdgeUpdate(fresh, 'premium', { access: false, rate: true }, {
          effect: 'percent_off',
          percent: 30,
        }),
        {
          memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 30 },
        }
      )
    })
  })

  describe('reading the edge', () => {
    it('reads the gate for a class and the rule for an appointment', () => {
      assert.deepEqual(
        gatedPlanIds(cls({ accessRule: { type: 'subscription', subscriptionTypeIds: ['a'] } })),
        ['a']
      )
      assert.deepEqual(
        ratedPlanIds(appt({ memberBenefit: { subscriptionTypeIds: ['b'], effect: 'included' } })),
        ['b']
      )
    })

    it('reports no gate for a class that is open or members-only', () => {
      assert.deepEqual(gatedPlanIds(cls({ accessRule: { type: 'open' } })), [])
      assert.deepEqual(gatedPlanIds(cls({ accessRule: { type: 'members' } })), [])
    })

    it('reads a rule stored in the legacy appointment shape', () => {
      // Reading past `normalizeBenefit` would make an old rule look unlinked,
      // and an unlinked-looking tick gets wiped on the next save.
      const legacy = appt({
        memberBenefit: { subscriptionTypeIds: ['old'], kind: 'discount', discountPercent: 10 },
      } as Partial<ActivityEdgeFields>)
      assert.deepEqual(ratedPlanIds(legacy), ['old'])
      assert.deepEqual(activityRateChoiceOf(legacy), {
        effect: 'percent_off',
        percent: 10,
        amount: null,
      })
    })
  })

  describe('plansSharingRate names who else a rate change hits', () => {
    it('lists the other plans on the rule', () => {
      const fresh = appt({
        memberBenefit: { subscriptionTypeIds: ['basic', 'premium', 'gold'], effect: 'included' },
      })
      assert.deepEqual(plansSharingRate(fresh, 'premium'), ['basic', 'gold'])
    })

    it('is empty when the plan is alone on the rule — nothing to warn about', () => {
      const fresh = appt({ memberBenefit: { subscriptionTypeIds: ['premium'], effect: 'included' } })
      assert.deepEqual(plansSharingRate(fresh, 'premium'), [])
    })
  })
})

describe('the course ↔ plan edge', () => {
  // The per-tier rules are not a choice made in the editor; they are what
  // `resolvePaymentOptions`' course arm honours. A control offered on a tier
  // that ignores the field writes successfully, shows no error, and changes
  // nothing a member sees — which is the failure these tests exist to stop.
  const course = (accessRule: Record<string, unknown>, benefit?: unknown) =>
    ({ accessRule, benefit } as unknown as CourseEdgeFields)

  describe('MANY EDGES ON ONE DOCUMENT fold into a single update', () => {
    // Local fixture: the shared `activity` helper is scoped to another block.
    const activity = (doc: Record<string, unknown>) => doc as never
    // The `from-offering` direction puts every PLAN on one activity, so a save
    // that touched several rows wrote several updates to the same ref — each
    // computed from the same snapshot, each overwriting the last. Only the
    // bottom row survived.
    it('adds every ticked plan to the gate, not just the last', () => {
      const fresh = activity({ type: 'class', accessRule: { type: 'members' } })
      const update = foldOfferingPlanEdgeUpdates({ kind: 'activity', doc: fresh } as never, [
        { subTypeId: 'premium', next: { access: true, rate: false } },
        { subTypeId: 'elite', next: { access: true, rate: false } },
        { subTypeId: 'starter', next: { access: true, rate: false } },
      ])
      assert.deepEqual(update, {
        accessRule: {
          type: 'members',
          audience: 'members',
          requirePlan: false,
          subscriptionTypeIds: ['premium', 'elite', 'starter'],
        },
        isFreeTrial: false,
      })
    })

    it('collects every rated plan onto the ONE rate rule', () => {
      const fresh = activity({ type: 'class', dropIn: { enabled: true, priceAmount: 25 } })
      const update = foldOfferingPlanEdgeUpdates({ kind: 'activity', doc: fresh } as never, [
        { subTypeId: 'premium', next: { access: false, rate: true },
          choice: { effect: 'percent_off', percent: 20 } },
        { subTypeId: 'elite', next: { access: false, rate: true },
          choice: { effect: 'percent_off', percent: 20 } },
      ])
      assert.deepEqual(update, {
        memberBenefit: {
          subscriptionTypeIds: ['premium', 'elite'],
          effect: 'percent_off',
          percent: 20,
        },
      })
    })

    it('a removal after an addition leaves only the addition', () => {
      const fresh = activity({
        type: 'class',
        accessRule: { type: 'subscription', subscriptionTypeIds: ['starter'] },
      })
      const update = foldOfferingPlanEdgeUpdates({ kind: 'activity', doc: fresh } as never, [
        { subTypeId: 'premium', next: { access: true, rate: false } },
        { subTypeId: 'starter', next: { access: false, rate: false } },
      ])
      assert.deepEqual(update, {
        accessRule: {
          type: 'subscription',
          audience: 'members',
          requirePlan: true,
          subscriptionTypeIds: ['premium'],
        },
        isFreeTrial: false,
      })
    })

    it('returns null when no edit changes anything', () => {
      const fresh = activity({
        type: 'class',
        accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
      })
      assert.equal(
        foldOfferingPlanEdgeUpdates({ kind: 'activity', doc: fresh } as never, [
          { subTypeId: 'premium', next: { access: true, rate: false } },
        ]),
        null
      )
    })
  })

  describe('an OPEN class carries neither facet', () => {
    it('has no gate to write and no price to reduce', () => {
      // Read off resolvePaymentOptions: its drop_in arm calls
      // resolveClassCoverage FIRST, and an open class comes back covered — so
      // it returns before applyModifiers and nobody ever pays.
      assert.deepEqual(activityPlanFacets({ type: 'class', accessRule: { type: 'open' } }), {
        access: false,
        rate: false,
      })
    })

    it('still carries both when someone has to qualify', () => {
      for (const rule of [
        { type: 'members' as const },
        { type: 'subscription' as const, subscriptionTypeIds: ['premium'] },
      ]) {
        assert.deepEqual(activityPlanFacets({ type: 'class', accessRule: rule }), {
          access: true,
          rate: true,
        })
      }
    })

    it('a legacy class with no accessRule falls back through resolveActivityAccessRule', () => {
      // `isFreeTrial !== false` means open, which is the pre-accessRule default.
      assert.equal(activityPlanFacets({ type: 'class' }).access, false)
      assert.equal(activityPlanFacets({ type: 'class', isFreeTrial: false }).access, true)
    })

    it('an appointment is unaffected — its price is its gate', () => {
      assert.deepEqual(activityPlanFacets({ type: 'appointment' }), {
        access: false,
        rate: true,
      })
    })
  })

  describe('which facets each tier honours', () => {
    it('free and registered honour neither', () => {
      assert.deepEqual(coursePlanFacets(course({ type: 'free' })), { access: false, rate: false })
      assert.deepEqual(coursePlanFacets(course({ type: 'registered' })), {
        access: false,
        rate: false,
      })
    })

    it('both plan-bearing tiers honour BOTH — the same pair a class carries', () => {
      // Until 2026-09-01 these were exclusive per tier, which is what made
      // "Premium free, Elite 20% off" inexpressible on a course while being
      // ordinary on a class.
      for (const doc of [
        course({ type: 'subscription' }),
        course({ type: 'purchase', priceAmount: 49 }),
      ]) {
        assert.deepEqual(coursePlanFacets(doc), { access: true, rate: true })
      }
    })

    it('a subscription-tier rate is honoured but INERT until there is a price', () => {
      // Offered, so a studio can set it up before pricing the course — and
      // dimmed, because the resolver's subscription branch returns before it
      // reads `benefit`. Exactly a class that sells no drop-in yet.
      assert.equal(coursePlanFacets(course({ type: 'subscription' })).rate, true)
      assert.equal(
        rateHasAPriceToApplyTo({ kind: 'course', doc: course({ type: 'subscription' }) as never }),
        false
      )
    })
  })

  describe('writes', () => {
    it('writes BOTH facets when both are asked for', () => {
      const update = coursePlanEdgeUpdate(
        course({ type: 'purchase', priceAmount: 49 }),
        'premium',
        { access: true, rate: true },
        { effect: 'percent_off', percent: 30 }
      )
      assert.deepEqual(update, {
        benefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 30 },
        accessRule: { type: 'purchase', priceAmount: 49, subscriptionTypeIds: ['premium'] },
      })
    })

    it('gates without rating when only access is asked for', () => {
      const update = coursePlanEdgeUpdate(course({ type: 'subscription' }), 'premium', {
        access: true,
        rate: false,
      })
      assert.deepEqual(update, {
        accessRule: { type: 'subscription', subscriptionTypeIds: ['premium'] },
      })
      assert.ok(update && !('benefit' in update), 'no rate was asked for')
    })

    it('keeps the tier when the last plan comes off the gate', () => {
      // Demoting to 'registered' would hand a paid course to every signed-in
      // contact. An empty gate is reported by the pricing health check instead.
      const fresh = course({ type: 'subscription', subscriptionTypeIds: ['premium'] })
      assert.deepEqual(coursePlanEdgeUpdate(fresh, 'premium', OFF), {
        accessRule: { type: 'subscription', subscriptionTypeIds: [] },
      })
    })

    it('rates a purchase-tier course without gating it', () => {
      const update = coursePlanEdgeUpdate(
        course({ type: 'purchase', priceAmount: 49 }),
        'premium',
        { access: false, rate: true },
        { effect: 'percent_off', percent: 30 }
      )
      assert.deepEqual(update, {
        benefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 30 },
      })
      assert.ok(update && !('accessRule' in update), 'no gate was asked for')
    })

    it('ABSORBS a legacy `included` benefit into the gate on first touch', () => {
      // The old spelling of "these plans get it free". Read as part of the gate,
      // then moved there and cleared — the whole migration, done lazily, with no
      // backfill to deploy.
      const fresh = course({ type: 'purchase', priceAmount: 49 }, {
        subscriptionTypeIds: ['premium', 'elite'],
        effect: 'included',
      })
      const update = coursePlanEdgeUpdate(
        fresh,
        'sportpass',
        { access: false, rate: true },
        { effect: 'percent_off', percent: 20 }
      )
      assert.deepEqual(update, {
        benefit: { subscriptionTypeIds: ['sportpass'], effect: 'percent_off', percent: 20 },
        accessRule: {
          type: 'purchase',
          priceAmount: 49,
          subscriptionTypeIds: ['premium', 'elite'],
        },
      })
    })

    it('writes nothing at all on a free or registered course', () => {
      // Both facets asked for, neither honoured.
      const asked = { access: true, rate: true }
      assert.equal(coursePlanEdgeUpdate(course({ type: 'free' }), 'premium', asked), null)
      assert.equal(coursePlanEdgeUpdate(course({ type: 'registered' }), 'premium', asked), null)
    })

    it('clears a purchase course RATE when its last plan comes off', () => {
      const fresh = course({ type: 'purchase', priceAmount: 49 }, {
        subscriptionTypeIds: ['premium'],
        effect: 'percent_off',
        percent: 20,
      })
      assert.deepEqual(coursePlanEdgeUpdate(fresh, 'premium', OFF), { benefit: null })
    })

    it('takes the last plan off a legacy `included` list as a GATE removal', () => {
      const fresh = course({ type: 'purchase', priceAmount: 49 }, {
        subscriptionTypeIds: ['premium'],
        effect: 'included',
      })
      // Only the benefit is written: the plan leaves the gate the legacy list
      // was standing in for, and the STORED gate — which was empty — ends up
      // empty either way, so there is nothing to write there.
      assert.deepEqual(coursePlanEdgeUpdate(fresh, 'premium', OFF), { benefit: null })
    })

    it('returns null when the edge is already as asked', () => {
      const fresh = course({ type: 'subscription', subscriptionTypeIds: ['premium'] })
      assert.equal(coursePlanEdgeUpdate(fresh, 'premium', { access: true, rate: false }), null)
    })
  })

  describe('reading', () => {
    it('reports no gate on a tier that has none', () => {
      assert.deepEqual(courseGatedPlanIds(course({ type: 'purchase', priceAmount: 9 })), [])
      assert.deepEqual(coursePlanEdge(course({ type: 'free' }), 'premium'), {
        access: false,
        rate: false,
      })
    })

    it('names the other plans on a shared course rate', () => {
      const fresh = course({ type: 'purchase', priceAmount: 49 }, {
        subscriptionTypeIds: ['basic', 'premium'],
        effect: 'percent_off',
        percent: 10,
      })
      assert.deepEqual(plansSharingCourseRate(fresh, 'premium'), ['basic'])
    })
  })
})

// ── Which rate effects an editor may OFFER ───────────────────────────────────
// The editor kept its own list and offered `included` on every rate row. On a
// CLASS the resolver ignores that effect — coverage there is the access rule's
// job — so a studio could tick "members get it included", save it, and watch
// members pay the full drop-in price anyway. Two controls that read as two ways
// to say "free", one of them inert.
//
// These assertions are the guard: `offeringRateEffects` derives from the very
// sets `resolvePaymentOptions` honours, so an effect can never again be offered
// where it would be dropped.
describe('offeringRateEffects — the editor offers only what the resolver honours', () => {
  const activityTarget = (type: 'class' | 'appointment') =>
    ({ kind: 'activity' as const, doc: { type } as never })
  const courseTarget = (type: 'free' | 'purchase' | 'subscription') =>
    ({ kind: 'course' as const, doc: { accessRule: { type } } as never })

  it('a CLASS gets price effects only — never `included`', () => {
    assert.deepEqual(offeringRateEffects(activityTarget('class')), [
      'percent_off',
      'fixed_price',
    ])
  })

  it('an APPOINTMENT keeps `included` — it is the only way to say "books free"', () => {
    // The mirror image of the class: an appointment has no access facet at all
    // (the price is the gate), so removing `included` there would take away the
    // only control that expresses a covered appointment.
    assert.deepEqual(offeringRateEffects(activityTarget('appointment')), [
      'included',
      'percent_off',
      'fixed_price',
    ])
  })

  it('a PURCHASE course keeps `included` — its tier has no gate to say it with', () => {
    assert.deepEqual(offeringRateEffects(courseTarget('purchase')), [
      'included',
      'percent_off',
      'fixed_price',
    ])
  })

  it('never offers `spend_credits` — the resolver honours it, no editor writes it', () => {
    for (const t of [
      activityTarget('class'),
      activityTarget('appointment'),
      courseTarget('purchase'),
    ]) {
      assert.ok(!offeringRateEffects(t).includes('spend_credits' as never))
    }
  })
})

// ── Whether a member RATE has a price to reduce ──────────────────────────────
// A rate is a discount ON something, and that something can be absent: a
// members-only class that sells no drop-in has no second price, so "20% off"
// there reduces nothing. The editor mutes the price effects when this is false
// rather than letting a studio configure a rule that silently never applies.
describe('rateHasAPriceToApplyTo', () => {
  const activity = (doc: Record<string, unknown>) =>
    ({ kind: 'activity' as const, doc: doc as never })

  it('a class needs an ENABLED drop-in carrying a real price', () => {
    assert.equal(rateHasAPriceToApplyTo(activity({ type: 'class' })), false)
    assert.equal(
      rateHasAPriceToApplyTo(activity({ type: 'class', dropIn: { enabled: false, priceAmount: 25 } })),
      false
    )
    assert.equal(
      rateHasAPriceToApplyTo(activity({ type: 'class', dropIn: { enabled: true } })),
      false
    )
    assert.equal(
      rateHasAPriceToApplyTo(activity({ type: 'class', dropIn: { enabled: true, priceAmount: 0 } })),
      false
    )
    assert.equal(
      rateHasAPriceToApplyTo(activity({ type: 'class', dropIn: { enabled: true, priceAmount: 25 } })),
      true
    )
  })

  it('an appointment needs at least one PRICED duration', () => {
    assert.equal(rateHasAPriceToApplyTo(activity({ type: 'appointment' })), false)
    assert.equal(
      rateHasAPriceToApplyTo(
        activity({ type: 'appointment', durations: [{ minutes: 60, priceAmount: null }] })
      ),
      false
    )
    assert.equal(
      rateHasAPriceToApplyTo(
        activity({
          type: 'appointment',
          durations: [{ minutes: 30 }, { minutes: 60, priceAmount: 90 }],
        })
      ),
      true
    )
  })

  it("a course's price IS its sale, so an unsold one has nothing to reduce", () => {
    const has = (accessRule: unknown) =>
      rateHasAPriceToApplyTo({ kind: 'course', doc: { accessRule } as never })
    assert.equal(has({ type: 'purchase', priceAmount: 49 }), true)
    assert.equal(has({ type: 'purchase' }), false, 'on sale but unpriced')
    assert.equal(has({ type: 'purchase', priceAmount: 0 }), false)
    assert.equal(has({ type: 'subscription', subscriptionTypeIds: ['premium'] }), false)
  })
})

// ─── ONE RULE PER SESSION LENGTH ─────────────────────────────────────────────
//
// An appointment's price is attached to its length, so a rule about that price
// is too (see `ActivityDurationBenefit`). Every case below was a way this could
// go wrong that a reviewer had to reason about rather than read.
describe('appointment member rules, per session length', () => {
  const twoLengths = {
    durations: [
      { minutes: 30, priceAmount: 60 },
      { minutes: 90, priceAmount: 120 },
    ],
  }

  it('reads the rule for the length asked about, not the activity', () => {
    const a = appt({
      ...twoLengths,
      durationBenefits: [
        { minutes: 30, benefit: { subscriptionTypeIds: ['premium'], effect: 'included' } },
        { minutes: 90, benefit: null },
      ],
    })
    assert.deepEqual(ratedPlanIds(a, 30), ['premium'])
    assert.deepEqual(ratedPlanIds(a, 90), [])
    assert.equal(activityPlanEdge(a, 'premium', 30).rate, true)
    assert.equal(activityPlanEdge(a, 'premium', 90).rate, false)
  })

  it('an activity nobody has re-edited behaves exactly as before', () => {
    // The migration is invisible: no `durationBenefits` ⇒ the activity-wide
    // rule still answers for every length, which is what stops this change
    // needing a backfill.
    const a = appt({
      ...twoLengths,
      memberBenefit: { subscriptionTypeIds: ['basic'], kind: 'included' },
    })
    assert.deepEqual(ratedPlanIds(a, 30), ['basic'])
    assert.deepEqual(ratedPlanIds(a, 90), ['basic'])
    assert.deepEqual(ratedPlanIds(a), ['basic'], 'and the legacy whole-activity read still works')
  })

  it('the FIRST per-length write absorbs the legacy rule onto every length', () => {
    // THE BUG THIS PINS: seeding only the edited length would leave 90 min
    // reading a field the same update clears — a member who booked free
    // yesterday silently starts paying, because the studio touched 30 min.
    const fresh = appt({
      ...twoLengths,
      memberBenefit: { subscriptionTypeIds: ['basic'], kind: 'included' },
    })
    const update = activityPlanEdgeUpdate(
      fresh,
      'premium',
      { access: false, rate: true },
      { effect: 'percent_off', percent: 20 },
      30
    )
    assert.deepEqual(update, {
      durationBenefits: [
        {
          minutes: 30,
          benefit: {
            subscriptionTypeIds: ['basic', 'premium'],
            effect: 'percent_off',
            percent: 20,
          },
        },
        { minutes: 90, benefit: { subscriptionTypeIds: ['basic'], effect: 'included' } },
      ],
      memberBenefit: null,
    })
  })

  it('clearing a length says NO RULE, and does not fall back to the old one', () => {
    const fresh = appt({
      ...twoLengths,
      memberBenefit: { subscriptionTypeIds: ['basic'], kind: 'included' },
    })
    const update = activityPlanEdgeUpdate(fresh, 'basic', OFF, undefined, 30)
    const after = { ...fresh, ...update } as ActivityEdgeFields
    assert.deepEqual(ratedPlanIds(after, 30), [], 'the length the studio cleared')
    assert.deepEqual(ratedPlanIds(after, 90), ['basic'], 'the one they did not touch')
  })

  it('edits to DIFFERENT lengths of one document fold into one payload', () => {
    // THE BUG THIS PINS: `durationBenefits` is written whole, so folding per
    // target — one fold per length — would have each rewrite the array from the
    // pre-save document and only the last would survive. Exactly the defect the
    // fold was written for, one level down.
    const fresh = appt(twoLengths)
    const update = foldOfferingPlanEdgeUpdates({ kind: 'activity', doc: fresh }, [
      {
        subTypeId: 'premium',
        next: { access: false, rate: true },
        choice: { effect: 'included' },
        minutes: 30,
      },
      {
        subTypeId: 'basic',
        next: { access: false, rate: true },
        choice: { effect: 'percent_off', percent: 10 },
        minutes: 90,
      },
    ])
    assert.deepEqual(update, {
      durationBenefits: [
        { minutes: 30, benefit: { subscriptionTypeIds: ['premium'], effect: 'included' } },
        {
          minutes: 90,
          benefit: { subscriptionTypeIds: ['basic'], effect: 'percent_off', percent: 10 },
        },
      ],
    })
  })

  it('a rate is dimmed against the length that has no price, not the activity', () => {
    const doc = appt({ durations: [{ minutes: 30 }, { minutes: 90, priceAmount: 120 }] })
    assert.equal(rateHasAPriceToApplyTo({ kind: 'activity', doc, minutes: 30 }), false)
    assert.equal(rateHasAPriceToApplyTo({ kind: 'activity', doc, minutes: 90 }), true)
    assert.equal(
      rateHasAPriceToApplyTo({ kind: 'activity', doc }),
      true,
      'the whole-activity question is still "any of them"'
    )
  })

  it('the whole-activity count is the UNION, so the summary survives the migration', () => {
    // `ratedPlanIds(a)` alone reads the legacy field, which the first
    // per-length write CLEARS — so a summary built on it would report "no
    // member rate" as a reward for using the new editor.
    const a = appt({
      ...twoLengths,
      durationBenefits: [
        { minutes: 30, benefit: { subscriptionTypeIds: ['premium'], effect: 'included' } },
        {
          minutes: 90,
          benefit: { subscriptionTypeIds: ['basic'], effect: 'percent_off', percent: 10 },
        },
      ],
    })
    assert.deepEqual(ratedPlanIds(a), [], 'the legacy field is gone')
    assert.deepEqual(anyRatedPlanIds(a).sort(), ['basic', 'premium'])
  })

  it('only an INCLUDED rule opens a benefit-only length, and it is asked per length', () => {
    const a = appt({
      durations: [
        { minutes: 30, benefitOnly: true },
        { minutes: 90, benefitOnly: true },
      ],
      durationBenefits: [
        { minutes: 30, benefit: { subscriptionTypeIds: ['premium'], effect: 'included' } },
        {
          minutes: 90,
          benefit: { subscriptionTypeIds: ['premium'], effect: 'percent_off', percent: 50 },
        },
      ],
    })
    assert.equal(benefitOpensDoorAt(a, 30), true)
    assert.equal(
      benefitOpensDoorAt(a, 90),
      false,
      'a percentage off a price that does not exist opens nothing'
    )
  })

  it('an orphaned rule is kept, so un-ticking a length by accident is undoable', () => {
    const fresh = appt({
      durations: [{ minutes: 30, priceAmount: 60 }],
      durationBenefits: [
        { minutes: 90, benefit: { subscriptionTypeIds: ['basic'], effect: 'included' } },
      ],
    })
    const update = activityPlanEdgeUpdate(
      fresh,
      'premium',
      { access: false, rate: true },
      { effect: 'included' },
      30
    )
    assert.deepEqual(update, {
      durationBenefits: [
        { minutes: 30, benefit: { subscriptionTypeIds: ['premium'], effect: 'included' } },
        { minutes: 90, benefit: { subscriptionTypeIds: ['basic'], effect: 'included' } },
      ],
    })
  })

  it('a class is untouched by any of this — one rule, on the activity', () => {
    const fresh = cls({ dropIn: { enabled: true, priceAmount: 30 } })
    const update = activityPlanEdgeUpdate(
      fresh,
      'premium',
      { access: false, rate: true },
      { effect: 'percent_off', percent: 20 }
    )
    assert.deepEqual(update, {
      memberBenefit: {
        subscriptionTypeIds: ['premium'],
        effect: 'percent_off',
        percent: 20,
      },
    })
    assert.deepEqual(offeringRateLengths({ kind: 'activity', doc: fresh }), [])
  })

  it('an appointment with no lengths set still asks about the fallback one', () => {
    assert.deepEqual(offeringRateLengths({ kind: 'activity', doc: appt() }), [60])
  })
})
