// A team whose WEBSITE is the front door of its own domain. Same reason as
// customDomainPaths.test.ts for living here: proxy.ts has no test runner.

import * as assert from 'assert'
import {
  TENANT_ROUTE_SEGMENTS,
  customDomainSiteUrl,
  isLinyupOwnHost,
  isValidSitePagePath,
  toTenantInternalPath,
  toTenantPublicPath,
} from '@linyup/shared'

const SLUG = 'crossfit-zug'
const site = { siteAtRoot: true }

describe('custom domain — the website at the root', () => {
  it('serves the site home at /', () => {
    assert.strictEqual(toTenantInternalPath('/', SLUG, 'team', site), `/public/${SLUG}/site`)
    assert.strictEqual(toTenantInternalPath('/fr', SLUG, 'team', site), `/fr/public/${SLUG}/site`)
  })

  it('maps any other path to a page of the site', () => {
    assert.strictEqual(toTenantInternalPath('/angebot/crossfit', SLUG, 'team', site), `/public/${SLUG}/site/angebot/crossfit`)
    assert.strictEqual(toTenantInternalPath('/de/blog/', SLUG, 'team', site), `/de/public/${SLUG}/site/blog`)
  })

  it('still reaches every tenant surface, and an explicit /site path', () => {
    for (const segment of ['shop', 'booking', 'space', 'appointments', 'forms', 'manage-booking']) {
      assert.strictEqual(toTenantInternalPath(`/${segment}/x`, SLUG, 'team', site), `/public/${SLUG}/${segment}/x`)
    }
    assert.strictEqual(toTenantInternalPath('/site/preise', SLUG, 'team', site), `/public/${SLUG}/site/preise`)
  })

  it('changes nothing without the flag, or for an organization', () => {
    assert.strictEqual(toTenantInternalPath('/', SLUG), `/public/${SLUG}`)
    assert.strictEqual(toTenantInternalPath('/angebot', SLUG), `/public/${SLUG}/angebot`)
    assert.strictEqual(toTenantInternalPath('/events', SLUG, 'org', site), `/public/org/${SLUG}/events`)
  })

  it('never lets a page claim a tenant route name', () => {
    for (const segment of TENANT_ROUTE_SEGMENTS) {
      assert.strictEqual(isValidSitePagePath(segment), false, segment)
      assert.strictEqual(isValidSitePagePath(`${segment}/unterseite`), false, segment)
    }
    assert.strictEqual(isValidSitePagePath('angebot/booking'), true)
  })
})

describe('custom domain — the addresses a visitor sees', () => {
  const base = { host: 'crossfitzug.ch', slug: SLUG, tenantLanguage: 'de' }

  it('names site pages at the root in the tenant language, prefixed otherwise', () => {
    assert.strictEqual(customDomainSiteUrl({ ...base, locale: 'de', siteAtRoot: true, segments: [] }), 'https://crossfitzug.ch')
    assert.strictEqual(customDomainSiteUrl({ ...base, locale: 'de', siteAtRoot: true, segments: ['angebot', 'crossfit'] }), 'https://crossfitzug.ch/angebot/crossfit')
    assert.strictEqual(customDomainSiteUrl({ ...base, locale: 'fr', siteAtRoot: true, segments: ['preise'] }), 'https://crossfitzug.ch/fr/preise')
  })

  it('keeps /site when the site is not the front door', () => {
    assert.strictEqual(customDomainSiteUrl({ ...base, locale: 'de', siteAtRoot: false, segments: [] }), 'https://crossfitzug.ch/site')
    assert.strictEqual(customDomainSiteUrl({ ...base, locale: 'it', siteAtRoot: false, segments: ['blog'] }), 'https://crossfitzug.ch/it/site/blog')
  })

  it('has no address for English on a non-English tenant', () => {
    // English has no address on a German domain — the caller omits it.
    assert.strictEqual(customDomainSiteUrl({ ...base, locale: 'en', siteAtRoot: true, segments: ['blog'] }), null)
    assert.strictEqual(customDomainSiteUrl({ ...base, tenantLanguage: 'en', locale: 'en', siteAtRoot: true, segments: ['blog'] }), 'https://crossfitzug.ch/blog')
  })

  it('shortens the links a page emits, and leaves what it cannot express', () => {
    const de = { slug: SLUG, tenantLanguage: 'de', siteAtRoot: true }
    assert.strictEqual(toTenantPublicPath(`/de/public/${SLUG}/site`, de), '/')
    assert.strictEqual(toTenantPublicPath(`/de/public/${SLUG}/site/angebot/crossfit`, de), '/angebot/crossfit')
    assert.strictEqual(toTenantPublicPath(`/de/public/${SLUG}/booking?from=site`, de), '/booking?from=site')
    assert.strictEqual(toTenantPublicPath(`/fr/public/${SLUG}/site/preise#x`, de), '/fr/preise#x')
    // Without the site at the root, /site stays in the path.
    assert.strictEqual(toTenantPublicPath(`/de/public/${SLUG}/site/preise`, { ...de, siteAtRoot: false }), '/site/preise')
    // English on a German tenant has no short form — the long path still works.
    assert.strictEqual(toTenantPublicPath(`/public/${SLUG}/site`, de), `/public/${SLUG}/site`)
    assert.strictEqual(toTenantPublicPath(`/public/${SLUG}/site`, { ...de, tenantLanguage: 'en' }), '/')
    // Another tenant's link, and anything that is not a public path, pass through.
    assert.strictEqual(toTenantPublicPath('/de/public/other-team/site', de), '/de/public/other-team/site')
    assert.strictEqual(toTenantPublicPath('https://crossfitzug.ch/wod', de), 'https://crossfitzug.ch/wod')
    assert.strictEqual(toTenantPublicPath('#top', de), '#top')
  })

  it('tells our own hosts from a studio domain', () => {
    for (const own of ['linyup.com', 'app.linyup.com', 'linyup-web-eu--linyup-prod.europe-west4.hosted.app', 'linyup-prod.web.app', 'localhost', '127.0.0.1']) {
      assert.strictEqual(isLinyupOwnHost(own), true, own)
    }
    for (const studio of ['crossfitzug.ch', 'www.crossfitzug.ch', 'linyup.com.evil.ch', 'notlinyup.com']) {
      assert.strictEqual(isLinyupOwnHost(studio), false, studio)
    }
  })
})
