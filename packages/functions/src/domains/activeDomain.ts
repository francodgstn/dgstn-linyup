/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import {
  ORGANIZATIONS_COLLECTION,
  PUBLIC_DOMAIN_INTEGRATION_DOC,
  TEAMS_COLLECTION,
  TEAM_INTEGRATIONS_SUBCOLLECTION,
  type PublicDomainConfig,
} from '@linyup/shared'

/**
 * A short in-process cache, because outbound mail asks this ONCE PER RECIPIENT:
 * a bulk send to 400 members would otherwise be 400 identical reads of one
 * document. Sixty seconds bounds a bulk run to a single read while keeping the
 * window in which a just-connected domain is still reported absent down to
 * something nobody notices.
 */
const TTL_MS = 60 * 1000
const cache = new Map<string, { host: string | null; expires: number }>()

/**
 * The hostname a tenant's public pages are currently SERVED from, or null.
 *
 * Exists for one job: deciding whether a caller's origin may be returned to
 * after a Stripe checkout. That makes it a security predicate, so it answers
 * for ONE tenant — never "is this anybody's custom domain". Returning to any
 * verified domain would be an open redirect wearing a customer's clothes.
 *
 * `active` and nothing else. A domain that is still `pending` (no DNS yet) or
 * `verifying` (no certificate yet) cannot serve a return page at all, so
 * treating it as trusted would send a paying visitor to a URL that does not
 * resolve — the one moment in the flow where that is least forgivable.
 */
export async function activeCustomDomainHost(
  entityId: string,
  scope: 'team' | 'org' = 'team'
): Promise<string | null> {
  if (!entityId) return null
  const key = `${scope}:${entityId}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.host
  const collection = scope === 'org' ? ORGANIZATIONS_COLLECTION : TEAMS_COLLECTION
  try {
    const snap = await admin
      .firestore()
      .collection(collection)
      .doc(entityId)
      .collection(TEAM_INTEGRATIONS_SUBCOLLECTION)
      .doc(PUBLIC_DOMAIN_INTEGRATION_DOC)
      .get()
    const config = snap.exists ? (snap.data() as PublicDomainConfig) : null
    const host =
      config && config.status === 'active' && config.hostname ? config.hostname : null
    cache.set(key, { host, expires: Date.now() + TTL_MS })
    return host
  } catch (err) {
    // A read failure must never fail a checkout. Falling through as "no custom
    // domain" returns the visitor to the canonical app host — the pre-custom-
    // domain behaviour, which is worse branding and a working payment.
    // Deliberately NOT cached: a transient failure must not pin "no domain" for
    // a minute across every send that follows it.
    console.warn(`activeCustomDomainHost: read failed for ${scope} ${entityId}:`, err)
    return null
  }
}
