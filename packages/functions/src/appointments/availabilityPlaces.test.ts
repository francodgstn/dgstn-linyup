import assert from 'node:assert/strict'
import { availabilityBucketKey, availabilityPlaceKey } from './window'

// ONE CALENDAR PER PLACE, the bucket `listAvailability` groups a coach's
// schedules into.
//
// The defect this pins produced WRONG OUTPUT, not a missing feature. Grouping
// on (provider, activity) merged a coach's schedules at different places into a
// single calendar and labelled it with whichever schedule happened to be read
// first. A visitor picked a Tuesday believing it was one place; `bookAppointment`
// then resolved the place from the availability that actually covered that
// start, and put them in another. Nothing failed anywhere.
//
// The fix is one key, so these fixtures are about what shares a bucket and what
// does not. The precedence (place → free-text location → online URL → nothing)
// is what keeps a legacy schedule, which only ever carried `location`, bucketing
// exactly as it did before.
//
// Run with: pnpm --filter @linyup/functions test

const sched = (over: Partial<{ placeId: string; location: string; onlineUrl: string }> = {}) => ({
  placeId: over.placeId ?? null,
  location: over.location ?? null,
  onlineUrl: over.onlineUrl ?? null,
})

describe('availability buckets: one per (activity, place)', () => {
  it('splits one offer taught at two places into two buckets', () => {
    const riverside = availabilityBucketKey('private-lesson', sched({ placeId: 'place-riverside' }))
    const northgate = availabilityBucketKey('private-lesson', sched({ placeId: 'place-northgate' }))
    assert.notEqual(
      riverside,
      northgate,
      'the same offer at two places must not merge into one calendar'
    )
  })

  it('merges two schedules for the same offer at the SAME place', () => {
    // "Saturday mornings" and "Weekday evenings", both at the Hallenbad: one
    // calendar is right here, and is the behaviour the grouping exists for.
    const saturdays = availabilityBucketKey('private-lesson', sched({ placeId: 'place-riverside' }))
    const evenings = availabilityBucketKey('private-lesson', sched({ placeId: 'place-riverside' }))
    assert.equal(saturdays, evenings)
  })

  it('keeps two different offers at one place apart', () => {
    const lesson = availabilityBucketKey('private-lesson', sched({ placeId: 'place-riverside' }))
    const analysis = availabilityBucketKey('technique-analysis', sched({ placeId: 'place-riverside' }))
    assert.notEqual(lesson, analysis)
  })

  it('buckets a legacy schedule by its free-text location, exactly as before', () => {
    // No tracked place was ever set on these, so `location` is the only thing
    // that distinguishes two of them, and two schedules carrying the same note
    // are the same calendar, which is what the old grouping did for ALL of them.
    const a = availabilityBucketKey('private-lesson', sched({ location: 'Hallenbad Leimbach' }))
    const b = availabilityBucketKey('private-lesson', sched({ location: 'Hallenbad Leimbach' }))
    const c = availabilityBucketKey('private-lesson', sched({ location: 'Freibad Letzigraben' }))
    assert.equal(a, b)
    assert.notEqual(a, c)
  })

  it('prefers the tracked place over the note written on top of it', () => {
    // Two schedules at the same place, each with its own free-text note, are ONE
    // calendar: the note is an instruction, not a second venue.
    const withNote = availabilityBucketKey(
      'private-lesson',
      sched({ placeId: 'place-riverside', location: 'Meet by the main entrance' })
    )
    const otherNote = availabilityBucketKey(
      'private-lesson',
      sched({ placeId: 'place-riverside', location: 'Meet in the changing rooms' })
    )
    assert.equal(withNote, otherNote)
  })

  it('separates online schedules by their URL, and groups a placeless one with itself', () => {
    assert.equal(availabilityPlaceKey(sched({ onlineUrl: 'https://meet.test/a' })), 'https://meet.test/a')
    assert.notEqual(
      availabilityBucketKey('coaching-call', sched({ onlineUrl: 'https://meet.test/a' })),
      availabilityBucketKey('coaching-call', sched({ onlineUrl: 'https://meet.test/b' }))
    )
    // Nothing set at all: one bucket, which is the pre-existing behaviour for a
    // schedule that says nothing about where it happens.
    assert.equal(availabilityPlaceKey(sched()), '')
    assert.equal(
      availabilityBucketKey('coaching-call', sched()),
      availabilityBucketKey('coaching-call', sched())
    )
  })
})
