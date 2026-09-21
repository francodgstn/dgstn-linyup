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
  PUBLIC_LOCALES,
  isValidSiteDate,
  normalizeSiteRedirectPath,
  SITE_REDIRECT_LIMIT,
  isValidSitePagePath,
  isValidVideoId,
  SITE_PAGE_LIMITS,
  SITE_THEME_IDS,
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
  FormSection,
  GallerySection,
  HeroSection,
  PlacesSection,
  PostsSection,
  PricingSection,
  ScheduleSection,
  SiteFooter,
  SiteFooterColumn,
  SiteFooterLogo,
  SiteMenuItem,
  SiteMeta,
  SitePageRef,
  SiteRedirect,
  SiteSurfaceLinkConfig,
  SiteTopBar,
  SplitSection,
  SurfaceThemePresetId,
  TeamSection,
  TestimonialsSection,
  VideoSection,
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
  const action0 = oneOf(d.action, ['booking', 'signup', 'membership', 'url', 'page', 'appointment', 'class'] as const, 'url')
  const action = action0 === 'membership' ? 'signup' : action0 // normalize legacy alias
  if (action === 'page') {
    // A page CTA with no page is a button that goes nowhere — drop it. Whether
    // the page still exists is the renderer's question (it hides a dead one).
    const pageId = optStr(d.pageId, 64)
    return pageId ? { label, action, pageId } : undefined
  }
  if (action === 'class') {
    // Same degradation as the appointment branch below: a class CTA naming no
    // class still has the booking list to open.
    const activitySlug = optStr(d.activitySlug, 120)
    return activitySlug ? { label, action, activitySlug } : { label, action: 'booking' }
  }
  if (action === 'appointment') {
    // An appointment CTA that names no activity still has somewhere sensible to
    // go — the booking panel's own list — so it degrades to 'booking' rather
    // than taking the studio's button off its page.
    const activityId = optStr(d.activityId, 64)
    return activityId ? { label, action, activityId } : { label, action: 'booking' }
  }
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
    bgVideoUrl: safeVideoFileUrl(d.bgVideoUrl),
    overlayStyle: optOneOf(d.overlayStyle, ['solid', 'gradient-left', 'gradient-bottom', 'gradient-left-bottom'] as const),
    overlayTone: optOneOf(d.overlayTone, ['dark', 'light'] as const),
    bgMotion: optOneOf(d.bgMotion, ['none', 'kenburns'] as const),
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
    layout: optOneOf(d.layout, ['grid', 'marquee', 'logos'] as const),
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

/** An in-page anchor to a section id. The id charset is the one section ids are
 *  minted with, so nothing but a same-page jump can be expressed. */
const SECTION_ANCHOR = /^#[A-Za-z0-9_-]{1,64}$/

/** A link a visitor can follow: an https?:// URL or a `#sectionId` anchor. */
export function safeLink(v: unknown): string | undefined {
  if (typeof v === 'string' && SECTION_ANCHOR.test(v)) return v
  return safeUrl(v)
}

/** An external background video: https and a video file extension. Anything
 *  else (a page URL, a YouTube link) would render a broken <video>. */
function safeVideoFileUrl(v: unknown): string | undefined {
  const url = safeUrl(v)
  return url && /^https:\/\/[^?#]+\.(mp4|webm)(\?[^#]*)?$/i.test(url) ? url : undefined
}

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
        linkUrl: safeLink(i.linkUrl),
        linkPageId: optStr(i.linkPageId, 64),
        imageUrl: safeUrl(i.imageUrl),
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
    style: optOneOf(d.style, ['cards', 'stats', 'checklist', 'panels'] as const),
    // Stats only; the renderer ignores it elsewhere.
    countUp: d.countUp === true ? true : undefined,
  }) as unknown as FeaturesSection
}

export function sanitizeCtaBannerSection(d: Dict, id: string): CtaBannerSection | null {
  const heading = optStr(d.heading, 200)
  if (!heading) return null
  return clean({
    id, type: 'cta_banner', heading,
    text: optStr(d.text, 600),
    cta: sanitizeCta(d.cta),
    style: optOneOf(d.style, ['card', 'band'] as const),
    bgImageUrl: safeUrl(d.bgImageUrl),
  }) as unknown as CtaBannerSection
}

/**
 * The video block. A section with neither a playable film nor a background loop
 * renders nothing, so it is dropped. `videoId` is validated against the
 * provider's real id shape — it is interpolated into a player URL at render.
 */
export function sanitizeVideoSection(d: Dict, id: string): VideoSection | null {
  const provider = optOneOf(d.provider, ['youtube', 'vimeo'] as const)
  const rawId = optStr(d.videoId, 32)
  const videoId = provider && rawId && isValidVideoId(provider, rawId) ? rawId : undefined
  const bgVideoUrl = safeVideoFileUrl(d.bgVideoUrl)
  if (!videoId && !bgVideoUrl) return null
  return clean({
    id, type: 'video',
    heading: optStr(d.heading, 200),
    text: optStr(d.text, 600),
    provider: videoId ? provider : undefined,
    videoId,
    display: optOneOf(d.display, ['inline', 'lightbox'] as const),
    playLabel: optStr(d.playLabel, 80),
    bgVideoUrl,
    posterUrl: safeUrl(d.posterUrl),
  }) as unknown as VideoSection
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
    style: optOneOf(d.style, ['cards', 'panels'] as const),
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
    groupBy: optOneOf(d.groupBy, ['term'] as const),
  }) as unknown as PricingSection
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

export function sanitizeTeamSection(d: Dict, id: string): TeamSection | null {
  const items = (Array.isArray(d.items) ? d.items : [])
    .map((raw) => {
      const i = asDict(raw)
      const name = optStr(i.name, 120)
      if (!name) return null
      const email = optStr(i.email, 200)
      return clean({
        name,
        role: optStr(i.role, 120),
        badge: optStr(i.badge, 40),
        bio: optStr(i.bio, 800),
        imageUrl: safeUrl(i.imageUrl),
        email: email && EMAIL.test(email) ? email : undefined,
        phone: optStr(i.phone, 64),
      })
    })
    .filter(nonNull)
    .slice(0, 40)
  if (items.length === 0) return null
  return clean({
    id, type: 'team',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    columns: columnsOf(d.columns),
    layout: optOneOf(d.layout, ['grid', 'contact'] as const),
    captionStyle: optOneOf(d.captionStyle, ['below', 'overlay-dark', 'overlay-light'] as const),
    bioDisplay: optOneOf(d.bioDisplay, ['inline', 'modal'] as const),
    items,
  }) as unknown as TeamSection
}

// A form section is only its form id and what follows a submit. Whether the form
// is the team's and published — and whether `next` names one of the team's
// appointment activities — needs Firestore, so publish checks it (./index).
export function sanitizeFormSection(d: Dict, id: string): FormSection | null {
  const formId = optStr(d.formId, 64)
  if (!formId) return null
  const next = asDict(d.next)
  const activityId = next.kind === 'appointment' ? optStr(next.activityId, 64) : undefined
  return clean({
    id, type: 'form',
    heading: optStr(d.heading, 200),
    text: optStr(d.text, 600),
    formId,
    next: activityId ? { kind: 'appointment', activityId } : undefined,
  }) as unknown as FormSection
}

// Two columns — the story and a panel beside it. Dropped only when BOTH sides
// are empty; a heading alone is a legitimate (if plain) section.
export function sanitizeSplitSection(d: Dict, id: string): SplitSection | null {
  const items = (Array.isArray(d.items) ? d.items : [])
    .map((raw) => {
      const i = asDict(raw)
      const title = optStr(i.title, 200)
      if (!title) return null
      const icon = optStr(i.icon, 64)
      return clean({ title, text: optStr(i.text, 600), icon: icon && FEATURE_ICON.test(icon) ? icon : undefined })
    })
    .filter(nonNull)
    .slice(0, 24)

  const rawSide = asDict(d.side)
  const facts = (Array.isArray(rawSide.facts) ? rawSide.facts : [])
    .map((raw) => {
      const f = asDict(raw)
      const label = optStr(f.label, 120)
      const value = optStr(f.value, 120)
      return label && value ? { label, value } : null
    })
    .filter(nonNull)
    .slice(0, 10)
  const side = clean({
    heading: optStr(rawSide.heading, 200),
    text: optStr(rawSide.text, 800),
    imageUrl: safeUrl(rawSide.imageUrl),
    facts: facts.length ? facts : undefined,
    cta: sanitizeCta(rawSide.cta),
  })

  const heading = optStr(d.heading, 200)
  const body = sanitizeRichHtml(str(d.body, 50000))
  if (!heading && !body && items.length === 0 && Object.keys(side).length === 0) return null
  return clean({
    id, type: 'split',
    heading,
    subheading: optStr(d.subheading, 400),
    body,
    items: items.length ? items : undefined,
    side: Object.keys(side).length ? side : undefined,
    sidePosition: optOneOf(d.sidePosition, ['left', 'right'] as const),
    sideSticky: optTrue(d.sideSticky),
  }) as unknown as SplitSection
}

// A posts section is presentation only: the posts themselves are the page index,
// already sanitized with the site.
export function sanitizePostsSection(d: Dict, id: string): PostsSection {
  return clean({
    id, type: 'posts',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    limit: num(d.limit, 1, 24, 6),
    layout: optOneOf(d.layout, ['grid', 'list'] as const),
    columns: columnsOf(d.columns),
  }) as unknown as PostsSection
}

/** What publish knows about the docs a form section points at. */
export interface FormCheckFacts {
  /** formId → the form doc's teamId and status, for forms that exist. */
  forms: ReadonlyMap<string, { teamId?: unknown; status?: unknown }>
  /** activityId → the activity doc's teamId and type, for activities that exist. */
  activities: ReadonlyMap<string, { teamId?: unknown; type?: unknown }>
}

/**
 * The publish-time half of a form section, IN PLACE across every page's list:
 * a section whose form is not this team's published form is removed (a public
 * page must never embed another tenant's form, nor a draft), and a `next` whose
 * activity is not one of this team's appointment activities is deleted — the
 * form still works, it just ends on a thank-you. Returns the removed ids.
 *
 * Pure: `publishWebsite` loads the facts, this decides.
 */
export function applyFormChecks(lists: WebsiteSection[][], teamId: string, facts: FormCheckFacts): string[] {
  const removed: string[] = []
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      const section = list[i]
      if (section.type !== 'form') continue
      const form = facts.forms.get(section.formId)
      if (!form || form.teamId !== teamId || form.status !== 'published') {
        removed.unshift(section.id)
        list.splice(i, 1)
        continue
      }
      if (section.next) {
        const activity = facts.activities.get(section.next.activityId)
        if (!activity || activity.teamId !== teamId || activity.type !== 'appointment') delete section.next
      }
    }
  }
  return removed
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
  video: sanitizeVideoSection,
  activities: sanitizeActivitiesSection,
  pricing: sanitizePricingSection,
  schedule: sanitizeScheduleSection,
  contact: sanitizeContactSection,
  places: sanitizePlacesSection,
  team: sanitizeTeamSection,
  form: sanitizeFormSection,
  posts: sanitizePostsSection,
  split: sanitizeSplitSection,
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

// ─── pages ────────────────────────────────────────────────────────────────────

/**
 * The site's page index (SitePageRef[]). World-readable once published, so
 * every field is re-derived: an id and a title are required, the path must be
 * valid under the ONE grammar (utils/sitePages.ts) and unique, ids are unique,
 * and the list is capped. `hidden` refs are kept — the callable decides what
 * publishes; the draft keeps them.
 */
export function sanitizePageRefs(raw: unknown): SitePageRef[] {
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  const refs: SitePageRef[] = []
  let pageCount = 0
  let postCount = 0
  for (const entry of Array.isArray(raw) ? raw : []) {
    const d = asDict(entry)
    const isPost = d.kind === 'post'
    // Pages and posts are capped apart — see SITE_PAGE_LIMITS.
    if (isPost ? postCount >= SITE_PAGE_LIMITS.maxPosts : pageCount >= SITE_PAGE_LIMITS.maxPages) continue
    const id = optStr(d.id, 64)
    const title = optStr(d.title, 200)
    const path = typeof d.path === 'string' ? d.path : ''
    if (!id || !title || !isValidSitePagePath(path) || seenIds.has(id) || seenPaths.has(path)) continue
    seenIds.add(id)
    seenPaths.add(path)
    if (isPost) postCount++
    else pageCount++
    const seo = asDict(d.seo)
    const cleanSeo = clean({ title: optStr(seo.title, 200), description: optStr(seo.description, 400) })
    refs.push(
      clean({
        id,
        path,
        title,
        navLabel: optStr(d.navLabel, 120),
        hidden: optTrue(d.hidden),
        seo: Object.keys(cleanSeo).length ? cleanSeo : undefined,
        // Post fields exist only on posts, so a page never carries a stale date.
        kind: isPost ? 'post' : undefined,
        publishedOn: isPost && isValidSiteDate(d.publishedOn) ? d.publishedOn : undefined,
        coverImageUrl: isPost ? safeUrl(d.coverImageUrl) : undefined,
        excerpt: isPost ? optStr(d.excerpt, 400) : undefined,
      }) as SitePageRef
    )
  }
  return refs
}

/**
 * Old-site redirects, whitelisted. A redirect to a page is kept only when that
 * page is published (`pageIds`), so a deleted page never leaves a 301 to a 404;
 * a path is kept once (the first wins) and never shadows a real page path — a
 * page always answers its own URL.
 */
export function sanitizeRedirects(
  raw: unknown,
  opts: { pageIds: ReadonlySet<string>; pagePaths: ReadonlySet<string> }
): SiteRedirect[] {
  const out: SiteRedirect[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= SITE_REDIRECT_LIMIT) break
    const d = asDict(entry)
    const from = normalizeSiteRedirectPath(str(d.from, 400))
    if (!from || seen.has(from) || opts.pagePaths.has(from.slice(1))) continue
    const to = asDict(d.to)
    let target: SiteRedirect['to'] | null = null
    if (to.kind === 'home') target = { kind: 'home' }
    else if (to.kind === 'page') {
      const pageId = optStr(to.pageId, 64)
      if (pageId && opts.pageIds.has(pageId)) target = { kind: 'page', pageId }
    } else if (to.kind === 'url') {
      const url = safeUrl(to.url)
      if (url?.startsWith('https://')) target = { kind: 'url', url }
    }
    if (!target) continue
    seen.add(from)
    out.push({ from, to: target })
  }
  return out
}

/**
 * Section ids unique across the WHOLE site (home + every page). An id is an
 * anchor, a translation key (`s.{id}`) and an embed address, so a duplicate on
 * a second page would be ambiguous in all three. The first occurrence wins; the
 * ids dropped from later lists are returned for logging.
 */
export function dedupeSectionIds<T extends { id: string }>(lists: readonly T[][]): { lists: T[][]; dropped: string[] } {
  const seen = new Set<string>()
  const dropped: string[] = []
  const out = lists.map((list) =>
    list.filter((section) => {
      if (seen.has(section.id)) {
        dropped.push(section.id)
        return false
      }
      seen.add(section.id)
      return true
    })
  )
  return { lists: out, dropped }
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
      } else if (t.kind === 'page') {
        const pageId = optStr(t.pageId, 64)
        const sectionId = optStr(t.sectionId, 64)
        if (pageId) target = clean({ kind: 'page', pageId, sectionId }) as SiteMenuItem['target']
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
  const headerCtaAction0 = oneOf(header.ctaAction, ['booking', 'signup', 'membership', 'url', 'page', 'appointment'] as const, 'booking')
  const headerCtaPageId = headerCtaAction0 === 'page' ? optStr(header.ctaPageId, 64) : undefined
  const headerCtaActivityId = headerCtaAction0 === 'appointment' ? optStr(header.ctaActivityId, 64) : undefined
  // The legacy alias is normalised, and a page or appointment button that
  // names no destination falls back to booking rather than publishing a button
  // that goes nowhere.
  const headerCtaAction =
    headerCtaAction0 === 'membership'
      ? 'signup'
      : headerCtaAction0 === 'page' && !headerCtaPageId
        ? 'booking'
        : headerCtaAction0 === 'appointment' && !headerCtaActivityId
          ? 'booking'
          : headerCtaAction0

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
    cardShape: optOneOf(d.cardShape, ['rounded', 'square'] as const),
    contentWidth: optOneOf(d.contentWidth, ['standard', 'wide', 'full'] as const),
    navCase: optOneOf(d.navCase, ['normal', 'uppercase'] as const),
    language: optOneOf(d.language, PUBLIC_LOCALES),
    appliedTheme: optOneOf(d.appliedTheme, SITE_THEME_IDS),
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
      ctaPageId: headerCtaPageId,
      ctaActivityId: headerCtaActivityId,
      showSignIn: header.showSignIn !== false,
      surfaceLinks: sanitizeSurfaceLinks(header.surfaceLinks),
      topBar: sanitizeTopBar(header.topBar),
    }),
    footer: sanitizeFooter(d.footer),
  }) as SiteMeta
}
