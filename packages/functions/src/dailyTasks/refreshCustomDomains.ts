/**
 * Re-polls every connected custom domain against Cloudflare and updates its
 * stored status.
 *
 * This sweep exists for ONE failure mode, and it is the worst this feature has:
 * a domain that stops working without anyone touching Linyup. Cloudflare
 * deactivates a custom hostname whose CNAME stops resolving, and certificates
 * lapse — a studio changing DNS providers, letting a domain expire, or
 * "tidying up" a record they no longer recognize all produce a dead public site
 * with no event on our side at all. Without this the studio is the last to
 * know, usually via a customer who could not book.
 *
 * It only ever WRITES STATUS. It never registers, never deletes, and never
 * touches the uniqueness claim — a sweep that could unclaim a hostname on a
 * transient Cloudflare error is a far worse bug than a stale badge.
 *
 * See docs/custom-domains.md.
 */

/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  ORGANIZATIONS_COLLECTION,
  PUBLIC_DOMAINS_COLLECTION,
  PUBLIC_DOMAIN_INTEGRATION_DOC,
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  type PublicDomainConfig,
} from '@linyup/shared'
import { firstError, getCustomHostname, toPublicDomainStatus } from '../domains/cloudflare'

export async function refreshCustomDomains(): Promise<{
  checked: number
  changed: number
  failed: number
  skipped: number
}> {
  const db = admin.firestore()
  const claims = await db.collection(PUBLIC_DOMAINS_COLLECTION).get()

  let checked = 0
  let changed = 0
  let failed = 0
  let skipped = 0

  for (const claim of claims.docs) {
    const { scope, entityId } = claim.data() as { scope?: 'team' | 'org'; entityId?: string }
    if (!entityId) {
      skipped++
      continue
    }

    const collection = scope === 'org' ? ORGANIZATIONS_COLLECTION : TEAMS_COLLECTION
    const ref = db
      .collection(collection)
      .doc(entityId)
      .collection(TEAM_INTEGRATIONS_SUBCOLLECTION)
      .doc(PUBLIC_DOMAIN_INTEGRATION_DOC)

    const snap = await ref.get()
    const config = snap.exists ? (snap.data() as PublicDomainConfig) : null
    // A claim with no config is a stranded row. Deliberately left alone and
    // merely counted — the operator console surfaces it, and guessing at a
    // repair here could delete a claim a half-finished registration still owns.
    if (!config?.cf_hostname_id) {
      skipped++
      continue
    }

    try {
      const cf = await getCustomHostname(config.cf_hostname_id)
      checked++
      const status = toPublicDomainStatus(cf)
      const error = firstError(cf)
      if (status === config.status && error === (config.error ?? null)) continue

      await ref.set(
        {
          status,
          ssl_status: cf.ssl?.status ?? null,
          error,
          last_checked_at: FieldValue.serverTimestamp(),
          ...(status === 'active' && !config.verified_at
            ? { verified_at: FieldValue.serverTimestamp() }
            : {}),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      changed++
      console.log(
        `refreshCustomDomains: ${config.hostname} ${config.status} → ${status}` +
          (error ? ` (${error})` : ''),
      )
    } catch (err) {
      // One tenant's failure must not stop the sweep — the next domain may be
      // the one that has actually broken.
      failed++
      console.warn(`refreshCustomDomains: ${claim.id} check failed:`, err)
    }
  }

  return { checked, changed, failed, skipped }
}
