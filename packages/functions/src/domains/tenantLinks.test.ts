// Rewriting the app's public links onto a studio's custom domain, applied once
// at the mail seam. It runs over every outbound studio mail for a tenant with a
// domain, so the interesting cases are the ones where it must NOT fire.

import * as assert from 'assert'
import { rewriteTenantPublicLinks } from '@linyup/shared'

const ORIGIN = 'https://app.linyup.com'
const SLUG = 'hmd-basel'
const HOST = 'book.hmdbasel.ch'
const opts = { origin: ORIGIN, slug: SLUG, host: HOST }

describe('rewriteTenantPublicLinks', () => {
  it('rewrites the tenant root', () => {
    assert.strictEqual(
      rewriteTenantPublicLinks(`${ORIGIN}/public/${SLUG}`, opts),
      `https://${HOST}`
    )
  })

  it('rewrites a surface and keeps the rest of the path', () => {
    assert.strictEqual(
      rewriteTenantPublicLinks(`${ORIGIN}/public/${SLUG}/manage-booking?t=abc`, opts),
      `https://${HOST}/manage-booking?t=abc`
    )
  })

  it('keeps the locale prefix', () => {
    assert.strictEqual(
      rewriteTenantPublicLinks(`${ORIGIN}/de/public/${SLUG}/space`, opts),
      `https://${HOST}/de/space`
    )
  })

  it('rewrites every occurrence in a body', () => {
    const html = `<a href="${ORIGIN}/public/${SLUG}/booking">book</a> and <a href="${ORIGIN}/de/public/${SLUG}/space">space</a>`
    assert.strictEqual(
      rewriteTenantPublicLinks(html, opts),
      `<a href="https://${HOST}/booking">book</a> and <a href="https://${HOST}/de/space">space</a>`
    )
  })

  // THE ONE THAT MATTERS: a slug that is a prefix of another must not drag its
  // neighbour onto this studio's domain.
  it('does NOT touch a different studio whose slug merely starts the same', () => {
    const other = `${ORIGIN}/public/${SLUG}-nord/booking`
    assert.strictEqual(rewriteTenantPublicLinks(other, opts), other)
  })

  it('does not touch another studio entirely', () => {
    const other = `${ORIGIN}/public/other-dojo/booking`
    assert.strictEqual(rewriteTenantPublicLinks(other, opts), other)
  })

  // App routes that are not tenant-scoped keep pointing at the app: /pay/result
  // is the Stripe return and /login is the operator app.
  it('leaves non-tenant app links alone', () => {
    const body = `${ORIGIN}/de/pay/result?status=success and ${ORIGIN}/login`
    assert.strictEqual(rewriteTenantPublicLinks(body, opts), body)
  })

  it('leaves a different origin alone', () => {
    const body = 'https://example.com/public/hmd-basel/booking'
    assert.strictEqual(rewriteTenantPublicLinks(body, opts), body)
  })

  it('routes an organisation through the org tree', () => {
    assert.strictEqual(
      rewriteTenantPublicLinks(`${ORIGIN}/public/org/${SLUG}/events`, {
        ...opts,
        scope: 'org',
      }),
      `https://${HOST}/events`
    )
  })

  it('a team rewrite does not touch the org tree', () => {
    const orgLink = `${ORIGIN}/public/org/${SLUG}/events`
    assert.strictEqual(rewriteTenantPublicLinks(orgLink, opts), orgLink)
  })

  it('tolerates a trailing slash on the configured origin', () => {
    assert.strictEqual(
      rewriteTenantPublicLinks(`${ORIGIN}/public/${SLUG}/shop`, { ...opts, origin: `${ORIGIN}/` }),
      `https://${HOST}/shop`
    )
  })

  it('is inert without a host, a slug or content', () => {
    const link = `${ORIGIN}/public/${SLUG}/shop`
    assert.strictEqual(rewriteTenantPublicLinks(link, { ...opts, host: '' }), link)
    assert.strictEqual(rewriteTenantPublicLinks(link, { ...opts, slug: '' }), link)
    assert.strictEqual(rewriteTenantPublicLinks('', opts), '')
  })

  // A slug is user-chosen; a regex-special character in one must not become a
  // pattern that matches things it should not.
  it('treats a regex-special slug literally', () => {
    const odd = { ...opts, slug: 'a.b' }
    assert.strictEqual(
      rewriteTenantPublicLinks(`${ORIGIN}/public/a.b/shop`, odd),
      `https://${HOST}/shop`
    )
    const notMatched = `${ORIGIN}/public/axb/shop`
    assert.strictEqual(rewriteTenantPublicLinks(notMatched, odd), notMatched)
  })
})
