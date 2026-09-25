/**
 * Custom public domains — the studio-facing callables.
 *
 * A studio serves its public surfaces from a hostname it owns
 * (`book.theirdojo.ch`) instead of `linyup.com/public/{slug}`. Modeled closely
 * on the BYO *email* domain pair (`mail/domainAuth.ts`), which solved the same
 * shape of problem first: register → show DNS → poll → fall back safely. The
 * access guards are literally shared with it.
 *
 * Design: docs/custom-domains.md.
 */

/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { FieldValue } from 'firebase-admin/firestore'
import {
  ORGANIZATIONS_COLLECTION,
  PUBLIC_DOMAINS_COLLECTION,
  PUBLIC_DOMAIN_INTEGRATION_DOC,
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  CUSTOM_DOMAIN_ENV_REFUSAL,
  customDomainsAvailable,
  planHasFeature,
  type PublicDomainConfig,
  type PublicDomainStatus,
  type SaasPlan,
} from '@linyup/shared'
import { assertAccess, validateScope } from '../mail/domainAuth'
import type { SenderScope } from '../mail/senderConfig'
import {
  CLOUDFLARE_CNAME_TARGET,
  CloudflareError,
  createCustomHostname,
  deleteCustomHostname,
  firstError,
  getCustomHostname,
  toPublicDomainStatus,
} from './cloudflare'

// ─── validation ──────────────────────────────────────────────────────────────

const HOSTNAME_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/**
 * Hostnames a tenant may never claim. Without this a studio could register
 * `app.linyup.com` as "their" domain and Cloudflare would happily start serving
 * their studio there — the platform's own surfaces are not tenant real estate.
 */
function isReserved(hostname: string): boolean {
  return hostname === 'linyup.com' || hostname.endsWith('.linyup.com')
}

function normalizeHostname(input: unknown): string {
  if (typeof input !== 'string') throw new HttpsError('invalid-argument', 'hostname is required')
  const hostname = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')

  if (!HOSTNAME_RE.test(hostname)) {
    throw new HttpsError('invalid-argument', 'Enter a valid domain (e.g. book.theirdojo.ch)')
  }
  if (isReserved(hostname)) {
    throw new HttpsError('invalid-argument', 'That domain belongs to Linyup. Use a domain you own.')
  }
  // Subdomain only, v1. An apex cannot CNAME, and most registrars — Swiss ones
  // especially — offer no ALIAS/ANAME to work around it. Two labels is a
  // definite apex; three or more is *probably* a subdomain (a `theirdojo.co.uk`
  // apex slips through, and fails informatively at their registrar instead).
  if (hostname.split('.').length < 3) {
    throw new HttpsError(
      'invalid-argument',
      'Use a subdomain such as book.theirdojo.ch — a root domain cannot be pointed at us.',
    )
  }
  return hostname
}

/**
 * Paid plans only, mirroring BYO email sending — a DOMAIN is the studio's own
 * identity, which is a different lever from removing Linyup branding (Studio+).
 *
 * The tier is read from `PLAN_FEATURES` rather than restated here, because it is
 * now ADVERTISED: the landing page's comparison table renders the same
 * `custom_domain` feature, and the studio card derives its upgrade prompt from
 * it too. Three surfaces, one place to change the tier.
 */
async function assertPlanEligible(scope: SenderScope, entityId: string): Promise<void> {
  if (scope === 'org') return // an org is inherently a paid tier
  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(entityId).get()
  const plan = snap.data()?.plan as SaasPlan | undefined
  if (!plan || !planHasFeature(plan, 'custom_domain')) {
    throw new HttpsError('failed-precondition', 'A custom domain requires a paid plan.')
  }
}

// ─── refs ────────────────────────────────────────────────────────────────────

function configRef(scope: SenderScope, entityId: string) {
  const col = scope === 'team' ? TEAMS_COLLECTION : ORGANIZATIONS_COLLECTION
  return admin
    .firestore()
    .collection(col)
    .doc(entityId)
    .collection(TEAM_INTEGRATIONS_SUBCOLLECTION)
    .doc(PUBLIC_DOMAIN_INTEGRATION_DOC)
}

function claimRef(hostname: string) {
  return admin.firestore().collection(PUBLIC_DOMAINS_COLLECTION).doc(hostname)
}

async function readConfig(scope: SenderScope, entityId: string): Promise<PublicDomainConfig | null> {
  const snap = await configRef(scope, entityId).get()
  return snap.exists ? (snap.data() as PublicDomainConfig) : null
}

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required')
  return uid
}

/**
 * Production only — see `customDomainsAvailable` for why (one zone has one
 * fallback origin, so a non-prod zone would need its own domain, token and
 * Worker).
 *
 * Enforced HERE and not merely hidden in the UI, because without it a sandbox
 * tenant reaches Cloudflare and registers a hostname on the PRODUCTION zone —
 * the token and zone id are per-environment params, but "unset" is a
 * misconfiguration away from "set to prod's". A settings form is not a boundary.
 *
 * `register` only. `check` and `remove` stay open so a domain connected before
 * a project was reclassified can still be inspected and cleaned up rather than
 * being stranded by the very guard meant to prevent strandings.
 */
function assertCustomDomainsEnabled(): void {
  if (!customDomainsAvailable(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT)) {
    throw new HttpsError(
      'failed-precondition',
      CUSTOM_DOMAIN_ENV_REFUSAL,
    )
  }
}

// ─── callables ───────────────────────────────────────────────────────────────

/**
 * Registers the studio's hostname at Cloudflare and returns the ONE DNS record
 * they must add. The uniqueness claim is taken FIRST, in a transaction, and
 * released if Cloudflare then refuses — a claim outliving a failed registration
 * would lock a hostname nobody owns, and the studio's only recourse would be
 * support.
 */
export const registerPublicDomain = onCall(async (request) => {
  const uid = requireAuth(request.auth?.uid)
  assertCustomDomainsEnabled()
  const { scope, entityId, hostname: raw } = request.data ?? {}
  validateScope(scope, entityId)
  await assertAccess(uid, scope, entityId)
  await assertPlanEligible(scope, entityId)

  const hostname = normalizeHostname(raw)

  // One tenant, one primary hostname. Aliases are a later, additive feature —
  // see PublicDomainConfig.hostname.
  const existing = await readConfig(scope, entityId)
  if (existing && existing.hostname !== hostname) {
    throw new HttpsError(
      'failed-precondition',
      `This ${scope === 'org' ? 'organisation' : 'studio'} already uses ${existing.hostname}. Remove it first.`,
    )
  }

  const db = admin.firestore()
  await db.runTransaction(async (tx) => {
    const claim = await tx.get(claimRef(hostname))
    if (claim.exists) {
      const owner = claim.data() as { scope?: string; entityId?: string }
      if (owner.scope !== scope || owner.entityId !== entityId) {
        throw new HttpsError('already-exists', 'That domain is already connected to another account.')
      }
      return // ours already — a retry, not a second claim
    }
    tx.set(claimRef(hostname), {
      hostname,
      scope,
      entityId,
      cf_hostname_id: '',
      created_at: FieldValue.serverTimestamp(),
    })
  })

  let cf
  try {
    cf = await createCustomHostname(hostname)
  } catch (err) {
    await claimRef(hostname).delete().catch(() => undefined)
    const message = err instanceof CloudflareError ? err.message : 'Could not register the domain'
    console.error('registerPublicDomain: Cloudflare createCustomHostname failed:', err)
    throw new HttpsError('internal', message)
  }

  const dnsRecord = {
    type: 'CNAME' as const,
    host: hostname.split('.')[0],
    value: CLOUDFLARE_CNAME_TARGET.value(),
  }

  await claimRef(hostname).set({ cf_hostname_id: cf.id }, { merge: true })
  await configRef(scope, entityId).set(
    {
      type: 'public_domain',
      hostname,
      cf_hostname_id: cf.id,
      status: toPublicDomainStatus(cf) as PublicDomainStatus,
      dns_record: dnsRecord,
      ssl_status: cf.ssl?.status ?? null,
      error: null,
      last_checked_at: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return { hostname, dnsRecord, status: toPublicDomainStatus(cf) }
})

/**
 * Polls Cloudflare and updates the stored status. Mounted on a button AND on the
 * daily sweep: Cloudflare deactivates a hostname whose CNAME disappears, and a
 * silently dead domain is the worst failure this feature has — the studio is the
 * last to know, usually via a customer.
 */
export const checkPublicDomain = onCall(async (request) => {
  const uid = requireAuth(request.auth?.uid)
  const { scope, entityId } = request.data ?? {}
  validateScope(scope, entityId)
  await assertAccess(uid, scope, entityId)

  const config = await readConfig(scope, entityId)
  if (!config?.cf_hostname_id) throw new HttpsError('not-found', 'No custom domain is configured.')

  let cf
  try {
    cf = await getCustomHostname(config.cf_hostname_id)
  } catch (err) {
    console.error('checkPublicDomain: Cloudflare getCustomHostname failed:', err)
    throw new HttpsError('internal', 'Could not reach Cloudflare. Try again shortly.')
  }

  const status = toPublicDomainStatus(cf)
  await configRef(scope, entityId).set(
    {
      status,
      ssl_status: cf.ssl?.status ?? null,
      error: firstError(cf),
      last_checked_at: FieldValue.serverTimestamp(),
      // Stamped once, and never reset by a later error — it records that the
      // domain DID work, which is what tells support "this broke" apart from
      // "this was never finished".
      ...(status === 'active' && !config.verified_at
        ? { verified_at: FieldValue.serverTimestamp() }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return { status, sslStatus: cf.ssl?.status ?? null, error: firstError(cf) }
})

/**
 * Disconnects the domain: deletes it at Cloudflare, releases the uniqueness
 * claim, drops the config. Releasing the claim matters — without it the studio
 * cannot re-add their own hostname after a mistake, and neither can anyone else.
 */
export const removePublicDomain = onCall(async (request) => {
  const uid = requireAuth(request.auth?.uid)
  const { scope, entityId } = request.data ?? {}
  validateScope(scope, entityId)
  await assertAccess(uid, scope, entityId)

  const config = await readConfig(scope, entityId)
  if (!config) return { removed: false }

  if (config.cf_hostname_id) {
    try {
      await deleteCustomHostname(config.cf_hostname_id)
    } catch (err) {
      // A hostname already gone at Cloudflare must not strand the local records:
      // leaving the claim behind would make the domain unrecoverable.
      console.warn('removePublicDomain: Cloudflare delete failed (continuing):', err)
    }
  }

  await claimRef(config.hostname).delete().catch(() => undefined)
  await configRef(scope, entityId).delete()

  return { removed: true, hostname: config.hostname }
})
