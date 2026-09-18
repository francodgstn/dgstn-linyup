import assert from 'node:assert/strict'
import type { ClubsSection, CoachesSection, LocationsSection } from '@linyup/shared'
import { orgSiteSourceLocale, sanitizeOrgMeta, sanitizeOrgSection } from './sanitize'

// THE ORG SITE'S OWN PUBLISH RULES. The sections it shares with the team site
// are round-tripped by ../website/sectionRoundTrip.test.ts; this covers what
// only an organisation has — the three aggregate sections, the header button,
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

  it('drops an unknown type and a section without an id', () => {
    assert.equal(sanitizeOrgSection({ id: 'p', type: 'pricing' }), null)
    assert.equal(sanitizeOrgSection({ type: 'clubs', columns: 3 }), null)
  })
})

describe('org website publish — the header button is a link or nothing', () => {
  const header = (h: Record<string, unknown>) => sanitizeOrgMeta({ header: { showNav: true, ...h } }, 'Federation').header

  it('keeps a labelled button with an address, as a link', () => {
    const h = header({ ctaLabel: 'Join', ctaAction: 'url', ctaUrl: 'https://example.ch/join' })
    assert.equal(h.ctaAction, 'url')
    assert.equal(h.ctaUrl, 'https://example.ch/join')
  })

  it('never publishes a booking button — an organisation has no booking page', () => {
    const h = header({ ctaLabel: 'Book now', ctaAction: 'booking' })
    assert.equal(h.ctaLabel, undefined)
    assert.equal(h.ctaAction, undefined)
  })

  it('keeps the link when the draft stored an address under another action', () => {
    const h = header({ ctaLabel: 'Join', ctaAction: 'booking', ctaUrl: 'https://example.ch/join' })
    assert.equal(h.ctaAction, 'url')
    assert.equal(h.ctaUrl, 'https://example.ch/join')
  })
})

describe('org website publish — the language the site is written in', () => {
  it("prefers the site's own language over the organisation's", () => {
    assert.equal(orgSiteSourceLocale({ language: 'de' }, { language: 'en' }), 'de')
  })
  it("falls back to the organisation's, then to English", () => {
    assert.equal(orgSiteSourceLocale({}, { language: 'fr' }), 'fr')
    assert.equal(orgSiteSourceLocale({}, {}), 'en')
  })
})
