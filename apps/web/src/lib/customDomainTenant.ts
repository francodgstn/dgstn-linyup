import 'server-only'
import {
  PUBLIC_DOMAINS_COLLECTION,
  TEAMS_COLLECTION,
  ORG_SITE_PUBLISHED_COLLECTION,
  USER_PUBLIC_PROFILE_SUBCOLLECTION,
} from '@linyup/shared'
import { resolveSiteLanguage } from './siteLanguage'
import { emulatorFirestoreHost } from './publicMetaRest'

/**
 * Resolves an incoming custom hostname to the tenant it belongs to.
 *
 * Two document GETs BY KNOWN ID — the cheapest read Firestore has, needing no
 * composite index and no query planner:
 *
 *   1. `public_domains/{hostname}`            → which tenant claimed this host
 *   2. `teams/{id}/public_profile/{id}` → that studio's slug, or
 *      `org_site_published/{id}` → that organization's (see below)
 *
 * **Two reads rather than one, deliberately.** The slug could have been
 * denormalised onto the claim to save a hop, but a team's slug is EDITABLE
 * (Settings → Team), so that copy would go stale the moment somebody renamed
 * theirs — and the symptom is a custom domain quietly serving a 404 while every
 * record involved looks correct. The public profile is the slug's owner, so it
 * is asked directly.
 *
 * Firestore REST, not the web SDK: SDK queries return empty in the Next server
 * (see `docs/` and the note in `lib/publicQueryError.ts`'s neighbors), and
 * middleware has no admin credentials. Both documents are world-readable — the
 * profile already was, and `public_domains` allows `get` but denies `list` so a
 * hostname can be resolved by anyone who already has it while the customer list
 * stays unenumerable.
 */

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
const API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY

export interface CustomDomainTenant {
  slug: string
  teamId: string
  scope: 'team' | 'org'
  /**
   * The tenant's own language, used when the visitor asked for no locale.
   *
   * A studio's own domain defaults to the STUDIO's language rather than the
   * browser's — `book.hmdbasel.ch/` is a Basel dojo's front door, and answering
   * it in English because a visitor's laptop is set that way is the wrong
   * default for a vanity domain. An explicit `/de/…` still wins.
   */
  language: string
  /**
   * The studio's WEBSITE owns the domain's root: its default public surface is
   * the site and the site is live. Then `/` is the site's home and every path
   * that is not another surface is a page of the site — see
   * `toTenantInternalPath`'s `siteAtRoot`. Team only: an organization's site
   * is always its root, so this is false for an org.
   */
  siteAtRoot: boolean
}

/**
 * In-process cache. App Hosting instances are long-lived, so this is one pair of
 * reads per instance per hostname rather than per request.
 *
 * The TTL is what bounds staleness after a slug rename or a disconnected domain
 * — five minutes of a stale mapping is a wrong page for a few visitors, where no
 * expiry at all would need an instance restart to correct. NEGATIVE results are
 * cached too, and for the same reason inverted: without that, every request to a
 * hostname that is not a tenant (a probe, a stale DNS record someone forgot)
 * costs two Firestore reads.
 */
const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { value: CustomDomainTenant | null; expires: number }>()

const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true'

function restDocUrl(path: string): string {
  // The emulator when the app runs against one — otherwise a custom domain can
  // never be exercised locally, and the mapping ships untried.
  const host = USE_EMULATORS
    ? `http://${emulatorFirestoreHost()}/v1`
    : 'https://firestore.googleapis.com/v1'
  const base = `${host}/projects/${PROJECT_ID}/databases/(default)/documents/${path}`
  return API_KEY && !USE_EMULATORS ? `${base}?key=${API_KEY}` : base
}

type RestFields = Record<string, { stringValue?: string; booleanValue?: boolean; mapValue?: { fields?: RestFields } }>

/** Firestore REST wraps every value in a type tag; this reads the string ones. */
function str(fields: RestFields | undefined, key: string): string | undefined {
  return fields?.[key]?.stringValue
}

async function fetchDoc(path: string): Promise<RestFields | null> {
  const res = await fetch(restDocUrl(path), { cache: 'no-store' })
  if (!res.ok) return null
  const body = (await res.json()) as { fields?: RestFields }
  return body.fields ?? null
}

export async function resolveCustomDomainTenant(
  hostname: string
): Promise<CustomDomainTenant | null> {
  const host = hostname.toLowerCase()
  const hit = cache.get(host)
  if (hit && hit.expires > Date.now()) return hit.value

  let value: CustomDomainTenant | null = null
  try {
    const claim = await fetchDoc(`${PUBLIC_DOMAINS_COLLECTION}/${encodeURIComponent(host)}`)
    const entityId = str(claim ?? undefined, 'entityId')
    const scope = str(claim ?? undefined, 'scope') === 'org' ? 'org' : 'team'

    if (entityId && scope === 'org') {
      // An ORGANIZATION has no public_profile mirror — nothing writes one — so
      // its slug comes from its published website, which is world-readable,
      // carries the slug, and is what its domain serves anyway: `/public/org/
      // {slug}` IS the site. No published site ⇒ nothing to serve ⇒ not a
      // tenant domain. One read, and the site's language comes with it.
      const site = await fetchDoc(`${ORG_SITE_PUBLISHED_COLLECTION}/${entityId}`)
      const slug = str(site ?? undefined, 'slug')
      const meta = site?.meta?.mapValue?.fields
      const manifest = site?.i18n?.mapValue?.fields
      const language = str(meta, 'language') || str(manifest, 'srcLang') || 'en'
      if (slug) value = { slug, teamId: entityId, scope, language, siteAtRoot: false }
    } else if (entityId) {
      const profile = await fetchDoc(
        `${TEAMS_COLLECTION}/${entityId}/${USER_PUBLIC_PROFILE_SUBCOLLECTION}/${entityId}`
      )
      const slug = str(profile ?? undefined, 'slug')
      // The WEBSITE's own language wins over the team's: the domain is the
      // site's front door, and a studio may work in one language and publish
      // its site in another (SiteMeta.language).
      const siteLanguage = slug ? await resolveSiteLanguage(slug) : null
      const language = siteLanguage || str(profile ?? undefined, 'language') || 'en'
      // Only when the site is the default AND live — the root page's own gate.
      const siteAtRoot =
        str(profile ?? undefined, 'default_public_surface') === 'site' &&
        profile?.active_public_surfaces?.mapValue?.fields?.site?.booleanValue === true
      if (slug) value = { slug, teamId: entityId, scope, language, siteAtRoot }
    }
  } catch {
    // A resolution failure must not 500 the request — it falls through as "not a
    // tenant domain", which serves the app's own routes rather than a stack
    // trace. Caching that miss for the full TTL would turn a blip into five
    // minutes of wrong pages, so a THROWN failure is deliberately not cached.
    return null
  }

  cache.set(host, { value, expires: Date.now() + TTL_MS })
  return value
}
