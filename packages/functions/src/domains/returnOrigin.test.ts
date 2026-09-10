// The Stripe return origin. This is a security predicate, not a formatting
// helper: it decides which host a paying visitor may be sent back to.
//
// The failure it exists to prevent is an OPEN REDIRECT through our own customer
// list — widening the trusted pattern to "any verified custom domain" would let
// a checkout for studio A return the visitor to studio B's site, which is why
// the tenant's host is passed in per call rather than matched against a pattern.

import * as assert from 'assert'
import { resolveBaseUrl } from '../utils/env'

const TENANT = 'book.theirdojo.ch'
const OTHER_TENANT = 'book.someoneelse.ch'

describe('resolveBaseUrl — Stripe return origin', () => {
  it('accepts our own origins with no tenant host at all', () => {
    assert.strictEqual(resolveBaseUrl('https://app.linyup.com'), 'https://app.linyup.com')
    assert.strictEqual(resolveBaseUrl('http://localhost:3000'), 'http://localhost:3000')
  })

  it("accepts the tenant's own verified domain", () => {
    assert.strictEqual(
      resolveBaseUrl(`https://${TENANT}`, TENANT),
      `https://${TENANT}`
    )
  })

  it('is case-insensitive about the host', () => {
    assert.strictEqual(
      resolveBaseUrl(`https://${TENANT.toUpperCase()}`, TENANT),
      `https://${TENANT.toUpperCase()}`
    )
  })

  it('tolerates a trailing slash on the origin', () => {
    assert.strictEqual(resolveBaseUrl(`https://${TENANT}/`, TENANT), `https://${TENANT}`)
  })

  // The whole point: one tenant's checkout may not return to another's domain,
  // even though both are domains we verified and serve.
  it("REFUSES another tenant's verified domain", () => {
    assert.notStrictEqual(
      resolveBaseUrl(`https://${OTHER_TENANT}`, TENANT),
      `https://${OTHER_TENANT}`
    )
  })

  it('refuses an unrelated origin', () => {
    assert.notStrictEqual(resolveBaseUrl('https://evil.example', TENANT), 'https://evil.example')
  })

  // http:// is not merely untidy — accepting it would let a checkout return over
  // a channel that can be read and rewritten in transit.
  it('refuses the right host over plain http', () => {
    assert.notStrictEqual(resolveBaseUrl(`http://${TENANT}`, TENANT), `http://${TENANT}`)
  })

  it('refuses a look-alike that merely ends with the host', () => {
    assert.notStrictEqual(
      resolveBaseUrl(`https://evil${TENANT}`, TENANT),
      `https://evil${TENANT}`
    )
  })

  it('refuses the host as a path on somebody else', () => {
    assert.notStrictEqual(
      resolveBaseUrl(`https://evil.example/${TENANT}`, TENANT),
      `https://evil.example/${TENANT}`
    )
  })

  it('ignores an absent tenant host rather than trusting the origin', () => {
    assert.notStrictEqual(
      resolveBaseUrl(`https://${TENANT}`, null),
      `https://${TENANT}`
    )
  })
})
