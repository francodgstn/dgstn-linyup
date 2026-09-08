# Custom domains ("bring your own domain")

A studio's public surfaces live at `linyup.com/public/{slug}/…` — bio-link, site,
booking, shop, documents, space, events, appointments. This feature serves that
same tree from a hostname the studio owns, with the slug segment gone.

## Status (2026-09-08)

**A studio's own domain serves their pages.** Connect it in Public pages, add one
CNAME, and `book.theirdojo.ch` is their bio-link, shop, booking and Space.

Built:

- `registerPublicDomain` / `checkPublicDomain` / `removePublicDomain`
  (`packages/functions/src/domains/`), plus the Cloudflare client.
- `PublicDomainConfig` + the `public_domains/{hostname}` uniqueness registry.
- **Studio UI: Public pages** — under the hero, which shows the custom domain in
  place of the linyup.com path once it is live.
- Operator console: Settings → Domains.
- `refreshCustomDomains` + `assertZoneRecordsUnproxied` in `dailyTasks`.
- **Host → tenant resolution in the app** (`proxy.ts` +
  `lib/customDomainTenant.ts` + `shared/utils/customDomainPaths.ts`), and the
  edge Worker reduced to a pass-through.
- **The Stripe return stays on the domain.** `buildResultUrls` resolves the
  tenant's active host and `resolveBaseUrl` accepts the caller's origin when it
  matches it — per tenant, never per pattern: widening the trusted regex to
  cover customer domains would let studio A's checkout return a visitor to
  studio B's site. Pinned by `domains/returnOrigin.test.ts`, including the
  look-alike (`https://evilbook.theirdojo.ch`) and plain-http cases.

Not built:

- **Emailed links still say linyup.com.** `getHostingUrl()` is one global param
  read at ~39 call sites; a booking confirmation therefore links to
  `app.linyup.com/public/{slug}/…` even for a studio on their own domain. Those
  links WORK — they are just not branded.
- **In-page links keep the slug.** `publicHref` still emits
  `/public/{slug}/shop`, so the address bar shows the short form only until the
  first click. Both forms serve (see below); making the builders host-aware is
  the remaining half.

## The shape

**One hostname per tenant, serving the WHOLE public tree.** Not one hostname per
surface. `book.theirdojo.ch/` is their default surface, `/shop` is the shop,
`/space` the member portal.

The reason is not tidiness — it is that **a subdomain is a separate origin and the
contact's session is origin-scoped**. Public contact sign-in is
`signInWithCustomToken`, persisted in Firebase Auth's IndexedDB plus a
localStorage flag (`PublicContactAuthProvider`), both keyed by origin. Splitting
booking and shop across two hosts means a member signs in twice, with two
passwordless email codes, to book a class and buy a T-shirt. Nothing recovers
that: Auth persistence is not cookie-scoped, and a token handoff on cross-host
navigation puts session tokens in URLs.

Extra hostnames are therefore **aliases that 301 into the primary** —
`shop.theirdojo.ch` → `theirdojo.ch/shop` — handled at the edge, never reaching
Next.js. A studio still gets the short host for a flyer or a QR code; the visitor
lands on one origin and stays there. Model the data as a LIST of hostnames with
exactly one primary from day one (the edge supports it for free), even though v1
may only expose one.

**Subdomains, not apex, in v1.** An apex cannot CNAME; it needs ALIAS/ANAME or
CNAME-flattening, which many registrars (Swiss ones especially) do not offer. This
is less of a compromise than it sounds: the common case is a studio keeping an
existing website on the apex and wanting only the transactional surfaces from us.
HMD Basel is exactly this — `hmdbasel.ch` is on GitHub Pages and is not moving.

**Suggest `book.`** as the prefilled default (`my.` as the visible alternative).
It names the action rather than the software, is four characters, and reads in all
four national languages. The field stays free text — a studio wanting
`buchen.theirdojo.ch` types it.

## Why Cloudflare

Firebase App Hosting custom domains are a manual Console/CLI operation per domain
against a Google-managed cert (`infra/README.md`, §5b/§6). Fine for our three
domains; there is no self-service path there.

**Cloudflare for SaaS** (custom hostnames) is built for this: one API call
registers a tenant hostname, Cloudflare issues and renews the cert. First 100
hostnames free, then $0.10/hostname/month.

**The SaaS zone is `linyup.com` itself** (decided 2026-08-21): move its DNS from
OVH to Cloudflare — registrar stays OVH, only the nameservers change — and give
tenants **`connect.linyup.com`** as their CNAME target.

**That target string is effectively irreversible.** Once studios have it in their
DNS, changing it means asking every one of them to edit a record, and the ones who
don't go dark. So it is chosen for the long run, not for convenience now.

Two alternatives were considered and rejected:

- **Delegating `sites.linyup.com` to Cloudflare while the rest stays at OVH** —
  not available: that is a child-zone setup and Cloudflare gates it to
  **Enterprise** (`dns/zone-setups/subdomain-setup/`: Free/Pro/Business all "No").
- **A separate single-purpose domain** (`linyup.app`) as the SaaS zone, leaving
  `linyup.com` on OVH. Rejected after examination: it buys only the *deferral* of
  an hour of DNS work, and costs a permanent second dependency whose lapsed
  registration would break every tenant's domain at once. The security argument
  for it does not survive contact with the facts — a token scoped to custom
  hostnames (`SSL and Certificates: Edit`) **cannot edit DNS records**, so the mail
  records were never reachable from this feature either way. `connect.linyup.com`
  is also the more legible target for a studio's IT person, and the move brings
  Cloudflare's WAF/analytics in front of the marketing site, which is wanted
  eventually regardless. (`linyup.app` may still be registered as brand defence —
  parked, no role here.)

**Moving the zone is not proxying it.** Every pre-existing record stays
**grey-cloud / DNS-only**, where Cloudflare is a plain authoritative host and MX,
SPF/DKIM/DMARC and the App Hosting records behave exactly as at OVH. Only the two
new records (`origin`, `connect`) are proxied. Migration preconditions are in
`infra/README.md` §5d — the one that actually bites is DNSSEC.

Traffic path:

```
visitor → theirdojo.ch
        → Cloudflare edge (custom hostname, CF-issued cert)
        → fallback origin = a Worker
             reads request.cf.hostMetadata → { teamId, slug, … }
             rewrites  /booking → /public/{slug}/booking
             fetch() to the App Hosting host, original host preserved in a header
        → Next.js on App Hosting, route tree unchanged
```

**The wildcard route makes every proxied record in the zone this Worker's
problem — so its default for anything it does not own is "carry on".** Learned
on 2026-08-21: every proxyable `linyup.com` record was orange-clouded at once,
and the Worker *refused* the ones it did not recognise, taking the apex, `app`,
`ops` and `demo` down together. Without a Worker they would have kept working —
Cloudflare would simply have forwarded to App Hosting. A guard turned a
degradation into an outage.

It now forwards an unknown `linyup.com` host to that hostname's own origin
(`fetch(request)`, safe because a Worker on a ROUTE cannot be the target of a
same-zone fetch — do not convert it to a Custom Domain without revisiting that),
and calls `ctx.passThroughOnException()` so a bug in the Worker degrades to "as
if no Worker" rather than 5xx-ing the zone.

That fixes availability and hides the mistake, which is why the other half
exists: proxying **flattens a CNAME**, so that day it also broke DKIM (every
outbound mail lost DMARC alignment) and flattened the five
`_acme-challenge_*` certificate authorizations. Neither fails loudly.
`assertZoneRecordsUnproxied` (daily tasks) is the alarm — it uses
`origin.linyup.com` as the reference for "what proxied looks like", so it tracks
Cloudflare's addressing instead of hardcoding IP ranges. **The invariant was
previously enforced by a comment, and the comment lost.**

**The Worker needs a `*/*` route, not a route on the fallback origin.** Worker
routes match the REQUEST hostname, so `origin.linyup.com/*` never fires for
`book.theirdojo.ch` — designating a Worker as the fallback origin is not enough
by itself, and the symptom is a 522 on the tenant domain while `origin` itself
answers fine. Cloudflare's documented answer is the wildcard, which captures
every request entering the zone with no per-tenant route ever. **That is only
safe because every `linyup.com` record is DNS-only** — a wildcard route reaches
proxied hostnames only. See the ⚠ in `infra/README.md` §5d and in
`wrangler.jsonc`; the Worker answers 503 naming the cause if it is ever handed
one of our own hostnames.

**The app resolves the tenant, not the edge** (decided 2026-09-08).

Cloudflare's `custom_metadata` — `{teamId, slug}` carried on the hostname record
and read at the edge as `request.cf.hostMetadata` — was the design, and it is
**Enterprise only**: creating a hostname with it fails outright with

```
1413  No custom metadata access has been allocated for this zone or account.
```

The alternative at the edge was Workers KV, and it was rejected. The app already
needs the host→tenant mapping for emailed links, canonical tags and the Stripe
return-origin check, so a KV copy could only DRIFT from it — and a drifted edge
serves a live customer domain another studio's pages. Resolving in the app leaves
one owner.

So `proxy.ts` resolves the host and rewrites internally:

```
book.theirdojo.ch/shop   →  (rewrite)  /de/public/{slug}/shop
```

Two document GETs by known id (`lib/customDomainTenant.ts`), cached in-process
for five minutes:

1. `public_domains/{hostname}` → which tenant claimed the host
2. `{teams|organizations}/{id}/public_profile/{id}` → that tenant's slug

**Two reads rather than one, deliberately.** The slug could be denormalised onto
the claim, but a team's slug is EDITABLE — that copy would go stale the moment
somebody renamed theirs, and the symptom is a custom domain quietly 404ing while
every record involved looks correct.

The registry allows `get` and denies `list`: the doc id IS the hostname, so
resolving one requires already knowing it, while listing would hand over the
customer roster.

Three consequences worth knowing:

- **The rewrite is INTERNAL**, so the visitor's address bar keeps `/shop` and
  nothing has to translate `Location` headers back out of `/public/{slug}/…`.
  That whole class of bug left with the Worker's rewrite.
- **`/public/…` is passed through unmapped.** The pages still emit
  `/public/{slug}/…` links, and mapping those a second time would produce
  `/public/{slug}/public/{slug}/…`. Both URL forms therefore serve.
- **An unprefixed path gets the TENANT's language**, not the browser's — a Basel
  dojo's front door answering in English because a visitor's laptop is set that
  way is the wrong default for a vanity domain. An explicit `/de/…` still wins.

## Per-tenant flow

Model it on the BYO **email** domain feature, which is the same problem solved
once already (`packages/functions/src/mail/domainAuth.ts`,
`packages/functions/src/mail/README.md` → "BYO domain flow"):

- Config at `teams|organizations/{id}/integrations/public_domain`, the sibling of
  `EmailSenderConfig` — status, hostname, CF hostname id, DNS records to display,
  `last_checked_at`. No credentials.
- Global uniqueness registry `public_domains/{hostname}` (doc-id IS the hostname,
  like `promo_codes`), so two tenants cannot claim one host. Callables only, and
  **unreadable by clients too** — it is a list of every studio's domain, so a
  readable registry would let any signed-in user enumerate the customer base.
- **The `integrations/{id}` rules had to be narrowed**, and this is the
  non-obvious part: that block granted an owner blanket write over every
  integration doc, which would have included `public_domain`. Firestore ORs all
  matching rules, so a more specific deny cannot override a broader allow — the
  owner's write is therefore excluded by condition
  (`integrationId != 'public_domain'`) on both the team and org blocks. Without
  it a studio could write another studio's hostname into their own config, which
  matters the moment anything resolves an incoming hostname by reading it.
- **Teardown**: the claim is registered in `TENANT_DATA_COLLECTIONS` (matched on
  `entityId`) because a claim outliving its tenant locks that hostname forever —
  including against the same studio signing up again. Deleting it does not delete
  the Cloudflare hostname, so it carries `externalTeardown: 'cloudflare_hostname'`
  and `purgeTeam` warns.
- `registerPublicDomain` / `checkPublicDomain` / `removePublicDomain`, guarded by
  `assertTeamOwner` / `assertOrgAdmin` and a plan check mirroring `isByoEligible`.
- The studio adds **one CNAME**. With HTTP validation, ownership and cert issuance
  both fall out of that record resolving — no separate TXT step in the common case.
- Status polls in `dailyTasks` plus a manual "Check now". **A silently dead domain
  is the worst failure mode here** — Cloudflare deactivates a hostname whose CNAME
  disappears, and the studio must be told.

## What this breaks in the app — the real cost

The edge work is contained. The app-side work is wide and quiet, and its failure
mode is "everything works except the emails":

1. **Emailed links.** `getHostingUrl()` is one global param used at ~39 call sites
   across 25 files (booking confirmations, .ics, waitlist claims, manage-booking,
   Space). All funnel through `publicUrl` / `localizedPublicUrl`, so the fix is one
   new resolver — `teamPublicBaseUrl(teamId)` — threaded in, not 39 rewrites.
   **Not optional**: a studio on their own domain whose confirmations say
   linyup.com is worse off than before.
2. **Stripe return origin.** `resolveBaseUrl` (`utils/env.ts`) validates the caller
   origin against a hardcoded `*.linyup.com` regex. It must check against **that
   tenant's verified domain** — widening the regex is an open redirect.
3. **Redirect host in `proxy.ts`.** It already rebuilds `Location` from
   `x-forwarded-host` to fix the Cloud Run `:8080` leak. If the Worker sets `Host`
   to the App Hosting hostname, locale redirects land on `*.hosted.app`. The Worker
   must preserve the original host and `proxy.ts` must prefer it.
4. **Canonical + 301.** Once live, `linyup.com/public/{slug}/*` should 301 to the
   custom domain — it stops us competing with our own customers in search, which is
   the point of the feature. Keep the linyup path alive forever: it is baked into
   old emails, .ics files and QR codes. Canonical is already host-derived
   (`site/page.tsx`), but the path still carries `/public/{slug}`.
5. Per-host `robots.ts` / sitemap (currently keyed on the prod project id only).

**Two things pleasantly do NOT break.** Public contact sign-in uses
`signInWithCustomToken`, which is not subject to Firebase Auth's authorized-domains
list — no per-tenant Auth config. And Firestore/Storage rules are origin-agnostic;
the tenant boundary is unchanged.

## Lifecycle

Removal on delete/downgrade/churn (delete the CF hostname, release the uniqueness
claim — otherwise we keep paying and, worse, keep serving), slug rename → PATCH
metadata, status drift → poll and tell the studio.

## Available today, no DNS

The embed widget system already exists (`embed_widgets/{teamId}`, framable from
anywhere, `/embed/{slug}/{sectionId}`). It covers discovery on a studio's existing
site, not transactions — clicking through opens the full page on linyup.com. It
stops being a stopgap the moment a domain lands, since the widget links then point
at the studio's own host.

## Open decisions

- ~~**Plan tier**~~ — settled: **coach+**, and now ADVERTISED, which is what
  settled it. It is stated once, as the `custom_domain` member of
  `PLAN_FEATURES`; the landing comparison row, the studio card's upgrade prompt
  and `assertPlanEligible` all read it from there rather than restating a plan
  list. Deliberately a tier below "Remove Linyup branding" (Studio+): a DOMAIN is
  the studio's own identity in the address bar and the From line, which is a
  different lever from taking our logo off the page.
- ~~**Zone**~~ — settled: `linyup.app`, see "Why Cloudflare" above and
  `infra/README.md` §5d.
- **Org tier** — a multi-club org wanting `zurich.federation.ch` per member studio
  is the same mechanism with a different authoring UI. Deferred, not designed out.
- **Path mounting** (`theirdojo.ch/shop` proxied from the studio's own site) needs
  a per-tenant base path in link generation — a second axis of complexity, and not
  reproducible by a customer on Wix or Squarespace. Rejected for v1.

Operator setup (zone, fallback origin, Worker, API token): `infra/README.md` §5d.
