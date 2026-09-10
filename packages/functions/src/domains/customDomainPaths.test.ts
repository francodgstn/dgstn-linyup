// The custom-domain path mapping. It lives in @linyup/shared and is applied by
// `apps/web/src/proxy.ts`, which has no test runner — so this is the only place
// the mapping is exercised, and it is exercised here rather than in the app for
// exactly that reason.

import * as assert from 'assert'
import {
  isCustomDomainPassthrough,
  splitPathLocale,
  toTenantInternalPath,
} from '@linyup/shared'

const SLUG = 'hmd-basel'

describe('custom domain path mapping', () => {
  describe('toTenantInternalPath', () => {
    it('maps the root to the tenant root', () => {
      assert.strictEqual(toTenantInternalPath('/', SLUG), `/public/${SLUG}`)
    })

    it('maps a surface', () => {
      assert.strictEqual(toTenantInternalPath('/shop', SLUG), `/public/${SLUG}/shop`)
    })

    it('ignores a trailing slash', () => {
      assert.strictEqual(toTenantInternalPath('/shop/', SLUG), `/public/${SLUG}/shop`)
    })

    it('keeps deep segments', () => {
      assert.strictEqual(
        toTenantInternalPath('/space/courses/x', SLUG),
        `/public/${SLUG}/space/courses/x`
      )
    })

    it('preserves a locale prefix', () => {
      assert.strictEqual(toTenantInternalPath('/de/shop', SLUG), `/de/public/${SLUG}/shop`)
      assert.strictEqual(toTenantInternalPath('/fr', SLUG), `/fr/public/${SLUG}`)
    })

    // `localePrefix: 'as-needed'` leaves the default locale unprefixed, so `en`
    // is a path segment like any other. Treating it as a locale would rewrite
    // into a route that does not exist.
    it('does NOT treat /en as a locale prefix', () => {
      assert.strictEqual(toTenantInternalPath('/en/shop', SLUG), `/public/${SLUG}/en/shop`)
    })

    it('routes an organisation to the org tree', () => {
      assert.strictEqual(
        toTenantInternalPath('/events', SLUG, 'org'),
        `/public/org/${SLUG}/events`
      )
      assert.strictEqual(toTenantInternalPath('/', SLUG, 'org'), `/public/org/${SLUG}`)
    })
  })

  describe('splitPathLocale', () => {
    it('splits a prefixed path', () => {
      assert.deepStrictEqual(splitPathLocale('/de/shop'), ['de', '/shop'])
    })
    it('leaves an unprefixed path alone', () => {
      assert.deepStrictEqual(splitPathLocale('/shop'), ['', '/shop'])
    })
  })

  describe('isCustomDomainPassthrough', () => {
    // Each of these would break something specific if it were mapped:
    // /pay/* strands a Stripe return mid-checkout, /embed/* already carries its
    // own slug, and the rest are framework-owned.
    const passthrough = [
      '/_next/static/a.js',
      '/api/x',
      '/pay/result',
      '/embed/s/1',
      '/de/embed/s/1',
      '/favicon.ico',
      '/robots.txt',
      '/embed.js',
      '/anything.png',
    ]
    for (const p of passthrough) {
      it(`passes through ${p}`, () => {
        assert.strictEqual(isCustomDomainPassthrough(p), true)
      })
    }

    const mapped = ['/', '/shop', '/de/shop', '/space', '/booking/yoga', '/events']
    for (const p of mapped) {
      it(`maps ${p}`, () => {
        assert.strictEqual(isCustomDomainPassthrough(p), false)
      })
    }
  })

  describe('round trip', () => {
    // The mapping must be stable: applying it to an already-internal path would
    // produce /public/{slug}/public/{slug}/…, which is why proxy.ts refuses to
    // map anything already under /public/.
    it('an internal path is recognisably already internal', () => {
      const internal = toTenantInternalPath('/shop', SLUG)
      const [, rest] = splitPathLocale(internal)
      assert.ok(rest.startsWith('/public/'))
    })

    it('…including when it carries a locale', () => {
      const internal = toTenantInternalPath('/de/shop', SLUG)
      const [locale, rest] = splitPathLocale(internal)
      assert.strictEqual(locale, 'de')
      assert.ok(rest.startsWith('/public/'))
    })
  })
})
