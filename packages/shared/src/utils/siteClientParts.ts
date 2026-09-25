// ─── Client-owned website parts ─────────────────────────────────────────────────
//
// THE BUILDER IS GENERIC; A LOOK BUILT FOR ONE CLIENT BELONGS TO THAT CLIENT.
//
// Some section types, section styles and themes were built to reproduce one
// studio's existing website. Offering them to every studio would hand that
// studio's competitors its exact website components — and custom website work
// is something Linyup may sell per client. So each such part names the plugin
// that owns it, and only a tenant with that plugin installed is OFFERED it.
//
// THIS FILE IS THE CENSUS. Every client-owned part is listed here and nowhere
// else; editor surfaces ask `sitePartOffered` rather than naming a plugin
// themselves. Adding a client's part is one line in this map plus its plugin.
//
// THE GATE IS ON OFFERING, NEVER ON RENDERING OR PUBLISHING — the same rule as
// plugin audiences (`PluginAudience`). A client-owned section already on a site
// keeps publishing and rendering, and stays editable in the builder, after the
// plugin is removed; it simply cannot be added again. The publish sanitizer and
// the renderer do not read this file, and must not: removing a plugin must never
// take a live website apart.

import type { SiteThemeId } from '../types/siteTheme'
import type { WebsiteSectionType } from '../types/website'

/** Plugin ids of client website plugins. */
export const CROSSFIT_ZUG_SITE_PLUGIN = 'crossfitzug'

export const CLIENT_SITE_PARTS: {
  /** Section types only the owning client can add. */
  sectionTypes: Partial<Record<WebsiteSectionType, string>>
  /** Section styles (`<type>.style` values) only the owning client can pick. */
  sectionStyles: Partial<Record<WebsiteSectionType, Record<string, string>>>
  /** Themes only the owning client can apply. */
  themes: Partial<Record<SiteThemeId, string>>
} = {
  sectionTypes: {
    // The two-column offer layout: story and included items beside a facts
    // panel with a booking button — crossfitzug.ch's offer pages.
    split: CROSSFIT_ZUG_SITE_PLUGIN,
  },
  sectionStyles: {
    // Solid black statement panels and the matching hard-edged FAQ.
    features: { panels: CROSSFIT_ZUG_SITE_PLUGIN },
    faq: { panels: CROSSFIT_ZUG_SITE_PLUGIN },
  },
  themes: {
    box: CROSSFIT_ZUG_SITE_PLUGIN,
  },
}

/**
 * Whether a part owned by `owner` (absent ⇒ a generic part) may be offered to a
 * tenant for which `hasPlugin` answers. No `hasPlugin` at all — a surface that
 * does not know the tenant's plugins, like the organization builder — offers
 * only generic parts.
 */
export function sitePartOffered(owner: string | undefined, hasPlugin?: (pluginId: string) => boolean): boolean {
  return !owner || !!hasPlugin?.(owner)
}
