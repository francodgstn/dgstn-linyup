---
title: Public API + remote MCP server
status: living
area: platform
---
# Public API + remote MCP server

Studio staff reach their studio's data from outside Linyup in two ways:

- **An AI assistant** (Claude, ChatGPT, Claude Code) through a remote **MCP** server, so an owner
  can ask "who hasn't come in three weeks?" or "how full were Thursday classes last month?".
- **A developer integration** through a versioned **REST** API.

Both are the same product: one origin, one principal, one read layer. This document is the owner of
the design; the code headers point here.

Status (2026-09-16): **merged to main (#369) and live on staging.** Sandbox and production are
configured here but their Hosting sites do not exist yet — see "Hosting target". Built: the scope table,
API key minting / principal resolver / single credential writer, `createApiKey` / `revokeApiKey`,
the `api-connectors` plugin with its revoke-all teardown, rules + TTL, the field catalog with
contact and session projections, and the `api` HTTPS function serving `/v1/me|team|contacts|sessions`
and `/mcp` (tools: `get_studio_overview`, `find_contacts`, `list_inactive_contacts`, `get_contact`,
`get_schedule`), and Settings → API keys (`/settings/api-keys`: create with scopes and expiry,
the secret shown once with Claude Code and curl examples, list, revoke).

Second wave: `/v1/activities`, `/v1/plans`, `/v1/sessions/{id}/roster`, `/v1/contacts/{id}/history`,
`/v1/subscriptions?state=`, `/v1/events`, `/v1/reports/weekly`, `/v1/reports/finance`,
`/v1/insights/class-fill`; MCP tools `list_offerings`, `get_session_roster`, `get_contact_history`,
`list_memberships`, `list_events`, `get_attendance_trend`, `get_revenue_summary`,
`get_class_fill_rates`.

Phase 2 (OAuth): discovery metadata, `/oauth/authorize|token|revoke` with Client ID Metadata
Documents, the consent page at `/oauth/consent`, and Connected apps on Settings → API keys — see
"OAuth" below.

**Staging (2026-09-15):** live at `https://api-stg.linyup.com` (custom domain on the
`linyup-api-staging` site; DNS-only CNAME in Cloudflare), and claude.ai and VS Code both completed
client verification against it.

**Sandbox and production (2026-09-16):** configured, not yet created. Each still needs its Hosting
site (`terraform apply` creates it), the custom domain added in the Firebase console with the DNS
record, and a deploy — sandbox by tag, production through its workflow. Sandbox exists so a lead
demo can show the connector; the `/try` playground is blocked from the API outright (see
"Blocked tenants").

## Hosting target

`firebase.json` target `api`: static folder `infra/hosting/api` (only a `robots.txt`), every other
path rewritten to the gen2 `api` function in europe-west6. `.firebaserc` maps it in every
environment, Terraform owns the site shells (`infra/modules/firebase-project`), and each deploy
workflow names `hosting:api` explicitly:

| Environment | Site | Answers on | Warm instances |
|---|---|---|---|
| staging | `linyup-api-staging` | `https://api-stg.linyup.com` | 0 |
| sandbox | `linyup-api-sandbox` | `https://api-demo.linyup.com` | 0 |
| production | `linyup-api-prod` | `https://api.linyup.com` | 1 |

`API_MIN_INSTANCES` (`packages/functions/.env.<env>`) sets the warm instances: production runs one
because a cold start measured 5.3 s and a connector gives up around 10 s. It must exist in every
env file, `.env.local` included — an unresolvable param makes the emulator prompt, and a prompt in
a non-TTY loads zero functions.

To deploy the target by hand (CI does it on every push to main / tag):

```
node scripts/vendor-shared-for-deploy.mjs      # then revert packages/functions/package.json
FUNCTIONS_DISCOVERY_TIMEOUT=120 npx firebase-tools deploy --project staging \
  --only functions:api,functions:createApiKey,functions:revokeApiKey,functions:getOAuthAuthorizationRequest,functions:approveOAuthAuthorization,functions:denyOAuthAuthorization,functions:revokeOAuthGrant,hosting:api \
  --non-interactive --force
```

`API_BASE_URL` in `packages/functions/.env.<env>` names the public origin; without it the issuer,
the MCP resource and the OpenAPI server would be the Cloud Run host (Phase 0 finding).

First staging deploy (2026-09-15, branch commit `c99d4fe2`), functions and hosting only.
**Rules and indexes were NOT deployed from the branch**: `main` had changed `firestore.rules`
since the branch was cut, so deploying them would have reverted that change. The API needs
neither (Admin SDK, existing indexes); the `api_keys` / `oauth_grants` read rules and the TTL
overrides reach staging with the merge. Smoke results through Hosting, no credential:

| Check | Result |
|---|---|
| `/health` | 200; warm 64–86 ms |
| Protected resource + AS metadata, OpenAPI `servers` | all name `https://linyup-api-staging.web.app`; after the custom domain, all name `https://api-stg.linyup.com` (re-run 2026-09-15, 11/11) |
| `POST /mcp` without a token | 401 with `resource_metadata` challenge, `private, no-store` |
| Bogus key on `/v1/me` | 401 |
| `/oauth/authorize` with an unverifiable client | 400 on our page, no redirect |
| `/oauth/token` with an unknown code | 400 `invalid_grant` |
| CORS preflight | 204 |

The site ID `linyup-staging-api` could not be reused: the Phase 0 spike deleted a site of that
name, and a deleted Hosting site ID is reserved forever.

**OpenAPI** — `GET /v1/openapi.json`, unauthenticated (it holds no studio data), OpenAPI 3.0.3,
built at request time by `api/openapi/document.ts`. It cannot drift by construction: the
operation table is a `Record<RestRouteKey, …>` over the router's own route keys; query parameters
are generated from `REST_QUERY`, the shapes the router parses with; and every response schema in
`api/openapi/components.ts` is written through `objectOf<T>()`, which fails the typecheck unless
it names every key of the projection type and exactly its optional keys. Linked from
Settings → API keys.

The document's `servers` URL comes from `publicBaseUrl` (`api/index.ts`): the `API_BASE_URL`
environment variable when set, otherwise the request's host with the function prefix the runtime
strips added back (`/<project>/europe-west6/api` on the emulator, `/api` on cloudfunctions.net,
nothing behind the `api` Hosting target). Set `API_BASE_URL` once the custom domain exists.

Records about people (a roster, a history, a membership) name the person from the CONTACT
document through `loadPeople` (`api/resources/people.ts`) — never from the copy denormalised on
the record — and a row whose person this connection may not see is left out and counted
(`hidden_bookings`), never shown nameless.

## Where the code is

| Concern | Owner |
|---|---|
| Scopes, key/credential types | `packages/shared/src/types/api.ts` |
| Field catalog, projections | `packages/shared/src/api/` |
| Ownership mirrors of the rules | `packages/shared/src/utils/dataScope.ts` |
| Principal resolver (the ONE) | `packages/functions/src/api/auth/principal.ts` |
| Credential writer (the ONE) | `packages/functions/src/api/auth/credentials.ts` |
| Key callables | `packages/functions/src/api/keys.ts` |
| HTTPS entry, rate limit, usage | `packages/functions/src/api/index.ts`, `usage.ts` |
| Read layer | `packages/functions/src/api/resources/` |
| REST router / MCP server | `packages/functions/src/api/rest.ts`, `mcp/server.ts` |
| OAuth endpoints, client metadata, consent callables | `packages/functions/src/api/oauth/` |
| The per-team block | `packages/functions/src/api/teamAccess.ts`, `apiAccessBlocked` in shared |
| Read tools (ONE registry: MCP server + in-app assistant) | `packages/functions/src/api/tools/` |
| In-app assistant (tool loop over the registry) | `packages/functions/src/assistant/` |
| Consent page | `apps/web/src/app/[locale]/oauth/consent/page.tsx` |

**MCP SDK:** `@modelcontextprotocol/sdk` 1.30 (stable, zod 3). The v2 split packages
(`@modelcontextprotocol/server` 2.0) require zod 4, which the functions do not run; `mcp/server.ts`
is the only importer, loaded lazily so no other function's cold start pays for it. Tools register
through `registerReadTool`, which validates arguments with the same `parseInput` REST uses.

## Decisions (Franco, 2026-09-14)

| # | Decision | Why |
|---|---|---|
| D1 | Designed from scratch. hmd-lineup's `hmdApi` + stdio MCP proxy is not a reference. | One key per user pinned to a team, raw documents out, no scopes, no audit. |
| D2 | Audience is **studio staff acting on one team**. No organisation principals, no member-facing agent. | The questions leads ask are a studio's questions; a member agent is a different identity (contact session) and a different risk. |
| D3 | **Read-only** in v1. | Every write path in Linyup runs through a seam (waiver gate, seat writer, payment resolver). An AI that books or cancels needs those seams exposed deliberately, not as a side effect. |
| D4 | **OAuth + API keys.** OAuth for connectors in claude.ai / ChatGPT; API keys for developers, scripts and Claude Code. | A non-technical owner cannot paste a header into claude.ai. |
| D5 | Entitlement is a plugin, **`api-connectors`**, `minPlan: 'studio'`. | Landing already sells "API access" on Studio + Organization. Plugin doctrine (`docs/plugins.md`): the plan requirement lives in the manifest, and the gate is on creation, never consumption. |

## Shape

```
claude.ai / ChatGPT ── OAuth access token ─┐
Claude Code / curl ─── API key ────────────┤   https://api.linyup.com
                                           ▼   Hosting target "api" → gen2 onRequest `api`, europe-west6
                          resolveApiPrincipal   ONE resolver; re-reads membership on every request
                                           ▼
                          api/resources + api/insights   ONE read layer, allow-list projections
                               ▲                     ▲
                         POST /mcp tools        GET /v1 REST (+ /v1/openapi.json)
```

Only the OAuth **consent page** lives in `apps/web`, because the Firebase login session is there.

## The principal

Every request — OAuth token or API key — resolves to one `ApiPrincipal`
(`packages/functions/src/api/auth/principal.ts`):

- `teamId`, `uid` (the member who granted or created the credential), how it came in, the member's
  **live** role, capabilities and data scope, and the granted **scopes**.
- A scope is usable only when the member **currently** holds the capability it requires
  (`API_SCOPE_REQUIREMENTS`, `packages/shared/src/types/api.ts`). Scopes narrow a role; they never
  widen one. A coach stays own-scoped (`coachOwnsContact`, `packages/shared/src/utils/dataScope.ts`).
- The member document is re-read on every request, so leaving the team, a demotion and a revocation
  take effect on the next call. Token scopes are never trusted on their own.
- **The API may be narrower than `firestore.rules`, never wider.**

### Scopes

| Scope | Live capability | Notes |
|---|---|---|
| `contacts:read` | `contacts.view` | coach → own contacts unless `contacts.view.all` |
| `contacts:read:pii` | `contacts.view` | email, phone, birthdate, gender, address. Off by default; requires `contacts:read` |
| `schedule:read` | `schedule.view` | own sessions unless `schedule.view.all` |
| `offerings:read` | membership | activities, plans |
| `subscriptions:read` | `contacts.view` | amounts also need `reports.view` |
| `reports:read` | `reports.view` | weekly reports, insights |
| `finance:read` | `reports.view` | and the finance plugin installed |

### API keys

`teams/{teamId}/api_keys/{keyId}` — **team-owned, authorising as their creator, capped by their
scopes.** A key whose creator leaves or is demoted stops working and shows as inactive. Created and
revoked only with `integrations.manage` (owner). The secret (`lyp_live_…`, `lyp_test_…` outside
production) is shown once; the credential is stored as its SHA-256 in `api_credentials/{hash}`, so a
lookup is a direct get.

### OAuth

Linyup is its own authorization server with Firebase Auth as the identity: authorization code +
S256 PKCE, public clients, RFC 8707 `resource` enforced, **Client ID Metadata Documents** for client
registration (Dynamic Client Registration is deprecated by the 2026-07-28 MCP spec and only added
if a client we need lacks CIMD). One grant = one user × one team × one client; the user picks the
team on the consent page. Opaque hashed tokens: code 5 min, access 1 h, refresh 30 d rotating.

The flow, and who owns each step:

| Step | Where |
|---|---|
| `POST /mcp` without a token → 401 `WWW-Authenticate: Bearer resource_metadata="…"` | `api/index.ts` |
| `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414, `client_id_metadata_document_supported`) | `api/oauth/metadata.ts` |
| `GET /oauth/authorize` — fetch + validate the client's metadata document, match `redirect_uri`, require S256, check `resource` and scopes, park `oauth_requests/{id}`, 302 to the web consent page | `api/oauth/endpoints.ts`, `clientMetadata.ts` |
| Consent — sign in, pick one studio, untick scopes | `apps/web/src/app/[locale]/oauth/consent/page.tsx` |
| `getOAuthAuthorizationRequest` / `approveOAuthAuthorization` / `denyOAuthAuthorization` | `api/oauth/consent.ts` |
| Consume the request, create the grant, mint the code (one transaction); exchange, refresh, revoke | `api/auth/credentials.ts` (the ONE writer) |
| `POST /oauth/token`, `POST /oauth/revoke` (RFC 7009) | `api/oauth/endpoints.ts` |
| Settings → API keys → Connected apps; `revokeOAuthGrant` | `…/settings/api-keys/ConnectedApps.tsx`, `api/oauth/consent.ts` |

Rules the code holds (the pure ones are pinned by `api/oauth/oauth.test.ts`; the transactional
ones were exercised end to end on the emulator):

- **Until the client and its `redirect_uri` are verified, errors render on our page**; only after
  do they go back to the client (RFC 6749 §4.1.2.1). The consent page never builds a redirect —
  the callable returns the registered one.
- **Metadata fetch is SSRF-guarded**: https only (loopback http on the emulator), IP literals,
  `localhost`, `.local`/`.internal` and hosts resolving to private addresses refused, no redirects
  followed, 3 s and 5 KB limits, the document's `client_id` must equal its URL. Cached 24 h in
  `oauth_clients/{sha256(client_id)}`.
- **What a grant may read is narrowed three times**: to what the client asked for, to what the
  member's role in the chosen studio can read now, and to what they leave ticked. Contact details
  start unticked. The principal still re-reads the member on every call.
- **An access token is accepted on `/mcp` only** (its `resource`); `/v1` stays API-key only.
- **Refresh tokens rotate single-use.** Presenting a used one revokes the whole grant and deletes
  its credentials — a replay means the token leaked.
- No remembered consent: every authorization shows the page. Clients outside
  `OAUTH_RECOGNISED_CLIENT_HOSTS` are labelled as unrecognised.
- Plugin removal revokes every grant with the keys (`sync/onInstalledPluginStatusChange.ts`); the
  plugin gates approval, not use. The teardown re-reads the install before revoking: a trigger can
  arrive late, and a stale deactivation delivered after a reinstall must not close connections made
  since (seen on the emulator, where one arrived twenty minutes after the write).

`oauth_requests`, `oauth_clients` and the OAuth `api_credentials` rows carry `expires_at` and are
TTL-deleted (`EXPIRING_DOCUMENT_COLLECTIONS`, `packages/shared/src/retention.ts`).
`teams/{t}/oauth_grants` is readable by an owner and by the member who made the grant.

## Read tools

A tool answers a question about the studio ("who has gone quiet?", "how full were Thursdays?")
from the read layer, for one resolved principal. **`api/tools/registry.ts` is the only place a
tool is defined**, and two front ends publish it:

| Front end | Principal | Published as |
|---|---|---|
| Remote MCP server (`api/mcp/server.ts`) — Claude, ChatGPT, Claude Code | API key or OAuth grant | MCP tools (the SDK converts the zod shape) |
| In-app assistant (`assistant/`) — the web app's chat panel | the signed-in member (`resolveMemberPrincipal`) | Gemini function declarations (`api/tools/jsonSchema.ts`) |

So an answer cannot depend on the door the question came through, and a tool added once reaches
both. Each tool states who may use it (`available`: scopes ∩ live capabilities through
`principalMay`), parses its own arguments with `parseInput`, and returns failures as results the
model reads rather than throws. The grounding preamble — studio, today in its zone, money in minor
units, the people vocabulary, what this principal cannot see — is `api/tools/instructions.ts`,
written once for both. `api/tools/registry.test.ts` pins that the MCP server publishes exactly
what the registry decides for the same principal.

**The member principal** (`decideMemberPrincipal`) has no credential: it is whoever is signed in to
the web app. Rules 1 and 4 of the principal hold unchanged — the member document is read for the
call, and the scopes the caller asks for are still intersected with live capabilities, so asking
for a scope never widens a role. It never reaches `api/index.ts`, which resolves bearers only.

**The assistant withholds contact details** (`ASSISTANT_SCOPES` = every scope except
`contacts:read:pii`). The member may see them in the app, but sending them to a model is a separate
decision, and the contact-summary precedent is that no identifying field reaches a prompt.

**The assistant's tool loop** (`assistant/toolLoop.ts`): up to `MAX_TOOL_ROUNDS` rounds, then one
more turn with tools off so the model answers from what it gathered; every call is paired with one
response (calls over `MAX_CALLS_PER_ROUND` are refused, not dropped — function calling rejects an
unpaired turn); a tool result is clipped at `MAX_TOOL_OUTPUT_CHARS` and says so. Rate-limited per
question, not per call. Its navigation help (`APP_MAP`) is unchanged and still hand-maintained.

## Blocked tenants

Some studios must never hand out credentials at all. `Team.api_access_blocked` says so, read
through `apiAccessBlocked` (`packages/shared/src/types/api.ts`) and never inline, and enforced
by `assertApiAccessAllowed` (`packages/functions/src/api/teamAccess.ts`) beside the plugin gate
in `createApiKey` and `approveOAuthAuthorization`.

The block is at CREATION, like the plugin gate: no key is minted and no grant approved, so no
credential exists for the principal resolver to accept later. Installing the plugin on a blocked
studio therefore changes nothing — which is the point, because the flag exists for the sandbox
`/try` playground, where the owner login is PUBLIC and a visitor could otherwise mint a key that
reads (and bills) our Firestore long after they close the tab. It is the same reasoning that
hard-silences outbound mail on those tenants (`scripts/seed-sandbox.ts`).

**Lead tenants (`lead-*`) are deliberately not blocked** and install `api-connectors` in their
seed: showing a prospect their own studio answering in Claude is the point of the demo.
Revoking is never blocked — a door must always close. Pinned by `api/teamAccess.test.ts`.

## The read layer

**Projections, never documents.** Every resource leaves through an allow-list projection in
`packages/shared/src/api/projections/`. `packages/shared/src/api/fieldCatalog.ts` classifies
EVERY key of each internal type as `exposed`, `pii` or `excluded`, typed as a mapped type over the
internal interface — so adding a field to `Contact` fails `turbo run typecheck` until somebody
decides whether it may leave. The consent screen renders the same catalog, and the catalog version
is stored on each key and grant.

Never shared in v1, by any scope: notes, AI summary, custom fields, booking question answers,
emergency contacts, weight, birthplace, login emails, booking tokens and references, payment
identifiers, meeting links, and anonymised or deleted people (whose names are taken from the contact
document, never from a denormalised copy on a booking).

Wire conventions: snake_case with an `object` field; money in integer minor units with `currency`;
instants as ISO UTC; stored buckets (finance `month`, weekly `iso_week`) returned as stored.

The read layer reuses the resolvers the rest of the product answers with — `contactLifecycle`,
`matchesFilter`, `subscriptionIsCancelling`, `resolveActivityDropIn`, `computeEngagementBand`, the
`held_plans` mirror. It never re-implements one.

## Phases

- **Phase 0 — staging spike.** A hello-world `api` behind a Hosting `api` target on staging, to
  verify: the rewrite reaches a europe-west6 gen2 function and forwards `Authorization`; no caching;
  cold start well under the 10 s connector budget; claude.ai and ChatGPT choose CIMD; MCP SDK v2
  stability. **Run 2026-09-14 (infrastructure only), then removed** — findings below.
- **Phase 1 — foundation over API keys.** Shared vocabulary + field catalog + projections; principal
  and credential writer; API key callables and the Settings screen; read layer; `/v1` and `/mcp`
  accepting keys; the `api-connectors` plugin with its teardown arm.
- **Phase 2 — OAuth + connectors.** Well-known metadata, authorize/token/revoke, consent page,
  Connected apps.
- **Phase 3 — on demand.** DCR fallback, usage dashboard and per-call access log, public developer
  docs, directory submissions, webhooks / incremental sync (needs a `Contact.updated_at` writer),
  more resources (waivers first), organisation principals, writes.

## Phase 0 findings (staging, 2026-09-14)

`api` was deployed from the feature branch (commit `4fcb87cb`) to `linyup-staging` behind a
temporary Hosting site `linyup-staging-api` with `rewrites: ** → function api (europe-west6)`,
exercised with a temporary key on `seed-team-studio`, then **all of it was deleted** (function,
site, key, usage counter). The claude.ai / ChatGPT client-registration test was deferred to
Phase 2, where the OAuth endpoints it needs are built.

| Question | Answer |
|---|---|
| Does a Hosting rewrite reach a gen2 function in europe-west6? | Yes. |
| Is `Authorization` forwarded? | Yes — `/v1/me` through the rewrite resolved the key. A 401 keeps its `WWW-Authenticate`. |
| Does Hosting cache responses? | No, with `Cache-Control: private, no-store`: repeated calls `x-cache: MISS`, and a wrong key straight after a success got 401. |
| CORS preflight through the rewrite | 204, `Access-Control-Allow-Origin: *`. |
| Hosting overhead (warm, 10 calls) | median 126 ms through Hosting vs 63 ms direct — about +60 ms. |
| Cold start | The instance started at deploy took **5.3 s** from "Starting new instance" to a passing startup probe — Node loading the whole functions index. Inside the 10 s connector budget but not by much: plan `minInstances: 1` on `api` in production, or trim what `index.ts` loads for it. |
| Concurrency | 120 concurrent `/health` calls were served by one instance (concurrency 40): all 200, median 409 ms, max 509 ms. |
| MCP over the network | The SDK client connected through Hosting; connect + three tool calls in 1.2 s. |
| Deploying from a laptop | Needs `FUNCTIONS_DISCOVERY_TIMEOUT=120` (the CLI's 10 s local discovery times out loading the index on Windows) and `scripts/vendor-shared-for-deploy.mjs` (which rewrites `packages/functions/package.json` — revert it afterwards). |

**One defect found:** behind the Hosting rewrite the request's `Host` is the Cloud Run host, so
`/v1/openapi.json` advertised `https://api-…-oa.a.run.app` as its server. Set `API_BASE_URL`
(`https://api.linyup.com`) in every deployed environment when the Hosting target lands; the host
fallback in `publicBaseUrl` is only right on the emulator and on cloudfunctions.net.
