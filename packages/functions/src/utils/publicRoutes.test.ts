import assert from 'node:assert/strict'
import {
  SYSTEM_LINK_META,
  SYSTEM_LINK_ROUTE,
  SYSTEM_LINK_SURFACE,
  SYSTEM_LINK_TARGETS,
  parseDateKey,
  parseDocId,
  parsePositiveInt,
  parsePublicFrom,
  parseSlug,
  publicPath,
  publicQuery,
  publicSubPath,
  publicSubUrl,
  publicUrl,
  localizedPublicUrl,
  localizedPublicSubUrl,
  publicLocalePrefix,
  systemLinkIsLive,
} from '@linyup/shared'

// Unit tests for the shared public-route builder (@linyup/shared/publicRoutes).
// Run with: pnpm --filter @linyup/functions test
//
// The "byte-identical" block is the acceptance test for routing the emailed /
// printed links through the builder: those URLs are already in inboxes and on
// printed QR codes, so the generated string must not change.

describe('publicQuery', () => {
  it('drops undefined / null / empty and returns "" when nothing is left', () => {
    assert.equal(publicQuery(), '')
    assert.equal(publicQuery({}), '')
    assert.equal(publicQuery({ a: undefined, b: null, c: '' }), '')
  })

  it('serializes in alphabetical key order regardless of object literal order', () => {
    assert.equal(
      publicQuery({ session: 's1', from: 'site', activity: 'a1' }),
      '?activity=a1&from=site&session=s1'
    )
    assert.equal(
      publicQuery({ activity: 'a1', from: 'site', session: 's1' }),
      '?activity=a1&from=site&session=s1'
    )
  })

  it('encodes keys and values, and accepts numbers', () => {
    assert.equal(publicQuery({ email: 'a+b@x.com' }), '?email=a%2Bb%40x.com')
    assert.equal(publicQuery({ duration: 45 }), '?duration=45')
    assert.equal(publicQuery({ q: 'a b/c' }), '?q=a%20b%2Fc')
  })

  it('keeps 0 (it is not empty)', () => {
    assert.equal(publicQuery({ duration: 0 }), '?duration=0')
  })
})

describe('publicPath', () => {
  it('bio-link is the team root, not a sibling route', () => {
    assert.equal(publicPath('acme'), '/public/acme')
    assert.equal(publicPath('acme', 'bio-link'), '/public/acme')
    assert.equal(publicPath('acme', 'bio-link', { from: 'site' }), '/public/acme?from=site')
  })

  it('builds sibling surfaces with their params', () => {
    assert.equal(publicPath('acme', 'booking'), '/public/acme/booking')
    assert.equal(
      publicPath('acme', 'booking', { session: 'sess1', from: 'site' }),
      '/public/acme/booking?from=site&session=sess1'
    )
    assert.equal(
      publicPath('acme', 'appointments', { activity: 'a1', duration: 30 }),
      '/public/acme/appointments?activity=a1&duration=30'
    )
    assert.equal(
      publicPath('acme', 'shop', { tab: 'subscriptions' }),
      '/public/acme/shop?tab=subscriptions'
    )
  })

  it('nests sub-segments and encodes each one', () => {
    assert.equal(
      publicSubPath('acme', 'booking', 'kids-yoga', { date: '2026-08-14' }),
      '/public/acme/booking/kids-yoga?date=2026-08-14'
    )
    assert.equal(
      publicSubPath('acme', 'space', ['courses', 'intro to breath']),
      '/public/acme/space/courses/intro%20to%20breath'
    )
  })
})

describe('SYSTEM_LINK_ROUTE mirrors SYSTEM_LINK_META', () => {
  // SYSTEM_LINK_META.route is stored/consumed data (BioLinkHome + the bio-link
  // editor read it). SYSTEM_LINK_ROUTE is the structured mirror. If someone edits
  // one and not the other, this fails.
  it('produces the same path for every target', () => {
    for (const target of SYSTEM_LINK_TARGETS) {
      const legacy = `/public/acme/${SYSTEM_LINK_META[target].route}`
      const derived = publicPath('acme', SYSTEM_LINK_ROUTE[target].route, {
        ...SYSTEM_LINK_ROUTE[target].params,
      })
      assert.equal(derived, legacy, `mismatch for system link target "${target}"`)
    }
  })

  it('covers every target exactly once', () => {
    assert.deepEqual(Object.keys(SYSTEM_LINK_ROUTE).sort(), [...SYSTEM_LINK_TARGETS].sort())
  })
})

describe('parsePublicFrom', () => {
  it('accepts every surface plus checkout', () => {
    assert.equal(parsePublicFrom('site'), 'site')
    assert.equal(parsePublicFrom('bio-link'), 'bio-link')
    assert.equal(parsePublicFrom('checkout'), 'checkout')
  })

  it('ignores anything else rather than throwing', () => {
    assert.equal(parsePublicFrom('nope'), undefined)
    assert.equal(parsePublicFrom(''), undefined)
    assert.equal(parsePublicFrom(undefined), undefined)
    assert.equal(parsePublicFrom('../../etc/passwd'), undefined)
  })
})

describe('untrusted query-param parsers', () => {
  // Threat model: an attacker sends a victim a crafted /public/… link. Every one
  // of these values reaches a Firestore path, an href, or a date constructor.

  describe('parseDocId', () => {
    it('accepts the url-safe ids we mint', () => {
      assert.equal(parseDocId('lead-nicole-session-007'), 'lead-nicole-session-007')
      assert.equal(parseDocId('AbC_123-xyz'), 'AbC_123-xyz')
    })

    it('rejects slashes — they silently re-target the Firestore document', () => {
      // doc(db,'sessions',id,'public_profile',id) splits args on '/', so an id
      // with a slash addresses a DIFFERENT doc than the call site intends.
      assert.equal(parseDocId('a/b'), undefined)
      assert.equal(parseDocId('x/public_profile/y'), undefined)
      assert.equal(parseDocId('../../teams/other'), undefined)
    })

    it('rejects traversal, reserved and oversized ids', () => {
      assert.equal(parseDocId('.'), undefined)
      assert.equal(parseDocId('..'), undefined)
      assert.equal(parseDocId('__name__'), undefined)
      assert.equal(parseDocId('a'.repeat(1501)), undefined)
    })

    it('rejects anything that could be reflected as markup or a scheme', () => {
      assert.equal(parseDocId('<script>alert(1)</script>'), undefined)
      assert.equal(parseDocId('javascript:alert(1)'), undefined)
      assert.equal(parseDocId('"onload="alert(1)'), undefined)
      assert.equal(parseDocId(''), undefined)
      assert.equal(parseDocId(undefined), undefined)
    })
  })

  describe('parseDateKey', () => {
    it('accepts a real day key', () => {
      assert.equal(parseDateKey('2026-08-14'), '2026-08-14')
    })

    it('rejects impossible dates rather than letting Date roll them over', () => {
      assert.equal(parseDateKey('2026-02-30'), undefined)
      assert.equal(parseDateKey('2026-13-01'), undefined)
      assert.equal(parseDateKey('2026-00-10'), undefined)
    })

    it('rejects anything not exactly YYYY-MM-DD', () => {
      assert.equal(parseDateKey('2026-8-14'), undefined)
      assert.equal(parseDateKey("2026-08-14'><img src=x onerror=alert(1)>"), undefined)
      assert.equal(parseDateKey('today'), undefined)
      assert.equal(parseDateKey(undefined), undefined)
    })
  })

  describe('parseSlug', () => {
    it('accepts tenant slugs', () => {
      assert.equal(parseSlug('samurai-fight-academy'), 'samurai-fight-academy')
    })

    it('rejects path escapes and scheme-ish values', () => {
      // These would otherwise be interpolated into a CTA href on /pay/result.
      assert.equal(parseSlug('../../evil'), undefined)
      assert.equal(parseSlug('//evil.com'), undefined)
      assert.equal(parseSlug('a/b'), undefined)
      assert.equal(parseSlug('javascript:alert(1)'), undefined)
      assert.equal(parseSlug('x?y=z'), undefined)
      assert.equal(parseSlug('-leading-dash'), undefined)
    })
  })

  describe('parsePositiveInt', () => {
    it('accepts bounded positive integers', () => {
      assert.equal(parsePositiveInt('30', 1440), 30)
      assert.equal(parsePositiveInt('1440', 1440), 1440)
    })

    it('rejects out-of-range, non-integer and non-numeric values', () => {
      assert.equal(parsePositiveInt('1441', 1440), undefined)
      assert.equal(parsePositiveInt('0'), undefined)
      assert.equal(parsePositiveInt('-5'), undefined)
      assert.equal(parsePositiveInt('1e9'), undefined)
      assert.equal(parsePositiveInt('30.5'), undefined)
      assert.equal(parsePositiveInt('Infinity'), undefined)
      assert.equal(parsePositiveInt('9007199254740993'), undefined)
    })
  })

  it('publicQuery encodes values, so a param cannot break out of the query', () => {
    assert.equal(
      publicQuery({ session: '"><script>alert(1)</script>' }),
      '?session=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E'
    )
    assert.equal(publicQuery({ from: 'a&b=c' }), '?from=a%26b%3Dc')
  })
})

describe('emailed + printed links stay byte-identical', () => {
  const ORIGIN = 'https://app.linyup.com'
  const slug = 'acme'

  it('booking canceled → rebook link (booking/index.ts)', () => {
    const activityId = 'act1'
    assert.equal(
      publicUrl(ORIGIN, slug, 'booking', { activity: activityId }),
      `${ORIGIN}/public/${slug}/booking?activity=${activityId}`
    )
    // …and no query at all when the session carries no activity.
    assert.equal(
      publicUrl(ORIGIN, slug, 'booking', { activity: undefined }),
      `${ORIGIN}/public/${slug}/booking`
    )
  })

  it('session updated → rebook link (sessions/index.ts)', () => {
    assert.equal(
      publicUrl(ORIGIN, slug, 'booking', { activity: 'act1' }),
      `${ORIGIN}/public/${slug}/booking?activity=act1`
    )
  })

  it('appointment rebook link (booking/index.ts)', () => {
    assert.equal(publicUrl(ORIGIN, slug, 'appointments'), `${ORIGIN}/public/${slug}/appointments`)
  })

  it('manage-booking token links (booking/index.ts, sendBookingReminders.ts)', () => {
    const token = 'tok_abc123'
    assert.equal(
      publicUrl(ORIGIN, slug, 'manage-booking', { token }),
      `${ORIGIN}/public/${slug}/manage-booking?token=${token}`
    )
  })

  it('waitlist token links (booking/waitlist/notify.ts)', () => {
    // ONE shape for both tokens — the page resolves which mode to render from
    // whichever matched, so an offer mail and a join confirmation are
    // indistinguishable by URL.
    assert.equal(
      publicUrl(ORIGIN, slug, 'waitlist', { token: 'offer_abc123' }),
      `${ORIGIN}/public/${slug}/waitlist?token=offer_abc123`
    )
    assert.equal(
      publicUrl(ORIGIN, slug, 'waitlist', { token: 'entry_abc123' }),
      `${ORIGIN}/public/${slug}/waitlist?token=entry_abc123`
    )
  })

  it('appointment cancel token links (appointments/*, connect/webhook.ts)', () => {
    const token = 'tok_abc123'
    assert.equal(
      publicUrl(ORIGIN, slug, 'appointments/cancel', { token }),
      `${ORIGIN}/public/${slug}/appointments/cancel?token=${token}`
    )
  })

  it('referral link (referrals/index.ts)', () => {
    assert.equal(
      publicUrl(ORIGIN, slug, 'booking', { referral: 'CODE123' }),
      `${ORIGIN}/public/${slug}/booking?referral=CODE123`
    )
  })

  it('outreach email links (utils/outreachEmail.ts)', () => {
    assert.equal(publicUrl(ORIGIN, slug, 'booking'), `${ORIGIN}/public/${slug}/booking`)
    assert.equal(publicUrl(ORIGIN, slug, 'signup'), `${ORIGIN}/public/${slug}/signup`)
    assert.equal(publicUrl(ORIGIN, slug), `${ORIGIN}/public/${slug}`)
  })

  it('contact payments portal link (contacts/contactPayments.ts)', () => {
    assert.equal(
      publicSubUrl(`${ORIGIN}/de`, slug, 'space', 'payments'),
      `${ORIGIN}/de/public/${slug}/space/payments`
    )
  })
})

// ─── Locale-pinned links (the ones that go into EMAILS) ─────────────────────
//
// An emailed link carries no locale unless it is put there, so the page answers
// in the READER's browser language while the mail around it is written in the
// studio's. These pin the prefix rule that fixes that — including the one that
// must NOT appear: `localePrefix: 'as-needed'` means the default locale is
// unprefixed, and an `/en/…` link costs a 302 on every click.

const EMAIL_ORIGIN = 'https://app.linyup.com'

describe('publicLocalePrefix', () => {
  it('emits nothing for the default locale', () => {
    assert.equal(publicLocalePrefix('en'), '')
    assert.equal(publicLocalePrefix('en-GB'), '')
  })

  it('emits /de /fr /it for the others, region tags included', () => {
    assert.equal(publicLocalePrefix('de'), '/de')
    assert.equal(publicLocalePrefix('fr'), '/fr')
    assert.equal(publicLocalePrefix('it'), '/it')
    assert.equal(publicLocalePrefix('de-CH'), '/de')
  })

  it('degrades to the default language rather than to a 404 path', () => {
    assert.equal(publicLocalePrefix(''), '')
    assert.equal(publicLocalePrefix(null), '')
    assert.equal(publicLocalePrefix(undefined), '')
    assert.equal(publicLocalePrefix('xx'), '')
    assert.equal(publicLocalePrefix('rm-CH'), '')
  })
})

describe('localizedPublicUrl / localizedPublicSubUrl', () => {
  const slug = 'my-studio'
  const token = 'tok_abc123'

  it("a German studio's manage-booking link opens in German", () => {
    assert.equal(
      localizedPublicUrl(EMAIL_ORIGIN, 'de', slug, 'manage-booking', { token }),
      `${EMAIL_ORIGIN}/de/public/${slug}/manage-booking?token=${token}`
    )
  })

  it("an English studio's link is byte-identical to the unprefixed builder", () => {
    // The acceptance test for changing every emailed link at once: nothing that
    // is already in an inbox may move.
    assert.equal(
      localizedPublicUrl(EMAIL_ORIGIN, 'en', slug, 'manage-booking', { token }),
      publicUrl(EMAIL_ORIGIN, slug, 'manage-booking', { token })
    )
    assert.equal(
      localizedPublicUrl(EMAIL_ORIGIN, undefined, slug, 'appointments/cancel', { token }),
      publicUrl(EMAIL_ORIGIN, slug, 'appointments/cancel', { token })
    )
  })

  it('carries the prefix onto sub-paths too', () => {
    assert.equal(
      localizedPublicSubUrl(EMAIL_ORIGIN, 'fr', slug, 'space', 'payments'),
      `${EMAIL_ORIGIN}/fr/public/${slug}/space/payments`
    )
    assert.equal(
      localizedPublicSubUrl(EMAIL_ORIGIN, 'en', slug, 'space', 'payments'),
      `${EMAIL_ORIGIN}/public/${slug}/space/payments`
    )
  })
})

// ─── systemLinkIsLive ─────────────────────────────────────────────────────────
//
// The bio-link's half of "a link to a surface that is no longer live is not
// offered" (UX-49). The website header has followed that rule since
// `resolveSiteSurfaceLinks`; the bio-link kept offering page links to surfaces
// its own `active_public_surfaces` said were down.

describe('systemLinkIsLive', () => {
  it('drops a page link whose surface is explicitly off', () => {
    const active = { site: false, space: true, booking: true }
    assert.equal(systemLinkIsLive('site', active), false)
    assert.equal(systemLinkIsLive('space', active), true)
  })

  it('keeps every shop link up when there is no till — the page is a price list', () => {
    // `shop: false` says "no till", not "no page": the shop route renders a
    // READ-ONLY PRICE LIST for a studio that takes payment offline, so a link
    // to it is not a dead end. See `routableSurfaces`, which is the ONE place
    // that correction is made — and note that the till itself does not move
    // (the page reads `payments_enabled` and offers no way to pay; every
    // checkout callable refuses anyway).
    //
    // The three shop-* deep links are TABS of that page, not surfaces of their
    // own, so they follow it — up or down, together.
    const active = { site: true, space: true, booking: true, shop: false }
    for (const t of ['shop', 'shop-subscriptions', 'shop-products', 'shop-courses'] as const) {
      assert.equal(systemLinkIsLive(t, active), true, t)
    }
    // …while a genuinely dead surface is still dropped.
    assert.equal(systemLinkIsLive('site', { ...active, site: false }), false)
  })

  it('fails open on an absent map — the admin preview builds its team from the form', () => {
    for (const t of SYSTEM_LINK_TARGETS) {
      assert.equal(systemLinkIsLive(t, undefined), true, t)
    }
  })

  it('fails open on an absent KEY — "not computed" is not "off"', () => {
    // `shop`, `documents`, `signup` and `kiosk` are optional on
    // ActivePublicSurfaces, so a mirror written before one existed omits it. A
    // stale mirror must never blank a studio's links; only an explicit false does.
    assert.equal(systemLinkIsLive('shop', { site: true, space: true, booking: true }), true)
    assert.equal(systemLinkIsLive('documents', { site: true, space: true, booking: true }), true)
  })

  it('maps every target to a surface — no target can be forgotten', () => {
    for (const t of SYSTEM_LINK_TARGETS) {
      assert.ok(SYSTEM_LINK_SURFACE[t], t)
    }
  })
})
