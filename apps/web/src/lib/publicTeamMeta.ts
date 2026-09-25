// Server-side reads of the world-readable `public_profile` mirrors, for
// `generateMetadata`.
//
// ── WHY REST AND NOT THE FIREBASE SDK ────────────────────────────────────────
// Inside the Next server runtime the web SDK's streamed query responses come
// back EMPTY (fetch-stream buffering), so a page's metadata would silently
// render as if the team did not exist. `site/page.tsx` hit this first and worked
// around it with a single unauthenticated REST read; this is the same move,
// generalised, for the collection-group lookups the public document pages need.
// A silent empty result matters more here than a wrong title: `noindex` is
// decided from this read, and "we could not tell" must not read as "indexable".
//
// Rules-wise these are public documents (`/{path=**}/public_profile/{id}` grants
// an unauthenticated read), so no credentials are involved.

import { emulatorFirestoreHost } from './publicMetaRest'

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true'

interface RestValue {
  stringValue?: string
  booleanValue?: boolean
  integerValue?: string
}
type RestFields = Record<string, RestValue>
interface RestRow {
  document?: { name?: string; fields?: RestFields }
}

const str = (v?: RestValue) => v?.stringValue
const bool = (v?: RestValue) => v?.booleanValue === true

function eq(field: string, value: string) {
  return { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } }
}

async function runQuery(filters: object[], limit = 1): Promise<RestRow[]> {
  const base = USE_EMULATORS
    ? `http://${emulatorFirestoreHost()}/v1`
    : 'https://firestore.googleapis.com/v1'
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  const url =
    `${base}/projects/${PROJECT_ID}/databases/(default)/documents:runQuery` +
    (!USE_EMULATORS && key ? `?key=${key}` : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        // allDescendants — the mirrors live in per-entity subcollections, so the
        // lookup is the same collection-group query the client surfaces run.
        from: [{ collectionId: 'public_profile', allDescendants: true }],
        where: { compositeFilter: { op: 'AND', filters } },
        limit,
      },
    }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`runQuery HTTP ${res.status}`)
  return (await res.json()) as RestRow[]
}

export interface PublicTeamMeta {
  teamId: string
  name: string
  /**
   * Whether this team's public pages may be indexed by search engines.
   *
   * FAILS CLOSED TO `false`: an absent field — every mirror written before the
   * flag existed, and any team whose sync has not re-run — reads as
   * not-indexable. The wrong direction here is the expensive one (a spam page
   * that got crawled cannot be un-crawled), and the repair is a single team
   * write, which happens on any settings change.
   */
  indexable: boolean
}

export async function fetchPublicTeamMeta(slug: string): Promise<PublicTeamMeta | null> {
  try {
    const rows = await runQuery([eq('slug', slug), eq('type', 'team')])
    const doc = rows.find((r) => r.document)?.document
    if (!doc?.fields) return null
    // .../documents/teams/{teamId}/public_profile/{teamId}
    const parts = (doc.name ?? '').split('/')
    const teamId = parts[parts.length - 3] ?? ''
    return {
      teamId,
      name: str(doc.fields.name) ?? slug,
      indexable: bool(doc.fields.public_pages_indexable),
    }
  } catch (e) {
    // Never silently: a broken server read otherwise masquerades as a missing
    // team, and the page would fall back to a generic title with no explanation.
    console.error('[public-meta] team lookup failed:', e)
    return null
  }
}

export interface PublicDocumentMeta {
  title: string
  summary: string | null
}

export async function fetchPublicDocumentMeta(
  teamId: string,
  documentSlug: string
): Promise<PublicDocumentMeta | null> {
  try {
    const rows = await runQuery([
      eq('teamId', teamId),
      eq('type', 'document'),
      eq('slug', documentSlug),
    ])
    const fields = rows.find((r) => r.document)?.document?.fields
    if (!fields) return null
    return { title: str(fields.title) ?? documentSlug, summary: str(fields.summary) ?? null }
  } catch (e) {
    console.error('[public-meta] document lookup failed:', e)
    return null
  }
}

/**
 * The `robots` block for a public tenant page.
 *
 * D2 de-gated Documents completely — public pages included — which hands every
 * free signup a publishing surface on a Linyup domain, and with it an SEO-spam
 * and reputation vector. The mitigation gates INDEXABILITY, NOT EXISTENCE: the
 * page renders identically for everyone and is shareable by link and QR; it just
 * carries `noindex` until the studio is on a paid, active plan. Nothing has to be
 * withdrawn later, which is what made de-gating completely safe to choose.
 */
export function robotsFor(meta: PublicTeamMeta | null) {
  return meta?.indexable
    ? undefined // inherit the app default (indexable)
    : { index: false, follow: false, googleBot: { index: false, follow: false } }
}
