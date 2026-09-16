import type {
  OrgSiteSection,
  OrgSiteSectionType,
  OrgSiteDraft,
  SiteMeta,
  ContactAddress,
} from '@linyup/shared'
// Client-only unique id generator — shared verbatim with the team site builder
// (React key + image path segment + anchor). Not org/team-specific.
import { newSectionId } from '@/plugins/website/defaults'
import type { SectionGroup } from '@/components/website/SectionPicker'
import { DEFAULT_ACCENT } from '@/components/ui/color-picker'

// ─── section library (for the "Add section" menu) ──────────────────────────────
// Org sites offer the PRESENTATIONAL sections — hero, content, gallery, features,
// CTA banner, FAQ, testimonials, contact, all shared with the team site — plus
// the three org-only aggregates (clubs / locations / coaches).
//
// NO pricing / activities / schedule / places: those are team-scoped commerce and
// an organisation has nothing to put in them. That was always the rule, but four
// presentational sections were missing anyway — they were added to the team
// library after this file was written and nobody pulled them across, so a
// federation could not put an FAQ on its own site (Franco, 2026-09-05).

export const ORG_SECTION_LIBRARY: {
  type: OrgSiteSectionType
  labelKey: string
  descKey: string
  icon: string
  /** Which drawer of the Add-section dialog it sits in — see SectionPicker. */
  group?: SectionGroup
  /** See SECTION_LIBRARY (team defaults.ts) — same convention, same default.
   *  No current type is 'managed'. */
  maturity?: 'full' | 'basic' | 'managed'
}[] = [
  { type: 'hero', group: 'content', labelKey: 'sectionHero', descKey: 'sectionHeroDesc', icon: 'Image' },
  { type: 'content', group: 'content', labelKey: 'sectionContent', descKey: 'sectionContentDesc', icon: 'FileText' },
  { type: 'gallery', group: 'content', labelKey: 'sectionGallery', descKey: 'sectionGalleryDesc', icon: 'Images' },
  { type: 'clubs', group: 'offer', labelKey: 'sectionClubs', descKey: 'sectionClubsDesc', icon: 'Building2' },
  {
    type: 'locations',
    group: 'offer',
    labelKey: 'sectionLocations',
    descKey: 'sectionLocationsDesc',
    icon: 'MapPin',
  },
  { type: 'coaches', group: 'trust', labelKey: 'sectionCoaches', descKey: 'sectionCoachesDesc', icon: 'UserCog' },
  { type: 'features', group: 'content', labelKey: 'sectionFeatures', descKey: 'sectionFeaturesDesc', icon: 'Sparkles' },
  { type: 'cta_banner', group: 'content', labelKey: 'sectionCta', descKey: 'sectionCtaDesc', icon: 'Megaphone' },
  { type: 'faq', group: 'trust', labelKey: 'sectionFaq', descKey: 'sectionFaqDesc', icon: 'HelpCircle' },
  {
    type: 'testimonials',
    group: 'trust',
    labelKey: 'sectionTestimonials',
    descKey: 'sectionTestimonialsDesc',
    icon: 'Quote',
  },
  { type: 'video', group: 'content', labelKey: 'sectionVideo', descKey: 'sectionVideoDesc', icon: 'Clapperboard' },
  { type: 'contact', group: 'offer', labelKey: 'sectionContact', descKey: 'sectionContactDesc', icon: 'Mail' },
]

/**
 * A new section, with the organisation's own details already in it where that
 * saves retyping.
 *
 * Only the CONTACT section takes them, and only as a starting value: the
 * section owns its text from then on, exactly as a team's does, so an org can
 * publish a different address on its site from the one it records in settings
 * without the two fighting. The alternative — resolving the org document at
 * RENDER time — would make the settings page a second, invisible editor of the
 * published site.
 */
export function newOrgSection(
  type: OrgSiteSectionType,
  org?: { headquarters?: ContactAddress; contact_email?: string; contact_phone?: string } | null
): OrgSiteSection {
  const id = newSectionId()
  switch (type) {
    case 'hero':
      return { id, type, headline: 'Welcome', align: 'center', overlay: 40 }
    // 'about' isn't offered from the section library, but is part of
    // OrgSiteSectionType (inherited from ContentSection's legacy alias) — handled
    // here purely for switch exhaustiveness, normalized to 'content'.
    case 'content':
    case 'about':
      return { id, type: 'content', body: '', imageSide: 'left' }
    case 'gallery':
      return { id, type, images: [], columns: 3 }
    case 'features':
      return {
        id,
        type,
        columns: 3,
        items: [
          { icon: 'Sparkles', title: 'Feature', text: 'A short line about it.' },
          { icon: 'Sparkles', title: 'Feature', text: 'A short line about it.' },
          { icon: 'Sparkles', title: 'Feature', text: 'A short line about it.' },
        ],
      }
    case 'cta_banner':
      return { id, type, heading: 'Find a club near you', text: 'Our studios are open to new members.' }
    case 'faq':
      return { id, type, items: [{ question: 'A question?', answer: 'The answer.' }] }
    case 'testimonials':
      return {
        id,
        type,
        items: [{ name: 'Alex', activity: 'Member', feedback: 'Best decision I made.' }],
      }
    case 'video':
      return { id, type, heading: '' }
    case 'clubs':
      return { id, type, columns: 3, showAddress: true }
    case 'locations':
      return { id, type, columns: 3 }
    case 'coaches':
      return { id, type, columns: 3 }
    case 'contact': {
      const hq = org?.headquarters
      const address = [
        [hq?.route, hq?.street_number].filter(Boolean).join(' '),
        [hq?.postal_code, hq?.locality].filter(Boolean).join(' '),
      ]
        .filter(Boolean)
        .join(', ')
      return {
        id,
        type,
        showSocial: true,
        ...(address ? { address } : {}),
        ...(org?.contact_phone ? { phone: org.contact_phone } : {}),
        ...(org?.contact_email ? { email: org.contact_email } : {}),
      }
    }
  }
}

/** Fresh draft for an org that has never opened the builder. */
export function emptyOrgDraft(org: { id: string; name: string; slug?: string }): OrgSiteDraft {
  const meta: SiteMeta = {
    title: org.name,
    theme: 'light',
    accentColor: DEFAULT_ACCENT,
    font: 'sans',
    header: { showNav: true },
    footer: { showSocial: true },
  }
  return {
    orgId: org.id,
    slug: org.slug || '',
    name: org.name,
    enabled: false,
    meta,
    // EMPTY ON PURPOSE. A fresh draft used to arrive pre-filled with four
    // sections under an English "Welcome" — a layout nobody chose, in a language
    // the federation may not write in. It now starts empty, and an empty site
    // offers the starters below; the old four are the "Federation home" one.
    sections: [],
  }
}

// ─── site starters ─────────────────────────────────────────────────────────────
//
// An organisation site is one page, so there is no "new page" moment to offer a
// shape at — the moment is an EMPTY site: the first visit, or after every
// section was removed. The sections a starter makes are ordinary sections;
// nothing remembers which starter produced them.

export type OrgSiteStarter = 'federation' | 'simple'

export const ORG_SITE_STARTERS: readonly OrgSiteStarter[] = ['federation', 'simple']

type StarterOrg = {
  name: string
  headquarters?: ContactAddress
  contact_email?: string
  contact_phone?: string
}

/** The sections an empty org site starts with. The org's own name is the
 *  headline; the contact block is pre-filled from the org record, exactly as
 *  adding one by hand would. */
export function orgStarterSections(starter: OrgSiteStarter, org: StarterOrg): OrgSiteSection[] {
  const hero: OrgSiteSection = { id: newSectionId(), type: 'hero', headline: org.name, align: 'center', overlay: 40 }
  switch (starter) {
    case 'federation':
      return [
        hero,
        newOrgSection('content', org),
        newOrgSection('clubs', org),
        newOrgSection('locations', org),
        newOrgSection('contact', org),
      ]
    case 'simple':
      return [hero, newOrgSection('content', org), newOrgSection('contact', org)]
  }
}
