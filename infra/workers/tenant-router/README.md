# tenant-router (Cloudflare Worker)

The fallback origin for the `linyup.com` SaaS zone. Every tenant custom domain
(`book.theirdojo.ch`) lands here and is mapped onto the public route tree the
Next.js app already serves:

```
book.theirdojo.ch/shop   →   <ORIGIN>/public/{slug}/shop
```

Design: `docs/custom-domains.md`. Operator setup: `infra/README.md` §5d.

**Deliberately outside the pnpm workspace** (which globs `apps/*` and
`packages/*`). It has its own dependencies and its own deploy, and pulling it
into turbo would put a wrangler toolchain in every CI job that touches the repo.
So: plain `npm` in this directory.

## Deploy

```bash
npm install
npx wrangler login          # once
npx wrangler deploy
```

Fill both `vars` in `wrangler.jsonc` first — the placeholders are deliberate, so
a deploy against an unconfigured backend fails loudly instead of silently
serving the wrong environment.

## Pass A → Pass B

**Pass A (now).** `TENANT_SLUG` is a var: one hostname, one studio, no lookup.
This exists to prove DNS → certificate → edge → Worker → App Hosting works end
to end before any app code is written. Test it against a hostname you control
(`book.hmdbasel.ch`) pointed at the **sandbox** backend.

**Pass B (next).** The slug stops being a var. **Not** via
`request.cf.hostMetadata` — Cloudflare's custom metadata is Enterprise only
(error 1413 on our plan, verified 2026-08-21). Workers KV or app-side resolution
instead; open decision in `docs/custom-domains.md`. The slug is read in exactly
one place, so whichever wins is a one-line change here.

## What it no longer does

It does not rewrite paths, so it no longer needs a passthrough list, and it does
not translate `Location` headers on the way back. An internal Next rewrite never
reaches the browser, so there is nothing to translate — that whole class of bug
left with the rewrite. The passthrough rules now live once, in
`@linyup/shared/utils/customDomainPaths`, exercised by
`packages/functions/src/domains/customDomainPaths.test.ts`.

## Verifying the path logic

It moved to the app, and so did its tests:

```bash
pnpm --filter @linyup/functions test    # customDomainPaths.test.ts
```
