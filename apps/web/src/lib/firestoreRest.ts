import 'server-only'

import { restEndpointBase } from './publicMetaRest'

// A general Firestore REST decoder, for server components that need MORE than
// the handful of string fields `publicMetaRest.ts` picks out for
// `generateMetadata`. Same reason that file exists at all: inside the Next
// server runtime the Firebase WEB SDK's streamed query responses come back
// EMPTY (fetch-stream buffering), so any server-side Firestore read has to go
// over REST instead — see CLAUDE.md "Next.js Firebase server reads".
//
// It reads ONLY world-readable data (the caller picks the query/path; the
// public Firestore rules are what actually enforce that), sends no
// credentials of its own, and never throws INTO a page — every failure is
// logged and degrades to `null`, exactly like `publicMetaRest.ts`.

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID

/** The Firestore REST wire shape of one field (`Document.fields[key]`). Only
 *  the members below are ever produced by the emulator or production — an
 *  unrecognised one decodes to `null` rather than throwing. */
interface RestFieldValue {
  stringValue?: string
  integerValue?: string
  doubleValue?: number
  booleanValue?: boolean
  nullValue?: null
  mapValue?: { fields?: Record<string, RestFieldValue> }
  arrayValue?: { values?: RestFieldValue[] }
  referenceValue?: string
  geoPointValue?: { latitude: number; longitude: number }
  bytesValue?: string
  timestampValue?: string
}

/**
 * A Firestore Timestamp, carried through the server → client JSON boundary as
 * this SERIALIZABLE marker (a real `Timestamp` instance is not JSON — it would
 * silently lose its prototype crossing into a Client Component prop). Never
 * read `__ts` directly outside `restTimestamps.ts` — call `reviveTimestamps`
 * at the point of use instead.
 */
export interface RestTimestampMarker {
  __ts: string
}

export type DecodedRestValue =
  | string
  | number
  | boolean
  | null
  | RestTimestampMarker
  | { latitude: number; longitude: number }
  | DecodedRestValue[]
  | { [key: string]: DecodedRestValue }

function decodeValue(value: RestFieldValue): DecodedRestValue {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.integerValue !== undefined) return Number(value.integerValue)
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.booleanValue !== undefined) return value.booleanValue
  if (value.nullValue !== undefined) return null
  if (value.timestampValue !== undefined) return { __ts: value.timestampValue }
  if (value.referenceValue !== undefined) return value.referenceValue
  if (value.geoPointValue !== undefined) return value.geoPointValue
  if (value.bytesValue !== undefined) return value.bytesValue
  if (value.mapValue !== undefined) return decodeRestFields(value.mapValue.fields)
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(decodeValue)
  return null
}

/**
 * Decode a Firestore REST `fields` map into plain JSON, deep. Every
 * `timestampValue` becomes a `{ __ts }` marker (see `RestTimestampMarker`) so
 * the result stays JSON-serializable across the server/client boundary;
 * `reviveTimestamps` (restTimestamps.ts, client-safe) turns those back into
 * real `Timestamp`s at the point of use.
 */
export function decodeRestFields(
  fields: Record<string, RestFieldValue> | undefined
): Record<string, DecodedRestValue> {
  const out: Record<string, DecodedRestValue> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = decodeValue(value)
  }
  return out
}

export interface RestDocument {
  id: string
  fields: Record<string, DecodedRestValue>
}

/**
 * GET one document by path, relative to the database root (e.g.
 * `site_published/{teamId}/pages/{pageId}`). `null` on a 404 or any failure —
 * logged, never thrown into a page.
 */
export async function restGetDocument(path: string): Promise<RestDocument | null> {
  try {
    const { base, key } = restEndpointBase()
    const url = `${base}/projects/${PROJECT_ID}/databases/(default)/documents/${path}` + (key ? `?key=${key}` : '')
    const res = await fetch(url, { cache: 'no-store' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`document GET HTTP ${res.status}`)
    const body = (await res.json()) as { name?: string; fields?: Record<string, RestFieldValue> }
    if (!body.name) return null
    const id = body.name.split('/').pop() ?? ''
    return { id, fields: decodeRestFields(body.fields) }
  } catch (e) {
    console.error('[firestore-rest] document GET failed:', path, e)
    return null
  }
}

export interface RestQueryDocument {
  /** Full resource name, `projects/.../documents/{collectionPath}/{id}`. */
  name: string
  id: string
  /**
   * The id of the document's PARENT DOCUMENT — for a collection-group hit on a
   * subcollection this is the owning document's id (e.g. the `teamId` that
   * owns a `public_profile` subcollection doc: `.../teams/{teamId}/
   * public_profile/{profileId}` → `parentId` is `teamId`). For a query against
   * a TOP-LEVEL collection this is not a meaningful document id (it lands on
   * the literal `documents` path segment) — callers querying a top-level
   * collection should read `id` instead.
   */
  parentId: string | undefined
  fields: Record<string, DecodedRestValue>
}

/**
 * Run a structured query and return the FIRST result, fully decoded, or
 * `null` (no match, or any failure — logged, never thrown into a page).
 */
export async function restRunQuery(structuredQuery: unknown): Promise<RestQueryDocument | null> {
  try {
    const { base, key } = restEndpointBase()
    const url = `${base}/projects/${PROJECT_ID}/databases/(default)/documents:runQuery` + (key ? `?key=${key}` : '')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`runQuery HTTP ${res.status}`)
    const rows = (await res.json()) as { document?: { name?: string; fields?: Record<string, RestFieldValue> } }[]
    const document = rows.find((r) => r.document)?.document
    if (!document?.name) return null
    const parts = document.name.split('/')
    const id = parts[parts.length - 1]
    const parentId = parts.length >= 3 ? parts[parts.length - 3] : undefined
    return { name: document.name, id, parentId, fields: decodeRestFields(document.fields) }
  } catch (e) {
    console.error('[firestore-rest] runQuery failed:', e)
    return null
  }
}
