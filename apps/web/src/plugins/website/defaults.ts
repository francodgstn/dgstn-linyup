import type { WebsiteSection, WebsiteSectionType, SiteDraft, SiteMeta } from '@linyup/shared'
import type { SectionGroup } from '@/components/website/SectionPicker'
import { DEFAULT_ACCENT } from '@/components/ui/color-picker'

// ─── section library (for the "Add section" menu) ──────────────────────────────
// icon names map to lucide icons resolved in the builder via the shared DynamicIcon.

export const SECTION_LIBRARY: {
  type: WebsiteSectionType
  labelKey: string
  descKey: string
  icon: string
  /** Which drawer of the Add-section dialog it sits in — see SectionPicker. */
  group?: SectionGroup
  /**
   * Absent ⇒ 'full' — offered in the "Add section" menu like every section
   * today. 'managed' is for a future type authored by Linyup itself (a seed or
   * an operator tool, not a studio) — it stays out of the Add-section
   * dropdowns but is still listed and editable in the section list once
   * present, so an operator-seeded section doesn't vanish from a studio's view.
   * No current type is 'managed'.
   */
  maturity?: 'full' | 'basic' | 'managed'
}[] = [
  { type: 'hero', group: 'content', labelKey: 'sectionHero', descKey: 'sectionHeroDesc', icon: 'Image' },
  { type: 'content', group: 'content', labelKey: 'sectionContent', descKey: 'sectionContentDesc', icon: 'FileText' },
  { type: 'gallery', group: 'content', labelKey: 'sectionGallery', descKey: 'sectionGalleryDesc', icon: 'Images' },
  {
    type: 'activities',
    group: 'offer',
    labelKey: 'sectionActivities',
    descKey: 'sectionActivitiesDesc',
    icon: 'LayoutGrid',
  },
  { type: 'pricing', group: 'offer', labelKey: 'sectionPricing', descKey: 'sectionPricingDesc', icon: 'Tag' },
  {
    type: 'schedule',
    group: 'offer',
    labelKey: 'sectionSchedule',
    descKey: 'sectionScheduleDesc',
    icon: 'CalendarDays',
  },
  { type: 'contact', group: 'offer', labelKey: 'sectionContact', descKey: 'sectionContactDesc', icon: 'MapPin' },
  { type: 'places', group: 'offer', labelKey: 'sectionPlaces', descKey: 'sectionPlacesDesc', icon: 'Map' },
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
  { type: 'team', group: 'trust', labelKey: 'sectionTeam', descKey: 'sectionTeamDesc', icon: 'Users', maturity: 'basic' },
  { type: 'form', group: 'offer', labelKey: 'sectionForm', descKey: 'sectionFormDesc', icon: 'ClipboardList', maturity: 'basic' },
  { type: 'posts', group: 'trust', labelKey: 'sectionPosts', descKey: 'sectionPostsDesc', icon: 'Newspaper', maturity: 'basic' },
  { type: 'split', group: 'content', labelKey: 'sectionSplit', descKey: 'sectionSplitDesc', icon: 'Columns2', maturity: 'basic' },
]

/** Client-only unique id for a new section (React key + image path segment + anchor). */
export function newSectionId(): string {
  return `s-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`
}

export function newSection(type: WebsiteSectionType): WebsiteSection {
  const id = newSectionId()
  switch (type) {
    case 'hero':
      return { id, type, headline: 'Welcome', align: 'center', overlay: 40 }
    case 'content':
    case 'about':
      return { id, type: 'content', body: '', imageSide: 'left' }
    case 'gallery':
      return { id, type, images: [], columns: 3 }
    case 'activities':
      return { id, type, source: 'activities', columns: 3, showBooking: true }
    case 'pricing':
      return { id, type, source: 'subscriptions' }
    case 'schedule':
      return { id, type, source: 'sessions', windowDays: 7, displayMode: 'calendar' }
    case 'contact':
      return { id, type, showSocial: true }
    case 'places':
      return { id, type, columns: 3 }
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
      return { id, type, heading: 'Ready to start?', text: 'Join us this week.' }
    case 'faq':
      return {
        id,
        type,
        items: [{ question: 'A question?', answer: 'The answer.' }],
      }
    case 'testimonials':
      return {
        id,
        type,
        items: [{ name: 'Alex', activity: 'Member', feedback: 'Best decision I made.' }],
      }
    case 'video':
      return { id, type, heading: '' }
    case 'team':
      return {
        id,
        type,
        columns: 3,
        layout: 'grid',
        items: [{ name: '' }],
      }
    case 'form':
      return { id, type, formId: '' }
    case 'posts':
      return { id, type, columns: 3, limit: 6 }
    case 'split':
      return {
        id,
        type,
        heading: 'What this offer includes',
        items: [
          { title: 'What you get', text: 'A short line about it.' },
          { title: 'Who it is for', text: 'A short line about it.' },
        ],
        side: { heading: 'Details', facts: [{ label: 'Duration', value: '60 min' }] },
      }
  }
}

/** Fresh draft for a team that has never opened the builder. */
export function emptyDraft(team: {
  id: string
  name: string
  slug?: string
  bioLinkAccentColor?: string
}): SiteDraft {
  const meta: SiteMeta = {
    title: team.name,
    theme: 'light',
    accentColor: team.bioLinkAccentColor || DEFAULT_ACCENT,
    font: 'sans',
    header: { showNav: true, ctaLabel: 'Book now', ctaAction: 'booking' },
    footer: { showSocial: true },
  }
  return {
    teamId: team.id,
    slug: team.slug || '',
    name: team.name,
    enabled: false,
    meta,
    sections: [newSection('hero'), newSection('content'), newSection('contact')],
  }
}

// ─── page starters ─────────────────────────────────────────────────────────────
//
// A NEW PAGE SHOULD NOT OPEN ON NOTHING. A studio's pages are overwhelmingly the
// same few shapes — an offer page is a hero, what it includes beside the facts,
// and a button to book — so creating one offers a shape to start from. Every
// section a starter makes is an ordinary section: movable, removable, editable,
// with nothing remembering which starter produced it.
//
// The placeholder copy comes in from the caller, already translated: a German
// studio starting an offer page should read German placeholders, and this
// module holds no copy of its own.

export type PageStarter = 'empty' | 'simple' | 'offer'

export const PAGE_STARTERS: readonly PageStarter[] = ['simple', 'offer', 'empty']

export interface PageStarterCopy {
  offerHeading: string
  offerItemWhat: string
  offerItemWho: string
  itemText: string
  factsHeading: string
  ctaHeading: string
  ctaText: string
  ctaLabel: string
}

/** The sections a new page starts with. The page's own title is its headline. */
export function starterSections(starter: PageStarter, title: string, copy: PageStarterCopy): WebsiteSection[] {
  const hero = (): WebsiteSection => ({ id: newSectionId(), type: 'hero', headline: title, align: 'left', overlay: 40 })
  switch (starter) {
    case 'empty':
      return []
    case 'simple':
      return [hero(), { id: newSectionId(), type: 'content', body: '', imageSide: 'left' }]
    case 'offer':
      return [
        hero(),
        // Generic sections only — a starter every studio sees must not be
        // built from a client-owned part (CLIENT_SITE_PARTS).
        {
          id: newSectionId(),
          type: 'features',
          heading: copy.offerHeading,
          columns: 3,
          items: [
            { icon: 'Sparkles', title: copy.offerItemWhat, text: copy.itemText },
            { icon: 'Users', title: copy.offerItemWho, text: copy.itemText },
            { icon: 'Info', title: copy.factsHeading, text: copy.itemText },
          ],
        },
        {
          id: newSectionId(),
          type: 'cta_banner',
          heading: copy.ctaHeading,
          text: copy.ctaText,
          // The one button every offer page exists for.
          cta: { label: copy.ctaLabel, action: 'booking' },
        },
      ]
  }
}
