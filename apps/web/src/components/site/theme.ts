import { resolveSurfacePalette, resolveThemePreset } from '@linyup/shared'
import type { SiteMeta, SiteCta, SurfaceThemePresetId } from '@linyup/shared'
import { DEFAULT_ACCENT } from '@/lib/colors'
import { publicHrefLocalized } from '@/lib/publicRoutes'

// Shared theming for the Website plugin renderer (public site + builder preview).
// Font stacks live in ./siteFonts, beside the font loaders they point at.

export interface SitePalette {
  isDark: boolean
  bg: string
  // Translucent header/nav background — always a valid solid+alpha (never the
  // custom page background, which may be a gradient that can't take an alpha).
  headerBg: string
  surface: string
  border: string
  text: string
  muted: string
  accent: string
  onAccent: string
  /**
   * The fill of a call-to-action button, and the ink on it. The accent unless
   * the studio chose `buttonColor` — kept apart because the accent also colours
   * links, icons, chips and the hero gradient, and a black button must not turn
   * every link black.
   */
  button: string
  onButton: string
  /**
   * A solid statement block (the features 'panels' style) and the ink on it.
   * The studio's BUTTON colour when it chose one — a box that picked black
   * buttons means black blocks, which is the look that style exists for — else
   * the page's own ink, so a site that never touched the brand fields still
   * gets a panel that reads on a light or a dark theme.
   */
  panel: string
  onPanel: string
}

/** Relative luminance test for a #rgb / #rrggbb colour. Anything unparseable
 *  reads as dark, which keeps the historic white-on-colour ink. */
function isLightHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return false
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.5
}

/** The button pair. No `buttonColor` ⇒ exactly the accent pair, today's look. */
function buttonColors(buttonColor: string | undefined, accent: string, onAccent: string) {
  if (!buttonColor) return { button: accent, onButton: onAccent }
  return { button: buttonColor, onButton: isLightHex(buttonColor) ? '#0f172a' : '#ffffff' }
}

/** The panel pair — see SitePalette.panel. */
function panelColors(buttonColor: string | undefined, text: string) {
  const panel = buttonColor || text
  return { panel, onPanel: isLightHex(panel) ? '#0f172a' : '#ffffff' }
}

/** The ink and lines that sit on a background of a given scheme. Shared by both
 *  the preset path and the legacy one, so a preset can never render text the
 *  legacy theme would have rendered differently. */
function inkFor(scheme: 'light' | 'dark', accent: string) {
  return scheme === 'light'
    ? {
        isDark: true,
        accent,
        onAccent: '#ffffff',
        border: 'rgba(255,255,255,0.12)',
        text: '#f8fafc',
        muted: 'rgba(248,250,252,0.62)',
      }
    : {
        isDark: false,
        accent,
        onAccent: '#ffffff',
        border: 'rgba(15,23,42,0.08)',
        text: '#0f172a',
        muted: '#64748b',
      }
}

/**
 * THE ONE palette resolver for the website renderer — preset first, legacy
 * theme+background second.
 *
 * `themePreset` carries BOTH schemes, so `systemDark` picks a half rather than
 * fighting a separately-chosen background (see types/themePreset.ts for the
 * crossings this removed). While it is absent the old path runs unchanged, which
 * is what lets presets ship with no backfill.
 *
 * The `headerBg` rule is the same in both: the bar is a translucent version of
 * the SOLID, never of the page background, which may be a gradient that cannot
 * take an alpha suffix.
 */
export function buildPalette(
  meta: {
    theme: SiteMeta['theme']
    accentColor?: string
    background?: string
    themePreset?: SurfaceThemePresetId | null
    // Read only for a 'custom' preset — see resolveThemePreset, which is the one
    // place a stored theme becomes a palette whichever kind it is.
    themeLight?: string | null
    themeDark?: string | null
    themeSingle?: boolean | null
    themeLighting?: boolean | null
    buttonColor?: string
  },
  systemDark: boolean
): SitePalette {
  const preset = resolveThemePreset({
    presetId: meta.themePreset,
    light: meta.themeLight,
    dark: meta.themeDark,
    single: meta.themeSingle,
    lighting: meta.themeLighting,
  })
  if (preset) {
    const surfacePalette = resolveSurfacePalette(preset, systemDark)
    const accent = meta.accentColor || preset.defaultAccent
    const base = inkFor(surfacePalette.scheme, accent)
    return {
      ...base,
      ...buttonColors(meta.buttonColor, base.accent, base.onAccent),
      ...panelColors(meta.buttonColor, base.text),
      surface: surfacePalette.surface,
      headerBg: `${surfacePalette.surface}d9`,
      bg: surfacePalette.background,
    }
  }

  const isDark = meta.theme === 'dark' || (meta.theme === 'auto' && systemDark)
  const accent = meta.accentColor || DEFAULT_ACCENT
  const solid = isDark ? '#0b0f19' : '#ffffff'
  const ink = inkFor(isDark ? 'light' : 'dark', accent)
  const base = {
    ...ink,
    ...buttonColors(meta.buttonColor, ink.accent, ink.onAccent),
    ...panelColors(meta.buttonColor, ink.text),
    surface: isDark ? 'rgba(255,255,255,0.05)' : '#f8fafc',
  }
  return { ...base, headerBg: `${solid}d9`, bg: meta.background || solid }
}

/**
 * Resolve a CTA to an href. booking/signup → the team's public flows; url → external.
 *
 * Locale-prefixed, because the site renders these as raw `<a href>` (see
 * `RenderCtx.locale`). `from: 'site'` gives the flow a back link to the website
 * the visitor is standing on, rather than the team's default landing surface.
 */
export function ctaHref(
  cta: Pick<SiteCta, 'action' | 'url' | 'pageId' | 'activityId'> | undefined,
  slug: string,
  locale: string,
  /** Resolves a page of this site to its URL — see RenderCtx.pageHref. */
  pageHref?: (pageId: string) => string | undefined
): string | undefined {
  if (!cta) return undefined
  if (cta.action === 'page') return cta.pageId ? pageHref?.(cta.pageId) : undefined
  if (cta.action === 'booking') return publicHrefLocalized(locale, slug, 'booking', { from: 'site' })
  // An appointment CTA keeps a real address (the picker for that one activity),
  // so middle-click and crawlers still work — `ctaIntent` is what turns the
  // plain click into the overlay. Without an activity it is the booking root.
  if (cta.action === 'appointment')
    return cta.activityId
      ? publicHrefLocalized(locale, slug, 'appointments', { activity: cta.activityId, from: 'site' })
      : publicHrefLocalized(locale, slug, 'booking', { from: 'site' })
  // 'signup' is current; 'membership' is the legacy stored alias.
  if (cta.action === 'signup' || (cta.action as string) === 'membership')
    return publicHrefLocalized(locale, slug, 'signup', { from: 'site' })
  return cta.url || undefined
}
