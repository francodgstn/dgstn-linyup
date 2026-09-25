import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import {
  decideReviewCode,
  reviewAccessAddresses,
  REVIEW_ACCESS_MAX_EMAILS,
  type ReviewAccess,
} from './reviewAccess'

// `decideReviewCode` is the whole decision with the Firestore read lifted out,
// which is why it can be tested at all. Each arm below is a way the fixed-code
// bypass could be left open by accident.

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const EMAIL = 'app.review@example.com'

function access(overrides: Record<string, unknown> = {}): ReviewAccess {
  return {
    enabled: true,
    email: EMAIL,
    code: '135790',
    expires_at: Timestamp.fromMillis(NOW + 7 * 24 * 3600 * 1000),
    ...overrides,
  } as ReviewAccess
}

describe('decideReviewCode — the fixed-code bypass, and every way it stays shut', () => {
  it('issues the fixed code for the one configured address', () => {
    const a = access()
    assert.equal(decideReviewCode(a, EMAIL, NOW), '135790')
  })

  it('returns null for every other address', () => {
    const a = access()
    // The neighboring cases that matter: a different person, and a near-miss.
    for (const other of ['someone.else@example.com', 'app.review@example.org', 'app.review+x@example.com']) {
      assert.equal(decideReviewCode(a, other, NOW), null, `${other} must not match`)
    }
  })

  it('returns null when disabled — this is the kill switch', () => {
    const a = access({ enabled: false })
    assert.equal(decideReviewCode(a, EMAIL, NOW), null)
  })

  it('returns null once EXPIRED, so nobody has to remember to turn it off', () => {
    const a = access({ expires_at: Timestamp.fromMillis(NOW - 1000) })
    assert.equal(decideReviewCode(a, EMAIL, NOW), null)
  })

  it('treats a MISSING or unparseable expiry as expired, never as forever', () => {
    for (const bad of [undefined, null, 'next tuesday', 12345]) {
      const a = access({ expires_at: bad })
      assert.equal(decideReviewCode(a, EMAIL, NOW), null, `expiry ${String(bad)} must not open the door`)
    }
  })

  it('refuses a stored code that is not six digits', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '', undefined]) {
      const a = access({ code: bad })
      assert.equal(decideReviewCode(a, EMAIL, NOW), null, `code ${String(bad)} must be refused`)
    }
  })

  it('returns null when nothing is configured at all', () => {
    assert.equal(decideReviewCode(null, EMAIL, NOW), null)
  })

  it('normalizes the stored address, so casing and stray spaces still match', () => {
    const a = access({ email: '  App.Review@Example.com ' })
    assert.equal(decideReviewCode(a, EMAIL, NOW), '135790')
  })
})

// ── The address LIST, added 2026-09-04 ──────────────────────────────────────
// Widening the door from one address to a dozen is the change most able to
// leave this bypass open by accident, so each arm of it is pinned here too.
describe('decideReviewCode — a bounded list of addresses', () => {
  const T1 = 'tester01@example.com'
  const T2 = 'tester02@example.com'

  it('issues the code for any address in `emails`', () => {
    const a = access({ email: undefined, emails: [T1, T2] })
    assert.equal(decideReviewCode(a, T1, NOW), '135790')
    assert.equal(decideReviewCode(a, T2, NOW), '135790')
  })

  it('still honors a LEGACY single `email`, and both together', () => {
    // A half-migrated document must behave as the sum of what it says.
    assert.equal(decideReviewCode(access(), EMAIL, NOW), '135790')
    const both = access({ emails: [T1] })
    assert.equal(decideReviewCode(both, EMAIL, NOW), '135790')
    assert.equal(decideReviewCode(both, T1, NOW), '135790')
  })

  it('returns null for an address that is not in the list', () => {
    const a = access({ email: undefined, emails: [T1, T2] })
    assert.equal(decideReviewCode(a, 'tester03@example.com', NOW), null)
  })

  it('normalizes every entry, not just the first', () => {
    const a = access({ email: undefined, emails: ['  TESTER01@Example.com ', T2] })
    assert.equal(decideReviewCode(a, T1, NOW), '135790')
  })

  it('FAILS CLOSED on an over-long list rather than honoring a prefix', () => {
    // Truncating would silently apply a different configuration than the one
    // stored — the opposite of what an auth bypass should do when confused.
    const many = Array.from({ length: REVIEW_ACCESS_MAX_EMAILS + 1 }, (_, i) => `t${i}@example.com`)
    const a = access({ email: undefined, emails: many })
    assert.equal(decideReviewCode(a, 't0@example.com', NOW), null)
    assert.equal(decideReviewCode(a, many[many.length - 1], NOW), null)
  })

  it('accepts a list exactly at the cap', () => {
    const many = Array.from({ length: REVIEW_ACCESS_MAX_EMAILS }, (_, i) => `t${i}@example.com`)
    const a = access({ email: undefined, emails: many })
    assert.equal(decideReviewCode(a, 't0@example.com', NOW), '135790')
  })

  it('returns null when the list is empty or malformed', () => {
    assert.equal(decideReviewCode(access({ email: undefined, emails: [] }), EMAIL, NOW), null)
    assert.equal(decideReviewCode(access({ email: undefined, emails: ['', '   '] }), EMAIL, NOW), null)
    assert.equal(decideReviewCode(access({ email: undefined, emails: 'nope' }), EMAIL, NOW), null)
  })

  it('applies expiry and the kill switch to the whole list, not just the legacy address', () => {
    const expired = access({ email: undefined, emails: [T1], expires_at: Timestamp.fromMillis(NOW - 1) })
    assert.equal(decideReviewCode(expired, T1, NOW), null)
    const off = access({ email: undefined, emails: [T1], enabled: false })
    assert.equal(decideReviewCode(off, T1, NOW), null)
  })
})

describe('reviewAccessAddresses', () => {
  it('unions legacy and list, normalized and de-duplicated', () => {
    const a = access({ emails: ['  APP.REVIEW@example.com', 'tester01@example.com', 'tester01@example.com'] })
    assert.deepEqual(reviewAccessAddresses(a).sort(), ['app.review@example.com', 'tester01@example.com'])
  })

  it('is empty for a null document', () => {
    assert.deepEqual(reviewAccessAddresses(null), [])
  })
})
