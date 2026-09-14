// ─── Website publish sanitizers (pure) ─────────────────────────────────────────
//
// The draft is authored by a (semi-trusted) manager, but site_published is
// fully public. Every published field is re-derived here from an explicit
// whitelist, so nothing unexpected — and nothing restricted — can leak into the
// public doc.
//
// PURE ON PURPOSE. No firebase-functions, no firebase-admin: this module is
// imported by the publish callables (../website, ../orgWebsite) AND by the lead
// seeder (scripts/seed-lead.ts), so a seeded demo site is exactly what a studio
// pressing Publish would get — never richer. A seed that bypassed these rules
// once made four section types look shipped while publishing silently dropped
// them.
//
// A NEW SECTION TYPE MUST BE ADDED TO `SECTION_BUILDERS`. The table is checked
// against `WebsiteSectionType` at compile time, so a union member with no
// builder fails `tsc` instead of vanishing at publish.
// sectionRoundTrip.test.ts pins that every field of every type survives.

import {
  isPublicSurface,
  SITE_FONTS,
  SITE_MENU_MAX_DEPTH,
  SURFACE_THEME_PRESETS,
} from '@linyup/shared'
import type {
  ActivitiesSection,
  ContactSection,
  ContentSection,
  CtaBannerSection,
  FaqSection,
  FeaturesSection,
  GallerySection,
  HeroSection,
  PlacesSection,
  PricingSection,
  ScheduleSection,
  SiteFooter,
  SiteFooterColumn,
  SiteFooterLogo,
  SiteMenuItem,
  SiteMeta,
  SiteSurfaceLinkConfig,
  SiteTopBar,
  SurfaceThemePresetId,
  TestimonialsSection,
  WebsiteSection,
  WebsiteSectionType,
} from '@linyup/shared'
import { sanitizeRichHtml } from '../utils/sanitizeHtml'

// ─── primitives ───────────────────────────────────────────────────────────────

export type Dict = Record<string, unknown>

export const asDict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {})

export function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}
export function optStr(v: unknown, max = 2000): string | undefined {
  const s = str(v, max)
  return s ? s : undefined
}
/** Allow only https?:// URLs; everything else (javascript:, data:, …) is dropped. */
export function safeUrl(v: unknown): string | undefined {
  return typeof v === 'string' && /^https?:\/\/.+/.test(v) ? v.slice(0, 2000) : undefined
}
export function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
export function bool(v: unknown): boolean {
  return v === true
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}
/** Like `oneOf`, but ABSENT stays absent. For optional presentation fields whose
 *  default the renderer supplies — writing the default would change the published
 *  doc of every site that never touched the option. */
export function optOneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}
/** Stored only when true — absence means off. */
export function optTrue(v: unknown): true | undefined {
  return v === true ? true : undefined
}
/** Drop keys whose value is undefined (Firestore rejects undefined). */
export function clean<T extends Dict>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k]
  return obj
}

const nonNull = <T,>(x: T | null): x is T => x !== null

function columnsOf(v: unknown): 2 | 3 | 4 {
  const columns = num(v, 2, 4, 3)
  return columns === 2 || columns === 4 ? columns : 3
}

// ─── colours ──────────────────────────────────────────────────────────────────
// These reach a `style` attribute on a public page. A length check alone let any
// CSS value through; a background is where an attacker would put `url(…)` to
// make every visitor's browser fetch a third-party resource.

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function safeHex(v: unknown): string | undefined {
  return typeof v === 'string' && HEX_COLOUR.test(v.trim()) ? v.trim() : undefined
}

/** A hex colour or a CSS gradient. The gradient charset has no `:` `/` `;` `{`
 *  `}` or quotes, so it cannot express `url(…)`, a second declaration, or a way
 *  out of the attribute. */
const CSS_GRADIENT = /^(?:repeating-)?(?:linear|radial|conic)-gradient\([#%.,()\sa-zA-Z0-9-]*\)$/

export function safeBackground(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s.length > 400) return undefined
  return safeHex(s) ?? (CSS_GRADIENT.test(s) ? s : undefined)
}

const THEME_PRESET_IDS: readonly SurfaceThemePresetId[] = [
  ...SURFACE_THEME_PRESETS.map((p) => p.id),
  'custom',
]

// ─── CTA ──────────────────────────────────────────────────────────────────────

export function sanitizeCta(v: unknown): Dict | undefined {
  const d = asDict(v)
  const label = optStr(d.label, 120)
  if (!label) return undefined
  const action0 = oneOf(d.action, ['booking', 'signup', 'membership', 'url'] as const, 'url')
  const action = action0 === 'membership' ? 'signup' : action0 // normalize legacy alias
  return clean({ label, action, url: action === 'url' ? safeUrl(d.url) : undefined })
}

// ─── presentational sections (shared with ../orgWebsite) ───────────────────────

export function sanitizeHeroSection(d: Dict, id: string): HeroSection | null {
  const headline = optStr(d.headline, 200)
  if (!headline) return null
  return clean({
    id, type: 'hero', headline,
    subheadline: optStr(d.subheadline, 400),
    bgImageUrl: safeUrl(d.bgImageUrl),
    overlay: num(d.overlay, 0, 100, 40),
    bgColor: safeHex(d.bgColor),
    layout: optOneOf(d.layout, ['full', 'card'] as const),
    align: oneOf(d.align, ['left', 'center'] as const, 'center'),
    cta: sanitizeCta(d.cta),
  }) as unknown as HeroSection
}

// Generic content block. 'about' is the legacy literal — normalized to 'content'
// on publish. Heading is optional; drop only when fully empty.
export function sanitizeContentSection(d: Dict, id: string): ContentSection | null {
  const heading = optStr(d.heading, 200)
  const body = sanitizeRichHtml(str(d.body, 50000))
  const imageUrl = safeUrl(d.imageUrl)
  if (!heading && !body && !imageUrl) return null
  return clean({
    id, type: 'content', heading, body,
    imageUrl,
    imageSide: oneOf(d.imageSide, ['left', 'right'] as const, 'left'),
  }) as unknown as ContentSection
}

export function sanitizeGallerySection(d: Dict, id: string): GallerySection | null {
  const images = (Array.isArray(d.images) ? d.images : [])
    .map((img) => {
      const i = asDict(img)
      const url = safeUrl(i.url)
      return url ? clean({ url, caption: optStr(i.caption, 200) }) : null
    })
    .filter(nonNull)
    .slice(0, 60)
  return clean({
    id, type: 'gallery',
    heading: optStr(d.heading, 200),
    images,
    columns: columnsOf(d.columns),
  }) as unknown as GallerySection
}

export function sanitizeContactSection(d: Dict, id: string): ContactSection {
  return clean({
    id, type: 'contact',
    heading: optStr(d.heading, 200),
    address: optStr(d.address, 400),
    phone: optStr(d.phone, 64),
    email: optStr(d.email, 200),
    hours: optStr(d.hours, 400),
    mapQuery: optStr(d.mapQuery, 400),
    showSocial: bool(d.showSocial),
  }) as unknown as ContactSection
}

/** Lucide icon names are PascalCase words; the renderer resolves them against its
 *  own icon set, so this only bounds the shape. */
const FEATURE_ICON = /^[A-Za-z0-9-]{1,64}$/

// Each of the item lists below renders NOTHING when empty (see the blocks in
// apps/web/src/components/site/sections.tsx), so a section whose items all fail
// validation is dropped rather than published as an empty anchor in the menu.

export function sanitizeFeaturesSection(d: Dict, id: string): FeaturesSection | null {
  const items = (Array.isArray(d.items) ? d.items : [])
    .map((raw) => {
      const i = asDict(raw)
      const title = optStr(i.title, 200)
      if (!title) return null
      const icon = optStr(i.icon, 64)
      return clean({
        icon: icon && FEATURE_ICON.test(icon) ? icon : undefined,
        title,
        text: optStr(i.text, 600),
        linkLabel: optStr(i.linkLabel, 120),
        linkUrl: safeUrl(i.linkUrl),
      })
    })
    .filter(nonNull)
    .slice(0, 24)
  if (items.length === 0) return null
  return clean({
    id, type: 'features',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    columns: columnsOf(d.columns),
    items,
  }) as unknown as FeaturesSection
}

export function sanitizeCtaBannerSection(d: Dict, id: string): CtaBannerSection | null {
  const heading = optStr(d.heading, 200)
  if (!heading) return null
  return clean({
    id, type: 'cta_banner', heading,
    text: optStr(d.text, 600),
    cta: sanitizeCta(d.cta),
  }) as unknown as CtaBannerSection
}

export function sanitizeFaqSection(d: Dict, id: string): FaqSection | null {
  const items = (Array.isArray(d.items) ? d.items : [])
    .map((raw) => {
      const i = asDict(raw)
      const question = optStr(i.question, 300)
      const answer = optStr(i.answer, 4000) // plain text, rendered pre-line
      return question && answer ? { question, answer } : null
    })
    .filter(nonNull)
    .slice(0, 50)
  if (items.length === 0) return null
  return clean({
    id, type: 'faq',
    heading: optStr(d.heading, 200),
    items,
  }) as unknown as FaqSection
}

export function sanitizeTestimonialsSection(d: Dict, id: string): TestimonialsSection | null {
  const items = (Array.isArray(d.items) ? d.items : [])
    .map((raw) => {
      const i = asDict(raw)
      const name = optStr(i.name, 120)
      const feedback = optStr(i.feedback, 2000)
      return name && feedback ? clean({ name, activity: optStr(i.activity, 120), feedback }) : null
    })
    .filter(nonNull)
    .slice(0, 30)
  if (items.length === 0) return null
  return clean({
    id, type: 'testimonials',
    heading: optStr(d.heading, 200),
    items,
  }) as unknown as TestimonialsSection
}

// ─── team-only live sections ───────────────────────────────────────────────────

function sanitizeActivitiesSection(d: Dict, id: string): ActivitiesSection {
  return clean({
    id, type: 'activities',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    source: 'activities',
    columns: columnsOf(d.columns),
    layout: oneOf(d.layout, ['grid', 'list'] as const, 'grid'),
    showBooking: bool(d.showBooking),
    pricingDisplay: optOneOf(d.pricingDisplay, ['list', 'compact', 'hidden'] as const),
  }) as unknown as ActivitiesSection
}

function sanitizePricingSection(d: Dict, id: string): PricingSection {
  return clean({
    id, type: 'pricing',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    source: 'subscriptions',
    ctaLabel: optStr(d.ctaLabel, 120),
    layout: optOneOf(d.layout, ['cards', 'table'] as const),
  }) as unknown as PricingSection
}

function sanitizeScheduleSection(d: Dict, id: string): ScheduleSection {
  return clean({
    id, type: 'schedule',
    heading: optStr(d.heading, 200),
    source: 'sessions',
    windowDays: num(d.windowDays, 1, 60, 7),
    maxItems: num(d.maxItems, 0, 50, 0) || undefined,
    activityId: optStr(d.activityId, 64),
    displayMode: d.displayMode === 'list' ? 'list' : 'calendar',
    showBooking: bool(d.showBooking),
  }) as unknown as ScheduleSection
}

// Places: keep only the selection + presentation here; the actual place data is
// embedded at publish time (enrichSectionsWithPlaces in ./index) — sanitizers
// are pure.
function sanitizePlacesSection(d: Dict, id: string): PlacesSection {
  const placeIds = (Array.isArray(d.placeIds) ? d.placeIds : [])
    .map((x) => optStr(x, 64))
    .filter((x): x is string => !!x)
    .slice(0, 50)
  return clean({
    id, type: 'places',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    columns: columnsOf(d.columns),
    placeIds: placeIds.length ? placeIds : undefined,
  }) as unknown as PlacesSection
}

// ─── the builder table ─────────────────────────────────────────────────────────

type SectionBuilder = (d: Dict, id: string) => WebsiteSection | null

const SECTION_BUILDERS = {
  hero: sanitizeHeroSection,
  content: sanitizeContentSection,
  // Legacy literal — the content builder normalizes it to 'content'.
  about: sanitizeContentSection,
  gallery: sanitizeGallerySection,
  features: sanitizeFeaturesSection,
  cta_banner: sanitizeCtaBannerSection,
  faq: sanitizeFaqSection,
  testimonials: sanitizeTestimonialsSection,
  activities: sanitizeActivitiesSection,
  pricing: sanitizePricingSection,
  schedule: sanitizeScheduleSection,
  contact: sanitizeContactSection,
  places: sanitizePlacesSection,
} satisfies Record<WebsiteSectionType, SectionBuilder>

function isSectionType(type: string): type is WebsiteSectionType {
  return Object.hasOwn(SECTION_BUILDERS, type)
}

/** One draft section → its public shape, or null when it has nothing publishable
 *  (or an unknown type). */
export function sanitizeSection(raw: unknown): WebsiteSection | null {
  const d = asDict(raw)
  const id = optStr(d.id, 64)
  const type = d.type
  if (!id || typeof type !== 'string' || !isSectionType(type)) return null

  const section = SECTION_BUILDERS[type](d, id)
  if (!section) return null
  applyNavFields(section, d)
  return section
}

/** Nav membership + label are common to every section type — for both tenants,
 *  so ../orgWebsite calls this too. `showInNav` is stored only when explicitly
 *  hidden; absence means "visible" (the renderer defaults it to true). */
export function applyNavFields(section: { showInNav?: boolean; menuLabel?: string }, d: Dict): void {
  if (d.showInNav === false) section.showInNav = false
  const menuLabel = optStr(d.menuLabel, 120)
  if (menuLabel) section.menuLabel = menuLabel
}

/** The draft's section list → the published list: hidden sections omitted,
 *  unpublishable ones dropped, capped. `enrichSectionsWithPlaces` still runs
 *  after this in the callable (it needs Firestore). */
export function sanitizeSections(raw: unknown): WebsiteSection[] {
  return (Array.isArray(raw) ? raw : [])
    // Drop sections the studio toggled hidden — they stay in the draft but never
    // reach the published site (or its nav).
    .filter((s) => !(s && typeof s === 'object' && (s as Dict).hidden === true))
    .map(sanitizeSection)
    .filter(nonNull)
    .slice(0, 30)
}

// ─── menu ─────────────────────────────────────────────────────────────────────

/**
 * The header menu tree.
 *
 * EVERY FIELD IS RE-DERIVED, like every other published field — the draft is
 * authored by a manager but `site_published` is world-readable, so a stored menu
 * is untrusted input. Three things this enforces that the editor also enforces,
 * because the editor is not the only thing that can write a draft:
 *
 *  • DEPTH. Recursion stops at SITE_MENU_MAX_DEPTH; anything deeper is dropped
 *    rather than flattened, so a hand-edited draft cannot publish a menu the
 *    renderer would have to guess at.
 *  • URL TARGETS go through `safeUrl`, the same guard every other published link
 *    uses — an unchecked one here would be a `javascript:` URL in a public header.
 *  • BREADTH. A cap per level, so a malformed draft cannot publish thousands of
 *    rows into a header.
 *
 * A section target is NOT checked against the published sections here: the
 * renderer already drops an item whose section is missing, and doing it twice
 * would mean this function had to run after `enrichSectionsWithPlaces`.
 *
 * Tenant-agnostic: it bounds depth and breadth and validates a target's shape,
 * none of which differs between a studio and an organisation.
 */
const MENU_MAX_PER_LEVEL = 24

export function sanitizeMenu(raw: unknown, depth = 1): SiteMenuItem[] | undefined {
  if (!Array.isArray(raw) || depth > SITE_MENU_MAX_DEPTH) return undefined
  const items = raw
    .slice(0, MENU_MAX_PER_LEVEL)
    .map((entry): SiteMenuItem | null => {
      const d = asDict(entry)
      const id = optStr(d.id, 64)
      if (!id) return null
      const t = asDict(d.target)
      let target: SiteMenuItem['target'] | null = null
      if (t.kind === 'section') {
        const sectionId = optStr(t.sectionId, 64)
        if (sectionId) target = { kind: 'section', sectionId }
      } else if (t.kind === 'surface') {
        // The real guard, not a cast: an unknown surface would publish a menu
        // row the renderer cannot resolve, and it would render as nothing with
        // no way to tell why.
        const surface = optStr(t.surface, 32)
        if (surface && isPublicSurface(surface)) target = { kind: 'surface', surface }
      } else if (t.kind === 'url') {
        const url = safeUrl(t.url)
        if (url) target = { kind: 'url', url }
      } else if (t.kind === 'none') {
        target = { kind: 'none' }
      }
      if (!target) return null
      const label = optStr(d.label, 120)
      const children = sanitizeMenu(d.children, depth + 1)
      return clean({
        id,
        target,
        label: label || undefined,
        children: children?.length ? children : undefined,
      }) as SiteMenuItem
    })
    .filter(nonNull)
  return items.length ? items : undefined
}

// ─── meta ─────────────────────────────────────────────────────────────────────

/**
 * Studio overrides for the header's cross-surface links.
 *
 * Only the OVERRIDE is stored — the link list itself is derived at render time
 * from `active_public_surfaces`, so nothing here can conjure a link to a surface
 * the team hasn't got. An entry naming an unknown surface is dropped; one naming
 * a currently-inactive surface is KEPT, so a studio's label survives toggling the
 * plugin off and on.
 */
function sanitizeSurfaceLinks(raw: unknown): SiteSurfaceLinkConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: SiteSurfaceLinkConfig[] = []
  for (const entry of raw.slice(0, 20)) {
    const d = asDict(entry)
    // Explicit guard rather than oneOf(): oneOf coerces an unknown value to its
    // fallback, which would silently rewrite a bad entry into a real surface.
    if (!isPublicSurface(d.surface)) continue
    const surface = d.surface
    if (seen.has(surface)) continue
    seen.add(surface)
    out.push(
      clean({
        surface,
        hidden: d.hidden === true ? true : undefined,
        label: optStr(d.label, 60),
        order: typeof d.order === 'number' && Number.isFinite(d.order) ? d.order : undefined,
      }) as SiteSurfaceLinkConfig
    )
  }
  return out.length ? out : undefined
}

/**
 * A FLAT link list — the top bar, a footer column, the legal row. Same targets
 * and URL guard as the header menu, via `sanitizeMenu`; called at the maximum
 * depth so any children are dropped rather than published into a strip that
 * has no dropdowns.
 */
function sanitizeFlatLinks(raw: unknown, max: number): SiteMenuItem[] | undefined {
  return sanitizeMenu(Array.isArray(raw) ? raw.slice(0, max) : undefined, SITE_MENU_MAX_DEPTH)
}

function sanitizeTopBar(raw: unknown): SiteTopBar | undefined {
  const d = asDict(raw)
  const topBar = clean({ text: optStr(d.text, 200), items: sanitizeFlatLinks(d.items, 8) })
  return topBar.text || topBar.items ? (topBar as SiteTopBar) : undefined
}

function sanitizeFooterColumns(raw: unknown): SiteFooterColumn[] | undefined {
  const columns = (Array.isArray(raw) ? raw : [])
    .slice(0, 5)
    .map((entry): SiteFooterColumn | null => {
      const d = asDict(entry)
      const id = optStr(d.id, 64)
      const items = sanitizeFlatLinks(d.items, 12)
      const heading = optStr(d.heading, 120)
      // A column with neither a heading nor a link renders as a gap.
      if (!id || (!items && !heading)) return null
      return clean({ id, heading, items: items ?? [] }) as SiteFooterColumn
    })
    .filter(nonNull)
  return columns.length ? columns : undefined
}

function sanitizeFooterLogos(raw: unknown): SiteFooterLogo[] | undefined {
  const logos = (Array.isArray(raw) ? raw : [])
    .slice(0, 24)
    .map((entry) => {
      const d = asDict(entry)
      const url = safeUrl(d.url)
      return url ? (clean({ url, link: safeUrl(d.link), alt: optStr(d.alt, 120) }) as SiteFooterLogo) : null
    })
    .filter(nonNull)
  return logos.length ? logos : undefined
}

function sanitizeFooter(raw: unknown): SiteFooter {
  const d = asDict(raw)
  const apps = asDict(d.appLinks)
  const appLinks = clean({ ios: safeUrl(apps.ios), android: safeUrl(apps.android) })
  return clean({
    showSocial: d.showSocial !== false,
    text: optStr(d.text, 600),
    columns: sanitizeFooterColumns(d.columns),
    logos: sanitizeFooterLogos(d.logos),
    appLinks: appLinks.ios || appLinks.android ? appLinks : undefined,
    legal: sanitizeFlatLinks(d.legal, 8),
  }) as SiteFooter
}

export function sanitizeMeta(raw: unknown, fallbackTitle: string): SiteMeta {
  const d = asDict(raw)
  const header = asDict(d.header)
  const seo = asDict(d.seo)
  const headerCtaAction0 = oneOf(header.ctaAction, ['booking', 'signup', 'membership', 'url'] as const, 'booking')
  const headerCtaAction = headerCtaAction0 === 'membership' ? 'signup' : headerCtaAction0 // normalize legacy

  return clean({
    title: optStr(d.title, 200) ?? fallbackTitle,
    // The preset WINS over `theme` + `background` in the renderer; both legacy
    // fields are still published so a site that predates presets keeps its look.
    themePreset: optOneOf(d.themePreset, THEME_PRESET_IDS),
    themeLight: safeHex(d.themeLight),
    themeDark: safeHex(d.themeDark),
    themeSingle: optTrue(d.themeSingle),
    themeLighting: optTrue(d.themeLighting),
    themeToggle: optTrue(d.themeToggle),
    theme: oneOf(d.theme, ['light', 'dark', 'auto'] as const, 'light'),
    accentColor: safeHex(d.accentColor) ?? '#6366f1',
    font: oneOf(d.font, SITE_FONTS, 'sans'),
    // Brand fields — each absent unless chosen, so a site that never opened
    // them publishes exactly what it did before.
    headingFont: optOneOf(d.headingFont, SITE_FONTS),
    headingCase: optOneOf(d.headingCase, ['normal', 'uppercase'] as const),
    buttonShape: optOneOf(d.buttonShape, ['pill', 'rounded', 'square'] as const),
    buttonColor: safeHex(d.buttonColor),
    logoUrl: safeUrl(d.logoUrl),
    background: safeBackground(d.background),
    seo: clean({
      title: optStr(seo.title, 200),
      description: optStr(seo.description, 400),
      ogImageUrl: safeUrl(seo.ogImageUrl),
    }),
    header: clean({
      showNav: header.showNav !== false,
      ctaLabel: optStr(header.ctaLabel, 120),
      ctaAction: headerCtaAction,
      ctaUrl: headerCtaAction === 'url' ? safeUrl(header.ctaUrl) : undefined,
      showSignIn: header.showSignIn !== false,
      surfaceLinks: sanitizeSurfaceLinks(header.surfaceLinks),
      topBar: sanitizeTopBar(header.topBar),
    }),
    footer: sanitizeFooter(d.footer),
  }) as SiteMeta
}
