import assert from 'node:assert/strict'
import {
  SITE_THEMES,
  applySiteTheme,
  findSiteTheme,
  themedSection,
  type SiteMeta,
  type WebsiteSection,
} from '@linyup/shared'
import { sanitizeMeta, sanitizeSections } from './sanitize'

// Themes are look + layout presets (shared types/siteTheme.ts): applying one
// writes brand settings and section styles, never content, and the result must
// survive publish like any studio edit.

const meta = (): SiteMeta => ({
  title: 'CrossFit Zug',
  theme: 'light',
  accentColor: '#0749ff',
  font: 'sans',
  logoUrl: 'https://example.ch/logo.svg',
  header: { showNav: true, ctaLabel: 'Kostenlos starten' },
  footer: { showSocial: true, text: 'Bösch 41' },
})

const sections = (): WebsiteSection[] => [
  { id: 'h', type: 'hero', headline: 'Training', align: 'center', overlay: 20 },
  { id: 'c', type: 'cta_banner', heading: 'Start', text: 'Now' },
  { id: 'v', type: 'video', heading: 'Film', provider: 'vimeo', videoId: '1113155200' },
  { id: 'f', type: 'faq', items: [{ question: 'q', answer: 'a' }] },
]

describe('site themes', () => {
  const box = findSiteTheme('box')!

  it('every theme only sets presentation — its section defaults name known style fields', () => {
    const presentational = new Set(['align', 'overlay', 'layout', 'overlayStyle', 'overlayTone', 'style', 'display'])
    for (const theme of SITE_THEMES) {
      for (const defaults of Object.values(theme.sections)) {
        for (const key of Object.keys(defaults ?? {})) assert.ok(presentational.has(key), `${theme.id}: ${key}`)
      }
    }
  })

  it('applies the look, records the theme, and keeps the studio content', () => {
    const out = applySiteTheme({ meta: meta(), sections: sections() }, box)
    assert.equal(out.meta.font, 'montserrat')
    assert.equal(out.meta.headingCase, 'uppercase')
    assert.equal(out.meta.cardShape, 'square')
    assert.equal(out.meta.appliedTheme, 'box')
    // The studio's identity is not the theme's.
    assert.equal(out.meta.accentColor, '#0749ff')
    assert.equal(out.meta.logoUrl, 'https://example.ch/logo.svg')
    assert.equal(out.meta.footer.text, 'Bösch 41')
    assert.equal(out.meta.header.ctaLabel, 'Kostenlos starten')
  })

  it('moves sections of a styled type to the theme style and leaves the rest alone', () => {
    const input = sections()
    const out = applySiteTheme({ meta: meta(), sections: input }, box)
    const byId = Object.fromEntries(out.sections.map((s) => [s.id, s as unknown as Record<string, unknown>]))
    assert.equal(byId.h.align, 'left')
    assert.equal(byId.h.headline, 'Training')
    assert.equal(byId.c.style, 'band')
    assert.equal(byId.v.display, 'lightbox')
    // A type the theme says nothing about is the same object.
    assert.equal(out.sections[3], input[3])
    // Pure: the input was not mutated.
    assert.equal((input[1] as { style?: string }).style, undefined)
  })

  it('a new section starts in the theme style', () => {
    const fresh: WebsiteSection = { id: 'n', type: 'cta_banner', heading: 'x' }
    const cta = themedSection(fresh, box) as { style?: string }
    assert.equal(cta.style, 'band')
  })

  it('a themed site survives publish', () => {
    const out = applySiteTheme({ meta: meta(), sections: sections() }, box)
    const published = sanitizeMeta(structuredClone(out.meta), 'fallback')
    for (const key of Object.keys(box.look) as (keyof typeof box.look)[]) {
      assert.equal(published[key], box.look[key], key)
    }
    assert.equal(published.appliedTheme, 'box')
    const publishedSections = sanitizeSections(structuredClone(out.sections))
    assert.equal((publishedSections.find((s) => s.id === 'c') as { style?: string }).style, 'band')
    // An unknown theme id is not published.
    assert.equal(sanitizeMeta({ ...out.meta, appliedTheme: 'neon' }, 't').appliedTheme, undefined)
  })
})
