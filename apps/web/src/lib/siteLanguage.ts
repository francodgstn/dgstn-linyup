import 'server-only'
import { ORG_SITE_PUBLISHED_COLLECTION, SITE_PUBLISHED_COLLECTION } from '@linyup/shared'
import { restEndpointBase, restMap, restString, type RestValue } from './publicMetaRest'

// ─── The language a website is written in ─────────────────────────────────────
//
// `SiteMeta.language` — the studio's choice for its PUBLIC SITE, which may
// differ from the language it runs its back office in. A visitor whose URL
// names no language gets this one (proxy.ts rewrites to it), so the page and
// the language switcher agree instead of the switcher claiming English over
// German copy.
//
// One REST read per slug per instance, cached like the custom-domain lookup —
// it runs in middleware, on every unprefixed site request.
//
// `scope` picks whose site: a studio's (`site_published`) or an organisation's
// (`org_site_published`) — both carry the slug and `meta.language`.

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { value: string | null; expires: number }>()

export async function resolveSiteLanguage(slug: string, scope: 'team' | 'org' = 'team'): Promise<string | null> {
  const key = `${scope}:${slug.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  let value: string | null = null
  try {
    const { base, key: apiKey } = restEndpointBase()
    const url =
      `${base}/projects/${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery` +
      (apiKey ? `?key=${apiKey}` : '')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: scope === 'org' ? ORG_SITE_PUBLISHED_COLLECTION : SITE_PUBLISHED_COLLECTION }],
          where: {
            fieldFilter: { field: { fieldPath: 'slug' }, op: 'EQUAL', value: { stringValue: slug } },
          },
          select: { fields: [{ fieldPath: 'meta.language' }] },
          limit: 1,
        },
      }),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`runQuery HTTP ${res.status}`)
    const rows = (await res.json()) as { document?: { fields?: Record<string, RestValue> } }[]
    const fields = rows.find((r) => r.document)?.document?.fields
    value = (fields && restString(restMap(fields.meta).language)) ?? null
  } catch {
    // A failed read must not 500 a page request — it falls through as "no
    // language of its own", which is today's behaviour. A THROWN failure is
    // deliberately not cached, so a blip does not last the whole TTL.
    return null
  }

  cache.set(key, { value, expires: Date.now() + TTL_MS })
  return value
}
