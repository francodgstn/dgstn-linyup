import assert from 'node:assert/strict'
import { findSiteRedirect, isRestorableReturnPath, normalizeSiteRedirectPath } from '@linyup/shared'
import { sanitizeRedirects } from './sanitize'

// Phase 6 of the website builder: what a site needs to replace a live website.

describe('site redirects', () => {
  it('normalises an old path the way a visitor may type it', () => {
    assert.equal(normalizeSiteRedirectPath('/Ueber-Uns/Unsere-Box/'), '/ueber-uns/unsere-box')
    assert.equal(normalizeSiteRedirectPath('ueber-uns?ref=x#top'), '/ueber-uns')
    assert.equal(normalizeSiteRedirectPath('/%C3%BCber-uns'), '/über-uns')
    assert.equal(normalizeSiteRedirectPath('//a//b'), '/a/b')
    for (const bad of ['', '/', '   ', '/a b', '/%E0%A4%A']) assert.equal(normalizeSiteRedirectPath(bad), '', JSON.stringify(bad))
  })

  it('finds a redirect whatever the case or trailing slash', () => {
    const redirects = [{ from: '/ueber-uns/unsere-box', to: { kind: 'home' as const } }]
    assert.equal(findSiteRedirect(redirects, '/Ueber-uns/Unsere-Box/')?.from, '/ueber-uns/unsere-box')
    assert.equal(findSiteRedirect(redirects, '/ueber-uns'), null)
    assert.equal(findSiteRedirect(undefined, '/x'), null)
  })

  it('keeps redirects that lead somewhere published, once per path, never over a real page', () => {
    const out = sanitizeRedirects(
      [
        { from: '/Ueber-Uns/Unsere-Box', to: { kind: 'page', pageId: 'p-box' } },
        { from: '/ueber-uns/unsere-box/', to: { kind: 'home' } },
        { from: '/alt', to: { kind: 'page', pageId: 'p-deleted' } },
        { from: '/extern', to: { kind: 'url', url: 'https://shop.example.ch' } },
        { from: '/unsicher', to: { kind: 'url', url: 'http://shop.example.ch' } },
        { from: '/preise', to: { kind: 'home' } },
        { from: '/', to: { kind: 'home' } },
        { from: '/kontakt', to: { kind: 'weird' } },
      ],
      { pageIds: new Set(['p-box', 'p-preise']), pagePaths: new Set(['preise']) }
    )
    assert.deepEqual(out, [
      { from: '/ueber-uns/unsere-box', to: { kind: 'page', pageId: 'p-box' } },
      { from: '/extern', to: { kind: 'url', url: 'https://shop.example.ch' } },
    ])
  })
})

describe('booking return after checkout', () => {
  const own = { customDomain: false }
  const custom = { customDomain: true }

  it('restores a public tenant page on the app hosts, sub-pages included', () => {
    for (const ok of ['/public/cfz/site', '/de/public/cfz/site/angebot/crossfit', '/de/public/cfz/site?book=1&session=a']) {
      assert.equal(isRestorableReturnPath(ok, own), true, ok)
    }
  })

  it('restores the short paths only on a studio domain', () => {
    for (const path of ['/', '/site/angebot/crossfit', '/de/booking?book=1', '/preise']) {
      assert.equal(isRestorableReturnPath(path, own), path === '/' ? false : false, path)
      assert.equal(isRestorableReturnPath(path, custom), true, path)
    }
  })

  it('never restores an off-site, script, payment or framework path', () => {
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/a\\b', '/pay/result', '/de/pay/result?x', '/api/x', '/_next/x', '/embed/cfz/book', '/site#x', 'x'.repeat(600)]) {
      assert.equal(isRestorableReturnPath(bad, custom), false, bad)
    }
  })
})
