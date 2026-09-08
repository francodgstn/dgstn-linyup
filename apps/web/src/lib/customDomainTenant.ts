import 'server-only'
import {
  PUBLIC_DOMAINS_COLLECTION,
  TEAMS_COLLECTION,
  ORGANIZATIONS_COLLECTION,
  USER_PUBLIC_PROFILE_SUBCOLLECTION,
} from '@linyup/shared'

/**
 * Resolves an incoming custom hostname to the tenant it belongs to.
 *
 * Two document GETs BY KNOWN ID — the cheapest read Firestore has, needing no
 * composite index and no query planner:
 *
 *   1. `public_domains/{hostname}`            → which tenant claimed this host
 *   2. `{teams|organizations}/{id}/public_profile/{id}` → that tenant's slug
 *
 * **Two reads rather than one, deliberately.** The slug could have been
 * denormalised onto the claim to save a hop, but a team's slug is EDITABLE
 * (Settings → Team), so that copy would go stale the moment somebody renamed
 * theirs — and the symptom is a custom domain quietly serving a 404 while every
 * record involved looks correct. The public profile is the slug's owner, so it
 * is asked directly.
 *
 * Firestore REST, not the web SDK: SDK queries return empty in the Next server
 * (see `docs/` and the note in `lib/publicQueryError.ts`'s neighbours), and
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

function restDocUrl(path: string): string {
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`
  return API_KEY ? `${base}?key=${API_KEY}` : base
}

/** Firestore REST wraps every value in a type tag; this reads the string ones. */
function str(fields: Record<string, { stringValue?: string }> | undefined, key: string): string | undefined {
  return fields?.[key]?.stringValue
}

async function fetchDoc(path: string): Promise<Record<string, { stringValue?: string }> | null> {
  const res = await fetch(restDocUrl(path), { cache: 'no-store' })
  if (!res.ok) return null
  const body = (await res.json()) as { fields?: Record<string, { stringValue?: string }> }
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

    if (entityId) {
      const collection = scope === 'org' ? ORGANIZATIONS_COLLECTION : TEAMS_COLLECTION
      const profile = await fetchDoc(
        `${collection}/${entityId}/${USER_PUBLIC_PROFILE_SUBCOLLECTION}/${entityId}`
      )
      const slug = str(profile ?? undefined, 'slug')
      const language = str(profile ?? undefined, 'language') || 'en'
      if (slug) value = { slug, teamId: entityId, scope, language }
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
