// Organization website — the PURE publish sanitizers, beside the callable that
// uses them (./index.ts) so they can be tested without a Firestore.
//
// hero/content/gallery/contact and the presentational sections are shared
// verbatim with the team site (../website/sanitize). Only the three aggregate
// section types are org-specific, plus two org rules on the site meta: the
// header button, and which language the site is written in.

import type { OrgSiteSection, OrgSiteSectionType, SiteMeta, UiLanguage } from '@linyup/shared'
import { resolveSiteSourceLocale } from '@linyup/shared'
import {
  asDict,
  clean,
  bool,
  num,
  optStr,
  optOneOf,
  optTrue,
  safeUrl,
  sanitizeMeta,
  applyNavFields,
  sanitizeHeroSection,
  sanitizeContentSection,
  sanitizeGallerySection,
  sanitizeContactSection,
  sanitizeFeaturesSection,
  sanitizeCtaBannerSection,
  sanitizeFaqSection,
  sanitizeTestimonialsSection,
  sanitizeVideoSection,
  sanitizePostsSection,
  type Dict,
} from '../website/sanitize'

const columnsOf = (v: unknown): 2 | 3 | 4 => {
  const columns = num(v, 2, 4, 3)
  return columns === 2 || columns === 4 ? columns : 3
}

// ─── org-only aggregate section sanitizers ─────────────────────────────────────

export function sanitizeClubsSection(d: Dict, id: string): OrgSiteSection {
  return clean({
    id, type: 'clubs',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    columns: columnsOf(d.columns),
    showAddress: bool(d.showAddress),
    // The editor has offered both since the directory gained a list view, and
    // the renderer reads both — publish dropped them, so a federation that
    // chose a searchable list got image cards with no search box.
    layout: optOneOf(d.layout, ['cards', 'list'] as const),
    searchable: optTrue(d.searchable),
  }) as unknown as OrgSiteSection
}

export function sanitizeLocationsSection(d: Dict, id: string): OrgSiteSection {
  const extra = (Array.isArray(d.extra) ? d.extra : [])
    .map((raw) => {
      const e = asDict(raw)
      const extraId = optStr(e.id, 64)
      const name = optStr(e.name, 200)
      if (!extraId || !name) return null
      return clean({ id: extraId, name, address: optStr(e.address, 400), mapsLink: safeUrl(e.mapsLink) })
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 50)
  return clean({
    id, type: 'locations',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    columns: columnsOf(d.columns),
    extra: extra.length ? extra : undefined,
  }) as unknown as OrgSiteSection
}

export function sanitizeCoachesSection(d: Dict, id: string): OrgSiteSection {
  return clean({
    id, type: 'coaches',
    heading: optStr(d.heading, 200),
    subheading: optStr(d.subheading, 400),
    columns: columnsOf(d.columns),
  }) as unknown as OrgSiteSection
}

type OrgBuilder = (d: Dict, id: string) => OrgSiteSection | null

/**
 * One builder per org section type. `satisfies` makes a new type in the
 * `OrgSiteSection` union without a builder a COMPILE error here — the switch
 * this replaced had no default arm for a new type, so a section the org
 * builder offered could publish as nothing, which is exactly how features,
 * CTA banners, FAQs and testimonials were once lost.
 */
const ORG_SECTION_BUILDERS = {
  hero: (d, id) => sanitizeHeroSection(d, id) as unknown as OrgSiteSection | null,
  // Legacy 'about' literal normalized to 'content' — same as the team site.
  content: (d, id) => sanitizeContentSection(d, id) as unknown as OrgSiteSection | null,
  about: (d, id) => sanitizeContentSection(d, id) as unknown as OrgSiteSection | null,
  gallery: (d, id) => sanitizeGallerySection(d, id) as unknown as OrgSiteSection | null,
  contact: (d, id) => sanitizeContactSection(d, id) as unknown as OrgSiteSection,
  features: (d, id) => sanitizeFeaturesSection(d, id),
  cta_banner: (d, id) => sanitizeCtaBannerSection(d, id),
  faq: (d, id) => sanitizeFaqSection(d, id),
  testimonials: (d, id) => sanitizeTestimonialsSection(d, id),
  video: (d, id) => sanitizeVideoSection(d, id),
  posts: (d, id) => sanitizePostsSection(d, id),
  clubs: sanitizeClubsSection,
  locations: sanitizeLocationsSection,
  coaches: sanitizeCoachesSection,
} satisfies Record<OrgSiteSectionType, OrgBuilder>

export function sanitizeOrgSection(raw: unknown): OrgSiteSection | null {
  const d = asDict(raw)
  const id = optStr(d.id, 64)
  const type = d.type
  if (!id || typeof type !== 'string' || !(type in ORG_SECTION_BUILDERS)) return null
  const section = ORG_SECTION_BUILDERS[type as OrgSiteSectionType](d, id)
  if (!section) return null
  // An org button opens one of its own pages or an external link — the shared
  // builders also accept booking, signup and appointment buttons, which on an
  // organization's site would point at surfaces it does not have.
  const withCta = section as { cta?: { action?: string } }
  if (withCta.cta && withCta.cta.action !== 'url' && withCta.cta.action !== 'page') delete withCta.cta
  // Nav membership + menu label — one rule for both tenants.
  applyNavFields(section, d)
  return section
}

/** A page's sections, as published: hidden ones omitted (kept in the draft,
 *  never on the site or in its menu), unknown or empty ones dropped, capped. */
export function sanitizeOrgSections(raw: unknown): OrgSiteSection[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((s) => !(s && typeof s === 'object' && (s as Dict).hidden === true))
    .map(sanitizeOrgSection)
    .filter((s): s is OrgSiteSection => s !== null)
    .slice(0, 30)
}

/**
 * The org site's meta: the team sanitizer, plus the HEADER BUTTON RULE.
 *
 * An organization has no booking page, no signup form and no appointments, so
 * its header button opens one of the site's own PAGES or a link — exactly the
 * two actions its section buttons offer (`sanitizeOrgSection`). The shared
 * sanitizer defaults the button's action to 'booking' — right for a studio, and
 * for an org a button pointing at `/public/{orgSlug}/booking`, a page that does
 * not exist. So anything but a page with an id or a link with an address is
 * dropped rather than shipped dead.
 */
export function sanitizeOrgMeta(raw: unknown, fallbackTitle: string): SiteMeta {
  const meta = sanitizeMeta(raw, fallbackTitle)
  const { ctaLabel, ctaUrl: _url, ctaAction, ctaPageId, ctaActivityId: _activity, ...header } = meta.header
  if (ctaLabel && ctaAction === 'page' && ctaPageId) {
    return { ...meta, header: { ...header, ctaLabel, ctaAction: 'page', ctaPageId } }
  }
  // Read the address from the draft directly: the shared sanitizer keeps it only
  // when the stored action is already 'url', and an org draft whose button was
  // saved before the action was set would lose a perfectly good link.
  const ctaUrl = safeUrl(asDict(asDict(raw).header).ctaUrl)
  return {
    ...meta,
    header: ctaLabel && ctaUrl ? { ...header, ctaLabel, ctaAction: 'url', ctaUrl } : header,
  }
}

/**
 * The language the org site is WRITTEN in — the site's own setting first, the
 * organization's working language after. The team publish has asked in this
 * order since sites gained a language of their own; the org publish read only
 * the organization's, so a federation that set its site to German while
 * working in English had its German copy "translated" from English.
 */
export function orgSiteSourceLocale(meta: Pick<SiteMeta, 'language'>, org: { language?: string | null }): UiLanguage {
  return resolveSiteSourceLocale({ language: meta.language ?? org.language ?? null })
}
