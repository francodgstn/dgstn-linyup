import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildActivityPublicProfile } from './syncActivityPublicProfile'

// THE MIRROR AND ITS READER, ASSERTED AGAINST EACH OTHER.
//
// `buildActivityPublicProfile` is the only writer of the world-readable activity
// document, and the public booking form rebuilds its own object out of it field
// by field. Nothing connected the two, and twice the writer grew a field the
// reader never picked up:
//
//   • `bookingGroup` — the public page's section headings. Written since the
//     feature shipped, never mapped, so `groupActivitiesForBooking` saw
//     `undefined` for every activity and the page rendered one unnamed section.
//     The feature was dead from the day it landed and nothing failed.
//   • `durationBenefits` — mapped now for the reason its own comment gives:
//     `resolveDurationBenefit` reads the PRESENCE of the list to decide whether
//     the activity-wide `memberBenefit` still applies, so a reader holding one
//     half quotes a rule the server has stopped honouring.
//
// Both are the same defect, and neither is visible in a type error, a lint run
// or a rendering test — the reader compiles perfectly while silently dropping a
// field. So this test asserts the CAUSE structurally: every key the writer can
// emit is named by the reader's mapping block. A new mirror field fails here
// until somebody decides, in writing, whether the booking form wants it.
//
// It reads the web SOURCE rather than importing it: `apps/web` has no test
// runner, and the claim is about the mapping TEXT, not about a value.
//
// Run with: pnpm --filter @linyup/functions test

/** SRC → packages/functions → packages → worktree root. This census spans the
 *  functions/web boundary, which is exactly where a correction stops
 *  travelling. */
const ROOT = join(__dirname, '..', '..', '..', '..')

/** Line endings normalised: the working tree is LF on CI and CRLF on Windows,
 *  and a claim spanning a line break must match on both. */
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

const BOOKING_FORM = 'apps/web/src/app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx'

/**
 * Keys the booking form is allowed not to read, each with the reason it cannot
 * be a dropped field. Anything NOT on this list must appear as `data.<key>` in
 * the mapping block, or the field is being written into silence.
 */
const NOT_THE_READER_S_BUSINESS: Record<string, string> = {
  type: "the mirror's discriminator — spent in the query (where('type','==','activity')), never mapped",
  teamId: 'the tenant filter — spent in the query, never mapped',
}

/** Every field the writer can emit, from two fixtures that between them turn on
 *  every conditional arm: a class with every class-only field, and an
 *  appointment with every appointment-only one. */
function everyMirrorKey(): string[] {
  const common = {
    teamId: 't1',
    name: 'Name',
    description: 'Desc',
    slug: 'name',
    color: '#123456',
    image_url: 'https://example.test/i.png',
    order: 3,
    tags: ['one'],
    bookingGroup: 'Kids',
    prerequisites: 'Can float',
    meetingPoint: 'On the pool deck',
    whatsIncluded: 'A board',
    whatsNotIncluded: 'Pool entry',
    faq: 'Q and A',
    cancellationPolicy: '24 hours',
    bookingQuestions: [{ key: 'q', label: 'Q', type: 'text' }],
    contactFields: [{ key: 'phone', required: true }],
  }

  const klass = buildActivityPublicProfile(
    {
      ...common,
      type: 'class',
      accessRule: { audience: 'anyone', subscriptionTypeIds: ['s1'] },
      dropIn: { mode: 'custom', priceAmount: 25 },
      trialEnabled: true,
      trialPriceAmount: 15,
      waitlistEnabled: true,
      memberBenefit: { subscriptionTypeIds: ['s1'], effect: 'percent_off', discountPercent: 20 },
    },
    null
  )

  const appointment = buildActivityPublicProfile(
    {
      ...common,
      type: 'appointment',
      durations: [{ minutes: 45, priceAmount: 110 }],
      memberBenefit: { subscriptionTypeIds: ['s1'], effect: 'percent_off', discountPercent: 20 },
      durationBenefits: [{ minutes: 45, benefit: null }],
    },
    null
  )

  return [...new Set([...Object.keys(klass), ...Object.keys(appointment)])].sort()
}

/** The reader's mapping block — from the typed list it builds to the sort that
 *  closes it. Bounded on purpose: a `data.x` elsewhere in a 3000-line file
 *  (the single-session fallback read, for one) is not this map. */
function activityMappingBlock(): string {
  const src = readRoot(BOOKING_FORM)
  const from = src.indexOf('const actList: ActivityProfile[] =')
  assert.notEqual(
    from,
    -1,
    `${BOOKING_FORM}: the activity mapping block moved — find it and update this test`
  )
  const to = src.indexOf('.sort(compareActivities)', from)
  assert.notEqual(
    to,
    -1,
    `${BOOKING_FORM}: the activity mapping block has no closing sort — find it and update this test`
  )
  return src.slice(from, to)
}

describe('the activity mirror and the public booking form', () => {
  it('names every field the mirror writes, or exempts it with a reason', () => {
    const block = activityMappingBlock()
    const dropped = everyMirrorKey().filter(
      (key) => !(key in NOT_THE_READER_S_BUSINESS) && !block.includes(`data.${key}`)
    )
    assert.deepEqual(
      dropped,
      [],
      `buildActivityPublicProfile writes ${dropped.join(', ')}, and the booking form's map ` +
        `never reads ${dropped.length === 1 ? 'it' : 'them'}. Either map the field in ${BOOKING_FORM}, ` +
        'or add it to NOT_THE_READER_S_BUSINESS with the reason it is spent elsewhere.'
    )
  })

  it('exempts nothing the mirror has stopped writing', () => {
    const keys = new Set(everyMirrorKey())
    const stale = Object.keys(NOT_THE_READER_S_BUSINESS).filter((key) => !keys.has(key))
    assert.deepEqual(
      stale,
      [],
      `NOT_THE_READER_S_BUSINESS names fields the mirror no longer writes: ${stale.join(', ')}`
    )
  })

  it('carries both halves of the appointment member rule, or neither', () => {
    // resolveDurationBenefit reads the PRESENCE of durationBenefits to decide
    // whether memberBenefit still applies, so one without the other is a quote
    // from a retired rule. Asserted on the reader, because the writer already
    // says so in a comment and a comment is not a gate.
    const block = activityMappingBlock()
    assert.equal(
      block.includes('data.memberBenefit'),
      block.includes('data.durationBenefits'),
      `${BOOKING_FORM} maps one half of the appointment member rule without the other`
    )
  })
})
