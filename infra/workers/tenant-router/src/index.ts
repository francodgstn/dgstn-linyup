/**
 * Tenant router — the Cloudflare Worker behind every custom domain.
 *
 * It is the fallback origin for the `linyup.com` SaaS zone: a request to a
 * tenant's own hostname (`book.theirdojo.ch`) lands here, and this Worker maps
 * it onto the public route tree the Next.js app already serves.
 *
 *     book.theirdojo.ch/shop   →   <ORIGIN>/public/{slug}/shop
 *
 * Design docs: `docs/custom-domains.md`. Operator setup: `infra/README.md` §5d.
 * The path mapping itself lives in `paths.ts` and is unit-checked by
 * `scripts/check-paths.ts`.
 *
 * ─── Why this Worker knows nothing about tenants ─────────────────────────────
 * It carries requests and preserves the visitor's hostname. That is all.
 *
 * It briefly did more: a `TENANT_SLUG` var pinned one hostname to one studio,
 * to prove the DNS → certificate → edge → App Hosting path end to end. The real
 * lookup was going to live here too, on Cloudflare's `custom_metadata` — which
 * turned out to be ENTERPRISE ONLY (error 1413, verified against the live zone
 * on 2026-08-21).
 *
 * The alternative was Workers KV at the edge, and it was rejected: the APP
 * already needs the host→tenant mapping for emailed links, canonical tags and
 * the Stripe return-origin check, so a KV copy could only drift from it — and a
 * drifted edge serves a live domain the wrong studio's pages. Resolving in the
 * app leaves ONE owner of that mapping. See `docs/custom-domains.md`.
 */


/** Zone hostnames that exist only to carry traffic — never a tenant destination. */
const PLUMBING_HOSTS = new Set(['origin.linyup.com', 'connect.linyup.com'])

interface Env {
  /** Base URL of the App Hosting backend, e.g. https://linyup-web--linyup-sandbox.europe-west4.hosted.app */
  ORIGIN: string
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // An unhandled bug in here must not take the zone down. With this, an
    // exception forwards the request to the origin exactly as if no Worker were
    // present — the `*/*` route means a throw would otherwise 5xx every proxied
    // hostname at once.
    ctx.passThroughOnException()

    const url = new URL(request.url)
    const tenantHost = url.hostname

    // The route is `*/*`, so anything PROXIED on the zone lands here — including
    // the plumbing hostnames. `origin` and `connect` are not destinations: there
    // is no tenant to serve, and answering with a studio's page would put that
    // studio on a linyup.com URL nobody chose.
    if (PLUMBING_HOSTS.has(tenantHost) || tenantHost === new URL(env.ORIGIN).hostname) {
      return new Response('Not found', { status: 404 })
    }

    // Any OTHER linyup.com hostname reaching this Worker means somebody
    // orange-clouded a record that is meant to be DNS-only. It is NOT this
    // Worker's traffic, so it is forwarded to whatever that hostname's own DNS
    // record points at, untouched.
    //
    // THIS USED TO RETURN 503, AND THAT TOOK THE WHOLE ZONE DOWN (2026-08-21).
    // Every record in the zone was proxied by accident; without a Worker they
    // would all have kept working — Cloudflare would simply have forwarded to
    // App Hosting — but this refused them, so linyup.com, app, ops and demo went
    // down together. A `*/*` route makes every proxied record in the zone this
    // Worker's problem, so its default for anything it does not own has to be
    // "carry on", not "refuse".
    //
    // The same-zone fetch is safe: a Worker on a ROUTE cannot be the target of a
    // same-zone fetch(), so this reaches the origin instead of re-entering here.
    // (Cloudflare docs, workers/configuration/routing/routes.) Do not convert
    // this Worker to a Custom Domain without revisiting that — Custom Domains
    // CAN be same-zone fetch targets, which would make this an infinite loop.
    //
    // Proxying still silently breaks certificate renewal and flattens CNAMEs
    // (it broke DKIM that day), so the misconfiguration still has to be found —
    // that is `assertZoneRecordsUnproxied` in the daily tasks, not this line.
    if (tenantHost === 'linyup.com' || tenantHost.endsWith('.linyup.com')) {
      console.warn(
        `tenant-router: ${tenantHost} is PROXIED but should be DNS-only on the ` +
          `linyup.com zone — passing through to origin. Un-proxy that record.`,
      )
      return fetch(request)
    }

    // ── The tenant's own domain ─────────────────────────────────────────────
    //
    // Forwarded UNTOUCHED. This Worker used to resolve the slug and rewrite the
    // path itself; it does neither now. The app resolves the tenant from the
    // host and rewrites internally (`proxy.ts` + `shared/utils/customDomainPaths`),
    // which is where that knowledge already had to live for emailed links,
    // canonical tags and the Stripe return-origin check.
    //
    // Deleting the rewrite from here deleted the return trip with it: an
    // internal Next rewrite never reaches the browser, so there are no
    // `Location` headers to translate back out of `/public/{slug}/…` and no
    // `redirect: 'manual'` handling. This Worker's whole job is now: carry the
    // request to App Hosting, and tell it which hostname the visitor typed.
    const origin = new URL(env.ORIGIN)
    origin.pathname = url.pathname
    origin.search = url.search

    // `new Request(origin, request)` re-derives Host from the target URL, which
    // is what App Hosting needs to route to the right backend — and is exactly
    // why the visitor's hostname has to be carried separately.
    const proxied = new Request(origin, request)
    proxied.headers.set('X-Linyup-Host', tenantHost)

    return fetch(proxied)
  },
} satisfies ExportedHandler<Env>
