import assert from 'node:assert/strict'
import type { SiteMeta, WebsiteSection, WebsiteSectionType } from '@linyup/shared'
import { sanitizeCta, sanitizeMeta, sanitizeMenu, sanitizeSection, sanitizeSections } from './sanitize'

// EVERY FIELD THE EDITOR CAN WRITE MUST SURVIVE PUBLISH.
//
// The publish sanitizer re-derives the public doc from a whitelist, which makes
// a forgotten field fail silently: the preview renders the draft, the live site
// renders the sanitized copy, and nothing errors. Four whole section types and
// every theme preset field were lost that way.
//
// So the fixtures below are typed COMPLETE — `-?` makes every optional key
// required — and ts-node type-checks this file when mocha loads it. A field
// added to a section type or to SiteMeta without a fixture value here fails
// the test run; with one, the deep-equal below fails until the sanitizer keeps
// it. (A section TYPE with no builder already fails `tsc` in ./sanitize.)

type Complete<T> = { [K in keyof T]-?: T[K] }

/** The section whose `type` admits K — ContentSection covers 'content' AND 'about'. */
type SectionOf<K, S = WebsiteSection> = S extends { type: infer T } ? (K extends T ? S : never) : never

/** `hidden` never reaches publish (filtered out before sanitizing); `places` is
 *  filled from Firestore after sanitizing, by the callable. */
type Fixture<K extends WebsiteSectionType> = Complete<Omit<SectionOf<K>, 'hidden' | 'places'>>

const nav = { menuLabel: 'Menu', showInNav: false } as const
const cta = { label: 'Kostenlos starten', action: 'url', url: 'https://example.ch/start' } as const

const FIXTURES: { [K in WebsiteSectionType]: Fixture<K> } = {
  hero: {
    id: 'hero', type: 'hero', ...nav,
    headline: 'Training, das Resultate liefert',
    subheadline: 'CrossFit in Zug',
    bgImageUrl: 'https://example.ch/hero.avif',
    bgMotion: 'kenburns',
    overlay: 55,
    bgColor: '#111827',
    layout: 'card',
    align: 'left',
    cta,
    bgVideoUrl: 'https://cdn.example.ch/drone-loop.mp4',
    overlayStyle: 'gradient-left-bottom',
    overlayTone: 'light',
  },
  content: {
    id: 'content', type: 'content', ...nav,
    heading: 'Unsere Box',
    body: '<p>600 m<strong>2</strong></p>',
    imageUrl: 'https://example.ch/box.jpg',
    imageSide: 'right',
  },
  about: {
    id: 'about', type: 'about', ...nav,
    heading: 'About',
    body: '<p>Legacy</p>',
    imageUrl: 'https://example.ch/about.jpg',
    imageSide: 'left',
  },
  gallery: {
    id: 'gallery', type: 'gallery', ...nav,
    heading: 'Impressionen',
    images: [{ url: 'https://example.ch/1.jpg', caption: 'Rig' }],
    columns: 4,
    layout: 'marquee',
  },
  features: {
    id: 'features', type: 'features', ...nav,
    countUp: true,
    heading: 'Dein Erfolg beginnt hier',
    subheading: 'Drei Werte',
    columns: 3,
    items: [
      {
        icon: 'Sparkles',
        title: 'Exzellenz',
        text: 'Coaching',
        linkLabel: 'Mehr',
        linkUrl: '#angebot',
        imageUrl: 'https://example.ch/crossfit.avif',
      },
    ],
    style: 'stats',
  },
  cta_banner: {
    id: 'cta', type: 'cta_banner', ...nav,
    heading: 'Dein kostenloses Erstgespräch wartet',
    text: 'Jetzt Termin buchen',
    cta,
    style: 'band',
    bgImageUrl: 'https://example.ch/cta.svg',
  },
  video: {
    id: 'video', type: 'video', ...nav,
    heading: 'Hier wird dein Training zum Erlebnis',
    text: 'Ein Blick in die Box',
    provider: 'vimeo',
    videoId: '1113155200',
    display: 'lightbox',
    playLabel: 'Video abspielen',
    bgVideoUrl: 'https://cdn.example.ch/drohnenflug.webm',
    posterUrl: 'https://example.ch/poster.jpg',
  },
  faq: {
    id: 'faq', type: 'faq', ...nav,
    heading: 'Alles, was du wissen musst',
    style: 'panels',
    items: [{ question: 'Brauche ich Erfahrung?', answer: 'Nein.\nWir starten gemeinsam.' }],
  },
  testimonials: {
    id: 'testimonials', type: 'testimonials', ...nav,
    heading: 'Echte Resultate',
    items: [{ name: 'Can', activity: 'Member', feedback: 'Beste Entscheidung.' }],
  },
  activities: {
    id: 'activities', type: 'activities', ...nav,
    heading: 'Angebot',
    subheading: 'Klassen',
    source: 'activities',
    columns: 2,
    layout: 'list',
    showBooking: true,
    pricingDisplay: 'compact',
  },
  pricing: {
    id: 'pricing', type: 'pricing', ...nav,
    heading: 'Preise',
    subheading: 'Abos',
    source: 'subscriptions',
    ctaLabel: 'Wählen',
    layout: 'table',
    groupBy: 'term',
  },
  schedule: {
    id: 'schedule', type: 'schedule', ...nav,
    heading: 'Stundenplan',
    source: 'sessions',
    windowDays: 14,
    maxItems: 20,
    activityId: 'act-1',
    displayMode: 'list',
    showBooking: true,
  },
  contact: {
    id: 'contact', type: 'contact', ...nav,
    heading: 'Anfahrt',
    address: 'Bösch 41, 6331 Hünenberg',
    phone: '+41 41 790 10 48',
    email: 'info@example.ch',
    hours: '24/7',
    mapQuery: 'Bösch 41 Hünenberg',
    showSocial: true,
  },
  places: {
    id: 'places', type: 'places', ...nav,
    heading: 'Standorte',
    subheading: 'Wo wir trainieren',
    columns: 2,
    placeIds: ['place-1'],
  },
  team: {
    id: 'team', type: 'team', ...nav,
    captionStyle: 'overlay-dark',
    bioDisplay: 'modal',
    heading: 'Unser Team',
    subheading: '12 Coaches',
    columns: 4,
    layout: 'contact',
    items: [
      {
        name: 'Patrick Dos Santos Rodrigues',
        role: 'Head Coach',
        badge: 'CF-L3',
        bio: 'Seit 2014 dabei',
        imageUrl: 'https://example.ch/patrick.png',
        email: 'patrick@example.ch',
        phone: '+41 41 790 10 48',
      },
    ],
  },
  form: {
    id: 'form', type: 'form', ...nav,
    heading: 'No Sweat Intro',
    text: '30 Minuten, kostenlos',
    formId: 'form-1',
    next: { kind: 'appointment', activityId: 'act-intro' },
  },
  split: {
    id: 'split', type: 'split', ...nav,
    heading: 'CrossFit',
    subheading: 'Funktionelles Training',
    body: '<p>Gemeinsam wachsen.</p>',
    items: [{ icon: 'Sparkles', title: 'Coaching', text: 'In kleinen Klassen' }],
    side: {
      heading: 'Gut zu wissen',
      text: 'Kostenloses Erstgespräch',
      imageUrl: 'https://example.ch/side.jpg',
      facts: [{ label: 'Dauer', value: '60 Min.' }],
      cta: { label: 'Jetzt starten', action: 'page', pageId: 'p-intro' },
    },
    sidePosition: 'left',
    sideSticky: true,
  },
  posts: {
    id: 'posts', type: 'posts', ...nav,
    heading: 'Aktuelles',
    subheading: 'Member of the Month',
    limit: 4,
    layout: 'list',
    columns: 2,
  },
}

describe('website publish — every section field round-trips', () => {
  for (const fixture of Object.values(FIXTURES) as WebsiteSection[]) {
    it(fixture.type, () => {
      // 'about' is the legacy literal; publish normalizes it to 'content'.
      const expected = fixture.type === 'about' ? { ...fixture, type: 'content' } : fixture
      assert.deepEqual(sanitizeSection(structuredClone(fixture)), expected)
    })
  }
})

describe('website publish — site meta round-trips', () => {
  const META: Complete<SiteMeta> = {
    title: 'CrossFit Zug',
    themePreset: 'custom',
    themeLight: '#fafafa',
    themeDark: '#0b0d12',
    themeSingle: true,
    themeLighting: true,
    themeToggle: true,
    theme: 'dark',
    accentColor: '#0749FF',
    font: 'montserrat',
    headingFont: 'oswald',
    headingCase: 'uppercase',
    buttonShape: 'square',
    cardShape: 'square',
    contentWidth: 'wide',
    navCase: 'uppercase',
    language: 'de',
    appliedTheme: 'box',
    buttonColor: '#000000',
    logoUrl: 'https://example.ch/logo.svg',
    background: 'linear-gradient(135deg, #fde0dd 0%, rgba(255, 255, 255, 0.8) 100%)',
    seo: { title: 'CFZ', description: 'CrossFit in Zug', ogImageUrl: 'https://example.ch/og.jpg' },
    header: {
      showNav: true,
      ctaLabel: 'Start',
      ctaAction: 'url',
      ctaUrl: 'https://example.ch/start',
      showSignIn: false,
      topBar: {
        text: 'info@example.ch · +41 41 790 10 48',
        items: [{ id: 'tb-login', label: 'Login', target: { kind: 'url', url: 'https://example.ch/login' } }],
      },
    },
    footer: {
      showSocial: false,
      text: 'CrossFit Zug\nBösch 41, 6331 Hünenberg',
      columns: [
        { id: 'col-offers', heading: 'Unsere Angebote', items: [{ id: 'fc-cf', label: 'CrossFit', target: { kind: 'section', sectionId: 'offers' } }] },
      ],
      logos: [{ url: 'https://example.ch/swica.png', link: 'https://www.swica.ch', alt: 'SWICA' }],
      appLinks: { ios: 'https://apps.apple.com/app/x', android: 'https://play.google.com/store/apps/details?id=x' },
      legal: [{ id: 'lg-impressum', label: 'Impressum', target: { kind: 'url', url: 'https://example.ch/impressum' } }],
    },
  }

  it('keeps every field', () => {
    assert.deepEqual(sanitizeMeta(structuredClone(META), 'fallback'), META)
  })

  it('accepts every fixed preset id', () => {
    assert.equal(sanitizeMeta({ themePreset: 'ocean' }, 't').themePreset, 'ocean')
  })
})

describe('website publish — what it refuses', () => {
  it('drops an unknown section type and hidden sections', () => {
    const out = sanitizeSections([
      { id: 'a', type: 'marquee' },
      { id: 'b', type: 'faq', hidden: true, items: [{ question: 'q', answer: 'a' }] },
      { id: 'c', type: 'faq', items: [{ question: 'q', answer: 'a' }] },
    ])
    assert.deepEqual(out.map((s) => s.id), ['c'])
  })

  it('drops list sections whose items are all invalid (they render nothing)', () => {
    assert.equal(sanitizeSection({ id: 'f', type: 'features', items: [{ text: 'no title' }] }), null)
    assert.equal(sanitizeSection({ id: 'q', type: 'faq', items: [{ question: 'no answer' }] }), null)
    assert.equal(sanitizeSection({ id: 't', type: 'testimonials', items: [{ name: 'no quote' }] }), null)
    assert.equal(sanitizeSection({ id: 'c', type: 'cta_banner', text: 'no heading' }), null)
  })

  it('strips unsafe links and icon names from feature items', () => {
    const out = sanitizeSection({
      id: 'f',
      type: 'features',
      items: [{ title: 'x', icon: '<svg onload=1>', linkLabel: 'go', linkUrl: 'javascript:alert(1)' }],
    })
    assert.deepEqual(out, { id: 'f', type: 'features', columns: 3, items: [{ title: 'x', linkLabel: 'go' }] })
  })

  it('refuses colours that are not colours', () => {
    const meta = sanitizeMeta(
      {
        accentColor: 'red; background: url(https://evil.example/x.png)',
        themeLight: 'white',
        themePreset: 'neon',
        background: 'url(https://evil.example/x.png)',
      },
      't',
    )
    assert.equal(meta.accentColor, '#6366f1')
    assert.equal(meta.themeLight, undefined)
    assert.equal(meta.themePreset, undefined)
    assert.equal(meta.background, undefined)
    assert.equal(sanitizeSection({ id: 'h', type: 'hero', headline: 'x', bgColor: 'expression(1)' })?.hasOwnProperty('bgColor'), false)
  })

  it('does not write presentation defaults a site never chose', () => {
    const hero = sanitizeSection({ id: 'h', type: 'hero', headline: 'x' }) as unknown as Record<string, unknown>
    assert.equal('layout' in hero, false)
    const pricing = sanitizeSection({ id: 'p', type: 'pricing' }) as unknown as Record<string, unknown>
    assert.equal('layout' in pricing, false)
    const meta = sanitizeMeta({}, 't') as unknown as unknown as Record<string, unknown>
    for (const k of ['themePreset', 'themeToggle', 'themeSingle', 'themeLighting', 'background']) {
      assert.equal(k in meta, false, k)
    }
  })

  it('refuses a video it cannot play safely', () => {
    // A YouTube id in a Vimeo slot, a URL where an id belongs, a page as a loop.
    assert.equal(sanitizeSection({ id: 'v1', type: 'video', provider: 'vimeo', videoId: 'dQw4w9WgXcQ' }), null)
    assert.equal(sanitizeSection({ id: 'v2', type: 'video', provider: 'youtube', videoId: 'https://evil.example/x' }), null)
    assert.equal(sanitizeSection({ id: 'v3', type: 'video', bgVideoUrl: 'https://example.ch/page.html' }), null)
    // A background loop alone is a valid block.
    assert.deepEqual(sanitizeSection({ id: 'v4', type: 'video', bgVideoUrl: 'https://cdn.example.ch/loop.mp4?v=2' }), {
      id: 'v4',
      type: 'video',
      bgVideoUrl: 'https://cdn.example.ch/loop.mp4?v=2',
    })
    // A hero loop that is not a video file is dropped; the hero stays.
    const hero = sanitizeSection({ id: 'h', type: 'hero', headline: 'x', bgVideoUrl: 'javascript:alert(1)' }) as unknown as Record<string, unknown>
    assert.equal('bgVideoUrl' in hero, false)
  })

  it('a feature link is an https URL or a same-page anchor, nothing else', () => {
    const linkOf = (linkUrl: string) =>
      (sanitizeSection({ id: 'f', type: 'features', items: [{ title: 'x', linkUrl }] }) as unknown as {
        items: { linkUrl?: string }[]
      }).items[0].linkUrl
    assert.equal(linkOf('#cfz-angebot'), '#cfz-angebot')
    assert.equal(linkOf('https://example.ch/a'), 'https://example.ch/a')
    assert.equal(linkOf('#"><script>'), undefined)
    assert.equal(linkOf('/relative'), undefined)
  })

  it('opens an appointment CTA on its own activity, and never on nothing', () => {
    assert.deepEqual(sanitizeCta({ label: 'Kostenlos starten', action: 'appointment', activityId: 'act-intro' }), {
      label: 'Kostenlos starten',
      action: 'appointment',
      activityId: 'act-intro',
    })
    // No activity ⇒ the booking panel's front door, not a dead button.
    assert.deepEqual(sanitizeCta({ label: 'Start', action: 'appointment' }), { label: 'Start', action: 'booking' })
    const header = (h: Record<string, unknown>) => sanitizeMeta({ header: h }, 't').header
    assert.equal(header({ ctaLabel: 'Start', ctaAction: 'appointment' }).ctaAction, 'booking')
    assert.equal(header({ ctaLabel: 'Start', ctaAction: 'appointment', ctaActivityId: 'act-intro' }).ctaActivityId, 'act-intro')
  })

  it('keeps the menu tree (the draft save used to drop it)', () => {
    const menu = [{ id: 'm1', label: 'Angebot', target: { kind: 'none' }, children: [{ id: 'm2', target: { kind: 'url', url: 'https://example.ch' } }] }]
    assert.deepEqual(sanitizeMenu(structuredClone(menu)), menu)
  })
})
