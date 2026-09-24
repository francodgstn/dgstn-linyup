import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COURSE_BLOCK_WAITLIST_SUBCOLLECTION,
  COURSE_CLAIM_DEFAULT_HOURS,
  COURSE_CLAIM_MIN_WINDOW_MINUTES,
  WAITLIST_SUBCOLLECTION,
  courseWaitlistCap,
  courseWaitlistOfferIsLive,
  resolveCourseClaimWindow,
  selectCourseOfferHeads,
} from '@linyup/shared'

// THE WAITING LIST FOR A FULL COURSE.
//
// It reuses the class queue's shape and none of its storage, so what is pinned
// here is the handful of places where reuse could go wrong.
//
// THE SINGLE-DEADLINE RULE is the one that costs a studio a place sold twice:
// the offered enrolment's `expires_at`, its `claim_expires_at`, the entry's
// `offer_expires_at` and the Stripe session all have to be ONE instant. It is
// asserted structurally, against the source, because the failure has no state a
// behaviour test could sample: two timers one second apart look identical until
// a real person claims in that second.
//
// THE NAME COLLISION is the other. A collection-group query is a global
// namespace, and the class sweep reads `collectionGroup('waitlist')` and then
// walks each hit as a session booking. A course entry under that name would be
// dereferenced through a `session` field it does not have. That one is a
// one-line assertion and would otherwise only show up in production.
//
// Run with: pnpm --filter @linyup/functions test

const HOUR = 60 * 60_000
const NOW = Date.UTC(2026, 5, 1, 9, 0)

describe('how long a course place is held', () => {
  it('is DAYS, not the class queue’s hours', () => {
    // A class seat is a grab-it-now decision. A course is a term's fees and a
    // diary to check, and an offer nobody can realistically answer is a place
    // the studio loses rather than fills.
    const w = resolveCourseClaimWindow({ nowMs: NOW })
    assert.equal(w.expiresAtMs, NOW + COURSE_CLAIM_DEFAULT_HOURS * HOUR)
    assert.ok(COURSE_CLAIM_DEFAULT_HOURS >= 24, 'a course window is measured in days')
    assert.ok(w.offerable)
  })

  it('is clamped by the course’s own closing date', () => {
    // Hard, not advisory: an offer outliving `booking_closes_at` hands somebody
    // a claim the course's own callables then refuse.
    const closes = NOW + 5 * HOUR
    const w = resolveCourseClaimWindow({ nowMs: NOW, closesAtMs: closes })
    assert.equal(w.expiresAtMs, closes)
  })

  it('is clamped by the course END, so no place is sold after the last lesson', () => {
    const last = NOW + 3 * HOUR
    const w = resolveCourseClaimWindow({ nowMs: NOW, lastMeetingMs: last, closesAtMs: NOW + 90 * HOUR })
    assert.equal(w.expiresAtMs, last)
  })

  it('STILL OFFERS on a course that has already started, which is the whole point', () => {
    // The defect this replaced: clamping to the FIRST lesson meant a course
    // three weeks in had a window that closed before it opened, so the promoter
    // refused every offer and returned silently. A place freeing in week four
    // is the case a waiting list exists for.
    const w = resolveCourseClaimWindow({ nowMs: NOW, lastMeetingMs: NOW + 30 * 24 * HOUR })
    assert.equal(w.offerable, true)
    assert.equal(w.expiresAtMs, NOW + COURSE_CLAIM_DEFAULT_HOURS * HOUR)
  })

  it('takes the EARLIEST of everything that can close it', () => {
    const w = resolveCourseClaimWindow({
      nowMs: NOW,
      lastMeetingMs: NOW + 10 * HOUR,
      closesAtMs: NOW + 4 * HOUR,
      claimHours: 72,
    })
    assert.equal(w.expiresAtMs, NOW + 4 * HOUR)
  })

  it('refuses to offer at all below the floor', () => {
    // The place then simply shows as free and the ordinary door can sell it,
    // which is the right outcome for a place that frees the evening before.
    const w = resolveCourseClaimWindow({
      nowMs: NOW,
      lastMeetingMs: NOW + (COURSE_CLAIM_MIN_WINDOW_MINUTES - 1) * 60_000,
    })
    assert.equal(w.offerable, false)
  })

  it('never offers a window that has already closed', () => {
    const w = resolveCourseClaimWindow({ nowMs: NOW, closesAtMs: NOW - HOUR })
    assert.ok(w.minutesLeft < 0)
    assert.equal(w.offerable, false)
  })
})

describe('how long the queue may get', () => {
  it('is twice the places, with a floor so a tiny course is not capped at two', () => {
    assert.equal(courseWaitlistCap(9), 18)
    assert.equal(courseWaitlistCap(2), 10)
  })

  it('treats an uncapped course as having no places to queue for', () => {
    // An uncapped course is never full, so nothing ever joins its queue; the cap
    // is the floor rather than infinity, which is the harmless direction.
    assert.equal(courseWaitlistCap(null), 10)
    assert.equal(courseWaitlistCap(0), 10)
  })
})

describe('who a promotion pass offers to', () => {
  const entry = (id: string) => ({ id })

  it('takes the head of the queue, in order', () => {
    const { heads } = selectCourseOfferHeads([entry('a'), entry('b'), entry('c')], 2)
    assert.deepEqual(heads.map((h) => h.id), ['a', 'b'])
  })

  it('FILTERS BEFORE IT TAKES THE HEAD, so one dead entry cannot wedge the queue', () => {
    // The class rail's defect, avoided by construction: filtering afterwards
    // meant a single deleted contact at the front made every pass select the
    // corpse, find nothing to offer and return without a write, so every
    // trigger re-picked it and everybody behind waited for the life of the
    // course. A contact really does disappear: purgeProvisionalContacts
    // hard-deletes provisional ones, and a shop registrant is exactly that.
    const live = new Set(['b', 'c'])
    const { heads, dropped } = selectCourseOfferHeads(
      [entry('a'), entry('b'), entry('c')],
      1,
      (e) => live.has(e.id)
    )
    assert.deepEqual(heads.map((h) => h.id), ['b'], 'the live head is offered, not the corpse')
    assert.deepEqual(dropped.map((d) => d.id), ['a'], 'the corpse is reported so it can be closed out')
  })

  it('offers nothing when there is no room', () => {
    assert.deepEqual(selectCourseOfferHeads([entry('a')], 0).heads, [])
  })
})

describe('whether an offer is still open', () => {
  it('is only ever true for an offered entry with a future deadline', () => {
    const ts = (ms: number) => ({ toMillis: () => ms })
    assert.equal(
      courseWaitlistOfferIsLive({ status: 'offered', offer_expires_at: ts(NOW + HOUR) }, NOW),
      true
    )
    assert.equal(
      courseWaitlistOfferIsLive({ status: 'offered', offer_expires_at: ts(NOW - 1) }, NOW),
      false
    )
    assert.equal(
      courseWaitlistOfferIsLive({ status: 'waiting', offer_expires_at: ts(NOW + HOUR) }, NOW),
      false
    )
    assert.equal(courseWaitlistOfferIsLive({ status: 'offered' }, NOW), false)
  })
})

describe('the two queues cannot be confused by a collection-group query', () => {
  it('uses a DIFFERENT subcollection name from the class queue', () => {
    // The class sweep reads collectionGroup('waitlist').where('status','==',
    // 'offered') and then walks each hit as a session booking. A course entry
    // sharing that name would be picked up by it and dereferenced through a
    // `session` field it does not have.
    assert.notEqual(COURSE_BLOCK_WAITLIST_SUBCOLLECTION, WAITLIST_SUBCOLLECTION)
  })

  it('and the class sweep’s own query is still the one this avoids', () => {
    // Read from the source so this pin follows the class sweep if it changes
    // shape, rather than asserting a fact about a file nobody re-reads.
    const sweep = readFileSync(
      join(__dirname, '..', 'booking/waitlist/sweep.ts'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    assert.match(sweep, /collectionGroup\(WAITLIST_SUBCOLLECTION\)/)
  })
})

describe('the single-deadline rule, asserted against the source', () => {
  const src = readFileSync(join(__dirname, 'waitlist.ts'), 'utf8').replace(/\r\n/g, '\n')
  const checkout = readFileSync(join(__dirname, 'checkout.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('computes the deadline ONCE and copies it', () => {
    // Structural, because the defect has no failing state to sample: two timers
    // a second apart look identical until somebody claims in that second.
    const calls = src.match(/resolveCourseClaimWindow\(/g) ?? []
    assert.equal(calls.length, 1, 'the promoter must compute the window exactly once')
    // …and the one value reaches all three stored fields.
    assert.match(src, /const expiresAt = Timestamp\.fromMillis\(window\.expiresAtMs\)/)
    assert.match(src, /expires_at: expiresAt/)
    assert.match(src, /claim_expires_at: expiresAt/)
    assert.match(src, /offer_expires_at: expiresAt/)
  })

  it('clamps the Stripe session to the OFFER’s deadline, never to a fresh window', () => {
    // A checkout that outlives the hold sells a place that has already gone to
    // the next person, which is the expensive direction.
    assert.match(checkout, /claimExpiresAtMs: claim\.expiresAtMs/)
    assert.match(checkout, /resolveClaimCheckoutWindow/)
  })

  it('does not take a place for a claim: the offer already holds it', () => {
    // Taking it again would rewrite the hold's deadline, which is exactly the
    // divergence this rule forbids.
    const claimBranch = checkout.slice(
      checkout.indexOf('if (claim) {'),
      checkout.indexOf('} else {', checkout.indexOf('if (claim) {'))
    )
    assert.ok(claimBranch.length > 0)
    assert.ok(
      !claimBranch.includes('takeCourseBlockPlace'),
      'the claim branch must not take a second place'
    )
  })

  it('does not RELEASE a claim’s place when the checkout fails', () => {
    // It was held by the offer before the call and stands until the offer's own
    // deadline: handing it to the next person over a Stripe hiccup would be
    // taking it from somebody who still has time to pay.
    assert.match(checkout, /if \(claim\) throw err/)
  })
})

describe('the promoter’s edge, asserted against the source', () => {
  const src = readFileSync(join(__dirname, 'waitlist.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('hangs on the place-freed EDGE, not on any write', () => {
    // Being an edge is what makes it loop-safe: its own write re-fires the
    // trigger, and on that pass the course is full again.
    assert.match(src, /if \(!placeFreedEdge\(before, after\)\) return/)
  })

  it('writes the course document exactly once, on the path that offers', () => {
    // THE BINDING COROLLARY: a handler on an edge must not write the course on
    // any path where it decides not to promote, or a harmless touch re-enters
    // the edge for ever. Counted structurally rather than reasoned about,
    // because "we return early everywhere" is a claim that rots.
    const fn = src.slice(
      src.indexOf('export async function offerCoursePlaces('),
      src.indexOf('export async function offerCoursePlacesAndNotify(')
    )
    const courseWrites = fn.match(/tx\.update\(ref,/g) ?? []
    assert.equal(courseWrites.length, 1, 'the course is written on the offering path only')
    // And that one write is below every refusal.
    assert.ok(fn.indexOf('tx.update(ref,') > fn.lastIndexOf('return []'))
  })

  it('writes places_taken as an ABSOLUTE value, never an increment', () => {
    // ONE PLACE WRITER, unchanged. Matched on any receiver: a pin that required
    // one spelling passes against the very edit it exists to catch.
    const offenders = src
      .split('\n')
      .filter((line) => /places_taken/.test(line) && /increment\s*\(/.test(line))
    assert.deepEqual(offenders, [], `places_taken must never be incremented:\n${offenders.join('\n')}`)
  })
})
