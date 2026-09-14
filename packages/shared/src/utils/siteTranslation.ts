/**
 * Tenant-site translation — the ONE extractor/resolver.
 *
 * This module owns the entire mapping between a tenant-authored site and its
 * flat translation-unit maps: which fields are translatable, what key each one
 * lives under, and when a stored translation may substitute the base text.
 * Same doctrine as `matchesFilter` (contactFilter.ts) and
 * `resolvePaymentOptions` (paymentOptions.ts): NEVER add a parallel
 * implementation — extend the field descriptors here.
 *
 * Scope boundaries, each deliberate:
 *  - App CHROME (buttons, nav labels of the product itself) is next-intl
 *    (`apps/web/messages/*`), not this pipeline.
 *  - LIVE-MIRROR data (activity / plan / session names read at render time from
 *    public_profile mirrors) is never handled here — a site translation
 *    translates what the tenant wrote INTO the site, not what the site pulls in.
 *  - BINDING text (waivers, policies, legal documents) never enters this
 *    pipeline: a machine translation of a signed text is a liability, not a
 *    feature.
 *
 * ── The key grammar (this table lives HERE and nowhere else) ────────────────
 *
 *   seo.title, seo.description      SiteMeta.seo — descriptive, translate
 *   header.cta                      SiteMeta.header.ctaLabel
 *   surf.{surface}                  SiteMeta.header.surfaceLinks[].label
 *   menu.{itemId}                   SiteMenuItem.label (tree flattened; only
 *                                   explicit labels — a derived label is
 *                                   already localized by its source). The
 *                                   SAME key space covers the top-bar links,
 *                                   every footer column's links and the legal
 *                                   row — item ids are unique across them
 *   topbar.text                     SiteMeta.header.topBar.text
 *   footer.text                     SiteMeta.footer.text
 *   footer.col.{columnId}.heading   SiteFooterColumn.heading
 *   s.{sectionId}.headline          hero
 *   s.{sectionId}.subheadline       hero
 *   s.{sectionId}.cta               hero SiteCta.label
 *   s.{sectionId}.heading           every section type that has one
 *   s.{sectionId}.subheading        every section type that has one
 *   s.{sectionId}.menuLabel         SectionBase.menuLabel
 *   s.{sectionId}.body              ContentSection rich HTML — format 'html'
 *   s.{sectionId}.ctaLabel          sections with CTA labels (pricing)
 *   s.{sectionId}.cap.{index}       gallery captions, index-keyed within the
 *                                   section (an image reorder makes the hash
 *                                   guard fall back to base until re-publish —
 *                                   accepted)
 *   s.{sectionId}.hours             ContactSection free-prose hours
 *   s.{sectionId}.text              CTA banner / video block body line
 *   s.{sectionId}.playLabel         video block play-button label
 *   page.{pageId}.title             SitePageRef.title (the site doc's page index)
 *   page.{pageId}.navLabel          SitePageRef.navLabel
 *   page.{pageId}.seo.title         SitePageRef.seo.title
 *   page.{pageId}.seo.description   SitePageRef.seo.description
 *
 * A PAGE's sections are translated into a sidecar of their own, beside the page
 * doc — the same `s.{sectionId}.*` grammar, one sidecar per page.
 *
 * EXCLUDED — never extracted, because it is a brand name, data, or a link
 * rather than prose: `SiteMeta.title` and the team/org name, contact
 * address / phone / email / mapQuery, place names and location extras
 * (`PlacesSection.places`, `LocationsSection.extra`), coach names, activity /
 * plan ids and tags, social links, URLs, `OrgSiteTeamRef` names, and the
 * studio-facing `EmbedWidget.label`.
 *
 * Embed widgets ARE `WebsiteSection`s, so the same `s.{id}.*` grammar covers
 * them — pass `sections: widgets` (or use `applySectionTranslations` for one).
 *
 * Empty / whitespace-only source strings are never emitted as units.
 */

import type {
  SiteMeta,
  SiteMenuItem,
  SitePageRef,
  WebsiteSection,
  SiteTranslationUnits,
} from '../types/website'
import { flattenSiteMenu } from '../types/website'
import type { OrgSiteSection } from '../types/orgWebsite'
import type { UiLanguage } from './regional'
import { PUBLIC_LOCALES } from '../publicRoutes'

// ─── Source hash ─────────────────────────────────────────────────────────────

/**
 * FNV-1a 64-bit over the UTF-8 encoding of `text`, as lowercase hex (16 chars).
 *
 * Cheap enough for render-path use (a site is a few KB of prose) and
 * dependency-free. NOT cryptographic and must not be presented as such — it
 * answers "is this still the text the translation was made from?", never
 * anything adversarial.
 */
export function translationSourceHash(text: string): string {
  const FNV_PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = 0xcbf29ce484222325n
  const mix = (byte: number): void => {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    // Manual UTF-8 so the result is identical in every runtime.
    if (cp < 0x80) {
      mix(cp)
    } else if (cp < 0x800) {
      mix(0xc0 | (cp >> 6))
      mix(0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      mix(0xe0 | (cp >> 12))
      mix(0x80 | ((cp >> 6) & 0x3f))
      mix(0x80 | (cp & 0x3f))
    } else {
      mix(0xf0 | (cp >> 18))
      mix(0x80 | ((cp >> 12) & 0x3f))
      mix(0x80 | ((cp >> 6) & 0x3f))
      mix(0x80 | (cp & 0x3f))
    }
  }
  return hash.toString(16).padStart(16, '0')
}

// ─── The shared field walk ───────────────────────────────────────────────────

/** One translatable string, as the extractor emits it. */
export interface TranslatableUnit {
  key: string
  text: string
  format: 'plain' | 'html'
}

type AnySection = WebsiteSection | OrgSiteSection

/**
 * One live binding to a translatable field: where it is (`key`), how to read
 * it and how to write it back. The extractor and the resolver BOTH walk these
 * bindings — one field-descriptor structure, not two enumerations that can
 * disagree.
 */
interface UnitBinding {
  key: string
  format: 'plain' | 'html'
  get(): string | undefined
  set(text: string): void
}

/**
 * Flat translatable string props, matched by NAME on whichever section carries
 * them (org section types included) — the key suffix is the prop name. Fields
 * that need structure (the hero CTA, gallery captions) get explicit bindings
 * in `sectionBindings` below.
 */
const SECTION_TEXT_PROPS: ReadonlyArray<{ prop: string; format: 'plain' | 'html' }> = [
  { prop: 'menuLabel', format: 'plain' },
  { prop: 'headline', format: 'plain' },
  { prop: 'subheadline', format: 'plain' },
  { prop: 'heading', format: 'plain' },
  { prop: 'subheading', format: 'plain' },
  { prop: 'ctaLabel', format: 'plain' },
  { prop: 'hours', format: 'plain' },
  // A section-level body line — the CTA banner's and the video block's. The
  // per-item `text` (a feature card) is bound by index below, not here.
  { prop: 'text', format: 'plain' },
  // The video block's play-button label.
  { prop: 'playLabel', format: 'plain' },
  { prop: 'body', format: 'html' },
]

/**
 * The translatable text fields on a section's `items[]`, by section type. A
 * person's `name` is deliberately absent — a testimonial's name is not
 * translated, any more than the studio's own name is.
 */
const SECTION_ITEM_TEXT_PROPS: Record<string, readonly string[]> = {
  features: ['title', 'text', 'linkLabel'],
  faq: ['question', 'answer'],
  testimonials: ['activity', 'feedback'],
}

function propBinding(
  target: Record<string, unknown>,
  key: string,
  prop: string,
  format: 'plain' | 'html'
): UnitBinding {
  return {
    key,
    format,
    get: () => (typeof target[prop] === 'string' ? (target[prop] as string) : undefined),
    set: (text) => {
      target[prop] = text
    },
  }
}

/** Bindings for one section, keys prefixed `s.{sectionId}.`. */
function sectionBindings(section: AnySection): UnitBinding[] {
  const s = section as unknown as Record<string, unknown>
  const prefix = `s.${section.id}.`
  const bindings: UnitBinding[] = SECTION_TEXT_PROPS.map(({ prop, format }) =>
    propBinding(s, `${prefix}${prop}`, prop, format)
  )
  // Hero CTA label — nested on SiteCta.
  const cta = s['cta']
  if (cta && typeof cta === 'object') {
    bindings.push(propBinding(cta as Record<string, unknown>, `${prefix}cta`, 'label', 'plain'))
  }
  // Gallery captions — index-keyed within the section.
  const images = s['images']
  if (Array.isArray(images)) {
    images.forEach((image, index) => {
      if (image && typeof image === 'object') {
        bindings.push(
          propBinding(image as Record<string, unknown>, `${prefix}cap.${index}`, 'caption', 'plain')
        )
      }
    })
  }
  // Repeatable items — features, FAQ, testimonials. Each field index-keyed so a
  // reorder in the editor cannot silently rebind one item's text onto another's
  // (the staleness guard would drop it, but the key makes the intent explicit).
  const itemFields = SECTION_ITEM_TEXT_PROPS[(section as { type?: string }).type ?? '']
  const items = s['items']
  if (itemFields && Array.isArray(items)) {
    items.forEach((item, index) => {
      if (item && typeof item === 'object') {
        for (const field of itemFields) {
          bindings.push(
            propBinding(item as Record<string, unknown>, `${prefix}item.${index}.${field}`, field, 'plain')
          )
        }
      }
    })
  }
  return bindings
}

/** Bindings for a whole site (meta + menu + page index + sections). */
function siteBindings(target: {
  meta?: SiteMeta
  menu?: readonly SiteMenuItem[]
  pages?: readonly SitePageRef[]
  sections?: readonly AnySection[]
}): UnitBinding[] {
  const bindings: UnitBinding[] = []
  const meta = target.meta
  if (meta) {
    if (meta.seo) {
      const seo = meta.seo as unknown as Record<string, unknown>
      bindings.push(propBinding(seo, 'seo.title', 'title', 'plain'))
      bindings.push(propBinding(seo, 'seo.description', 'description', 'plain'))
    }
    if (meta.header) {
      const header = meta.header as unknown as Record<string, unknown>
      bindings.push(propBinding(header, 'header.cta', 'ctaLabel', 'plain'))
      for (const link of meta.header.surfaceLinks ?? []) {
        bindings.push(
          propBinding(
            link as unknown as Record<string, unknown>,
            `surf.${link.surface}`,
            'label',
            'plain'
          )
        )
      }
      if (meta.header.topBar) {
        bindings.push(
          propBinding(meta.header.topBar as unknown as Record<string, unknown>, 'topbar.text', 'text', 'plain')
        )
      }
    }
    if (meta.footer) {
      bindings.push(propBinding(meta.footer as unknown as Record<string, unknown>, 'footer.text', 'text', 'plain'))
      for (const column of meta.footer.columns ?? []) {
        bindings.push(
          propBinding(
            column as unknown as Record<string, unknown>,
            `footer.col.${column.id}.heading`,
            'heading',
            'plain'
          )
        )
      }
    }
  }
  // Every link list shares the `menu.{itemId}` key — the header menu, the top
  // bar, the footer columns and the legal row. Item ids are unique across all
  // of them (the editor mints them that way), which is what keeps one key space.
  const linkLists = [
    target.menu,
    meta?.header?.topBar?.items,
    ...(meta?.footer?.columns ?? []).map((column) => column.items),
    meta?.footer?.legal,
  ]
  for (const list of linkLists) {
    for (const { item } of flattenSiteMenu(list)) {
      bindings.push(
        propBinding(item as unknown as Record<string, unknown>, `menu.${item.id}`, 'label', 'plain')
      )
    }
  }
  for (const page of target.pages ?? []) {
    const ref = page as unknown as Record<string, unknown>
    bindings.push(propBinding(ref, `page.${page.id}.title`, 'title', 'plain'))
    bindings.push(propBinding(ref, `page.${page.id}.navLabel`, 'navLabel', 'plain'))
    if (page.seo) {
      const seo = page.seo as unknown as Record<string, unknown>
      bindings.push(propBinding(seo, `page.${page.id}.seo.title`, 'title', 'plain'))
      bindings.push(propBinding(seo, `page.${page.id}.seo.description`, 'description', 'plain'))
    }
  }
  for (const section of target.sections ?? []) {
    bindings.push(...sectionBindings(section))
  }
  return bindings
}

// ─── Extractor ───────────────────────────────────────────────────────────────

/**
 * Every translatable unit of a site, in document order. This is what the MT
 * writer translates; the keys are what the sidecar / inline unit maps store.
 * Surface-link labels live on `meta.header.surfaceLinks`, so they are taken
 * from `meta` — there is no separate input for them.
 */
export function extractSiteUnits(input: {
  meta?: SiteMeta
  menu?: readonly SiteMenuItem[]
  pages?: readonly SitePageRef[]
  sections: readonly AnySection[]
}): TranslatableUnit[] {
  const units: TranslatableUnit[] = []
  for (const binding of siteBindings(input)) {
    const text = binding.get()
    if (typeof text === 'string' && text.trim() !== '') {
      units.push({ key: binding.key, text, format: binding.format })
    }
  }
  return units
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/** Substitute where — and only where — the stored translation is still current. */
function applyBindings(bindings: readonly UnitBinding[], units: SiteTranslationUnits): void {
  for (const binding of bindings) {
    const unit = units[binding.key]
    if (!unit || typeof unit.text !== 'string' || unit.text === '') continue
    const base = binding.get()
    if (typeof base !== 'string' || base.trim() === '') continue
    // The staleness guard: a unit made from OTHER text never substitutes —
    // the reader gets the base language, never wrong text. `pinned` is
    // deliberately not read here (it is a writer-side concern).
    if (unit.srcHash !== translationSourceHash(base)) continue
    binding.set(unit.text)
  }
}

/**
 * Plain-object deep clone for the site shapes this module walks. Non-plain
 * objects (e.g. Firestore Timestamps) are kept by reference — they are never
 * written into, only carried.
 */
function cloneDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => cloneDeep(v)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = cloneDeep(v)
    return out as T
  }
  return value
}

/**
 * A site with `units` substituted wherever a unit exists at the field's key,
 * its `srcHash` still equals `translationSourceHash` of the CURRENT base text,
 * and its text is non-empty — anything else leaves the base text standing.
 * Returns a clone; the input is never mutated (with no units it is returned
 * unchanged). Never reads `pinned`.
 */
export function applySiteTranslations<
  S extends {
    meta?: SiteMeta
    menu?: SiteMenuItem[]
    pages?: SitePageRef[]
    sections: readonly AnySection[]
  },
>(site: S, units: SiteTranslationUnits | null | undefined): S {
  if (!units || Object.keys(units).length === 0) return site
  const next: S = {
    ...site,
    ...(site.meta !== undefined ? { meta: cloneDeep(site.meta) } : {}),
    ...(site.menu !== undefined ? { menu: cloneDeep(site.menu) } : {}),
    ...(site.pages !== undefined ? { pages: cloneDeep(site.pages) } : {}),
    sections: cloneDeep(site.sections as AnySection[]),
  }
  applyBindings(siteBindings(next), units)
  return next
}

/**
 * `applySiteTranslations` for ONE section — the embed widget case. Same
 * `s.{id}.*` key grammar, same staleness guard, same clone-never-mutate rule.
 */
export function applySectionTranslations<Sec extends AnySection>(
  section: Sec,
  units: SiteTranslationUnits | null | undefined
): Sec {
  if (!units || Object.keys(units).length === 0) return section
  const next = cloneDeep(section)
  applyBindings(sectionBindings(next), units)
  return next
}

// ─── Source locale ───────────────────────────────────────────────────────────

/**
 * THE one statement of the source-language rule: a tenant's site content is
 * authored in its `language` when that is a supported locale, else in English.
 * Takes a `Team`, an `Organization`, a `TeamPublicProfile`, or null — anything
 * carrying an optional `language`.
 */
export function resolveSiteSourceLocale(
  tenant: { language?: string | null } | null | undefined
): UiLanguage {
  const lang = tenant?.language
  return lang && (PUBLIC_LOCALES as readonly string[]).includes(lang)
    ? (lang as UiLanguage)
    : 'en'
}
