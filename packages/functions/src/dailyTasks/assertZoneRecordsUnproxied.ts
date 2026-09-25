/**
 * Catches a `linyup.com` record that has been PROXIED (orange-clouded) when it
 * should be DNS-only.
 *
 * On 2026-08-21 every proxyable record in the zone was proxied at once. Three
 * things broke, in descending order of how loudly:
 *
 *   1. the web hosts 503'd, because the tenant-router refused them — that is
 *      fixed at the source now: the Worker passes unknown `linyup.com` hosts
 *      through to their own origin instead of refusing;
 *   2. DKIM broke, because proxying FLATTENS a CNAME — `brevo1._domainkey` began
 *      answering with a Cloudflare address instead of resolving to the Brevo
 *      key, so every outbound mail failed DMARC alignment;
 *   3. certificate renewal broke, because the `_acme-challenge_*` authorizations
 *      were flattened the same way. Nothing fails today; it fails at renewal.
 *
 * Fixing (1) is what makes this job necessary. A proxied record no longer takes
 * a host down, so (2) and (3) would now happen in complete silence — mail
 * quietly landing in spam, certificates quietly failing to renew weeks later.
 * The invariant used to be enforced by a comment. This is the alarm.
 *
 * Detection uses `origin.linyup.com` as the reference: it is DEFINITIONALLY
 * proxied (it is the Cloudflare for SaaS fallback origin), so anything resolving
 * to the same addresses is proxied too. That tracks whatever IPs Cloudflare
 * assigns this zone, instead of hardcoding IP ranges that go stale.
 *
 * Read-only. It never changes DNS — the token cannot, deliberately.
 */

/* eslint-disable no-console */
import { promises as dns } from 'node:dns'
import { customDomainsAvailable } from '@linyup/shared'

/**
 * THE CENSUS — every hostname whose proxy state is worth an alarm.
 *
 * Not the whole zone: MX, TXT and SRV have no proxy toggle, and this is the one
 * place the list is written down. Add a record here when you add one to the zone
 * that must stay gray.
 */
const A_HOSTS = [
  'linyup.com',
  'app.linyup.com',
  'demo.linyup.com',
  'ops.linyup.com',
  'app-stg.linyup.com',
  'ops-stg.linyup.com',
]

/**
 * CNAMEs, checked differently and more directly: a proxied CNAME is FLATTENED,
 * so the question is simply "does this still resolve as a CNAME at all". That
 * tests the property that actually matters — the chain reaches the key or the
 * validation target — rather than inferring it from an address.
 */
const CNAME_HOSTS = [
  'brevo1._domainkey.linyup.com',
  'brevo2._domainkey.linyup.com',
  'ovhmo-selector-1._domainkey.linyup.com',
  'ovhmo-selector-2._domainkey.linyup.com',
  '_acme-challenge_37zms4qlx63nraqa.app.linyup.com',
  '_acme-challenge_37zms4qlx63nraqa.app-stg.linyup.com',
  '_acme-challenge_37zms4qlx63nraqa.demo.linyup.com',
  '_acme-challenge_37zms4qlx63nraqa.ops.linyup.com',
  '_acme-challenge_37zms4qlx63nraqa.ops-stg.linyup.com',
]

const FALLBACK_ORIGIN = 'origin.linyup.com'

export async function assertZoneRecordsUnproxied(): Promise<{
  checked: number
  proxied: string[]
  unresolved: string[]
  skipped?: boolean
}> {
  // Only the environment that owns the zone (docs/custom-domains.md →
  // "Environments"). Elsewhere there is nothing to be right or wrong about.
  if (!customDomainsAvailable(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT)) {
    return { checked: 0, proxied: [], unresolved: [], skipped: true }
  }

  let proxyAddresses: Set<string>
  try {
    proxyAddresses = new Set(await dns.resolve4(FALLBACK_ORIGIN))
  } catch (err) {
    // Without the reference set there is no test to run. Warn rather than throw:
    // a DNS blip must not fail the whole daily run.
    console.warn(`assertZoneRecordsUnproxied: could not resolve ${FALLBACK_ORIGIN}:`, err)
    return { checked: 0, proxied: [], unresolved: [], skipped: true }
  }

  const proxied: string[] = []
  const unresolved: string[] = []

  for (const host of A_HOSTS) {
    try {
      const addresses = await dns.resolve4(host)
      if (addresses.some((a) => proxyAddresses.has(a))) proxied.push(host)
    } catch {
      unresolved.push(host)
    }
  }

  for (const host of CNAME_HOSTS) {
    try {
      const targets = await dns.resolveCname(host)
      if (targets.length === 0) proxied.push(host)
    } catch {
      // ENODATA on a name that should be a CNAME is exactly what flattening
      // looks like. It is also what a deleted record looks like — both need a
      // human, so they are reported together rather than guessed apart.
      proxied.push(host)
    }
  }

  if (proxied.length > 0) {
    console.error(
      `assertZoneRecordsUnproxied: ${proxied.length} linyup.com record(s) are PROXIED or ` +
        `flattened and must be set to DNS-only (gray cloud): ${proxied.join(', ')}. ` +
        `Proxying breaks DKIM and App Hosting certificate renewal silently.`,
    )
  }
  if (unresolved.length > 0) {
    console.warn(`assertZoneRecordsUnproxied: did not resolve: ${unresolved.join(', ')}`)
  }

  return { checked: A_HOSTS.length + CNAME_HOSTS.length, proxied, unresolved }
}
