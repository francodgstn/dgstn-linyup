// ─── A theme built from the studio's own colors ─────────────────────────────
//
// WHAT THE PRESETS COULD NOT SAY. The fixed presets are one look each; a studio
// that wants a page in its own color picks colors here instead (Franco,
// 2026-09-03).
//
// THE COLOR YOU PICK IS THE PAGE. There is no "strength" and no ramp — the
// earlier version had three of them per half and it was the thing that made a
// simple idea feel complicated. You choose the light-page color and the
// dark-page color, and those ARE the backgrounds. A switch collapses that to
// one color and one look for everyone.
//
// TWO THINGS ARE STILL DERIVED, because they are consequences of the choice
// rather than choices of their own:
//   • the SURFACE (cards, the header bar) steps a few percent away from the
//     page so it separates from it — lighter on a dark page, darker on a light
//     one;
//   • the TEXT SCHEME follows the page's lightness, so a dark color gets light
//     text and a light one dark text. Declared on the palette, never sniffed at
//     render time.
//
// THE ONE GUARANTEE. A color that lands in the unreadable middle — too dark
// for dark text, too light for light — is nudged to the nearer edge, and only
// then. Every color a studio would actually choose as a page is used verbatim;
// the nudge exists so a mid-gray cannot produce a page nobody can read.

import type { SurfacePalette, SurfaceThemePreset } from './themePreset'

interface Hsl {
  h: number
  s: number
  l: number
}

/** `#rgb` or `#rrggbb` → HSL. Returns null for anything else, so a caller can
 *  fall back rather than render from a color that was never parsed. */
export function hexToHsl(hex: string): Hsl | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let hue: number
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) hue = ((b - r) / d + 2) / 6
  else hue = ((r - g) / d + 4) / 6
  return { h: hue * 360, s: s * 100, l: l * 100 }
}

function hslToHex({ h, s, l }: Hsl): string {
  const sN = Math.min(100, Math.max(0, s)) / 100
  const lN = Math.min(100, Math.max(0, l)) / 100
  const c = (1 - Math.abs(2 * lN - 1)) * sN
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x]
  const m = lN - c / 2
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r1)}${to(g1)}${to(b1)}`
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * THE CARD COLOR, kept NEUTRAL so cards lift off the page.
 *
 * TWO FIXED SHADES, not a derived one: a card that shared the page's hue blended
 * into a colored page, and even a whisper of hue looked like a tint that did
 * not quite match. So the card is a plain near-white on a light page and a plain
 * dark neutral on a dark one — it comes out because it is hueless, whatever the
 * page's color (Franco, 2026-09-03). Not dynamic on purpose: one gray to
 * recognize across every theme.
 */
const SURFACE_LIGHT = '#f6f7f9'
const SURFACE_DARK = '#1b1e25'

function neutralSurfaceHsl(bg: Hsl): string {
  return bg.l >= BAND_MAX ? SURFACE_LIGHT : SURFACE_DARK
}

/** The neutral card color for a page background — the exported form used to
 *  build the fixed presets, so they and the custom themes share one rule. */
export function neutralSurface(hex: string): string {
  const hsl = hexToHsl(hex)
  return hsl ? neutralSurfaceHsl(hsl) : SURFACE_LIGHT
}

/**
 * THE UNREADABLE MIDDLE. A background between these carries neither dark text
 * nor light text, so a color that lands here is pushed to the nearer edge —
 * keeping its hue, at the closest lightness that reads. Everything outside is
 * used exactly as picked.
 */
const BAND_MIN = 40
const BAND_MAX = 66

/** One page background → a full palette. Null if the color will not parse. */
function paletteFromColour(hex: string, lighting: boolean): SurfacePalette | null {
  const hsl = hexToHsl(hex)
  if (!hsl) return null
  const l =
    hsl.l > BAND_MIN && hsl.l < BAND_MAX
      ? hsl.l - BAND_MIN < BAND_MAX - hsl.l
        ? BAND_MIN
        : BAND_MAX
      : hsl.l
  const isLightPage = l >= BAND_MAX
  const bg: Hsl = { h: hsl.h, s: hsl.s, l }
  return {
    background: lighting ? lightingGradient(bg, isLightPage) : hslToHex(bg),
    // Neutral, so cards come out of the page rather than blending into it.
    surface: neutralSurfaceHsl(bg),
    // 'dark' means DARK TEXT (a light page); 'light' means light text.
    scheme: isLightPage ? 'dark' : 'light',
  }
}

/**
 * A soft radial glow from the top, instead of a flat fill — the "lighting"
 * option. Subtle on purpose: it lifts the flatness without becoming a feature
 * of its own. The surface stays a solid, because the header bar and cards take
 * an alpha and a gradient cannot.
 */
function lightingGradient(bg: Hsl, isLightPage: boolean): string {
  const glow: Hsl = isLightPage
    ? { h: bg.h, s: clamp(bg.s + 6, 0, 100), l: clamp(bg.l + 4, 0, 100) }
    : { h: bg.h, s: clamp(bg.s + 16, 0, 100), l: clamp(bg.l + 12, 0, 45) }
  return `radial-gradient(130% 90% at 50% -10%, ${hslToHex(glow)} 0%, ${hslToHex(bg)} 62%)`
}

/** The dark counterpart of a light color, same hue — used when a studio sets a
 *  light color and leaves the dark one to us, so "the dark correlates with the
 *  light" holds by construction. */
function correlatedDark(hex: string): string {
  const hsl = hexToHsl(hex) ?? { h: 220, s: 20, l: 10 }
  return hslToHex({ h: hsl.h, s: clamp(Math.max(hsl.s, 24), 0, 60), l: 11 })
}

function accentFrom(hex: string): string {
  const hsl = hexToHsl(hex) ?? { h: 245, s: 70, l: 60 }
  return hslToHex({ h: hsl.h, s: Math.max(hsl.s, 55), l: clamp(hsl.l, 42, 60) })
}

/** What a studio configured for a custom theme. */
export interface CustomThemeInput {
  /** The light-page background color — and, when `single`, the whole site. */
  light: string
  /** The dark-page background color. Absent ⇒ a correlate of `light`. */
  dark?: string | null
  /** One color, one look for everyone — no separate dark version. */
  single?: boolean
  /** A soft gradient instead of a flat background. */
  lighting?: boolean
}

/**
 * Build a preset from a studio's own colors.
 *
 * `single` gives one look for everyone: the light color is used as it is, and
 * whether the site reads light or dark follows that color's own lightness. The
 * result is `adaptive: false`, which is what makes the visitor light/dark switch
 * refuse to render on it — there is no second version to switch to.
 *
 * Otherwise the light and dark colors drive their own halves and a viewer gets
 * whichever matches their device.
 *
 * Returns null for an unparseable light color, so the caller falls back to the
 * studio's previous look rather than rendering from nothing.
 */
export function deriveCustomPreset(input: CustomThemeInput): SurfaceThemePreset | null {
  const light = paletteFromColour(input.light, !!input.lighting)
  if (!light) return null

  if (input.single) {
    return {
      id: 'custom',
      nameKey: 'custom',
      light,
      dark: light,
      defaultAccent: accentFrom(input.light),
      adaptive: false,
      // Both halves are identical, so which one `resolveSurfacePalette` picks
      // does not matter — 'light' reads it off `preset.light`.
      fixedScheme: 'light',
    }
  }

  const dark =
    paletteFromColour(input.dark || correlatedDark(input.light), !!input.lighting) ?? light
  return {
    id: 'custom',
    nameKey: 'custom',
    light,
    dark,
    defaultAccent: accentFrom(input.light),
    adaptive: true,
  }
}
