import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeBenefit, parseOfferingSetup, type SetupClass, type SetupPlan } from '@linyup/shared'
import { newClassDocument, planDocument, setupPlanFields } from './offeringWriter'

// The setup wizard's answers → the documents it creates, through the writer the
// AI draft shares (offer/offeringWriter.ts). Decisions: the courses plan file,
// section 8 (Franco, 2026-09-26).

const stamp = { teamId: 't1', uid: 'u1', order: 3, createdVia: 'wizard' as const }
const cls = (over: Partial<SetupClass> = {}): SetupClass => ({
  name: 'Tuesday Yoga',
  signupRequired: false,
  includedPlanIds: [],
  dropIn: { mode: 'off' },
  ...over,
})

describe('parseOfferingSetup: what the wizard may send', () => {
  it('reads a class, dropping anything it does not name', () => {
    const { setup, problems } = parseOfferingSetup({
      kind: 'class',
      teamId: 'someone-else',
      class: { name: ' Yoga ', signupRequired: true, includedPlanIds: ['p1', 'p1'], dropIn: { mode: 'studio' }, id: 'x' },
    })
    assert.deepEqual(problems, [])
    assert.deepEqual(setup, {
      kind: 'class',
      class: { name: 'Yoga', signupRequired: true, includedPlanIds: ['p1'], dropIn: { mode: 'studio' } },
    })
  })
  it('refuses a price nobody can be charged, and a member rate for no plan', () => {
    assert.equal(parseOfferingSetup({ kind: 'class', class: { ...cls(), dropIn: { mode: 'custom', priceAmount: 0.2 } } }).setup, null)
    assert.equal(
      parseOfferingSetup({
        kind: 'class',
        class: { ...cls(), dropIn: { mode: 'custom', priceAmount: 25 }, memberRate: { planIds: [], effect: 'percent_off', percent: 20 } },
      }).setup,
      null
    )
  })
  it('refuses an id that is not one', () => {
    assert.equal(parseOfferingSetup({ kind: 'class', class: { ...cls(), includedPlanIds: ['../x'] } }).setup, null)
  })
  it('a membership needs a price, a pack needs its classes', () => {
    const plan = { name: 'Unlimited', public: true, includedActivityIds: [] }
    assert.equal(parseOfferingSetup({ kind: 'plan', plan: { ...plan, kind: 'membership' } }).setup, null)
    assert.equal(parseOfferingSetup({ kind: 'plan', plan: { ...plan, kind: 'pack', packAmount: 150 } }).setup, null)
    assert.ok(parseOfferingSetup({ kind: 'plan', plan: { ...plan, kind: 'pack', packAmount: 150, credits: 10 } }).setup)
  })
  it('refuses a setup of no known kind', () => {
    assert.equal(parseOfferingSetup({ kind: 'course' }).setup, null)
  })
})

describe('newClassDocument: one answer, one document', () => {
  it('"included in my membership": the plan includes it and nothing is sold at the door', () => {
    const doc = newClassDocument(cls({ includedPlanIds: ['p1'] }), stamp, null)
    assert.deepEqual(doc.accessRule, { audience: 'anyone', subscriptionTypeIds: ['p1'] })
    assert.deepEqual(doc.dropIn, { mode: 'off' })
    assert.equal(doc.type, 'class')
    assert.equal(doc.created_via, 'wizard')
    assert.equal(doc.slug, 'tuesday-yoga')
  })
  it('"only people who signed up with me" is the wall', () => {
    const doc = newClassDocument(cls({ signupRequired: true, dropIn: { mode: 'studio' } }), stamp, null)
    assert.equal((doc.accessRule as { audience: string }).audience, 'members')
  })
  it('a trial where the door grants something, at the price given', () => {
    const doc = newClassDocument(cls({ includedPlanIds: ['p1'], trial: { priceAmount: 15 } }), stamp, null)
    assert.equal(doc.trialEnabled, true)
    assert.equal(doc.trialPriceAmount, 15)
  })
  it('no trial on a class free to anyone: there is nothing to try before committing to', () => {
    const doc = newClassDocument(cls({ trial: {} }), stamp, null)
    assert.equal(doc.trialEnabled, false)
    assert.equal(doc.trialPriceAmount, null)
  })
  it('"members pay less": a member rate on the drop-in price, through the edge writer', () => {
    const doc = newClassDocument(
      cls({
        dropIn: { mode: 'custom', priceAmount: 25 },
        memberRate: { planIds: ['p2'], effect: 'percent_off', percent: 20 },
      }),
      stamp,
      null
    )
    assert.deepEqual(doc.dropIn, { mode: 'custom', priceAmount: 25 })
    const rate = normalizeBenefit(doc.memberBenefit as never)
    assert.deepEqual(rate?.subscriptionTypeIds, ['p2'])
    assert.equal(rate?.effect, 'percent_off')
    assert.equal(rate?.percent, 20)
    // The access facet is untouched: p2 does not include the class.
    assert.deepEqual(doc.accessRule, { audience: 'anyone' })
  })
  it('no member rate where there is no drop-in price for it to lower', () => {
    const doc = newClassDocument(
      cls({ includedPlanIds: ['p1'], memberRate: { planIds: ['p2'], effect: 'fixed_price', amount: 10 } }),
      stamp,
      null
    )
    assert.equal(doc.memberBenefit, null)
  })
  it('the AI draft shape: a price is the class own price, none follows the studio', () => {
    assert.deepEqual(newClassDocument(cls({ dropIn: { mode: 'custom', priceAmount: 25 } }), stamp, null).dropIn, {
      mode: 'custom',
      priceAmount: 25,
    })
    assert.deepEqual(newClassDocument(cls({ dropIn: { mode: 'studio' } }), stamp, null).dropIn, { mode: 'studio' })
  })
})

describe('planDocument + setupPlanFields: the plan kinds', () => {
  const plan = (over: Partial<SetupPlan>): SetupPlan => ({
    name: 'Unlimited',
    kind: 'membership',
    public: true,
    includedActivityIds: [],
    ...over,
  })
  const build = (p: SetupPlan) => planDocument(setupPlanFields(p), stamp, (i) => `plan-${i}`)

  it('a membership: monthly and yearly prices, a limit, and an intro price on the monthly one', () => {
    const doc = build(
      plan({ monthlyAmount: 89, annualAmount: 890, limit: { count: 2, per: 'week' }, intro: { amount: 0, periods: 1 } })
    )
    assert.deepEqual(doc.prices, [
      { amount: 89, recurrence: 'monthly', id: 'plan-0', active: true },
      { amount: 890, recurrence: 'annual', id: 'plan-1', active: true },
    ])
    assert.deepEqual(doc.limits, [{ count: 2, per: 'week' }])
    assert.deepEqual(doc.introOffers, [{ priceId: 'plan-0', periods: 1, amount: 0 }])
    assert.equal(doc.source, 'internal')
    assert.equal(doc.public, true)
    assert.equal('isActive' in doc, false, 'a plan is `active`, never `isActive`')
  })
  it('a pack: one price, its classes and how long they stay valid', () => {
    const doc = build(plan({ kind: 'pack', packAmount: 150, credits: 10, validMonths: 6 }))
    assert.deepEqual(doc.prices, [
      { amount: 150, recurrence: 'one_time', credits: 10, included_months: 6, id: 'plan-0', active: true },
    ])
  })
  it('complimentary carries no prices at all', () => {
    assert.equal('prices' in build(plan({ kind: 'complimentary', public: false })), false)
  })
  it('a partner app: aggregator source and what it pays per visit', () => {
    const doc = build(plan({ kind: 'partner', payoutPerVisit: 12, public: false }))
    assert.equal(doc.source, 'aggregator')
    assert.equal(doc.payoutPerVisit, 12)
  })
})

describe('one writer, two ways in', () => {
  // Read as source: a document literal written inline in either caller is
  // exactly how the AI applier drifted onto a drop-in shape the forms no longer
  // write. Only the writer builds a slug, and both callers import it.
  const read = (f: string) => readFileSync(join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')
  for (const file of ['draftOfferings.ts', 'offeringSetup.ts']) {
    it(`${file} builds its documents through offeringWriter`, () => {
      const src = read(file)
      assert.ok(src.includes("from './offeringWriter'"), 'imports the writer')
      assert.equal((src.match(/\bslug\s*:/g) ?? []).length, 0, 'builds no activity document itself')
      assert.equal((src.match(/\bdropIn\s*:\s*\{/g) ?? []).length, 0, 'writes no drop-in shape itself')
    })
  }
})
