// ─── Studio website brand layer ───────────────────────────────────────────────
//
// The typefaces a studio can choose for its public site (SITE_BRAND_FONTS in
// @linyup/shared), plus the root props that carry the rest of the brand —
// heading case and button shape — into the page as CSS variables.
//
// FONTS ARE SELF-HOSTED. next/font downloads each family at build time and
// serves it from our own origin, so a visitor's IP never reaches Google — the
// reason a plain Google Fonts <link> is not used. `preload: false` on every
// family: a site only ever renders one or two of them, and preloading all six
// would download every file on every public page.
//
// WHY VARIABLES, NOT INLINE STYLES. The renderer styles almost everything
// inline, but headings take their font from a global `h1…h6` rule and buttons
// their radius from a `rounded-full` utility. The rules in globals.css (search
// "Studio website brand layer") read the variables set here, and every
// variable falls back to today's look — so a site with no brand fields renders
// exactly as it did before they existed.

import { DM_Sans, Inter, Montserrat, Oswald, Playfair_Display, Poppins } from 'next/font/google'
import type { CSSProperties } from 'react'
import type { SiteBrandFont, SiteFont, SiteMeta } from '@linyup/shared'

const montserrat = Montserrat({ subsets: ['latin'], variable: '--site-font-montserrat', display: 'swap', preload: false })
const inter = Inter({ subsets: ['latin'], variable: '--site-font-inter', display: 'swap', preload: false })
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--site-font-poppins',
  display: 'swap',
  preload: false,
})
const oswald = Oswald({ subsets: ['latin'], variable: '--site-font-oswald', display: 'swap', preload: false })
const playfair = Playfair_Display({ subsets: ['latin'], variable: '--site-font-playfair', display: 'swap', preload: false })
const dmSans = DM_Sans({ subsets: ['latin'], variable: '--site-font-dm-sans', display: 'swap', preload: false })

/** Every brand family's `--site-font-*` variable, as one class string for the
 *  site root. Defining a variable downloads nothing — a file is fetched only
 *  once a rule actually uses its family. */
const SITE_FONT_VARIABLE_CLASSES = [montserrat, inter, poppins, oswald, playfair, dmSans]
  .map((font) => font.variable)
  .join(' ')

const SYSTEM_STACKS = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"ui-rounded", "SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif',
} as const

const BRAND_STACKS: Record<SiteBrandFont, string> = {
  montserrat: `var(--site-font-montserrat), ${SYSTEM_STACKS.sans}`,
  inter: `var(--site-font-inter), ${SYSTEM_STACKS.sans}`,
  poppins: `var(--site-font-poppins), ${SYSTEM_STACKS.sans}`,
  oswald: `var(--site-font-oswald), ${SYSTEM_STACKS.sans}`,
  playfair: `var(--site-font-playfair), ${SYSTEM_STACKS.serif}`,
  'dm-sans': `var(--site-font-dm-sans), ${SYSTEM_STACKS.sans}`,
}

/** THE font-family stack for a stored font id. The only reader — the site root,
 *  the embed root and the builder's font picker all resolve through it. */
export const FONT_STACK: Record<SiteFont, string> = { ...SYSTEM_STACKS, ...BRAND_STACKS }

const BUTTON_RADIUS: Record<NonNullable<SiteMeta['buttonShape']>, string> = {
  pill: '9999px',
  rounded: '0.5rem',
  square: '0px',
}

const CONTENT_WIDTH: Record<NonNullable<SiteMeta['contentWidth']>, string> = {
  standard: '64rem',
  wide: '80rem',
  full: '96rem',
}

type BrandMeta = Pick<
  SiteMeta,
  'font' | 'headingFont' | 'headingCase' | 'buttonShape' | 'cardShape' | 'contentWidth' | 'navCase'
>

/**
 * className + style for a website root element (the full site and an embedded
 * section). A variable is set ONLY for a choice the studio made; an absent one
 * leaves the globals.css fallback — today's heading font, normal case, pills —
 * in charge.
 */
export function siteBrandRootProps(meta: BrandMeta): { className: string; style: CSSProperties } {
  const style: Record<string, string> = {
    fontFamily: FONT_STACK[meta.font] ?? FONT_STACK.sans,
  }
  // Headings follow a chosen heading font, or the body font when that body font
  // is a brand face. A system body font keeps the app's heading face, as before.
  const headingFont = meta.headingFont ?? (meta.font in BRAND_STACKS ? meta.font : undefined)
  if (headingFont) style['--site-font-heading'] = FONT_STACK[headingFont]
  if (meta.headingCase === 'uppercase') style['--site-heading-case'] = 'uppercase'
  if (meta.buttonShape) style['--site-btn-radius'] = BUTTON_RADIUS[meta.buttonShape]
  // Cards come in two radii today (large surfaces 1rem, compact tiles 0.75rem),
  // so 'square' zeroes both and 'rounded' leaves both fallbacks untouched.
  if (meta.cardShape === 'square') {
    style['--site-card-radius'] = '0px'
    style['--site-card-radius-sm'] = '0px'
  }
  style['--site-width'] = CONTENT_WIDTH[meta.contentWidth ?? 'standard']
  if (meta.navCase === 'uppercase') style['--site-nav-case'] = 'uppercase'
  return { className: `site-root ${SITE_FONT_VARIABLE_CLASSES}`, style: style as CSSProperties }
}
