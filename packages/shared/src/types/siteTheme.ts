// ─── Website themes — named look + layout presets ─────────────────────────────
//
// A theme is DATA, not a renderer. It names a combination of brand settings the
// site builder already has (typeface, capitals, button and card shape, button
// color, theme preset) plus the style each section type should start in (a CTA
// as a full-width band, a video as a lightbox…). Applying one writes those
// values into the site like a studio's own edits — every value stays editable,
// and nothing about a theme survives except the settings it wrote and the
// `SiteMeta.appliedTheme` note saying where they came from.
//
// What a theme deliberately does NOT carry: content (logo, colors that are the
// studio's identity, copy, footer links). Those are the studio's; a theme is the
// look they are shown in. So `accentColor` is left alone unless a theme is a
// look that only works with its own accent.
//
// The picker is unlocked by the `site-themes` plugin; the registry itself is
// plain data so the publish sanitizer can validate `appliedTheme` against it.

import type {
  CtaBannerSection,
  FaqSection,
  FeaturesSection,
  GallerySection,
  HeroSection,
  SiteMeta,
  VideoSection,
  WebsiteSection,
} from './website'

/** Stable machine identifier. Stored in `SiteMeta.appliedTheme` — a rename is a
 *  migration. */
export type SiteThemeId = 'box'

/** The brand settings a theme may set. */
export type SiteThemeLook = Partial<
  Pick<
    SiteMeta,
    | 'themePreset'
    | 'accentColor'
    | 'font'
    | 'headingFont'
    | 'headingCase'
    | 'navCase'
    | 'buttonShape'
    | 'buttonColor'
    | 'cardShape'
  >
>

/** The style each section type starts in under a theme. Presentation fields
 *  only — never content. */
export interface SiteThemeSectionDefaults {
  hero?: Partial<Pick<HeroSection, 'align' | 'overlay' | 'layout' | 'overlayStyle' | 'overlayTone'>>
  features?: Partial<Pick<FeaturesSection, 'style'>>
  gallery?: Partial<Pick<GallerySection, 'layout'>>
  cta_banner?: Partial<Pick<CtaBannerSection, 'style'>>
  faq?: Partial<Pick<FaqSection, 'style'>>
  video?: Partial<Pick<VideoSection, 'display'>>
}

export interface SiteThemeDef {
  id: SiteThemeId
  /** Keys in the `Website` i18n namespace — this module is shared with Cloud
   *  Functions and holds no copy. */
  nameKey: string
  descriptionKey: string
  look: SiteThemeLook
  sections: SiteThemeSectionDefaults
}

export const SITE_THEMES: readonly SiteThemeDef[] = [
  {
    // Bold and athletic — a box, a performance gym: one strong sans in capitals,
    // black pill buttons, square cards, full-width calls to action, films that
    // open over the page. The accent stays the studio's own color.
    id: 'box',
    nameKey: 'themeBox',
    descriptionKey: 'themeBoxDesc',
    look: {
      themePreset: 'paper',
      font: 'montserrat',
      headingCase: 'uppercase',
      // The nav in capitals too — a box's header is a row of short words.
      navCase: 'uppercase',
      buttonShape: 'pill',
      buttonColor: '#000000',
      cardShape: 'square',
    },
    sections: {
      // A bright hero: the photo washed white from the left and the bottom, dark
      // copy on top — the text is readable without darkening the whole image.
      hero: { align: 'left', overlay: 90, overlayStyle: 'gradient-left-bottom', overlayTone: 'light' },
      cta_banner: { style: 'band' },
      // The questions in the same hard-edged, high-contrast language as the
      // panels above them — a box's page does not go soft at the FAQ.
      faq: { style: 'panels' },
      video: { display: 'lightbox' },
    },
  },
]

export const SITE_THEME_IDS: readonly SiteThemeId[] = SITE_THEMES.map((theme) => theme.id)

export function findSiteTheme(id: string | null | undefined): SiteThemeDef | undefined {
  return SITE_THEMES.find((theme) => theme.id === id)
}

/** One section in its theme's starting style. Sections of a type the theme says
 *  nothing about come back unchanged (the same object). */
export function themedSection<S extends WebsiteSection>(section: S, theme: SiteThemeDef): S {
  const defaults = (theme.sections as Record<string, Record<string, unknown> | undefined>)[section.type]
  return defaults ? { ...section, ...defaults } : section
}

/**
 * A site with a theme applied: the look merged into `meta` (recorded as
 * `appliedTheme`), and every section of a type the theme styles moved to that
 * style. Pure — returns new objects and never touches content fields.
 */
export function applySiteTheme<T extends { meta: SiteMeta; sections: WebsiteSection[] }>(site: T, theme: SiteThemeDef): T {
  return {
    ...site,
    meta: { ...site.meta, ...theme.look, appliedTheme: theme.id },
    sections: site.sections.map((section) => themedSection(section, theme)),
  }
}
