// Consumer-side fixtures for the shared extractor/resolver
// (@linyup/shared utils/siteTranslation.ts) — this module (translate/) is the
// pipeline that reads their output, so these pin the contract it depends on:
// key stability, the staleness guard, the excluded-field list, org/widget
// sections sharing one extractor, deep-clone, and whitespace handling.
import assert from 'node:assert/strict'
import {
  extractSiteUnits,
  applySiteTranslations,
  applySectionTranslations,
  translationSourceHash,
  type HeroSection,
  type ContentSection,
  type ContactSection,
  type SiteMeta,
  type EmbedWidget,
  type ClubsSection,
  type FeaturesSection,
  type FaqSection,
  type TestimonialsSection,
  type SiteTranslationUnits,
} from '@linyup/shared'

function hero(id: string, headline: string): HeroSection {
  return { id, type: 'hero', headline, align: 'center' }
}

function content(id: string, heading: string, body: string): ContentSection {
  return { id, type: 'content', heading, body, imageSide: 'left' }
}

describe('translate/siteTranslation (extractor/resolver contract)', () => {
  it('key stability: reordering sections does not change the set of keys', () => {
    const a = [hero('h1', 'Welcome'), content('c1', 'About', '<p>Hi</p>')]
    const b = [content('c1', 'About', '<p>Hi</p>'), hero('h1', 'Welcome')]

    const keysA = extractSiteUnits({ sections: a })
      .map((u) => u.key)
      .sort()
    const keysB = extractSiteUnits({ sections: b })
      .map((u) => u.key)
      .sort()
    assert.deepEqual(keysA, keysB)
    assert.deepEqual(keysA, ['s.c1.body', 's.c1.heading', 's.h1.headline'])
  })

  it('staleness guard: a unit whose srcHash no longer matches the base text is never substituted', () => {
    const sections = [hero('h1', 'Welcome to the studio')]
    const staleUnits: SiteTranslationUnits = {
      's.h1.headline': { text: 'Bienvenue (STALE)', srcHash: translationSourceHash('a different headline entirely') },
    }
    const translated = applySiteTranslations({ sections }, staleUnits)
    assert.equal((translated.sections[0] as HeroSection).headline, 'Welcome to the studio')
  })

  it('staleness guard: a unit whose srcHash matches IS substituted', () => {
    const sections = [hero('h1', 'Welcome to the studio')]
    const freshUnits: SiteTranslationUnits = {
      's.h1.headline': { text: 'Bienvenue au studio', srcHash: translationSourceHash('Welcome to the studio') },
    }
    const translated = applySiteTranslations({ sections }, freshUnits)
    assert.equal((translated.sections[0] as HeroSection).headline, 'Bienvenue au studio')
  })

  it('excluded fields are never extracted: contact address/phone/email, meta.title, place names', () => {
    const contactSection: ContactSection = {
      id: 'ct1',
      type: 'contact',
      heading: 'Find us',
      address: '123 Main St',
      phone: '+41 22 000 00 00',
      email: 'hello@example.com',
      mapQuery: '123 Main St',
      showSocial: false,
    }
    const meta: SiteMeta = {
      title: 'My Studio', // excluded — brand name
      theme: 'light',
      accentColor: '#000',
      font: 'sans',
      header: { showNav: true, ctaAction: 'booking', showSignIn: true },
      footer: { showSocial: true },
    }
    const units = extractSiteUnits({ meta, sections: [contactSection] })
    const keys = units.map((u) => u.key)
    assert.ok(keys.includes('s.ct1.heading'))
    assert.ok(!keys.some((k) => k.includes('address')))
    assert.ok(!keys.some((k) => k.includes('phone')))
    assert.ok(!keys.some((k) => k.includes('email')))
    assert.ok(!keys.some((k) => k.includes('mapQuery')))
    assert.ok(!keys.includes('meta.title'))
    assert.ok(!units.some((u) => u.text === 'My Studio'))
  })

  it('org sections and widget sections extract through the SAME extractor as team sections', () => {
    const clubs: ClubsSection = { id: 'org1', type: 'clubs', heading: 'Our clubs', columns: 3 }
    const widget: EmbedWidget = { id: 'w1', type: 'hero', headline: 'Embedded hero', align: 'left', label: 'Studio-facing label' }

    const orgUnits = extractSiteUnits({ sections: [clubs] })
    assert.deepEqual(
      orgUnits.map((u) => u.key),
      ['s.org1.heading']
    )

    // Widgets ARE WebsiteSections — pass `sections: widgets`.
    const widgetUnits = extractSiteUnits({ sections: [widget] })
    assert.deepEqual(
      widgetUnits.map((u) => u.key),
      ['s.w1.headline']
    )
    // The studio-facing `label` is never extracted.
    assert.ok(!widgetUnits.some((u) => u.text === 'Studio-facing label'))

    const resolvedWidget = applySectionTranslations(widget, {
      's.w1.headline': { text: 'Héros intégré', srcHash: translationSourceHash('Embedded hero') },
    })
    assert.equal(resolvedWidget.headline, 'Héros intégré')
  })

  it('deep-clone: applySiteTranslations never mutates the input site', () => {
    const sections = [hero('h1', 'Welcome')]
    const site = { sections }
    const units: SiteTranslationUnits = {
      's.h1.headline': { text: 'Bienvenue', srcHash: translationSourceHash('Welcome') },
    }
    const translated = applySiteTranslations(site, units)
    assert.equal((site.sections[0] as HeroSection).headline, 'Welcome')
    assert.equal((translated.sections[0] as HeroSection).headline, 'Bienvenue')
    assert.notEqual(translated.sections, site.sections)
  })

  it('whitespace-only source is never extracted', () => {
    const sections = [hero('h1', '   ')]
    const units = extractSiteUnits({ sections })
    assert.deepEqual(units, [])
  })

  it('whitespace-only base text is never substituted, even with a matching stored unit', () => {
    const sections = [hero('h1', '   ')]
    const units: SiteTranslationUnits = {
      's.h1.headline': { text: 'should never appear', srcHash: translationSourceHash('   ') },
    }
    const translated = applySiteTranslations({ sections }, units)
    assert.equal((translated.sections[0] as HeroSection).headline, '   ')
  })

  it('features / faq / testimonials extract their item text, and a testimonial NAME does not', () => {
    const features: FeaturesSection = {
      id: 'f1', type: 'features', columns: 3,
      items: [{ icon: 'Star', title: 'Coached', text: 'By pros', linkLabel: 'More', linkUrl: 'https://x' }],
    }
    const faq: FaqSection = {
      id: 'q1', type: 'faq',
      items: [{ question: 'When?', answer: 'Anytime.' }],
    }
    const testis: TestimonialsSection = {
      id: 't1', type: 'testimonials',
      items: [{ name: 'Alex', activity: 'Member', feedback: 'Loved it' }],
    }
    const units = extractSiteUnits({ sections: [features, faq, testis] })
    const byKey = new Map(units.map((u) => [u.key, u.text]))
    assert.equal(byKey.get('s.f1.item.0.title'), 'Coached')
    assert.equal(byKey.get('s.f1.item.0.text'), 'By pros')
    assert.equal(byKey.get('s.f1.item.0.linkLabel'), 'More')
    assert.equal(byKey.get('s.q1.item.0.question'), 'When?')
    assert.equal(byKey.get('s.q1.item.0.answer'), 'Anytime.')
    assert.equal(byKey.get('s.t1.item.0.activity'), 'Member')
    assert.equal(byKey.get('s.t1.item.0.feedback'), 'Loved it')
    // The person's name is never extracted, so it is never machine-translated.
    assert.equal([...byKey.keys()].some((k) => k.startsWith('s.t1.item.0.name')), false)
    // Nor is a link URL.
    assert.equal([...byKey.keys()].some((k) => k.includes('linkUrl')), false)
  })

  it('a translated feature item is substituted back at its key', () => {
    const features: FeaturesSection = {
      id: 'f2', type: 'features', columns: 2,
      items: [{ title: 'Fast' }],
    }
    const units: SiteTranslationUnits = {
      's.f2.item.0.title': { text: 'Schnell', srcHash: translationSourceHash('Fast') },
    }
    const out = applySiteTranslations({ sections: [features] }, units)
    assert.equal((out.sections[0] as FeaturesSection).items[0].title, 'Schnell')
  })

  // The brand chrome — top bar, footer text, footer columns, legal row — is
  // tenant-authored prose like any section, so it rides the same pipeline.
  const brandMeta = (): SiteMeta => ({
    title: 'CFZ',
    theme: 'light',
    accentColor: '#0749ff',
    font: 'montserrat',
    header: {
      showNav: true,
      topBar: { text: 'Open 24/7', items: [{ id: 'tb1', label: 'Login', target: { kind: 'url', url: 'https://x.ch' } }] },
    },
    footer: {
      showSocial: true,
      text: 'Your box in Zug',
      columns: [{ id: 'col1', heading: 'Offers', items: [{ id: 'fc1', label: 'CrossFit', target: { kind: 'none' } }] }],
      logos: [{ url: 'https://x.ch/logo.png', alt: 'SWICA' }],
      legal: [{ id: 'lg1', label: 'Imprint', target: { kind: 'url', url: 'https://x.ch/imprint' } }],
    },
  })

  it('top bar, footer text, footer columns and the legal row extract under their own keys', () => {
    const byKey = new Map(extractSiteUnits({ meta: brandMeta(), sections: [] }).map((u) => [u.key, u.text]))
    assert.equal(byKey.get('topbar.text'), 'Open 24/7')
    assert.equal(byKey.get('menu.tb1'), 'Login')
    assert.equal(byKey.get('footer.text'), 'Your box in Zug')
    assert.equal(byKey.get('footer.col.col1.heading'), 'Offers')
    assert.equal(byKey.get('menu.fc1'), 'CrossFit')
    assert.equal(byKey.get('menu.lg1'), 'Imprint')
    // A partner logo's alt is a brand name, never prose to translate.
    assert.equal([...byKey.values()].includes('SWICA'), false)
  })

  it('translated brand chrome is substituted back, and a stale unit is not', () => {
    const units: SiteTranslationUnits = {
      'topbar.text': { text: 'Rund um die Uhr offen', srcHash: translationSourceHash('Open 24/7') },
      'footer.col.col1.heading': { text: 'Angebote', srcHash: translationSourceHash('Offers') },
      'menu.lg1': { text: 'Impressum', srcHash: translationSourceHash('Imprint') },
      'footer.text': { text: 'Veraltet', srcHash: translationSourceHash('some older footer') },
    }
    const out = applySiteTranslations({ meta: brandMeta(), sections: [] }, units)
    assert.equal(out.meta?.header.topBar?.text, 'Rund um die Uhr offen')
    assert.equal(out.meta?.footer.columns?.[0].heading, 'Angebote')
    assert.equal(out.meta?.footer.legal?.[0].label, 'Impressum')
    assert.equal(out.meta?.footer.text, 'Your box in Zug')
  })
})
