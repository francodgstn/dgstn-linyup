import assert from 'node:assert/strict'
import type { ClubsSection, CoachesSection, LocationsSection } from '@linyup/shared'
import { publicOrgPath } from '@linyup/shared'
import { orgSiteSourceLocale, sanitizeOrgMeta, sanitizeOrgSection } from './sanitize'

// THE ORG SITE'S OWN PUBLISH RULES. The sections it shares with the team site
// are round-tripped by ../website/sectionRoundTrip.test.ts; this covers what
// only an organization has — the three aggregate sections, the header button,
// and which language the site is written in. There were no org publish tests
// before this file, which is how the club directory's layout and search box
// were lost at publish without anything failing.

// Every optional key made required, so a field added to one of these types
// fails the build here until it has a fixture value — and then fails the
// deep-equal until the sanitizer carries it.
type Complete<T> = { [K in keyof T]-?: T[K] }

const nav = { showInNav: false } as const

describe('org website publish — the aggregate sections round-trip', () => {
  const clubs: Complete<Omit<ClubsSection, 'hidden'>> = {
    id: 'clubs', type: 'clubs', ...nav,
    heading: 'Our clubs',
    subheading: 'Train with us',
    columns: 4,
    showAddress: true,
    layout: 'list',
    searchable: true,
  }
  const locations: Complete<Omit<LocationsSection, 'hidden'>> = {
    id: 'locations', type: 'locations', ...nav,
    heading: 'Where to find us',
    subheading: 'Across Switzerland',
    columns: 2,
    extra: [{ id: 'x1', name: 'Summer camp', address: 'Seeweg 1, 6300 Zug', mapsLink: 'https://maps.example.ch/x1' }],
  }
  const coaches: Complete<Omit<CoachesSection, 'hidden'>> = {
    id: 'coaches', type: 'coaches', ...nav,
    heading: 'Our coaches',
    subheading: 'Certified',
    columns: 3,
  }

  for (const fixture of [clubs, locations, coaches]) {
    it(fixture.type, () => {
      assert.deepEqual(sanitizeOrgSection(structuredClone(fixture)), fixture)
    })
  }

  it('publishes a blog-posts section — organizations write news too', () => {
    const posts = { id: 'news', type: 'posts', heading: 'News', limit: 4, layout: 'list', columns: 2 }
    assert.deepEqual(sanitizeOrgSection(structuredClone(posts)), posts)
  })

  it('drops an unknown type and a section without an id', () => {
    assert.equal(sanitizeOrgSection({ id: 'p', type: 'pricing' }), null)
    assert.equal(sanitizeOrgSection({ type: 'clubs', columns: 3 }), null)
  })
})

describe('org website publish — section buttons open a page or a link', () => {
  it('keeps a page button and a link button', () => {
    const hero = (cta: Record<string, unknown>) =>
      (sanitizeOrgSection({ id: 'h', type: 'hero', headline: 'Verband', align: 'center', cta }) as unknown as {
        cta?: { action: string }
      }).cta
    assert.equal(hero({ label: 'Über uns', action: 'page', pageId: 'p-about' })?.action, 'page')
    assert.equal(hero({ label: 'Mehr', action: 'url', url: 'https://example.ch' })?.action, 'url')
  })
  it('drops a booking, signup or appointment button', () => {
    for (const action of ['booking', 'signup', 'appointment']) {
      const banner = sanitizeOrgSection({
        id: 'c', type: 'cta_banner', heading: 'Los', cta: { label: 'Buchen', action, activityId: 'a1' },
      }) as unknown as { cta?: unknown }
      assert.equal(banner.cta, undefined, action)
    }
  })
})

describe('org website publish — the header button is a page, a link, or nothing', () => {
  const header = (h: Record<string, unknown>) => sanitizeOrgMeta({ header: { showNav: true, ...h } }, 'Federation').header

  it('keeps a labeled button with an address, as a link', () => {
    const h = header({ ctaLabel: 'Join', ctaAction: 'url', ctaUrl: 'https://example.ch/join' })
    assert.equal(h.ctaAction, 'url')
    assert.equal(h.ctaUrl, 'https://example.ch/join')
  })

  it('never publishes a booking button — an organization has no booking page', () => {
    const h = header({ ctaLabel: 'Book now', ctaAction: 'booking' })
    assert.equal(h.ctaLabel, undefined)
    assert.equal(h.ctaAction, undefined)
  })

  it('keeps the link when the draft stored an address under another action', () => {
    const h = header({ ctaLabel: 'Join', ctaAction: 'booking', ctaUrl: 'https://example.ch/join' })
    assert.equal(h.ctaAction, 'url')
    assert.equal(h.ctaUrl, 'https://example.ch/join')
  })

  it("opens one of the site's own pages", () => {
    const h = header({ ctaLabel: 'Membership', ctaAction: 'page', ctaPageId: 'p-join', ctaUrl: 'https://stale.example' })
    assert.equal(h.ctaAction, 'page')
    assert.equal(h.ctaPageId, 'p-join')
    assert.equal(h.ctaUrl, undefined)
  })

  it('drops a page button that names no page, unless it still has an address', () => {
    assert.equal(header({ ctaLabel: 'Membership', ctaAction: 'page' }).ctaLabel, undefined)
    const h = header({ ctaLabel: 'Join', ctaAction: 'page', ctaUrl: 'https://example.ch/join' })
    assert.equal(h.ctaAction, 'url')
  })

  it('never publishes an appointment button', () => {
    const h = header({ ctaLabel: 'Book', ctaAction: 'appointment', ctaActivityId: 'a1' })
    assert.equal(h.ctaLabel, undefined)
    assert.equal(h.ctaActivityId, undefined)
  })
})

describe('org website publish — the language the site is written in', () => {
  it("prefers the site's own language over the organization's", () => {
    assert.equal(orgSiteSourceLocale({ language: 'de' }, { language: 'en' }), 'de')
  })
  it("falls back to the organization's, then to English", () => {
    assert.equal(orgSiteSourceLocale({}, { language: 'fr' }), 'fr')
    assert.equal(orgSiteSourceLocale({}, {}), 'en')
  })
})

describe('org website addresses', () => {
  it('puts pages directly under the org slug — no /site level', () => {
    assert.equal(publicOrgPath('swiss-hmd'), '/public/org/swiss-hmd')
    assert.equal(publicOrgPath('swiss-hmd', ['ueber-uns', 'vorstand']), '/public/org/swiss-hmd/ueber-uns/vorstand')
  })
})
