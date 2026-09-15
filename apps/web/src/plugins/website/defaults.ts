import type { WebsiteSection, WebsiteSectionType, SiteDraft, SiteMeta } from '@linyup/shared'
import { DEFAULT_ACCENT } from '@/components/ui/color-picker'

// ─── section library (for the "Add section" menu) ──────────────────────────────
// icon names map to lucide icons resolved in the builder via the shared DynamicIcon.

export const SECTION_LIBRARY: {
  type: WebsiteSectionType
  labelKey: string
  descKey: string
  icon: string
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
  { type: 'hero', labelKey: 'sectionHero', descKey: 'sectionHeroDesc', icon: 'Image' },
  { type: 'content', labelKey: 'sectionContent', descKey: 'sectionContentDesc', icon: 'FileText' },
  { type: 'gallery', labelKey: 'sectionGallery', descKey: 'sectionGalleryDesc', icon: 'Images' },
  {
    type: 'activities',
    labelKey: 'sectionActivities',
    descKey: 'sectionActivitiesDesc',
    icon: 'LayoutGrid',
  },
  { type: 'pricing', labelKey: 'sectionPricing', descKey: 'sectionPricingDesc', icon: 'Tag' },
  {
    type: 'schedule',
    labelKey: 'sectionSchedule',
    descKey: 'sectionScheduleDesc',
    icon: 'CalendarDays',
  },
  { type: 'contact', labelKey: 'sectionContact', descKey: 'sectionContactDesc', icon: 'MapPin' },
  { type: 'places', labelKey: 'sectionPlaces', descKey: 'sectionPlacesDesc', icon: 'Map' },
  { type: 'features', labelKey: 'sectionFeatures', descKey: 'sectionFeaturesDesc', icon: 'Sparkles' },
  { type: 'cta_banner', labelKey: 'sectionCta', descKey: 'sectionCtaDesc', icon: 'Megaphone' },
  { type: 'faq', labelKey: 'sectionFaq', descKey: 'sectionFaqDesc', icon: 'HelpCircle' },
  {
    type: 'testimonials',
    labelKey: 'sectionTestimonials',
    descKey: 'sectionTestimonialsDesc',
    icon: 'Quote',
  },
  { type: 'video', labelKey: 'sectionVideo', descKey: 'sectionVideoDesc', icon: 'Clapperboard' },
  { type: 'team', labelKey: 'sectionTeam', descKey: 'sectionTeamDesc', icon: 'Users', maturity: 'basic' },
  { type: 'form', labelKey: 'sectionForm', descKey: 'sectionFormDesc', icon: 'ClipboardList', maturity: 'basic' },
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
