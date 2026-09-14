# Public API + remote MCP server

Studio staff reach their studio's data from outside Linyup in two ways:

- **An AI assistant** (Claude, ChatGPT, Claude Code) through a remote **MCP** server, so an owner
  can ask "who hasn't come in three weeks?" or "how full were Thursday classes last month?".
- **A developer integration** through a versioned **REST** API.

Both are the same product: one origin, one principal, one read layer. This document is the owner of
the design; the code headers point here.

Status (2026-09-14): **Phase 1 in progress, nothing deployed.** Built so far: the scope table,
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
`get_class_fill_rates`. Not yet: OpenAPI, the Hosting `api` target, OAuth (Phase 2).

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

### OAuth (Phase 2)

Linyup is its own authorization server with Firebase Auth as the identity: authorization code +
S256 PKCE, public clients, RFC 8707 `resource` enforced, **Client ID Metadata Documents** for client
registration (Dynamic Client Registration is deprecated by the 2026-07-28 MCP spec and only added
if a client we need lacks CIMD). One grant = one user × one team × one client; the user picks the
team on the consent page. Opaque hashed tokens: code 5 min, access 1 h, refresh 30 d rotating.

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
  stability. **Findings: not run yet.**
- **Phase 1 — foundation over API keys.** Shared vocabulary + field catalog + projections; principal
  and credential writer; API key callables and the Settings screen; read layer; `/v1` and `/mcp`
  accepting keys; the `api-connectors` plugin with its teardown arm.
- **Phase 2 — OAuth + connectors.** Well-known metadata, authorize/token/revoke, consent page,
  Connected apps.
- **Phase 3 — on demand.** DCR fallback, usage dashboard and per-call access log, public developer
  docs, directory submissions, webhooks / incremental sync (needs a `Contact.updated_at` writer),
  more resources (waivers first), organisation principals, writes.
