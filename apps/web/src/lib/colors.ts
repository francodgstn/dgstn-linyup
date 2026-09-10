// Colour constants — deliberately dependency-free.
//
// These live apart from `components/ui/color-picker.tsx` on purpose: that module
// is a 'use client' component pulling in react-colorful, Popover and Input, so
// importing a constant from it would drag the whole picker into any bundle that
// just wants a hex — including public, unauthenticated routes (the bio-link, the
// shop, the space theme, the embeddable widget iframe) that render a brand accent
// but never show a picker. Import colours from here; import the UI from there.

/** The studio accent palette — the single source of truth. Previously copy-pasted
 *  into org/website, plugins/website, team/bio-link and the public BookingForm.
 *  Picked to stay legible on both light and dark surfaces. */
export const COLOR_PRESETS = [
  '#6366f1',
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
] as const

/** The app-wide default accent. */
export const DEFAULT_ACCENT = '#6366f1'

export const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** Normalise anything stored (legacy 3-digit hex, missing '#', empty) to a
 *  6-digit hex, falling back to the default. Stored values are free text. */
export function normalizeHex(value: string | undefined | null, fallback = DEFAULT_ACCENT): string {
  if (!value) return fallback
  let v = value.trim()
  if (!v.startsWith('#')) v = `#${v}`
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  return HEX_RE.test(v) ? v.toLowerCase() : fallback
}

/** The avatar-bubble palette — Tailwind background classes, so it lives here
 *  in the web app rather than in shared (the member app draws its bubbles with
 *  Paper's theme). Used to be declared in both `BookingRow` and the
 *  gamification page, byte-for-byte. */
const AVATAR_COLORS = [
  'bg-blue-500',
  'bg-purple-500',
  'bg-green-500',
  'bg-orange-500',
  'bg-pink-500',
  'bg-teal-500',
  'bg-red-500',
  'bg-indigo-500',
] as const

/** A stable colour for an entity id, so the same person's bubble is the same
 *  colour on every list that shows it. */
export function avatarColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
