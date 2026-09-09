/* eslint-disable no-console */
/**
 * App Store Connect webhook — the push half of the app-store integration.
 *
 * Apple introduced these at WWDC25. Registered per app under App Store Connect
 * → Users and Access → Integrations → Webhooks, with a secret you choose and a
 * URL pointing at this function. Every delivery is signed:
 *
 *     x-apple-signature: hmacsha256=<hex of HMAC-SHA256(body, secret)>
 *
 * THE PREFIX IS PART OF THE HEADER. Comparing the whole header value against a
 * bare hex digest fails every time, silently and identically to a wrong secret —
 * which is the single most likely way this file gets broken by someone
 * "simplifying" it.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 * The daily ingest already reads every one of these facts. What the webhook buys
 * is LATENCY: a rejection is visible in seconds rather than up to a day. That is
 * the whole value, and it is why the handler does its work inline rather than
 * acknowledging first — Cloud Run may freeze the instance the moment the
 * response is sent, so anything deferred past `res.send` may simply not happen.
 *
 * ── IT DOES NOT WRITE `store_presence` ─────────────────────────────────────
 * That doc is a gauge with exactly ONE writer (the ingest, which replaces it
 * wholesale). A webhook that also merged into it would be clobbered on the next
 * sweep, and in the meantime the two could disagree — the card saying
 * READY_FOR_REVIEW while the event log said REJECTED is worse than no webhook
 * at all. So this records the event, then RE-RUNS the ingest, and the gauge
 * keeps its single writer.
 *
 * ── IT FAILS CLOSED ────────────────────────────────────────────────────────
 * No secret configured ⇒ 503, not "accept and warn". This is an endpoint on the
 * open internet that writes to Firestore; the setup-phase leniency in
 * `billing/handlePayrexxWebhook.ts` is not appropriate here, and a webhook
 * cannot be registered in ASC without a secret anyway, so the lenient branch
 * would only ever serve an attacker.
 *
 * Payload shape (JSON:API-ish), verified against Apple's documented examples:
 *   { data: { type, id, version, attributes: {...}, relationships: { instance } } }
 * `attributes` differ per event and are thin — a version-state change carries
 * `oldValue`/`newValue`/`timestamp` but NOT the version string, and beta
 * feedback carries only a timestamp. The detail comes from the ingest's API
 * calls, which is the other reason this re-runs it.
 */
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'
// Timestamp comes from the modular entry point, not `admin.firestore.Timestamp`.
// The latter is only populated once something else has loaded this submodule, so
// a file that happens not to import it gets `undefined` at RUNTIME — types and
// unit tests both pass, and the first real delivery 500s. That is exactly how
// this was found.
import { Timestamp } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import {
  ATTENTION_VERSION_STATES,
  STORE_EVENTS_COLLECTION,
  storeEventDocId,
  type StoreEventDoc,
  type StoreEventKind,
} from '@linyup/shared'
import { readSecret } from '../utils/secrets'
import { timingSafeEqualStr } from '../utils/secureCompare'
import { to } from '../utils/async'
import { runStoreIngest } from './ingest'

const SIGNATURE_HEADER = 'x-apple-signature'
const SIGNATURE_SCHEME = 'hmacsha256'

// ─── Signature ──────────────────────────────────────────────────────────────

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'bad_scheme' | 'mismatch'; detail?: string }

/**
 * Verifies Apple's `x-apple-signature` against the RAW body.
 *
 * Raw, not re-serialized: `JSON.stringify(req.body)` reorders nothing but does
 * change whitespace and unicode escaping, so an HMAC over it will not match.
 *
 * The scheme is required rather than tolerated. Accepting a bare hex digest
 * would mean accepting whatever scheme Apple might send next without knowing
 * what it hashed — so an unrecognised scheme is refused, and named in the
 * result so a format change is diagnosable instead of looking like a bad key.
 */
export function verifyAscSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' }

  const eq = header.indexOf('=')
  if (eq === -1) return { ok: false, reason: 'bad_scheme', detail: 'no scheme prefix' }

  const scheme = header.slice(0, eq).trim().toLowerCase()
  const provided = header.slice(eq + 1).trim()
  if (scheme !== SIGNATURE_SCHEME) {
    return { ok: false, reason: 'bad_scheme', detail: scheme }
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  // timingSafeEqualStr hashes both sides to a fixed width first, so it is safe
  // against a header of any length or casing-mangled hex.
  return timingSafeEqualStr(expected, provided.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'mismatch' }
}

// ─── Payload ────────────────────────────────────────────────────────────────

interface AscWebhookPayload {
  data?: {
    type?: string
    id?: string
    attributes?: Record<string, unknown>
    relationships?: { instance?: { data?: { type?: string; id?: string } } }
  }
}

export interface ParsedAscEvent {
  vendorType: string
  vendorId: string
  kind: StoreEventKind
  summary: string
  oldValue: string | null
  newValue: string | null
  instanceType: string | null
  instanceId: string | null
  /** Apple's timestamp when the payload carries one; else null (caller stamps). */
  occurredAtIso: string | null
  needsAttention: boolean
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * Classifies one delivery. Pure, so the whole mapping is unit-testable without
 * a request.
 *
 * Returns null only when the envelope is unusable (no `data.type` / `data.id`)
 * — an event type we do not recognise is NOT a failure. It is stored as `other`
 * with Apple's own type string, because a webhook that silently drops what it
 * has not been taught about is a webhook nobody can debug. That also means a
 * ping or test delivery is accepted and visible, whatever Apple calls it.
 */
export function parseAscWebhookEvent(body: unknown): ParsedAscEvent | null {
  const data = (body as AscWebhookPayload)?.data
  const vendorType = str(data?.type)
  const vendorId = str(data?.id)
  if (!vendorType || !vendorId) return null

  const attrs = data?.attributes ?? {}
  const instance = data?.relationships?.instance?.data
  const oldValue = str(attrs.oldValue)
  // A version change carries `newValue`; a build-upload change carries
  // `newState`. Same idea, two names — read both rather than picking one.
  const newValue = str(attrs.newValue) ?? str(attrs.newState)
  const occurredAtIso = str(attrs.timestamp)

  let kind: StoreEventKind = 'other'
  let summary = vendorType
  let needsAttention = false

  if (vendorType === 'appStoreVersionAppVersionStateUpdated') {
    kind = 'version_state'
    summary = oldValue
      ? `App Store version state: ${oldValue} → ${newValue ?? 'unknown'}`
      : `App Store version state: ${newValue ?? 'unknown'}`
    needsAttention = newValue != null && ATTENTION_VERSION_STATES.includes(newValue)
  } else if (vendorType === 'buildUploadStateUpdated') {
    kind = 'build_state'
    summary = `Build upload state: ${newValue ?? 'unknown'}`
  } else if (vendorType.startsWith('betaFeedback')) {
    kind = 'beta_feedback'
    // A crash submission and a screenshot submission are different enough to
    // say which — pre-launch these are the only words real users send us.
    summary = vendorType.includes('Crash')
      ? 'TestFlight crash feedback submitted'
      : 'TestFlight feedback submitted'
    needsAttention = true
  }

  return {
    vendorType,
    vendorId,
    kind,
    summary,
    oldValue,
    newValue,
    instanceType: str(instance?.type),
    instanceId: str(instance?.id),
    occurredAtIso,
    needsAttention,
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export const handleAppStoreWebhook = onRequest(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed')
      return
    }

    const secret = await readSecret('apple-asc-webhook-secret')
    if (!secret.ok) {
      // 503, not 401: we are not rejecting the caller, we cannot do our job.
      // Loud, because an unconfigured secret means every delivery is being lost.
      console.error(
        `[appstore-webhook] cannot verify — secret ${secret.reason}: ${secret.detail}`,
      )
      res.status(503).json({ ok: false, reason: 'not_configured' })
      return
    }

    // rawBody is what Apple signed. Falling back to a re-serialization would
    // produce a mismatch on every delivery, so an absent rawBody is refused
    // rather than papered over.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
    if (!rawBody) {
      console.error('[appstore-webhook] no rawBody on the request — cannot verify')
      res.status(400).json({ ok: false, reason: 'no_raw_body' })
      return
    }

    const header = req.headers[SIGNATURE_HEADER] as string | undefined
    const sig = verifyAscSignature(rawBody, header, secret.value)
    if (!sig.ok) {
      console.warn(
        `[appstore-webhook] signature rejected (${sig.reason}${sig.detail ? `: ${sig.detail}` : ''})`,
      )
      res.status(401).json({ ok: false, reason: sig.reason })
      return
    }

    const event = parseAscWebhookEvent(req.body)
    if (!event) {
      // Signed by Apple but shaped in a way we cannot read. 200 on purpose:
      // retrying will not help, and a retry storm on a payload we will never
      // understand is worse than one logged line.
      console.warn(
        `[appstore-webhook] unparseable payload: ${rawBody.toString('utf8').slice(0, 500)}`,
      )
      res.status(200).json({ ok: false, reason: 'unparseable' })
      return
    }

    const db = admin.firestore()
    const now = Timestamp.now()
    const occurredAt = event.occurredAtIso
      ? Timestamp.fromDate(new Date(event.occurredAtIso))
      : now

    const doc: StoreEventDoc = {
      platform: 'ios',
      vendor_type: event.vendorType,
      vendor_id: event.vendorId,
      kind: event.kind,
      summary: event.summary,
      old_value: event.oldValue,
      new_value: event.newValue,
      instance_type: event.instanceType,
      instance_id: event.instanceId,
      needs_attention: event.needsAttention,
      occurred_at: occurredAt as unknown as StoreEventDoc['occurred_at'],
      received_at: now as unknown as StoreEventDoc['received_at'],
    }

    // The event is written BEFORE the ingest runs, deliberately: the ingest
    // talks to Apple and can be slow or fail, and losing the notification
    // because the follow-up work did not go well would defeat the point.
    // Apple's `data.id` makes the doc id deterministic, so a redelivery
    // rewrites this row rather than duplicating it.
    const [writeErr] = await to(
      db
        .collection(STORE_EVENTS_COLLECTION)
        .doc(storeEventDocId('ios', event.vendorId))
        .set(doc),
    )
    if (writeErr) {
      // Ask Apple to try again — this one IS worth retrying.
      console.error('[appstore-webhook] event write failed:', writeErr)
      res.status(500).json({ ok: false, reason: 'write_failed' })
      return
    }

    console.log(`[appstore-webhook] ${event.vendorType} — ${event.summary}`)

    // Refresh the gauge through its ONE writer so the store card cannot
    // disagree with the log. `force` because the environment kill switch guards
    // the unattended cron, and a verified push from Apple is not that. Never
    // throws; a failure here leaves the event recorded and the card stale until
    // 05:30, which is the correct order of preference.
    const tally = await runStoreIngest('ios', { force: true })

    res.status(200).json({ ok: true, kind: event.kind, refreshed: tally.ok })
  },
)
