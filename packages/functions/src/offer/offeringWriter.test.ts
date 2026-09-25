import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeBenefit,
  parseOfferingSetup,
  resolveDurationBenefit,
  type SetupAppointment,
  type SetupClass,
  type SetupCourse,
  type SetupPlan,
} from '@linyup/shared'
import { resolveCourseSchedule } from '../courseBlocks/schedule'
import {
  newClassDocument,
  planDocument,
  setupAppointmentDocument,
  setupCourseLinks,
  setupCourseWrite,
  setupPlanFields,
} from './offeringWriter'

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

describe('appointments: each length, and the member deal per length', () => {
  const appt = (over: Partial<SetupAppointment> = {}): SetupAppointment => ({
    name: 'Private lesson',
    lengths: [
      { minutes: 30, sale: 'free' },
      { minutes: 60, sale: 'priced', priceAmount: 90 },
      { minutes: 90, sale: 'plan_only' },
    ],
    memberDeal: { planIds: ['p1'], effect: 'included' },
    ...over,
  })

  it('parses a free intro beside a paid hour and a plan-only length', () => {
    const { setup, problems } = parseOfferingSetup({ kind: 'appointment', appointment: appt() })
    assert.deepEqual(problems, [])
    assert.equal(setup?.kind, 'appointment')
  })
  it('a plan-only length needs plans that INCLUDE it: a discount opens nothing', () => {
    const { problems } = parseOfferingSetup({
      kind: 'appointment',
      appointment: appt({ memberDeal: { planIds: ['p1'], effect: 'percent_off', percent: 10 } }),
    })
    assert.ok(problems.some((p) => p.path === 'appointment.memberDeal'))
  })
  it('a fixed member price is asked for every priced length', () => {
    const { problems } = parseOfferingSetup({
      kind: 'appointment',
      appointment: appt({
        lengths: [{ minutes: 60, sale: 'priced', priceAmount: 90 }],
        memberDeal: { planIds: ['p1'], effect: 'fixed_price' },
      }),
    })
    assert.deepEqual(problems, [{ path: 'appointment.lengths.0.memberAmount', code: 'missing' }])
  })
  it('refuses the same length twice', () => {
    const lengths = [
      { minutes: 60, sale: 'free' },
      { minutes: 60, sale: 'free' },
    ]
    assert.equal(parseOfferingSetup({ kind: 'appointment', appointment: { name: 'X', lengths } }).setup, null)
  })

  it('writes each length as the pricing form would, a plan-only one with no price to quote', () => {
    const doc = setupAppointmentDocument(appt(), stamp)
    assert.equal(doc.type, 'appointment')
    assert.deepEqual(doc.durations, [
      { minutes: 30, priceAmount: null },
      { minutes: 60, priceAmount: 90 },
      { minutes: 90, priceAmount: null, benefitOnly: true },
    ])
  })
  it('"included": on the paid and the plan-only lengths, never on the free one', () => {
    const doc = setupAppointmentDocument(appt(), stamp) as never
    assert.equal(resolveDurationBenefit(doc, 30), null)
    assert.deepEqual(normalizeBenefit(resolveDurationBenefit(doc, 60))?.subscriptionTypeIds, ['p1'])
    assert.equal(normalizeBenefit(resolveDurationBenefit(doc, 90))?.effect, 'included')
  })
  it('"a fixed member price": each length at its own amount', () => {
    const doc = setupAppointmentDocument(
      appt({
        lengths: [
          { minutes: 30, sale: 'priced', priceAmount: 50, memberAmount: 40 },
          { minutes: 90, sale: 'priced', priceAmount: 130, memberAmount: 110 },
        ],
        memberDeal: { planIds: ['p1', 'p2'], effect: 'fixed_price' },
      }),
      stamp
    ) as never
    assert.equal(normalizeBenefit(resolveDurationBenefit(doc, 30))?.amount, 40)
    assert.equal(normalizeBenefit(resolveDurationBenefit(doc, 90))?.amount, 110)
    assert.deepEqual(normalizeBenefit(resolveDurationBenefit(doc, 90))?.subscriptionTypeIds, ['p1', 'p2'])
  })
})

describe('courses: the wizard answers, as the course creator reads them', () => {
  const course = (over: Partial<SetupCourse> = {}): SetupCourse => ({
    name: 'Autumn swim course',
    schedule: { kind: 'dates', meetings: [{ startMs: Date.UTC(2026, 9, 10, 8), minutes: 45 }] },
    priceAmount: 364,
    includedPlanIds: [],
    signupRequired: false,
    ...over,
  })

  it('a free course takes no plan links: there is nothing to include or discount', () => {
    const { problems } = parseOfferingSetup({
      kind: 'course',
      course: { ...course({ includedPlanIds: ['p1'] }), priceAmount: undefined },
    })
    assert.deepEqual(problems, [{ path: 'course.priceAmount', code: 'missing' }])
  })
  it('refuses a schedule of no known shape, and a lesson that is not a date', () => {
    assert.equal(parseOfferingSetup({ kind: 'course', course: { ...course(), schedule: { kind: 'x' } } }).setup, null)
    assert.equal(
      parseOfferingSetup({
        kind: 'course',
        course: { ...course(), schedule: { kind: 'dates', meetings: [{ startMs: 5, minutes: 45 }] } },
      }).setup,
      null
    )
  })
  it('links: included plans on the gate, cheaper plans on the rate, free wins on both', () => {
    const links = setupCourseLinks(
      course({ includedPlanIds: ['p1'], memberRate: { planIds: ['p1', 'p2'], effect: 'percent_off', percent: 20 } })
    )
    assert.deepEqual(links.includedSubscriptionTypeIds, ['p1'])
    const rate = normalizeBenefit(links.benefit)
    assert.deepEqual(rate?.subscriptionTypeIds, ['p2'])
    assert.equal(rate?.percent, 20)
  })
  it('no links on a free course, whatever was asked', () => {
    const links = setupCourseLinks({ ...course({ includedPlanIds: ['p1'] }), priceAmount: undefined })
    assert.deepEqual(links, { includedSubscriptionTypeIds: [], benefit: null })
  })
  it('a weekly course resolves through the real schedule resolver, a skipped day costing no lesson', () => {
    // Wednesdays 7.10 to 4.11, no lesson on 21.10: four lessons, not five.
    const write = setupCourseWrite(
      course({
        signupRequired: true,
        places: 9,
        closeDaysBefore: 3,
        schedule: {
          kind: 'weekly',
          startMs: new Date(2026, 9, 7, 15, 45).getTime(),
          minutes: 45,
          weekday: new Date(2026, 9, 7).getDay(),
          endMs: new Date(2026, 10, 4, 23, 59).getTime(),
          skipMs: [new Date(2026, 9, 21, 12).getTime()],
        },
      })
    )
    assert.equal(write.audience, 'members')
    assert.equal(write.places, 9)
    assert.equal(write.closeDaysBefore, 3)
    const { meetings, recurrence } = resolveCourseSchedule(write.schedule!)
    assert.equal(meetings.length, 4)
    assert.equal(recurrence?.endCondition, 'date')
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

  // A course is a document, an owned series and its lessons, written in an
  // order that matters. A second creator is the drift this pins against: the
  // wizard reaches the course creator, and so does the course form's callable.
  it('a course is made by the course creator, from the wizard and from the form', () => {
    const setup = read('offeringSetup.ts')
    assert.ok(setup.includes('createCourseBlockRecord('), 'the wizard calls the course creator')
    assert.equal(
      (setup.match(/\b(COURSE_BLOCKS_COLLECTION|SESSION_SERIES_COLLECTION|materializeOccurrences)\b/g) ?? []).length,
      0,
      'the wizard writes no course, series or lesson itself'
    )
    const courses = read('../courseBlocks/index.ts')
    const callable = courses.slice(courses.indexOf('export const createCourseBlock = onCall'))
    assert.ok(
      callable.slice(0, callable.indexOf('\n})\n') + 4).includes('createCourseBlockRecord('),
      'createCourseBlock goes through the creator'
    )
  })
})
