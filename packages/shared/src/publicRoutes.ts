import type { PublicSurface, SystemLinkTarget } from './types/team'

// ─── Public tenant routes ─────────────────────────────────────────────────────
//
// The ONE place that knows the shape of `/public/{slug}/…`. Lives in @linyup/shared
// (not apps/web) because packages/functions builds these URLs for emails too and
// cannot import `Route` from next — when the contract lived only in the web app,
// the two drifted: `sendBookingCancelled` and `updateSession` have been emailing
// `…/booking?activity={id}` for months and the booking page never read the param.
//
// Layering:
//   publicPath / publicUrl        (here)          — pure strings, no framework
//   publicHref / publicHrefLocalized (apps/web)   — next-intl + typedRoutes wrappers
//
// Params are serialized in ALPHABETICAL key order so the same call always yields
// the same string (idempotency keys, snapshot tests, email diffs).

/**
 * Routable public paths. This is deliberately WIDER than `PublicSurface`:
 * `PublicSurface` is the set a team may pick as its default landing surface
 * (`Team.default_public_surface`) and is depended on by `ActivePublicSurfaces`
 * and the root page's redirect — do not widen it. These extra entries are
 * reachable routes that are never a landing.
 */
export type PublicRoutable =
  | PublicSurface
  | 'appointments'
  | 'appointments/cancel'
  | 'manage-booking'
  | 'waitlist'
  | 'contact-update'
  | 'trial-booking'
  | 'forms'

/** `/public/{slug}/booking` — see the booking deep-link contract in BookingForm. */
export interface BookingParams {
  /** Session id. Highest precedence: lands the visitor on the "who's booking" step. */
  session?: string
  /** Activity id (NOT the slug — the slug form is the `/booking/{activitySlug}` path). */
  activity?: string
  /** `YYYY-MM-DD`. Only meaningful once an activity is resolved. */
  date?: string
  /** Referral code, carried through to `bookSession({ referralCode })`. */
  referral?: string
  /** Where the visitor came from — resolves the back link. See `returnHref`. */
  from?: PublicFrom
}

/** `/public/{slug}/appointments` */
export interface AppointmentParams {
  activity?: string
  /** Provider (coach) id. */
  provider?: string
  date?: string
  /** Duration in minutes. */
  duration?: number
  from?: PublicFrom
}

export interface ShopParams {
  tab?: 'subscriptions' | 'products' | 'courses'
  /** Subscription type id — opens that plan. */
  type?: string
  course?: string
  from?: PublicFrom
}

export interface SignupParams {
  from?: PublicFrom
  email?: string
}

export interface TokenParams {
  token?: string
}

export interface ContactUpdateParams {
  contactId?: string
  from?: PublicFrom
  /**
   * A contact update LINK token (see types/contactLink.ts). Present instead of
   * `contactId`, never beside it: the token resolves the contact server-side,
   * and putting an id in a pre-authorised URL is how the code-based flow was
   * once talked into authoring an update against an arbitrary contact.
   */
  t?: string
}

export interface FromOnlyParams {
  from?: PublicFrom
}

/**
 * `/public/{slug}/documents` and `/public/{slug}/documents/{documentSlug}`.
 *
 * `v` is a PINNED document link's version (utils/documentLink.ts). Absent means
 * the latest published version, which is what the public mirror serves.
 */
export interface DocumentsParams extends FromOnlyParams {
  v?: number
}

/**
 * `/public/{slug}/events`, `/public/{slug}/events/{eventId}` and its printable
 * sheet `/public/{slug}/events/{eventId}/print`.
 *
 * Only PUBLISHED events are reachable — the pages read the world-readable
 * `events/{id}/public_profile/{id}` mirror, which exists only while
 * `Event.publicVisibility === 'public'`.
 */
export type EventsParams = FromOnlyParams

/**
 * `?from=` values. Every `PublicSurface` plus `'checkout'` (the Stripe return,
 * which is not a surface a visitor can go "back" to). Unknown values are not an
 * error — `returnHref` falls back to the team's default surface.
 */
export type PublicFrom = PublicSurface | 'checkout'

/** Per-route param types, so `publicPath(slug, 'booking', { … })` is checked. */
export interface PublicRouteParams {
  'bio-link': FromOnlyParams
  site: FromOnlyParams
  space: FromOnlyParams
  booking: BookingParams
  shop: ShopParams
  signup: SignupParams
  documents: DocumentsParams
  events: EventsParams
  kiosk: Record<string, never>
  appointments: AppointmentParams
  'appointments/cancel': TokenParams
  'manage-booking': TokenParams
  /** Both waitlist tokens land here — the page decides which mode to render by
   *  which one the server matched, so the link shape stays identical whether it
   *  came from a join confirmation or from an offer. */
  waitlist: TokenParams
  'contact-update': ContactUpdateParams
  'trial-booking': BookingParams
  forms: FromOnlyParams
}

type ParamValue = string | number | undefined | null

/** Alphabetical, undefined/null/'' dropped, values encoded. Empty → ''. */
export function publicQuery(params?: Record<string, ParamValue>): string {
  if (!params) return ''
  const parts: string[] = []
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/**
 * Path only, no origin, no locale prefix.
 *
 * `'bio-link'` is the team ROOT (`/public/{slug}`), not a sibling route — it
 * renders inline there. Omitting `route` means the same thing.
 */
export function publicPath<R extends PublicRoutable>(
  slug: string,
  route?: R,
  params?: PublicRouteParams[R]
): string {
  const base = route && route !== 'bio-link' ? `/public/${slug}/${route}` : `/public/${slug}`
  return `${base}${publicQuery(params as Record<string, ParamValue> | undefined)}`
}

/**
 * Same, with extra path segments — for the dynamic sub-routes
 * (`booking/{activitySlug}`, `documents/{slug}`, `space/courses/{slug}`, …).
 * Segments are encoded individually.
 */
export function publicSubPath<R extends PublicRoutable>(
  slug: string,
  route: R,
  sub: string | string[],
  params?: PublicRouteParams[R]
): string {
  const segments = (Array.isArray(sub) ? sub : [sub]).filter(Boolean).map(encodeURIComponent)
  const base = `/public/${slug}/${route}${segments.length ? `/${segments.join('/')}` : ''}`
  return `${base}${publicQuery(params as Record<string, ParamValue> | undefined)}`
}

/**
 * Absolute URL. This is the form packages/functions uses for emailed links —
 * always with `getHostingUrl()` as the origin, never a request host.
 */
export function publicUrl<R extends PublicRoutable>(
  origin: string,
  slug: string,
  route?: R,
  params?: PublicRouteParams[R]
): string {
  return `${origin}${publicPath(slug, route, params)}`
}

/** Absolute variant of `publicSubPath`. */
export function publicSubUrl<R extends PublicRoutable>(
  origin: string,
  slug: string,
  route: R,
  sub: string | string[],
  params?: PublicRouteParams[R]
): string {
  return `${origin}${publicSubPath(slug, route, sub, params)}`
}

// ─── Locale-prefixed URLs — for EMAILED links ────────────────────────────────
//
// An emailed link carries no locale, so the page it opens picks its language
// from the READER's browser (next-intl resolves: URL prefix → NEXT_LOCALE
// cookie → Accept-Language → default 'en'; public surfaces never write that
// cookie). The mail itself is written in the studio's language — every booking
// template takes a `lang` off `Team.language` — so a German studio's German
// confirmation mail was handing its member an English cancellation page.
//
// apps/web already fixed the same bug for anchors (`publicHrefLocalized`); this
// is the equivalent for the URLs packages/functions builds, and the reason it
// lives here rather than there is that both ends must agree on ONE prefix rule.
//
// `localePrefix: 'as-needed'`: the default locale is the one WITHOUT a prefix.
// Emitting `/en/public/…` is not merely redundant — it costs a 302 on a link
// somebody clicks in a mail client.

/**
 * The locales apps/web serves. MUST stay in step with
 * `apps/web/src/i18n/routing.ts` and with `Team.language` (types/team.ts) —
 * `publicRoutes.test.ts` pins the shape these produce.
 */
export const PUBLIC_LOCALES = ['en', 'de', 'fr', 'it'] as const
export type PublicLocale = (typeof PUBLIC_LOCALES)[number]

/** The unprefixed one, per `localePrefix: 'as-needed'`. */
export const DEFAULT_PUBLIC_LOCALE: PublicLocale = 'en'

/**
 * `''` for the default locale and for anything unrecognised (a bad value
 * degrades to the default language, never to a 404 at `/xx/public/…`),
 * `'/de'` | `'/fr'` | `'/it'` otherwise.
 */
export function publicLocalePrefix(locale: string | null | undefined): string {
  if (!locale) return ''
  const normalized = locale.toLowerCase().split('-')[0]
  if (normalized === DEFAULT_PUBLIC_LOCALE) return ''
  return (PUBLIC_LOCALES as readonly string[]).includes(normalized) ? `/${normalized}` : ''
}

/** `publicUrl` with the reader's locale pinned into the path. Use this for every
 *  link that goes into an email — see the note above. */
export function localizedPublicUrl<R extends PublicRoutable>(
  origin: string,
  locale: string | null | undefined,
  slug: string,
  route?: R,
  params?: PublicRouteParams[R]
): string {
  return `${origin}${publicLocalePrefix(locale)}${publicPath(slug, route, params)}`
}

/** Locale-pinned variant of `publicSubUrl`. */
export function localizedPublicSubUrl<R extends PublicRoutable>(
  origin: string,
  locale: string | null | undefined,
  slug: string,
  route: R,
  sub: string | string[],
  params?: PublicRouteParams[R]
): string {
  return `${origin}${publicLocalePrefix(locale)}${publicSubPath(slug, route, sub, params)}`
}

// ─── Locale-prefixed APP routes ──────────────────────────────────────────────
//
// Not every emailed link is a tenant route. An invitation to help run an
// ORGANISATION belongs to no studio, so it has no `{slug}` and cannot go
// through `publicPath` — but it has exactly the same locale problem, and
// solving it a second way is how the two halves drift.
//
// So: one prefix rule (`publicLocalePrefix`), two path shapes.

/**
 * `{origin}{/de|/fr|/it|''}{path}` for an authenticated-app route.
 *
 * `path` must start with `/` and must NOT already carry a locale prefix — this
 * function is the ONE place that decides the prefix. Use it instead of
 * `${getHostingUrl()}/some/route`, which is the unprefixed form that hands a
 * German reader an English page (and, with `localePrefix: 'as-needed'`, an
 * `/en/…` link costs a 302 on every click).
 */
export function localizedAppUrl(
  origin: string,
  locale: string | null | undefined,
  path: string
): string {
  return `${origin}${publicLocalePrefix(locale)}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * `/org-member-invite/{orgId}/{token}` — where a person invited to help run an
 * ORGANISATION lands.
 *
 * Deliberately NOT `/org-invite/{orgId}/{invId}`, which is the other
 * relationship entirely: that page asks a studio OWNER to enrol their studio
 * and move its billing onto the org plan. An org admin who clicks "you've been
 * invited" must never arrive there. See the naming rule beside
 * `ORG_INVITATIONS_SUBCOLLECTION` in paths.ts.
 *
 * The token is the only secret in the URL; the orgId is there so the server can
 * resolve the invitation with a collection-scope query instead of a
 * collection-group one (no index to forget, and the emulator hides a missing
 * one).
 */
export function orgMemberInvitePath(orgId: string, token: string): string {
  return `/org-member-invite/${encodeURIComponent(orgId)}/${encodeURIComponent(token)}`
}

/**
 * Structured form of `SYSTEM_LINK_META[t].route` (types/team.ts), which is a
 * pre-baked string that may carry a query (`'shop?tab=subscriptions'`).
 *
 * That literal stays the source of truth — it is stored/consumed data read by
 * `BioLinkHome` and the bio-link editor. This table is the structured mirror, so
 * new call sites can go through `publicPath` instead of string-concatenating a
 * route that already contains a `?`. `publicRoutes.test.ts` asserts the two agree.
 */
export const SYSTEM_LINK_ROUTE: Record<
  SystemLinkTarget,
  { route: PublicRoutable; params?: ShopParams }
> = {
  booking: { route: 'booking' },
  signup: { route: 'signup' },
  shop: { route: 'shop' },
  'shop-subscriptions': { route: 'shop', params: { tab: 'subscriptions' } },
  'shop-products': { route: 'shop', params: { tab: 'products' } },
  'shop-courses': { route: 'shop', params: { tab: 'courses' } },
  space: { route: 'space' },
  site: { route: 'site' },
  documents: { route: 'documents' },
  events: { route: 'events' },
}

/**
 * Which `ActivePublicSurfaces` flag decides whether a bio-link "page link" has
 * anywhere to land. The three `shop-*` deep links all ride on the shop surface —
 * a tab of a page that is not live is not a destination either.
 */
export const SYSTEM_LINK_SURFACE: Record<SystemLinkTarget, PublicSurface> = {
  booking: 'booking',
  signup: 'signup',
  shop: 'shop',
  'shop-subscriptions': 'shop',
  'shop-products': 'shop',
  'shop-courses': 'shop',
  space: 'space',
  site: 'site',
  documents: 'documents',
  events: 'events',
}

/**
 * `active_public_surfaces` AS A ROUTING QUESTION — "does this route render
 * something the visitor came for?" — which is what every link, the team root's
 * redirect, the website header and the studio's own public-pages hub ask.
 *
 * For every surface but one it is exactly what the mirror already says.
 *
 * THE SHOP IS THE EXCEPTION, and this is the only place that correction is
 * made. Its flag answers a NARROWER question — "is there a till?"
 * (`syncTeamPublicProfile` computes `shopActive` straight from
 * `payments_enabled`, UX-33) — and since a studio that takes payment offline
 * gets a READ-ONLY PRICE LIST at the same URL, no till is no longer no
 * destination. Hiding the page hid the only public surface on which a visitor
 * could see what a membership costs, and a cash-only studio is a normal
 * business, not a broken one.
 *
 * Nothing about the till moves: the shop page reads `payments_enabled` itself
 * and renders no control that could take money, and every checkout callable
 * still refuses without a chargeable account (`requireChargeableAccount`).
 *
 * The other flags keep their own defaults at each call site — some fail open
 * (a link), some fail closed (the root redirect), and that difference is
 * deliberate. This function only ever ADDS `shop`.
 */
export function routableSurfaces<T extends Partial<Record<PublicSurface, boolean>>>(
  active: T | undefined
): Partial<T> & { shop: true } {
  return { ...(active ?? ({} as T)), shop: true }
}

/**
 * IS THE APPOINTMENT PICKER (`/public/{slug}/appointments`) LIVE?
 *
 * THE ONE PLACE THE TWO HALVES ARE COMBINED. Neither half is the answer:
 *
 *   • `bookingSettings.appointmentsEnabled` is the studio's TOGGLE — an
 *     intention, not a fact. On with nothing published, the picker renders an
 *     empty state and every visitor sent there finds nothing to book. ABSENT
 *     MEANS ON (see the field's doc comment in types/team.ts), which is exactly
 *     why the content half below has to be the strict one.
 *   • `active_public_surfaces.appointments` is the CONTENT — server-computed by
 *     `syncTeamPublicProfile` from the same inputs `listAvailability` reads
 *     (active hours × bookable appointment activities). It says something is
 *     behind the door, not that the studio wants the door open.
 *
 * They live on the same public_profile document and are read in the same read,
 * so composing them costs nothing — but they are refreshed by different writers
 * (the toggle by the settings form, the content by the team-doc sync), which is
 * exactly why the toggle is not stored inside the content flag. See
 * `ActivePublicSurfaces.appointments`.
 *
 * FAILS CLOSED, unlike `systemLinkIsLive` below: this answers "should I tell the
 * studio this surface is live", and a row claiming live over an empty picker is
 * worse than an absent one (UX-28).
 */
export function appointmentPickerLive(profile: {
  active_public_surfaces?: { appointments?: boolean }
  bookingSettings?: { appointmentsEnabled?: boolean }
} | undefined | null): boolean {
  if (!profile) return false
  return (
    profile.bookingSettings?.appointmentsEnabled !== false &&
    profile.active_public_surfaces?.appointments === true
  )
}

/**
 * Is a bio-link page link's destination actually live?
 *
 * THE SAME RULE THE WEBSITE HEADER ALREADY FOLLOWS (`resolveSiteSurfaceLinks`,
 * types/website.ts): a link to a surface that is not live is not offered. The
 * bio-link kept offering one, so unpublishing the website — or losing the
 * website plugin, or a Connect account that stops being chargeable — left the
 * studio's own front page linking into a dead end (UX-49).
 *
 * FAILS OPEN, deliberately, and in two ways:
 *   • an absent `active` map (the admin's live preview builds its team object
 *     from the FORM, which carries no surface flags) hides nothing;
 *   • an absent KEY means "not computed", not "off" — only an explicit `false`
 *     hides a link.
 * The flags are a denormalized mirror recomputed on every team write, so the
 * cost of being wrong is asymmetric: a briefly-stale mirror must never blank a
 * studio's links, while a surface that is genuinely down is stated as `false`
 * by `syncTeamPublicProfile` on the very write that took it down.
 *
 * The shop's four targets ride on `routableSurfaces` — see there for why a shop
 * with no till is still a destination.
 */
export function systemLinkIsLive(
  target: SystemLinkTarget,
  active: Partial<Record<PublicSurface, boolean>> | undefined
): boolean {
  if (!active) return true
  return routableSurfaces(active)[SYSTEM_LINK_SURFACE[target]] !== false
}

/** The set `?from=` accepts. Anything else is ignored rather than rejected. */
const PUBLIC_FROM_VALUES: readonly PublicFrom[] = [
  'bio-link',
  'site',
  'space',
  'booking',
  'shop',
  'signup',
  'documents',
  'kiosk',
  'checkout',
]

/** Narrow an untrusted `?from=` query value. */
export function parsePublicFrom(value: string | undefined | null): PublicFrom | undefined {
  if (!value) return undefined
  return (PUBLIC_FROM_VALUES as readonly string[]).includes(value)
    ? (value as PublicFrom)
    : undefined
}

// ─── Untrusted query-param parsers ───────────────────────────────────────────
//
// Everything the public routes read out of a URL is attacker-supplied: a malformed
// link can be sent to a victim, so the value has to be shaped BEFORE it reaches a
// Firestore path, an href, a date constructor or the render tree.
//
// These narrow to `undefined` rather than throwing — a bad param degrades the
// deep link, it never breaks the page.

/**
 * A Firestore document id used as a PATH SEGMENT.
 *
 * The important rule is no `/`: `doc(db, 'sessions', id, 'public_profile', id)`
 * splits its arguments on slashes, so an id like `a/b/c` silently addresses a
 * DIFFERENT document than the caller intended. Also rejects `.`/`..` (path
 * traversal), the reserved `__x__` form, and anything over Firestore's limit.
 */
export function parseDocId(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  if (value.length > 1500) return undefined
  if (value === '.' || value === '..') return undefined
  if (value.includes('/')) return undefined
  if (/^__.*__$/.test(value)) return undefined
  // Ids we mint are url-safe; anything else is not ours and has no business in a path.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  return value
}

/** A `YYYY-MM-DD` day key, rejecting impossible dates (`2026-13-45`). */
export function parseDateKey(value: string | undefined | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const probe = new Date(Date.UTC(y, m - 1, d))
  // Round-trip catches 2026-02-30 and friends, which Date silently rolls over.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
    return undefined
  return value
}

/** A tenant/course/activity slug appearing in a path segment. */
export function parseSlug(value: string | undefined | null): string | undefined {
  if (!value || value.length > 200) return undefined
  return /^[a-z0-9][a-z0-9-]*$/i.test(value) ? value : undefined
}

/** A positive integer query value (`?duration=`), bounded to keep it sane. */
export function parsePositiveInt(
  value: string | undefined | null,
  max = Number.MAX_SAFE_INTEGER
): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : undefined
}
