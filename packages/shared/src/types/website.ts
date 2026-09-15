import type { Timestamp } from './common'
import type { SurfaceThemePresetId } from './themePreset'
import type { SiteThemeId } from './siteTheme'
import type { PublicSurface, SocialLink } from './team'
import type { UiLanguage } from '../utils/regional'

// ─────────────────────────────────────────────────────────────────────────────
// Website plugin — studio site builder.
//
// A site is one or more pages made of stacked, typed sections. The HOME page's
// sections live on the site doc itself; every other page is a doc of its own in
// a `pages` subcollection, listed by the site doc's `pages` index (see
// SitePageRef). Two docs back the site:
//   • site_drafts/{teamId}    — PRIVATE working copy (manager+ read/write)
//   • site_published/{teamId}  — PUBLIC, fully-public snapshot containing ONLY
//                                whitelisted fields. Written by the publishWebsite
//                                Cloud Function (clients can never write it).
//
// "Live" sections (pricing, schedule) store only presentation config here and
// read their data at render time from existing public mirrors (team
// public_profile.aggregator_subscription_types, session public_profile), so a
// published site stays fresh without re-publishing.
// ─────────────────────────────────────────────────────────────────────────────

export type SiteTheme = 'light' | 'dark' | 'auto'

/**
 * Curated brand typefaces, loaded from Google Fonts by the renderer and served
 * from our own origin (next/font), so a visitor's IP never reaches Google.
 * A CLOSED list on purpose: every entry is a font file the public site ships,
 * and the publish sanitizer refuses anything else. The ids are stored — a
 * rename is a migration.
 */
export const SITE_BRAND_FONTS = ['montserrat', 'inter', 'poppins', 'oswald', 'playfair', 'dm-sans'] as const
export type SiteBrandFont = (typeof SITE_BRAND_FONTS)[number]

/** The three system stacks sites have always had, plus the brand typefaces. */
export const SITE_FONTS = ['sans', 'serif', 'rounded', ...SITE_BRAND_FONTS] as const
export type SiteFont = (typeof SITE_FONTS)[number]
export type SectionAlign = 'left' | 'center'
export type SiteCtaAction = 'booking' | 'signup' | 'url' | 'page'

/** A call-to-action button. `booking`/`signup` resolve to the team's bio-link
 *  flows; `url` opens an external link. ('membership' is a legacy alias for
 *  'signup', still accepted on read/publish for older stored sites.) */
export interface SiteCta {
  label: string
  action: SiteCtaAction
  url?: string
  /** For `action: 'page'` — the page to open (a SitePageRef id). */
  pageId?: string
}

export interface SiteImage {
  url: string
  caption?: string
}

interface SectionBase {
  /** Stable id (used as React key, image upload path segment, anchor target). */
  id: string
  /** Short label shown for this section in the nav menu. When unset, the nav
   *  falls back to the section's heading (or a type default). Lets a studio keep
   *  a long on-page title while the menu stays terse (e.g. heading "Our weekly
   *  schedule" → menu "Schedule"). */
  menuLabel?: string
  /** Whether this section shows as an item in the site's navigation menu.
   *  Defaults to visible (true) when unset; the hero is never listed. */
  showInNav?: boolean
  /** When true the section is kept in the draft but omitted from the published
   *  site (a quick show/hide that doesn't delete the section). */
  hidden?: boolean
}

export interface HeroSection extends SectionBase {
  type: 'hero'
  headline: string
  subheadline?: string
  bgImageUrl?: string
  /** Dark overlay strength over the background image, 0–100. */
  overlay?: number
  /**
   * A solid background colour used WHEN THERE IS NO IMAGE. Absent ⇒ the theme's
   * page colour, today's behaviour. Ignored while `bgImageUrl` is set — an image
   * is its own background.
   */
  bgColor?: string
  /**
   * How the hero content sits on the background:
   *  - 'full' (default): text directly on the background, edge to edge.
   *  - 'card': the text in a surface card floating on the background — the same
   *    "comes out of the page" idea the theme applies to cards, for a hero over
   *    a busy image or a strong colour.
   *
   * Absent ⇒ 'full', so existing heroes are unaffected.
   */
  layout?: 'full' | 'card'
  align: SectionAlign
  cta?: SiteCta
  /**
   * A muted, looping background video (an https mp4/webm URL). EXTERNAL ONLY —
   * the studio's own host or CDN, never an upload: hosted video is billed per
   * byte to every visitor (storage.rules, docs/scalability-2026-09.md §12).
   * `bgImageUrl` is its poster and what visitors who prefer reduced motion see.
   */
  bgVideoUrl?: string
  /**
   * How the `overlay` is laid over the image:
   *  - 'solid' (default): an even wash across the whole hero — today's look.
   *  - 'gradient-left': strongest behind the text on the left, fading out to
   *    the right, so the photo stays vivid where there is no copy.
   *  - 'gradient-bottom': strongest at the bottom, fading upwards.
   *  - 'gradient-left-bottom': both at once — the corner behind the text is
   *    covered and the top right of the photo stays clear.
   * `overlay` still sets how strong the wash is where it is strongest.
   */
  overlayStyle?: 'solid' | 'gradient-left' | 'gradient-bottom' | 'gradient-left-bottom'
  /**
   * The wash colour. 'dark' (default): black, white text — today's look.
   * 'light': white, dark text, for a bright, airy hero.
   */
  overlayTone?: 'dark' | 'light'
}

/** A row of highlight items. For "why us" callouts, offer cards, a stats row or
 *  a checklist — one list of items, drawn in the chosen `style`. No rich text. */
export interface FeaturesSection extends SectionBase {
  type: 'features'
  heading?: string
  subheading?: string
  columns: 2 | 3 | 4
  items: FeatureItem[]
  /**
   * How the items are drawn:
   *  - 'cards' (default): a card per item — icon, or an image on top when the
   *    item has one (an offer grid).
   *  - 'stats': big figures in a row — `title` is the figure ("500 m²"), `text`
   *    the caption.
   *  - 'checklist': a tick per item, no cards.
   * Absent ⇒ 'cards', so existing sections are unaffected.
   */
  style?: 'cards' | 'stats' | 'checklist'
}

export interface FeatureItem {
  /** A lucide icon name (validated against a small allow-list at render). */
  icon?: string
  title: string
  text?: string
  linkLabel?: string
  /** An https URL, or `#sectionId` to jump to a section of the same page. */
  linkUrl?: string
  /** A page of this site. Wins over `linkUrl`; a page that is not published
   *  renders no link at all. */
  linkPageId?: string
  /** Image across the top of the card ('cards' style). Replaces the icon. */
  imageUrl?: string
}

/** A call to action mid-page — a heading, a line and a wide button. */
export interface CtaBannerSection extends SectionBase {
  type: 'cta_banner'
  heading: string
  text?: string
  cta?: SiteCta
  /**
   * - 'card' (default): one centred card, spaced above and below.
   * - 'band': full width, edge to edge — over `bgImageUrl` when set.
   */
  style?: 'card' | 'band'
  /** Background image, dimmed so the text stays readable. */
  bgImageUrl?: string
}

/**
 * A video block — a YouTube or Vimeo film, shown inline or opened in a lightbox
 * from a play button, optionally over a muted background loop.
 *
 * Only `provider` + `videoId` are stored, never an embed URL: the renderer
 * builds the privacy-friendly player address itself (utils/videoEmbed.ts), so
 * no arbitrary iframe source can ever be published.
 */
export interface VideoSection extends SectionBase {
  type: 'video'
  heading?: string
  text?: string
  provider?: VideoProvider
  videoId?: string
  /** 'inline' (default): the player sits in the page. 'lightbox': a play button
   *  opens it over the page. */
  display?: 'inline' | 'lightbox'
  /** The play button's label in lightbox mode ("Video abspielen"). */
  playLabel?: string
  /** Muted background loop behind the block — external https mp4/webm only,
   *  like `HeroSection.bgVideoUrl`. */
  bgVideoUrl?: string
  /** Still image: the lightbox block's background, and the loop's poster. */
  posterUrl?: string
}

export type VideoProvider = 'youtube' | 'vimeo'

/** A list of question/answer pairs, rendered as an accordion. */
export interface FaqSection extends SectionBase {
  type: 'faq'
  heading?: string
  items: FaqItem[]
}

export interface FaqItem {
  question: string
  answer: string
}

/** One testimonial at a time in a card, stepped through with chevrons. */
export interface TestimonialsSection extends SectionBase {
  type: 'testimonials'
  heading?: string
  items: Testimonial[]
}

export interface Testimonial {
  name: string
  /** What they do / their role — "Member since 2021", "Competitor". */
  activity?: string
  feedback: string
}

/** Generic free-form content block: a rich-text body (HTML, produced by the
 *  shared RichTextEditor) plus an optional title and optional side image. The
 *  legacy 'about' literal is still accepted so existing sites keep rendering;
 *  publish normalizes them to 'content'. */
export interface ContentSection extends SectionBase {
  type: 'content' | 'about'
  heading?: string
  body: string // rich text (HTML)
  imageUrl?: string
  imageSide: 'left' | 'right'
}

/** @deprecated Renamed to ContentSection (a generic content block). */
export type AboutSection = ContentSection

export interface GallerySection extends SectionBase {
  type: 'gallery'
  heading?: string
  images: SiteImage[]
  columns: 2 | 3 | 4
  /**
   * - 'grid' (default): cropped tiles in `columns`, with captions.
   * - 'marquee': one endlessly scrolling strip of photos (still for visitors
   *   who prefer reduced motion).
   * - 'logos': partner / certification logos — never cropped, evenly spaced.
   * Absent ⇒ 'grid'.
   */
  layout?: 'grid' | 'marquee' | 'logos'
}

/** Pulls live activities from the team's public_profile mirrors (type: 'activity').
 *  Presented as a card grid; each card can deep-link into the booking flow. */
export interface ActivitiesSection extends SectionBase {
  type: 'activities'
  heading?: string
  subheading?: string
  source: 'activities'
  columns: 2 | 3 | 4
  /**
   * Card arrangement:
   *  - 'grid' (default): image on top, content below, `columns` per row
   *  - 'list': one full-width row per activity, image left / content right
   *
   * Absent ⇒ 'grid', so existing sites are unaffected. `columns` is ignored in
   * list layout (a list is always one per row) but kept, so switching back to
   * grid restores the studio's column choice.
   */
  layout?: 'grid' | 'list'
  /** Show a "Book" link on each card → /booking/[activitySlug]. */
  showBooking?: boolean
  /**
   * How much of the commercial story each card states.
   *
   *  - 'list' (default): every line, one per row — today's behaviour.
   *  - 'compact': the money collapses behind one "Prices" control that reveals
   *    the same lines on tap/hover.
   *  - 'hidden': no amount is rendered at all.
   *
   * HIDING A PRICE MUST NEVER HIDE A GATE. Whatever this is set to, a card
   * whose activity REFUSES a visitor keeps saying so — the members-tier line
   * and the "included with {plan}" line of a subscription-gated class are
   * requirements, not prices, and they render under every mode (the latter
   * without its price under 'hidden'). What this option governs is the money a
   * visitor could choose to spend: drop-in, appointment prices, member
   * discounts, and a PAID trial badge (a free-trial badge quotes no amount and
   * stays). Anything else would sell a click that ends in a refusal.
   *
   * Under 'compact' a gate line keeps its price inline rather than moving
   * behind the control: splitting it would either duplicate the line or strip
   * the one number that makes the requirement actionable ("Included with
   * Premium" — at what?). It is the OPTIONAL spend that collapses.
   *
   * Absent ⇒ 'list', so existing sites are unaffected.
   */
  pricingDisplay?: 'list' | 'compact' | 'hidden'
}

/** Pulls live data from the team's public_profile.aggregator_subscription_types. */
export interface PricingSection extends SectionBase {
  type: 'pricing'
  heading?: string
  subheading?: string
  source: 'subscriptions'
  ctaLabel?: string
  /**
   * How the plans are laid out:
   *  - 'cards' (default): one card per plan — today's behaviour.
   *  - 'table': the comparison a prospect actually makes — activities as ROWS,
   *    plans as COLUMNS, each cell saying what that plan gets you for that
   *    activity. No new data: it is the same activity mirrors + plan list the
   *    cards already read, resolved through the same access rules.
   *
   * Absent ⇒ 'cards'.
   */
  layout?: 'cards' | 'table'
  /**
   * 'term': cards grouped into tabs by commitment length ("1 month", "6
   * months", "12 months"), each plan showing its price for the chosen term —
   * see `priceTermMonths`. A plan with no termed price (a credit pack, a
   * per-class price) is listed below the tabs. Cards layout only.
   * Absent ⇒ every price on one card.
   */
  groupBy?: 'term'
}

/** Pulls upcoming bookable sessions from the session public_profile mirrors. */
export interface ScheduleSection extends SectionBase {
  type: 'schedule'
  heading?: string
  source: 'sessions'
  /** How many days ahead to show. Defaults to 7 when unset. */
  windowDays?: number
  /** Cap on how many sessions to list (keeps a busy schedule short). Unset/0 = no cap. */
  maxItems?: number
  /** Optional activity filter (activity id). */
  activityId?: string
  /** Studio's default view. The live site also shows a small List/Calendar toggle.
   *  'calendar' = weekly time-grid planner (formerly 'week', a chip grid).
   *  Defaults to 'calendar' when unset. */
  displayMode?: 'list' | 'calendar'
  /** Show a small "Book" icon on each session row/chip → /booking. Off by default
   *  (the space is tight and it repeats on every session). */
  showBooking?: boolean
}

export interface ContactSection extends SectionBase {
  type: 'contact'
  heading?: string
  address?: string
  phone?: string
  email?: string
  hours?: string
  /** Free-text place/address used to embed a map. */
  mapQuery?: string
  showSocial?: boolean
}

/** A studio-selected subset of the team's Places, rendered as simple cards (no map).
 *  Draft stores the selection (`placeIds`); publish embeds a whitelisted snapshot
 *  (`places`) so the public site needs no extra reads. */
export interface PlacesSection extends SectionBase {
  type: 'places'
  heading?: string
  subheading?: string
  columns: 2 | 3 | 4
  placeIds?: string[]
  places?: { id: string; name: string; address?: string; mapsLink?: string }[]
}

/**
 * People, authored in the builder — a studio's coaches on a team page, or the
 * one contact person on an offer page. Nothing is read from the team roster:
 * a website shows who the studio chooses, with the role and photo it chooses.
 * (The org site's `coaches` block is the roster-driven one; different type.)
 */
export interface TeamSection extends SectionBase {
  type: 'team'
  heading?: string
  subheading?: string
  columns: 2 | 3 | 4
  /**
   * - 'grid' (default): a portrait card per person — photo, name, role, badge.
   * - 'contact': a wide card per person with the bio and email / phone
   *   buttons — "your contact person" on an offer page.
   */
  layout?: 'grid' | 'contact'
  items: TeamMemberItem[]
}

export interface TeamMemberItem {
  name: string
  role?: string
  /** A short tag on the card, e.g. a certification ("CF-L2"). Not translated. */
  badge?: string
  bio?: string
  imageUrl?: string
  email?: string
  phone?: string
}

/**
 * One of the team's published forms, filled in on the page itself. The fields
 * are read live from the form's public mirror; publish drops the section when
 * the form is not the team's or not published.
 */
export interface FormSection extends SectionBase {
  type: 'form'
  heading?: string
  text?: string
  formId: string
  /**
   * What follows a successful submit. Absent ⇒ a thank-you line.
   * 'appointment' opens the appointment booking for that activity — a free
   * intro call booked straight after the enquiry. Publish drops a `next` whose
   * activity is not one of the team's appointment activities.
   */
  next?: { kind: 'appointment'; activityId: string }
}

export type WebsiteSection =
  | HeroSection
  | ContentSection
  | GallerySection
  | ActivitiesSection
  | PricingSection
  | ScheduleSection
  | ContactSection
  | PlacesSection
  | FeaturesSection
  | CtaBannerSection
  | FaqSection
  | TestimonialsSection
  | VideoSection
  | TeamSection
  | FormSection
  | PostsSection

/**
 * The site's newest blog posts (pages with `kind: 'post'`), read from the page
 * index the site already carries — no extra reads, and a post that is hidden
 * or unpublished is simply not in it.
 */
export interface PostsSection extends SectionBase {
  type: 'posts'
  heading?: string
  subheading?: string
  /** How many posts, newest first. Publish defaults it to 6. */
  limit?: number
  /** 'grid' (default): cover cards. 'list': rows with a small image. */
  layout?: 'grid' | 'list'
  columns: 2 | 3 | 4
}

export type WebsiteSectionType = WebsiteSection['type']

export interface SiteSeo {
  title?: string
  description?: string
  ogImageUrl?: string
}

/**
 * A studio's OVERRIDE for one auto-derived cross-surface header link.
 *
 * The link list itself comes from `TeamPublicProfile.active_public_surfaces` at
 * render time, not from here — so enabling the shop plugin surfaces a Shop link
 * without the studio having to re-edit the website. This type only records the
 * studio's deviations from that default.
 *
 * `surface` is the stable machine identifier (see PublicSurface); an entry
 * naming a surface that isn't live is ignored rather than removed, so toggling a
 * plugin off and on again doesn't lose the label the studio wrote.
 */
export interface SiteSurfaceLinkConfig {
  surface: PublicSurface
  /** Hide a link the studio doesn't want in the nav. Absent ⇒ visible. */
  hidden?: boolean
  /** Replaces the default localized name (the `PublicSurfaceLinks` messages). */
  label?: string
  /** Ascending. Unset entries sort after the configured ones, in their natural order. */
  order?: number
}

/**
 * ─── THE SITE MENU ──────────────────────────────────────────────────────────
 *
 * A STORED TREE, replacing two derived lists that could never interleave.
 *
 * Before this the header nav was assembled from two independent sources:
 *   • section anchors — `sections` filtered by `showInNav`, in section order;
 *   • surface links   — derived from `active_public_surfaces`, ordered only
 *     among THEMSELVES by `SiteSurfaceLinkConfig.order`.
 * They were rendered as two runs, so "Shop" could never sit between two section
 * anchors however the studio ordered either list. That is why the system links
 * read as fixed, and why their settings had washed up in the appearance panel:
 * there was nowhere else for them to live.
 *
 * ABSENT MEANS DERIVE. A site with no `menu` renders exactly what it rendered
 * before — see `deriveSiteMenu`. No backfill, no migration, and a studio that
 * never opens the menu editor is unaffected; the first edit stores a tree and
 * that tree wins from then on.
 */
export type SiteMenuTarget =
  /** A section of the HOME page — an anchor there, from any page. */
  | { kind: 'section'; sectionId: string }
  /** Another page of the site, optionally scrolled to one of its sections. */
  | { kind: 'page'; pageId: string; sectionId?: string }
  | { kind: 'surface'; surface: PublicSurface }
  | { kind: 'url'; url: string }
  /** A parent that only opens its children — no destination of its own. */
  | { kind: 'none' }

export interface SiteMenuItem {
  /** Stable id — React key and the handle the editor moves around. */
  id: string
  /** Overrides the label derived from the target. Absent ⇒ derived. */
  label?: string
  target: SiteMenuTarget
  children?: SiteMenuItem[]
}

/**
 * How deep the tree may nest, root included.
 *
 * Four is a CAP, not a target: a header menu that needs four levels is usually
 * a site that needs fewer pages. The editor refuses an indent past this rather
 * than silently flattening it, so the limit is met as a message instead of as
 * a surprise on the published site.
 */
export const SITE_MENU_MAX_DEPTH = 4

/** Depth of the deepest branch, 0 for an empty tree. */
export function siteMenuDepth(items: readonly SiteMenuItem[] | undefined): number {
  if (!items || items.length === 0) return 0
  return 1 + Math.max(0, ...items.map((i) => siteMenuDepth(i.children)))
}

/** Every item in the tree, depth-first — the order it is read in. */
export function flattenSiteMenu(
  items: readonly SiteMenuItem[] | undefined,
  depth = 1
): { item: SiteMenuItem; depth: number }[] {
  return (items ?? []).flatMap((item) => [
    { item, depth },
    ...flattenSiteMenu(item.children, depth + 1),
  ])
}

/**
 * The menu a site with no stored tree gets: exactly today's behaviour, as data.
 *
 * Section anchors first, in section order, then the live surface links — which
 * is the two-run layout the header already drew. Producing it here rather than
 * in the renderer means the editor can open it, the studio can reorder it, and
 * the first save turns it into an ordinary stored tree.
 */
export function deriveSiteMenu(params: {
  sections: readonly { id: string; type: string; showInNav?: boolean }[]
  surfaceLinks: readonly { surface: PublicSurface }[]
  /** A multi-page site lists its visible pages after the home anchors. */
  pages?: readonly { id: string; hidden?: boolean; kind?: 'page' | 'post' }[]
}): SiteMenuItem[] {
  const anchors = params.sections
    .filter((s) => s.type !== 'hero' && s.showInNav !== false)
    .map((s): SiteMenuItem => ({
      id: `section:${s.id}`,
      target: { kind: 'section', sectionId: s.id },
    }))
  // Posts are reached through a posts section, never one menu item each.
  const pages = (params.pages ?? [])
    .filter((p) => !p.hidden && p.kind !== 'post')
    .map((p): SiteMenuItem => ({ id: `page:${p.id}`, target: { kind: 'page', pageId: p.id } }))
  const surfaces = params.surfaceLinks.map((l): SiteMenuItem => ({
    id: `surface:${l.surface}`,
    target: { kind: 'surface', surface: l.surface },
  }))
  return [...anchors, ...pages, ...surfaces]
}

export interface SiteHeader {
  /** Sticky top bar with in-page anchor nav. */
  showNav: boolean
  ctaLabel?: string
  ctaAction?: SiteCtaAction
  ctaUrl?: string
  /** The page the header button opens, when `ctaAction` is 'page'. */
  ctaPageId?: string
  /**
   * Show the member control ("Sign in" / "My space") in the header. Absent ⇒
   * shown: a returning member on the website otherwise has no way into their
   * Space, which is the gap this exists to close.
   */
  showSignIn?: boolean
  /** Per-surface overrides for the auto-derived links. See SiteSurfaceLinkConfig. */
  surfaceLinks?: SiteSurfaceLinkConfig[]
  /** A thin utility strip ABOVE the header — contact details, a login link.
   *  Absent ⇒ no strip, today's header. */
  topBar?: SiteTopBar
}

/**
 * The utility strip above the header. Links are ordinary menu items so they
 * share the menu's targets, sanitizer and translation keys — but FLAT: a strip
 * with dropdowns is a second menu, and the publish sanitizer drops children.
 */
export interface SiteTopBar {
  /** Free text on the leading side ("info@studio.ch · +41 …"). */
  text?: string
  items?: SiteMenuItem[]
}

/** One link column in the footer. `id` keys its heading's translation, so a
 *  reorder cannot rebind one column's heading onto another. */
export interface SiteFooterColumn {
  id: string
  heading?: string
  /** Flat, like the top bar. */
  items: SiteMenuItem[]
}

/** A partner / certification logo in the footer strip. */
export interface SiteFooterLogo {
  url: string
  /** Where the logo links to. Absent ⇒ not a link. */
  link?: string
  /** Alt text — the partner's name. */
  alt?: string
}

/**
 * Which cross-surface links a website header shows, and in what order.
 *
 * The list is DERIVED from what's live and then adjusted by the studio's
 * overrides — never stored wholesale. That ordering matters: a studio that
 * enables the online-courses plugin should get a Shop link without editing the
 * site, and a studio that disabled the shop shouldn't get a dead link back when
 * they re-enable it.
 *
 * `defaultLabel` is injected by the caller (it's localized in the web app), so
 * this stays framework- and locale-agnostic and can be unit-tested.
 */
export function resolveSiteSurfaceLinks(
  header: SiteHeader | undefined,
  liveSurfaces: readonly PublicSurface[],
  defaultLabel: (surface: PublicSurface) => string
): { surface: PublicSurface; label: string }[] {
  const overrides = new Map(
    (header?.surfaceLinks ?? []).map((c) => [c.surface, c] as const)
  )
  return liveSurfaces
    .filter((s) => !overrides.get(s)?.hidden)
    .map((surface, index) => {
      const config = overrides.get(surface)
      return {
        surface,
        label: config?.label?.trim() || defaultLabel(surface),
        // Unconfigured links keep their natural order, after the configured ones.
        order: config?.order ?? Number.MAX_SAFE_INTEGER,
        index,
      }
    })
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ surface, label }) => ({ surface, label }))
}

/**
 * The footer. Everything past `showSocial` is optional and absent on every
 * site that predates it, which renders exactly the footer it always had.
 */
export interface SiteFooter {
  showSocial: boolean
  /** A line of prose — an address block, a tagline. Plain text, pre-line. */
  text?: string
  /** Link columns ("Unsere Angebote", "Gut zu wissen"). */
  columns?: SiteFooterColumn[]
  /** Partner / certification logos, shown as a strip above the footer. */
  logos?: SiteFooterLogo[]
  /** Store badges for the studio's member app. */
  appLinks?: { ios?: string; android?: string }
  /** The bottom row — Impressum, Datenschutz, AGB. Flat. */
  legal?: SiteMenuItem[]
}

export interface SiteMeta {
  title: string
  /**
   * ONE choice carrying both a light and a dark palette — see
   * `types/themePreset.ts`. When set it WINS over `theme` and `background`
   * below, which stay only so a site authored before presets keeps its look
   * until the studio picks one (no backfill, no deploy ordering).
   */
  themePreset?: SurfaceThemePresetId
  /**
   * The studio's own colour, read ONLY when `themePreset` is 'custom'. Both
   * halves of the page are derived from it — see `types/themeDerive.ts`.
   *
   * NOT the accent. `accentColor` is what must be noticed (a button, a link);
   * this is what everything else is made of. Keeping them apart is what lets a
   * deep-green studio have a green PAGE with an orange call to action, which
   * the fixed presets could not express at all.
   */
  /**
   * Custom theme — the studio's own colours. Read only when `themePreset` is
   * 'custom'; the colour you pick IS the page background (see themeDerive.ts).
   */
  /** The light-page colour, and the whole site when `themeSingle`. */
  themeLight?: string
  /** The dark-page colour. Absent ⇒ a correlate of `themeLight`. */
  themeDark?: string
  /** One colour, one look for everyone — no separate dark version. */
  themeSingle?: boolean
  /** A soft gradient instead of a flat background. */
  themeLighting?: boolean
  /**
   * Show visitors a light/dark switch in the site header.
   *
   * OFF BY DEFAULT, and absent means off. A studio that has chosen how its site
   * looks has not asked for a control that lets every visitor choose again, and
   * a toggle appearing on a live site because a field was added is a change
   * nobody made.
   *
   * It renders only on an ADAPTIVE theme — see `WebsiteRenderer`. On a theme
   * that is deliberately one look ('ink', or any fixed preset) there is no
   * second half to switch to, so the control would be a button that does
   * nothing.
   */
  themeToggle?: boolean
  /** LEGACY, and only read while `themePreset` is absent. It crosses with
   *  `background`: "auto" with a fixed background follows the viewer for the
   *  text and not for the page. That is the bug presets exist to remove. */
  theme: SiteTheme
  accentColor: string
  /** Body typeface — and headings too, unless `headingFont` says otherwise. */
  font: SiteFont
  /** A separate display face for headings. Absent ⇒ `font`. */
  headingFont?: SiteFont
  /** Headings set in capitals. Absent ⇒ 'normal', today's look. */
  headingCase?: 'normal' | 'uppercase'
  /** The shape of every call-to-action button. Absent ⇒ 'pill', today's look. */
  buttonShape?: 'pill' | 'rounded' | 'square'
  /** The corners of cards and image tiles. Absent ⇒ 'rounded', today's look. */
  cardShape?: 'rounded' | 'square'
  /** The theme whose look was last applied (types/siteTheme.ts). A note for the
   *  builder — which theme to preselect, which section defaults to start new
   *  sections in — never read by the renderer: the look itself lives in the
   *  fields above, where the studio may have changed it since. */
  appliedTheme?: SiteThemeId
  /** Button fill, when it should differ from the accent (a black button on a
   *  blue-accented site). Absent ⇒ the accent colour, today's look. */
  buttonColor?: string
  /** The studio's logo, shown in the header in place of the site title. The
   *  title stays the accessible name. Absent ⇒ the title as text. */
  logoUrl?: string
  // Optional custom page background (a hex color or full CSS value, e.g. a
  // linear-gradient). Overrides the theme's default page background; the header
  // keeps a theme-based translucent bar. Text stays theme-driven, so pick a
  // background that suits the chosen `theme` (a light one for theme: 'light').
  background?: string
  seo?: SiteSeo
  header: SiteHeader
  footer: SiteFooter
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages
//
// The home page is the site doc's own `sections`; every other page is a
// SitePageDoc in `{site_drafts|site_published}/{teamId}/pages/{pageId}`, listed
// by the site doc's `pages` index. A page lives at `/site/{path}`.
//
// WHY A DOC PER PAGE, not an array on the site doc: a site of thirty pages of
// rich sections does not fit in one Firestore document (1 MiB, and translations
// roughly double it). The index stays on the site doc so a renderer resolves a
// URL to a page with the one read it already makes.
//
// ABSENT MEANS ONE PAGE: a site with no `pages` renders exactly as it always
// did, so nothing existing needs a backfill.
// ─────────────────────────────────────────────────────────────────────────────

/** One page in the site's index. */
export interface SitePageRef {
  /** Stable id — the page doc id, and what menu / CTA targets point at. */
  id: string
  /** URL path under /site, e.g. 'angebot/crossfit'. Lowercase words and
   *  dashes, '/'-separated — see utils/sitePages.ts. Never 'slug': the public
   *  slug queries on these collections must never match a page. */
  path: string
  title: string
  /** Shorter label for menus that list the page. Absent ⇒ the title. */
  navLabel?: string
  /** Kept in the draft, never published. */
  hidden?: boolean
  seo?: SiteSeo
  /**
   * 'post' makes the page a blog post: listed by `posts` sections newest first,
   * shown under a post header (title, date, cover image), and left out of the
   * derived menu. A post is otherwise an ordinary page — its own URL, sections,
   * translations and SEO. Absent ⇒ 'page'.
   */
  kind?: 'page' | 'post'
  /** Posts: the date shown and sorted by, 'YYYY-MM-DD'. A calendar date, not a
   *  Timestamp, so it never shifts with the reader's timezone. */
  publishedOn?: string
  /** Posts: the card and header image, and the social preview image. */
  coverImageUrl?: string
  /** Posts: a sentence or two for the card and the meta description. */
  excerpt?: string
}

/** A page's content — `{site_drafts|site_published}/{teamId}/pages/{pageId}`. */
export interface SitePageDoc {
  teamId: string
  pageId: string
  sections: WebsiteSection[]
  /** Published docs only: which translation sidecars exist for this page.
   *  Sidecars sit beside the page doc, id `{pageId}__i18n_{locale}`. */
  i18n?: SiteI18nManifest
  published_at?: Timestamp
  updated_at?: Timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Site translations (public-site localization)
//
// Tenant-authored site content is machine-translated at publish/save time into
// the other locales of en/de/fr/it and stored as flat unit maps keyed by
// stable section-id-based keys. The key grammar, the extractor and the ONE
// resolver live in utils/siteTranslation.ts — these are only the stored shapes.
// ─────────────────────────────────────────────────────────────────────────────

/** One translated string. `srcHash` is `translationSourceHash(...)` of the
 *  SOURCE text the translation was made from — the resolver substitutes the
 *  unit ONLY while the base text still hashes to it, so a stale translation
 *  degrades to the base language, never to wrong text. */
export interface TranslatedUnit {
  text: string
  /** translationSourceHash(source text at write time). */
  srcHash: string
  /** Future manual override (Option C). Written only by a future callable; MT
   *  writers keep it while srcHash matches and clear it when the source changes.
   *  The resolver never reads it. */
  pinned?: boolean
}

/** Flat unit map, keyed by the grammar in utils/siteTranslation.ts. */
export type SiteTranslationUnits = Record<string, TranslatedUnit>

/** Publisher-written summary on PublishedSite / OrgPublishedSite /
 *  EmbedWidgetSet.i18n: which locale the tenant authored in, and which target
 *  locales have a sidecar / inline unit map. */
export interface SiteI18nManifest {
  srcLang: UiLanguage
  locales: UiLanguage[]
}

/**
 * Per-locale translation sidecar — a doc in the SAME collection as the site it
 * translates: site_published/{teamId}__i18n_{locale} and
 * org_site_published/{orgId}__i18n_{locale} (doc id via `siteI18nDocId`,
 * paths.ts). Function-write only, like every other doc in those collections.
 *
 * NEVER carries a `slug` field: the public slug queries on these collections
 * must never be able to return a sidecar instead of the site itself.
 */
export interface SiteTranslationDoc {
  kind: 'site_i18n'
  teamId?: string
  orgId?: string
  /** Target locale — never equals `srcLang`. */
  locale: UiLanguage
  srcLang: UiLanguage
  units: SiteTranslationUnits
  updated_at?: Timestamp
}

/** PRIVATE working copy — site_drafts/{teamId}. Manager+ read/write. */
export interface SiteDraft {
  teamId: string
  slug: string
  name: string
  /** When false the published site is removed and /site/[slug] 404s. */
  enabled: boolean
  meta: SiteMeta
  sections: WebsiteSection[]
  /** The header menu. Absent ⇒ derived from sections + live surfaces. */
  menu?: SiteMenuItem[]
  /** The other pages of the site. Absent ⇒ a one-page site. Each page's
   *  sections are in the `pages` subcollection. */
  pages?: SitePageRef[]
  updated_at?: Timestamp
  updatedBy?: string
}

/** PUBLIC snapshot — site_published/{teamId}. Public read, function-write only.
 *  Contains ONLY whitelisted public fields. */
export interface PublishedSite {
  teamId: string
  slug: string
  name: string
  meta: SiteMeta
  sections: WebsiteSection[]
  /** The header menu. Absent ⇒ derived from sections + live surfaces. */
  menu?: SiteMenuItem[]
  /** The published pages (hidden ones never are). Absent ⇒ a one-page site. */
  pages?: SitePageRef[]
  /** Denormalised from the team at publish time, for footer/contact icons. */
  socialLinks?: SocialLink[]
  /** Denormalised from the plan — true on the free plan ("Powered by Linyup"). */
  showBranding?: boolean
  /** Which translation sidecars exist for this site (written by the publisher). */
  i18n?: SiteI18nManifest
  published_at?: Timestamp
  updated_at?: Timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone embed widgets
//
// A studio that already has its own website can embed individual Linyup sections
// (schedule, pricing, …) WITHOUT building or publishing a Linyup site. Each widget
// is just a WebsiteSection authored on its own, with its own look. Stored PUBLICLY
// at embed_widgets/{teamId} (public read, manager write — the config IS the public
// config, so there is no draft/publish split like the full site). The /embed route
// resolves a widget by id first, then falls back to a published site section.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-widget look. Standalone widgets have no SiteMeta, so each carries its own. */
export interface WidgetTheme {
  theme: SiteTheme
  accentColor?: string
  font?: SiteFont
  /** 'transparent' lets the host page's background show through (blends in). */
  background: 'solid' | 'transparent'
  /** Which language the embedded widget renders in. 'auto' (or absent — today's
   *  behaviour) follows the visitor's Accept-Language; a pinned locale bakes the
   *  language into the embed snippet URL. */
  locale?: 'auto' | UiLanguage
}

/** One standalone, embeddable widget: a section plus a studio-facing label and look. */
export type EmbedWidget = WebsiteSection & {
  /** Studio-facing name shown in the builder list (the section type is the fallback). */
  label?: string
  theme?: WidgetTheme
}

/** PUBLIC per-team set of standalone widgets — embed_widgets/{teamId}.
 *  Public read, manager write. */
export interface EmbedWidgetSet {
  teamId: string
  slug: string
  widgets: EmbedWidget[]
  /** Denormalised from the team so contact widgets can render social icons. */
  socialLinks?: SocialLink[]
  /**
   * Inline widget translations (no sidecar doc — widgets have no draft/publish
   * split, so the translations ride on the one public doc). Written WHOLE by the
   * onEmbedWidgetsWritten trigger; saveEmbedWidgets carries it forward on client
   * saves. A wiped field self-heals at the next trigger run. Keys inside each
   * locale's unit map use the same `s.{sectionId}.*` grammar as the site
   * sidecars (utils/siteTranslation.ts).
   */
  i18n?: { srcLang: UiLanguage; locales: Partial<Record<UiLanguage, SiteTranslationUnits>> }
  updated_at?: Timestamp
  updatedBy?: string
}
