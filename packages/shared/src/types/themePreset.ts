// ─── Public-surface theme presets ────────────────────────────────────────────
//
// THE PROBLEM THIS REPLACES. A studio's public surfaces (bio-link, website) each
// carried TWO independent controls: a light/dark/auto switch and a free
// background — a hex color or a gradient. The two cross, and every crossing is
// a way to make an unreadable page:
//
//   • "Auto" + a fixed background is a contradiction. The text follows the
//     viewer's system preference and the background does not, so half the
//     audience reads dark gray on near-black. It was the DEFAULT pairing.
//   • "Light" + a dark custom background was patched over with a luminance
//     check that silently overrode the studio's own choice of theme — so the
//     switch did nothing, sometimes, and nothing said which times.
//   • Nothing anywhere expressed the thing a studio actually wants: "look right
//     in dark mode too."
//
// So a theme is now ONE choice with BOTH halves in it. A preset carries a light
// palette and a dark palette; whether a viewer sees one or the other is the
// preset's own business (`adaptive`), not a second setting. The studio picks a
// look and an accent color, and the pair can never disagree.
//
// ── THE HOOKS FOR A FUTURE CUSTOM THEME ─────────────────────────────────────
// The registry below is closed on purpose for now — a handful of presets, no
// editor. Everything a per-studio custom theme needs is already in the shape:
// `SurfaceThemePreset` is a plain value with no reference to this file's list,
// and both resolvers (`resolveSurfacePalette` here, `buildPalette` in the web
// app) take a PRESET, not an id. Adding "create your own" later is a stored
// `SurfaceThemePreset` on the tenant plus a picker entry — the renderers do not
// change, and neither does anything stored today.
//
// ── STORAGE, AND WHY NOTHING MIGRATES ───────────────────────────────────────
// `Team.bioLinkThemePreset` / `SiteMeta.themePreset` hold an id. ABSENT means
// "this tenant predates presets", and the legacy `theme` + `background` fields
// still answer for it — the resolvers fall back to them. So no backfill, no
// deploy ordering, and a studio that had a look it liked keeps it until it picks
// a preset. Once it does, the preset wins and the legacy fields are ignored.

import { deriveCustomPreset, neutralSurface } from './themeDerive'

/** Stable machine identifier. Stored in Firestore — a rename is a migration. */
export type SurfaceThemePresetId =
  | 'paper'
  | 'ink'
  | 'sand'
  | 'forest'
  | 'ocean'
  | 'rose'
  | 'violet'
  | 'slate'
  // DERIVED, not a member of SURFACE_THEME_PRESETS. Its palettes are computed
  // from the tenant's own colors — see `themeDerive.ts` and `resolveThemePreset`
  // below, which is the ONE place the two kinds meet.
  | 'custom'

/** One half of a preset: what the page looks like in one color scheme. */
export interface SurfacePalette {
  /**
   * The page background. A plain hex, or any full CSS background value (a
   * gradient) — it is assigned to `background`, never to `background-color`.
   */
  background: string
  /**
   * Which text scheme sits on that background. Declared, never sniffed: a
   * luminance check cannot tell what a gradient reads like at the top of the
   * page, and it was the thing quietly overriding the studio's choice before.
   */
  scheme: 'light' | 'dark'
  /** The solid the header/nav bar and cards are tinted from. */
  surface: string
}

export interface SurfaceThemePreset {
  id: SurfaceThemePresetId
  /** Key in the `Themes` i18n namespace. Keys, not strings: this module is
   *  shared with Cloud Functions and must hold no English. */
  nameKey: string
  light: SurfacePalette
  dark: SurfacePalette
  /** The accent a studio gets before it picks one. Always overridable. */
  defaultAccent: string
  /**
   * Does the preset follow the viewer's system color scheme?
   *
   * True for the neutral pairs. FALSE for a preset that IS a look — `ink` is
   * dark on purpose, and swapping it to parchment for a viewer in light mode
   * would be a different design, not the same one adapted. A fixed preset uses
   * its `light`/`dark` entry per `fixedScheme` in both modes.
   */
  adaptive: boolean
  /** Which half a non-adaptive preset always uses. Ignored when adaptive. */
  fixedScheme?: 'light' | 'dark'
}

/**
 * The presets, in picker order. Neutral first: most studios want their own
 * color to be the only color, and the accent is what carries it.
 */
export const SURFACE_THEME_PRESETS: readonly SurfaceThemePreset[] = (() => {
  // The surface is NEUTRAL for every preset, from the one rule custom themes use
  // — so a card comes out of the page here exactly as it does there, and there
  // is no second definition to drift. A preset declares only its page color and
  // which text sits on it; `pal` fills in the card color (Franco, 2026-09-03).
  const pal = (background: string, scheme: 'light' | 'dark'): SurfacePalette => ({
    background,
    scheme,
    surface: neutralSurface(background),
  })
  return [
    {
      // The default, and the neutral one. `mono` used to sit beside this with the
      // same near-white light page; it was a second name for one look, so it is
      // gone (Franco, 2026-09-03).
      id: 'paper',
      nameKey: 'paper',
      light: pal('#ffffff', 'dark'),
      dark: pal('#0b0d12', 'light'),
      defaultAccent: '#6366f1',
      adaptive: true,
    },
    {
      // Dark by choice, in both modes — the look a lot of gyms and clubs want.
      id: 'ink',
      nameKey: 'ink',
      light: pal('#0f1115', 'light'),
      dark: pal('#0f1115', 'light'),
      defaultAccent: '#f59e0b',
      adaptive: false,
      fixedScheme: 'dark',
    },
    {
      // Each pair is ONE HUE: the dark page is the light page taken much darker,
      // so the two versions read as the same theme at two times of day. The CARD
      // on each is neutral, so it lifts off the colored page.
      id: 'sand',
      nameKey: 'sand',
      light: pal('#faf5ec', 'dark'),
      dark: pal('#171310', 'light'),
      defaultAccent: '#b45309',
      adaptive: true,
    },
    {
      id: 'forest',
      nameKey: 'forest',
      light: pal('#f0f7f2', 'dark'),
      dark: pal('#0b1410', 'light'),
      defaultAccent: '#15803d',
      adaptive: true,
    },
    {
      id: 'ocean',
      nameKey: 'ocean',
      light: pal('#eef6fc', 'dark'),
      dark: pal('#08131d', 'light'),
      defaultAccent: '#0369a1',
      adaptive: true,
    },
    {
      id: 'rose',
      nameKey: 'rose',
      light: pal('#fdf2f6', 'dark'),
      dark: pal('#180f14', 'light'),
      defaultAccent: '#e11d76',
      adaptive: true,
    },
    {
      id: 'violet',
      nameKey: 'violet',
      light: pal('#f5f3ff', 'dark'),
      dark: pal('#130f1f', 'light'),
      defaultAccent: '#7c3aed',
      adaptive: true,
    },
    {
      id: 'slate',
      nameKey: 'slate',
      light: pal('#f5f7fa', 'dark'),
      dark: pal('#0d1117', 'light'),
      defaultAccent: '#475569',
      adaptive: true,
    },
  ]
})()

export const DEFAULT_SURFACE_THEME_PRESET_ID: SurfaceThemePresetId = 'paper'

/** Look up a preset by id. Unknown/absent ids resolve to null rather than to the
 *  default, so a caller can tell "not chosen" from "chose this". */
export function surfaceThemePreset(
  id: string | null | undefined
): SurfaceThemePreset | null {
  if (!id) return null
  return SURFACE_THEME_PRESETS.find((p) => p.id === id) ?? null
}

/** What a tenant stored about its theme. The fields travel together because
 *  they are one choice — see `resolveThemePreset`. */
export interface ThemeSelection {
  presetId?: string | null
  /** Custom: the light-page color (and the whole site when `single`). */
  light?: string | null
  /** Custom: the dark-page color. Absent ⇒ a correlate of `light`. */
  dark?: string | null
  /** Custom: one color, one look for everyone. */
  single?: boolean | null
  /** Custom: a soft gradient instead of a flat background. */
  lighting?: boolean | null
}

/**
 * THE ONE PLACE A STORED THEME BECOMES A PRESET.
 *
 * Both kinds resolve here: a registry id looks up, `'custom'` derives. Every
 * renderer calls this rather than `surfaceThemePreset`, so there is no surface
 * where a custom theme could be handled differently from a fixed one — the
 * failure this whole module exists to prevent, one level up.
 *
 * Returns null for "nothing chosen", exactly as `surfaceThemePreset` does, so
 * the legacy `theme` + `background` fallback in each renderer is reached the
 * same way it was before custom themes existed. A `'custom'` selection whose
 * base will not parse ALSO returns null: falling back to the studio's previous
 * look is honest, where falling back to `paper` would silently redesign the page.
 */
export function resolveThemePreset(sel: ThemeSelection): SurfaceThemePreset | null {
  if (sel.presetId === 'custom') {
    if (!sel.light) return null
    return deriveCustomPreset({
      light: sel.light,
      dark: sel.dark,
      single: !!sel.single,
      lighting: !!sel.lighting,
    })
  }
  return surfaceThemePreset(sel.presetId)
}

/**
 * Which half of a preset a viewer sees.
 *
 * `systemDark` is the viewer's `prefers-color-scheme`. A non-adaptive preset
 * ignores it entirely — that is the whole difference between "a theme that
 * adapts" and "a theme that is dark".
 */
export function resolveSurfacePalette(
  preset: SurfaceThemePreset,
  systemDark: boolean
): SurfacePalette {
  if (!preset.adaptive) return preset.fixedScheme === 'light' ? preset.light : preset.dark
  return systemDark ? preset.dark : preset.light
}
