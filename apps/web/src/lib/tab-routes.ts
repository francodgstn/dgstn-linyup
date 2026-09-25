// Route registry + helpers for the open-pages tab strip (see OpenTabsContext /
// OpenTabsStrip). Only a curated set of routes become tabs: the high-frequency
// section pages (labeled from the Nav i18n namespace) and the entity detail
// pages (which self-register a rich label once their data loads). Everything
// else — settings, org admin, plugin config hubs — is intentionally not tracked
// so the strip stays focused on what a studio manager flips between.

import type { Route } from 'next'

export type EntityKind = 'contact' | 'session' | 'event' | 'section'

// Section pages: matched by exact path. labelKey is a key in the `Nav` message
// namespace (reused from NAV_SECTIONS in the sidebar, keep in sync).
const SECTION_ROUTES: { base: string; labelKey: string }[] = [
  { base: '/dashboard', labelKey: 'dashboard' },
  { base: '/schedule', labelKey: 'calendar' },
  { base: '/contacts', labelKey: 'contacts' },
  { base: '/bookings', labelKey: 'bookings' },
  { base: '/payments', labelKey: 'payments' },
  { base: '/automations', labelKey: 'automations' },
]

// Entity detail pages: matched as `<base>/<single-segment>` (the id). The pages
// themselves upgrade the label via useRegisterTab; until then a generic
// per-kind fallback is shown.
const ENTITY_ROUTES: { base: string; kind: EntityKind }[] = [
  { base: '/contacts', kind: 'contact' },
  { base: '/sessions', kind: 'session' },
  { base: '/events', kind: 'event' },
]

export interface ResolvedTab {
  /** Stable tab id = normalized path (no query), e.g. "/contacts/123". */
  id: string
  kind: EntityKind
  /** Present for section routes only — a `Nav` message key. */
  labelKey?: string
}

/** Strip the query string and any trailing slash — the stable tab identity. */
export function normalizeTabPath(pathname: string): string {
  const p = pathname.split('?')[0]
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * Decide whether a pathname is trackable as a tab. Entity detail routes win
 * over their section base (`/contacts/123` is a contact, `/contacts` is the
 * section). Returns null for untracked routes.
 */
export function resolveTabRoute(pathname: string): ResolvedTab | null {
  const id = normalizeTabPath(pathname)

  for (const r of ENTITY_ROUTES) {
    const prefix = `${r.base}/`
    if (id.startsWith(prefix)) {
      const rest = id.slice(prefix.length)
      // Exactly one segment after the base → an entity id (not a nested route).
      if (rest.length > 0 && !rest.includes('/')) return { id, kind: r.kind }
    }
  }

  for (const s of SECTION_ROUTES) {
    if (id === s.base) return { id, kind: 'section', labelKey: s.labelKey }
  }

  return null
}

/**
 * Human label for a route that isn't in the tracked set (e.g. Settings, an
 * Offer page): title-case its last path segment. The active tab follows the
 * user everywhere, so it needs a readable label for any page.
 */
export function fallbackLabelFromPath(pathname: string): string {
  const segs = normalizeTabPath(pathname).split('/').filter(Boolean)
  const last = segs[segs.length - 1] ?? 'home'
  return last
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * The single place the `typedRoutes` cast lives for dynamic tab hrefs. Stored
 * tab targets are entity URLs that aren't statically enumerable, so they can't
 * satisfy the generated `Route` union without a cast.
 */
export function toRoute(href: string): Route {
  return href as Route
}
