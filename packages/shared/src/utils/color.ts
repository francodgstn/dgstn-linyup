// Small, dependency-free colour arithmetic — pure, hex-in/hex-out, so it can be
// unit-tested and so a theme can be derived from ONE studio accent (the member
// app's `utils/tenantTheme.ts`).
//
// ONE contrast rule. `contrastText` / `isLightColor` use WCAG relative
// luminance and contrast ratio. Three other copies of "is this colour light?"
// used the YIQ approximation (`0.299r + 0.587g + 0.114b`) with two different
// thresholds (`> 0.5` in two places, `>= 0.6` in the third), and the four
// disagreed for mid-tones — the same studio accent could get black text on one
// surface and white on another. Those copies are gone; every surface asks here.

export interface Rgb {
  r: number
  g: number
  b: number
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored) → RGB, else null. */
export function parseHex(value: string | null | undefined): Rgb | null {
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (!m) return null
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

export function isHexColor(value: string | null | undefined): value is string {
  return parseHex(value) !== null
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

export function toHex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Linear blend of `a` towards `b` by `t` (0 = a, 1 = b). Unparseable → `a`. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa) return a
  if (!pb) return a
  const k = Math.max(0, Math.min(1, t))
  return toHex({
    r: pa.r + (pb.r - pa.r) * k,
    g: pa.g + (pb.g - pa.g) * k,
    b: pa.b + (pb.b - pa.b) * k,
  })
}

/** `rgba(r, g, b, alpha)` for a hex colour; unparseable → the input unchanged. */
export function withAlpha(hex: string, alpha: number): string {
  const p = parseHex(hex)
  if (!p) return hex
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${p.r}, ${p.g}, ${p.b}, ${a})`
}

/** WCAG relative luminance, 0 (black) … 1 (white). Unparseable → 0. */
export function relativeLuminance(hex: string): number {
  const p = parseHex(hex)
  if (!p) return 0
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(p.r) + 0.7152 * lin(p.g) + 0.0722 * lin(p.b)
}

/** WCAG contrast ratio between two colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black or white — whichever reads better on `hex`. */
export function contrastText(hex: string): '#000000' | '#FFFFFF' {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#FFFFFF') ? '#000000' : '#FFFFFF'
}

/** Is this a light colour (black text reads better on it)? */
export function isLightColor(hex: string): boolean {
  return contrastText(hex) === '#000000'
}
