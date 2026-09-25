// Server-side reads of PUBLIC tenant data, for `generateMetadata` only.
//
// WHY REST AND NOT THE FIREBASE WEB SDK. Inside the Next server runtime the
// web SDK's streamed query responses come back EMPTY (fetch-stream buffering),
// so a `getDocs` in `generateMetadata` silently yields nothing and every page
// title falls back to the app-wide default. `site/page.tsx` hit this first and
// solved it the same way; this module is that mechanism, lifted so the bio-link
// root (UX-31) does not carry a second private copy of it.
//
// It reads ONLY world-readable data — the `public_profile` collection group,
// which `firestore.rules` allows any unauthenticated client to read — so it
// sends no credentials and is safe to run for any visitor.

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true'

export interface RestValue {
  stringValue?: string
  booleanValue?: boolean
  mapValue?: { fields?: Record<string, RestValue> }
  arrayValue?: { values?: RestValue[] }
}
export const restString = (v?: RestValue) => v?.stringValue
export const restMap = (v?: RestValue) => v?.mapValue?.fields ?? {}
export const restArray = (v?: RestValue) => v?.arrayValue?.values ?? []

/**
 * The Firestore emulator a SERVER-side read talks to. The port comes from the
 * same variable the browser SDK reads, so a checkout on another local-env slot
 * (scripts/local-env.mjs) reads its OWN emulator: a bare `localhost:8080`
 * fallback sent a worktree's server renders to slot 0's emulator, which is
 * another checkout's data, or nothing, and every public page then rendered
 * from the wrong tenant data or none.
 */
export function emulatorFirestoreHost(): string {
  return (
    process.env.FIRESTORE_EMULATOR_HOST ||
    `localhost:${process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT || '8080'}`
  )
}

// Exported so `firestoreRest.ts` (the general REST decoder) reuses the same
// emulator/API-key endpoint logic instead of a second copy.
export function restEndpointBase(): { base: string; key?: string } {
  const base = USE_EMULATORS
    ? `http://${emulatorFirestoreHost()}/v1`
    : 'https://firestore.googleapis.com/v1'
  return { base, key: USE_EMULATORS ? undefined : process.env.NEXT_PUBLIC_FIREBASE_API_KEY }
}

/** One `documents:runQuery` against the public Firestore REST endpoint. */
async function runQuery(structuredQuery: unknown): Promise<Record<string, RestValue> | null> {
  const { base, key } = restEndpointBase()
  const url =
    `${base}/projects/${PROJECT_ID}/databases/(default)/documents:runQuery` + (key ? `?key=${key}` : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`runQuery HTTP ${res.status}`)
  const rows = (await res.json()) as { document?: { fields?: Record<string, RestValue> } }[]
  return rows.find((r) => r.document)?.document?.fields ?? null
}

/**
 * One document GET by path relative to the database root, e.g.
 * `site_published/{teamId}__i18n_{locale}` — the i18n sidecar doc id
 * (`siteI18nDocId`, @linyup/shared). Returns `null` when the document does not
 * exist (a sidecar that was never generated, or a stale locale) rather than
 * throwing, so a caller degrades to the base language exactly like a
 * stale/absent translation unit would.
 */
export async function fetchDocumentFields(path: string): Promise<Record<string, RestValue> | null> {
  try {
    const { base, key } = restEndpointBase()
    const url = `${base}/projects/${PROJECT_ID}/databases/(default)/documents/${path}` + (key ? `?key=${key}` : '')
    const res = await fetch(url, { cache: 'no-store' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`document GET HTTP ${res.status}`)
    const body = (await res.json()) as { fields?: Record<string, RestValue> }
    return body.fields ?? null
  } catch (e) {
    console.error('[public-meta] document fetch failed:', e)
    return null
  }
}

export interface TeamPublicMeta {
  name?: string
  description?: string
  profileImage?: string
  heroImage?: string
}

/**
 * The team's public profile by slug — the SAME collection-group query every
 * public surface uses at runtime (`public_profile` where slug == … and type ==
 * 'team'), so it needs no index the app does not already have.
 */
export async function fetchTeamPublicMeta(slug: string): Promise<TeamPublicMeta | null> {
  try {
    const fields = await runQuery({
      from: [{ collectionId: 'public_profile', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'slug' }, op: 'EQUAL', value: { stringValue: slug } } },
            { fieldFilter: { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: 'team' } } },
          ],
        },
      },
      limit: 1,
    })
    if (!fields) return null
    return {
      name: restString(fields.name),
      description: restString(fields.description),
      profileImage: restString(fields.profileImage),
      heroImage: restString(fields.heroImage),
    }
  } catch (e) {
    // The preview falls back to the generic title, but never silently — a broken
    // server-side read otherwise masquerades as a missing team.
    console.error('[public-meta] team profile fetch failed:', e)
    return null
  }
}
