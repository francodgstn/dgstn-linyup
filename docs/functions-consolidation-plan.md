---
title: Cloud Functions consolidation plan (2026-09)
status: plan
area: ops
description: Reduce the deployed Cloud Functions by routing callables through domain routers, keeping every external name alive until it is provably unused.
---

# Cloud Functions consolidation plan (2026-09)

> Written 2026-09-19.

## 1. Why

`packages/functions` deploys one Cloud Function per callable, trigger, cron,
webhook and task handler. Each gen2 function is its own Cloud Run service. Nearly
every recurring ops failure scales with that count:

| Failure | Where it is recorded |
|---|---|
| Per-minute mutation quota → HTTP 429 during a full deploy | the retry loop in `.github/workflows/deploy-prod.yml` |
| Cloud Run CPU-capacity quota → deploy reports success while revisions are refused | `docs/launch/readiness-2026-08.md`, `docs/launch/analysis-2026-08-25.md` |
| firebase-tools 15.18 abandoned whole memory groups and exited 0 | the `Deploy complete!` grep in the deploy workflows |
| Green deploy with stale or refused revisions | `scripts/check-functions-ready.mjs` (`pnpm functions:ready`) |
| Emulator silently loads zero functions | `FUNCTIONS_DISCOVERY_TIMEOUT` in `scripts/emulators-run.mjs` |
| Long deploys and slow CI | — |

**Goal:** cut the number of deployables sharply without changing any behaviour,
any external URL or any name a live client calls.

## 2. Inventory

### 2.1 Recipe (re-run it; do not trust the snapshot below)

**Primary recipe: `scripts/functions-inventory.mjs`.** It loads the built bundle and
reads each export's `__endpoint`. This is the same manifest firebase-tools discovery
reads (firebase-functions 6.6.0, `lib/runtime/manifest.d.ts`). It gives kind, memory,
timeout, concurrency, minInstances, secrets and service account per export:

```bash
pnpm --filter @linyup/functions build    # the script reads whatever dist holds
pnpm functions:inventory                 # summary: total, by kind, by domain × kind,
                                         # non-default options, trigger paths several triggers share
pnpm functions:inventory --md            # the same summary as markdown tables (the snapshot below is this output)
pnpm functions:inventory --json          # one full record per function
pnpm functions:inventory --tsv           # one row per function
pnpm functions:inventory --dist <path>   # another build
```

Loading the bundle outside firebase-tools **works** (checked 2026-09-19). A plain
`require` of `packages/functions/dist/index.js` needs no environment variables and no
credentials: nothing evaluates a param (`defineString`, `defineInt`) at load, and an
option a function does not set comes back as the SDK's reset sentinel. A cold load
takes tens of seconds. The script also parses `packages/functions/src/index.ts` to
give each name its domain, and exits non-zero when the bundle and the index disagree
on the set of names, which is what a stale `dist` looks like. `enforceAppCheck` is not
part of the manifest, so the fallback recipe below still owns it. The script header
holds the detail, and the alternative if `__endpoint` ever goes away (the SDK's own
discovery binary).

**Fallback recipe.** This works from source, without a build. Run it in Git Bash from
`packages/functions/src`:

```bash
# totals per kind (exported const definitions only)
rg -U --no-heading "export const (\w+)(\s*:\s*[^=]+)?\s*=\s*\n?\s*(on\w+|before\w+)\s*[(<]" \
  -r '$3' -o -g '!*.test.ts' -g '!utils/reportError.ts' | sed 's/^[^:]*://' | sort | uniq -c
# per folder: same rg, then | sed -E 's#[\\/].*:# #' | sort | uniq -c
# cross-check: names re-exported from index.ts
sed -e 's#//.*##' index.ts | tr '\n' ' ' | grep -oE "export \{[^}]*\}" \
  | sed -E 's/export \{//; s/\}//' | tr ',' '\n' | sed -E 's/^\s+|\s+$//g' | grep -v '^$' | sort -u | wc -l
# options that make a function "heavy"
rg -n "memory:\s*'|timeoutSeconds:|minInstances|concurrency:|invoker:|retry:\s*true|enforceAppCheck" -g '!*.test.ts'
# Firestore trigger paths, grouped (input for the same-path merge in Phase 6)
rg -o --no-filename "onDocument(Written|Created|Updated|Deleted)\(\s*\{?[^'\"]*['\"][^'\"]+['\"]" -g '!*.test.ts' | sort | uniq -c | sort -rn
```

**Client names.** Run from the repo root. The coverage check exposes names passed
as variables:

```bash
# {1} is a no-op that keeps "]" and "(" apart: pnpm docs:check reads "](" as a markdown link
for a in mobile web admin landing help; do
  echo "== $a"
  rg -U -o --no-filename -r '$1' \
    "httpsCallable\s*(?:<[^()]*?>)?\s*\(\s*[^,]+?,\s*['\"\`]{1}([A-Za-z0-9_]+)['\"\`]" \
    apps/$a --glob '!**/node_modules/**' --glob '!**/.next/**' | sort -u
done
rg -c 'httpsCallable(FromURL)?\s*(<|\()' apps/web --glob '!**/node_modules/**'   # sites vs extracted names
```

### 2.2 Snapshot (recipe output, 2026-09-19; stale the day after)

Output of `pnpm functions:inventory --md`. It includes the routers built so far (`rpcSpike`, the throwaway
Phase 0 one, and `rpcOps`, the pilot) as `https` functions in the `routers` domain. Every endpoint is `gcfv2`, none
binds a secret and none sets a service account.

**299 deployable functions** — `packages/functions/dist/index.js`, built 2026-09-19T18:52Z. Global options: region=europe-west6, maxInstances=20.

**By kind**

| Kind | Count |
| --- | ---: |
| `callable` | 215 |
| `https` | 12 |
| `firestore.created` | 5 |
| `firestore.deleted` | 2 |
| `firestore.updated` | 2 |
| `firestore.written` | 44 |
| `pubsub` | 1 |
| `schedule` | 7 |
| `taskQueue` | 10 |
| `blocking.beforeCreate` | 1 |

**By domain × kind** (domain = the folder under `packages/functions/src` the index re-exports the name from; `fs.` = Firestore trigger)

| Domain | callable | https | fs.created | fs.deleted | fs.updated | fs.written | pubsub | schedule | taskQueue | blocking | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `contacts` | 25 |  |  |  |  | 2 |  |  |  |  | 27 |
| `sync` |  |  |  |  | 2 | 25 |  |  |  |  | 27 |
| `connect` | 25 | 1 |  |  |  |  |  |  |  |  | 26 |
| `booking` | 18 |  |  | 1 |  | 1 |  |  |  |  | 20 |
| `orgs` | 20 |  |  |  |  |  |  |  |  |  | 20 |
| `teams` | 11 |  | 1 |  |  |  |  |  |  |  | 12 |
| `waivers` | 10 |  | 1 |  |  |  |  |  |  |  | 11 |
| `whatsapp` | 9 | 1 |  |  |  |  |  |  | 1 |  | 11 |
| `saas-billing` | 7 | 1 |  |  |  |  |  | 1 |  |  | 9 |
| `tarif595` | 8 |  |  |  |  |  |  |  | 1 |  | 9 |
| `automation` | 2 | 1 |  |  |  | 4 |  |  | 1 |  | 8 |
| `analytics` |  |  |  |  |  | 4 | 1 | 2 |  |  | 7 |
| `api` | 6 | 1 |  |  |  |  |  |  |  |  | 7 |
| `auth` | 5 |  | 1 |  |  |  |  |  |  | 1 | 7 |
| `dailyTasks` |  |  |  |  |  |  |  | 2 | 5 |  | 7 |
| `sessions` | 6 |  |  |  |  |  |  |  | 1 |  | 7 |
| `accounting` | 5 |  |  |  |  | 1 |  |  |  |  | 6 |
| `appointments` | 6 |  |  |  |  |  |  |  |  |  | 6 |
| `events` | 5 |  |  |  |  | 1 |  |  |  |  | 6 |
| `ops` | 6 |  |  |  |  |  |  |  |  |  | 6 |
| `gamification` | 4 |  | 1 |  |  |  |  |  |  |  | 5 |
| `invoices` | 5 |  |  |  |  |  |  |  |  |  | 5 |
| `mail` | 4 | 1 |  |  |  |  |  |  |  |  | 5 |
| `affiliations` | 4 |  |  |  |  |  |  |  |  |  | 4 |
| `coaching` |  |  |  | 1 |  | 3 |  |  |  |  | 4 |
| `referrals` | 4 |  |  |  |  |  |  |  |  |  | 4 |
| `appstores` | 1 | 1 |  |  |  |  |  | 1 |  |  | 3 |
| `domains` | 3 |  |  |  |  |  |  |  |  |  | 3 |
| `plugins` | 1 |  |  |  |  | 2 |  |  |  |  | 3 |
| `aiInsights` | 1 |  |  |  |  |  |  |  | 1 |  | 2 |
| `billing` |  | 2 |  |  |  |  |  |  |  |  | 2 |
| `finance` | 1 |  |  |  |  |  |  | 1 |  |  | 2 |
| `offer` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `orgWebsite` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `payments` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `routers` |  | 2 |  |  |  |  |  |  |  |  | 2 |
| `website` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `assistant` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `bio-link` |  | 1 |  |  |  |  |  |  |  |  | 1 |
| `documents` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `feedback` |  |  | 1 |  |  |  |  |  |  |  | 1 |
| `forms` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `kiosk` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `outreach` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `translate` |  |  |  |  |  | 1 |  |  |  |  | 1 |
| **Total** | **215** | **12** | **5** | **2** | **2** | **44** | **1** | **7** | **10** | **1** | **299** |

**Non-default options** (set by the function, or different from the global options)

| Function | Domain | Kind | Options |
| --- | --- | --- | --- |
| `rebuildAccountingLedger` | `accounting` | callable | `memory=512` `timeout=540` |
| `generateTeamSentiment` | `aiInsights` | callable | `timeout=120` |
| `refreshTeamSentimentRound` | `aiInsights` | taskQueue | `memory=512` `timeout=540` |
| `capturePlatformMetrics` | `analytics` | schedule | `memory=512` `timeout=300` |
| `weeklyReports` | `analytics` | schedule | `memory=512` `timeout=300` |
| `api` | `api` | https | `memory=512` `timeout=60` `concurrency=40` `minInstances=param:API_MIN_INSTANCES` `maxInstances=10` `invoker=public` |
| `handleAppStoreWebhook` | `appstores` | https | `memory=512` `timeout=120` |
| `ingestAppStores` | `appstores` | schedule | `memory=512` `timeout=540` |
| `refreshStorePresence` | `appstores` | callable | `memory=512` `timeout=540` |
| `inboundWebhook` | `automation` | https | `invoker=public` |
| `handlePayrexxWebhook` | `billing` | https | `invoker=public` |
| `handleTeamStripeWebhook` | `billing` | https | `invoker=public` |
| `handleConnectWebhook` | `connect` | https | `invoker=public` |
| `bookingRemindersHourly` | `dailyTasks` | schedule | `memory=512` `timeout=300` |
| `dailyTasks` | `dailyTasks` | schedule | `memory=512` `timeout=300` |
| `financeReportForTeam` | `dailyTasks` | taskQueue | `timeout=540` |
| `noShowsForTeam` | `dailyTasks` | taskQueue | `timeout=300` |
| `remindersForTeam` | `dailyTasks` | taskQueue | `timeout=300` |
| `scheduledRulesForTeam` | `dailyTasks` | taskQueue | `timeout=540` |
| `weeklyReportForTeam` | `dailyTasks` | taskQueue | `timeout=540` |
| `monthlyFinanceReports` | `finance` | schedule | `memory=512` `timeout=540` |
| `processScoresRebuildJob` | `gamification` | firestore.created | `memory=1024` `timeout=540` |
| `recalculateScoresFromDate` | `gamification` | callable | `memory=1024` `timeout=540` |
| `handleBrevoWebhook` | `mail` | https | `invoker=public` |
| `manageDemoTenant` | `ops` | callable | `memory=512` `timeout=540` |
| `resyncTenantFeeRate` | `ops` | callable | `timeout=300` |
| `sendPlatformNotice` | `ops` | callable | `timeout=540` |
| `publishOrgWebsite` | `orgWebsite` | callable | `timeout=300` |
| `sendOutreachEmail` | `outreach` | callable | `memory=512` `timeout=540` |
| `onOrgBundleInstallChange` | `plugins` | firestore.written | `retry=true` |
| `onTeamBundleInstallChange` | `plugins` | firestore.written | `retry=true` |
| `rpcOps` | `routers` | https | `memory=512` `timeout=540` `cpu=1` `concurrency=10` `maxInstances=3` |
| `rpcSpike` | `routers` | https | `memory=512` `timeout=60` `cpu=1` `concurrency=40` |
| `handleStripeWebhook` | `saas-billing` | https | `invoker=public` |
| `handleTrialLifecycle` | `saas-billing` | schedule | `memory=1024` `timeout=540` |
| `runSeriesTeardown` | `sessions` | taskQueue | `timeout=540` |
| `runTarif595BulkIssue` | `tarif595` | taskQueue | `memory=1024` `timeout=540` |
| `startTarif595BulkIssue` | `tarif595` | callable | `timeout=300` |
| `suggestTarif595Mappings` | `tarif595` | callable | `memory=512` `timeout=120` |
| `publishWebsite` | `website` | callable | `timeout=300` |
| `handleWhatsAppWebhook` | `whatsapp` | https | `invoker=public` |

**Firestore trigger paths listened to by more than one trigger** (same event type, same `retry`)

| Path | Event | Retry | Triggers |
| --- | --- | --- | --- |
| `contacts/{contactId}` | written | no | `onContactSubscriptionChange`, `onContactWrite`, `syncAffiliationContactLive`, `trackContacts` |
| `sessions/{sessionId}` | written | no | `onSessionWrite`, `promoteWaitlistOnSeatFreed`, `syncSessionPublicProfile`, `trackSessions` |
| `contacts/{contactId}/credit_grants/{grantId}` | written | no | `heldPlansOnCreditGrantWrite`, `onCreditGrantWrite` |
| `sessions/{sessionId}/bookings/{bookingId}` | written | no | `onBookingWrite`, `trackBookings` |
| `teams/{teamId}/member_subscriptions/{subscriptionId}` | written | no | `heldPlansOnMemberSubscriptionWrite`, `onMemberSubscriptionWrite` |

**Clients.** These figures come from the client-names ripgrep recipe in §2.1, not from
the script:

- Mobile calls 17 names. Eight of them are mobile-only: `cancelContactDeletion`, `getContactQR`, `getMyAttendance`, `getMyReferralCode`, `getMyReferralStats`, `requestContactDeletion`, `selfCheckIn`, `switchActiveContact`.
- Web calls about 185 distinct names. Five web call sites pass the name through a helper: `apps/web/src/hooks/usePromoCodes.ts`, `apps/web/src/hooks/useSaasBilling.ts`, and `callWaitlist` in the session detail page (`apps/web/src/app/[locale]/(auth)/sessions/[id]/page.tsx`).
- Admin calls 5 names. Landing and help call none.

### 2.3 Facts the design depends on (verified in source)

- **One global option.** `setGlobalOptions({ region: 'europe-west6', maxInstances: 20 })`
  in `packages/functions/src/index.ts`. Every other option is set inline; there is
  no shared helper.
  - Heavy members set `memory` (`512MiB`, `1GiB`) and `timeoutSeconds` (300/540).
  - `api` alone sets `minInstances` and `concurrency`.
  - `packages/functions/src/plugins/bundleTriggers.ts` sets `retry: true`.
- **No secret is bound at deploy.** There is no `defineSecret`. Every secret is read at
  runtime from Secret Manager via `packages/functions/src/utils/secrets.ts`, and no
  function sets
  `serviceAccount`.
  - So every function already runs as the same identity and can read every secret.
  - Merging therefore widens no secret access. The "union of secrets" concern does
    not apply as the code stands.
  - Routers make per-domain service accounts cheap, as optional hardening (§9).
- **A callable is already a request handler.** In firebase-functions 6.6.0,
  `CallableFunction extends HttpsFunction`, which is `(req, res)`. `onCallHandler`
  runs `checkTokens` (ID token and App Check header), `enforceAppCheck` and CORS
  **in-process**. So an `onRequest` router can hand `(req, res)` to the existing
  callable value unchanged.
  - The callable protocol, `request.auth`, `request.app` and `HttpsError`
    serialisation are all preserved.
  - Caveat: at runtime the router's own memory, timeout, cpu and concurrency
    govern, and the member's own are ignored.
  - Verified in SDK source only. The Phase 0 spike proves it at runtime.
- **App Check.** `packages/functions/src/utils/appCheck.ts` holds two flags:
  - web: the checkout callables, `submitForm`, `previewPromoCode`, `checkGiftCard`
  - mobile: `sendContactVerificationCode`, `loginContactWithCode`

  Each value stays on its own callable and is enforced inside `onCallHandler`, so it
  survives routing.
- **Task queues are function names.** They are addressed as
  `locations/europe-west6/functions/<name>`:
  - `tenantQueueName` in `packages/functions/src/utils/tenantFanOut.ts`
  - literal names in the dispatchers
  - constants in `packages/functions/src/utils/automationEngine.ts`,
    `packages/functions/src/whatsapp/automation.ts`,
    `packages/functions/src/sessions/teardown.ts`,
    `packages/functions/src/aiInsights/teamSentimentRun.ts`,
    `packages/functions/src/tarif595/bulk.ts`

  Each handler has its own `retryConfig` and `rateLimits`.
- **Cold start does not get worse.** Every function already loads the whole
  `index.ts` bundle. `docs/public-api.md` records a 5.3s cold start for `api` for
  exactly that reason. A router loads the same bundle and runs fewer, warmer
  instances.

## 3. What merges, and what stays one-to-one

| Kind | Decision | Why |
|---|---|---|
| `onCall` | **Merge into domain routers.** | No event source binds them. This is essentially the whole win. |
| `onRequest` webhooks + `api` + `getInTouchForm` | **Stay, names frozen.** | Their URLs are registered outside the repo (table below). |
| `onTaskDispatched` | **Stay.** | The queue name is the function name, and each queue has its own retry and rate limits. Merging would drain and re-point every queue and fuse retry policies. |
| `onSchedule` | **Stay.** | One Cloud Scheduler job each. Folding them saves little and couples timeouts. |
| `onMessagePublished` (`handleBudgetNotification`) | **Stay.** | Topic contract in `infra/modules/budget`. |
| `beforeUserCreated` (`beforeSignup`) | **Stay.** | Blocking-function registration. |
| Firestore triggers | **Merge only same path + same event type + same `retry` setting** (optional, Phase 6). | A merged trigger re-runs all members on retry, so every member must already be idempotent. A wildcard catch-all trigger is rejected: it fires on every write (cost) and loses per-trigger retry. |

**Frozen external names.** Never rename these, and never let them drop out of the
exports:

| Name | Registered where |
|---|---|
| `handleStripeWebhook`, `handleConnectWebhook` | Stripe, via `scripts/stripe-sync.ts`. It matches endpoints **by function name**, so a rename creates a new endpoint with a new signing secret. |
| `handleTeamStripeWebhook?teamId=`, `handlePayrexxWebhook?teamId=` | Typed into each studio's own Stripe/Payrexx account (`docs/payment-contact-studio.md`) |
| `inboundWebhook` | Pasted by studios into third-party tools; also in the App Hosting configs (`apps/web/apphosting.yaml`, `apps/web/apphosting.sandbox.yaml`, `apps/web/apphosting.prod.yaml`) |
| `handleBrevoWebhook` | Brevo dashboard, by hand |
| `handleAppStoreWebhook` | App Store Connect, by hand (`docs/app-store-insights.md`) |
| `handleWhatsAppWebhook` | Meta app, by hand |
| `api` | Hosting rewrite in `firebase.json` (`api` target) |
| `handleBudgetNotification`, `beforeSignup` | Terraform topic and blocking-function contracts |
| every `onTaskDispatched` handler | queue path |

**Honest end state.** The callables collapse into a handful of routers. The frozen
HTTP set, the triggers, the task handlers and the schedules remain. Re-run the
inventory to size it. At the 2026-09-19 snapshot, that is roughly a third of today's
count, plus the mobile aliases while their window is open. Firestore triggers set
the floor. Only Phase 6 moves it, and only a little.

## 4. Target shape: domain routers inside the existing Firebase codebase

### 4.1 Server

- **New helper `packages/functions/src/utils/callableRouter.ts`.**
  `callableRouter(opts, table: Record<string, CallableFunction>)` returns an
  `onRequest(opts, (req, res) => …)`:
  - It reads the callable name from the last path segment
    (`/rpcStudio/createContact`).
  - It looks the name up in `table`. An unknown name gets a callable-protocol
    `NOT_FOUND` JSON error.
  - It logs one structured line `{ router, callable, ms, status }`.
  - It then `return table[name](req, res)`.
  - The router sets no `invoker`, the same as today's callables. Their invoker
    posture is carried over unchanged; confirm it in the spike.
- **Router options:**
  - `cpu: 1` and an explicit `concurrency` (start at 40, like `api`). This is a sizing
    choice, not a rescue: a plain callable here already deploys at 1 cpu and concurrency
    80 (measured on staging, 2026-09-19 — an earlier draft of this plan claimed a
    fractional-CPU, concurrency-1 default, and that was wrong). A router carries a whole
    domain, so its concurrency is stated where the next reader will look for it.
  - Its own `maxInstances`, sized per router. The global 20 is per function, and a
    router puts many functions under one cap.
  - `memory` and `timeoutSeconds` set to the max of its members.
- **Tables are built from the existing exported values**, e.g.
  `rpcStudio = callableRouter(STUDIO_OPTS, { createContact, updateContact, … })`.
  - Handler code is untouched.
  - While a name is still in its alias window, the same object is also exported
    standalone from `index.ts`, so there is zero duplicated logic.

### 4.2 Grouping (by audience, option profile and blast radius, not purely by folder)

| Router | Members (derive exact list from inventory in Phase 0) | Profile |
|---|---|---|
| `rpcMember` | Contact-session and anonymous hot path: booking, appointments, waitlist, contact auth/OTP, Space, referrals, the contact self-service callables | Latency-sensitive; `minInstances: 1` candidate |
| `rpcCheckout` | Checkouts, promo preview, gift cards (the App Check-enforced set) | Money path; separate blast radius |
| `rpcStudio` | Staff CRUD: contacts, teams, events, sessions, waivers, documents, forms, kiosk, automations, plugins, domains, mail, whatsapp, AI, api keys | Default profile |
| `rpcFinance` | finance, accounting, invoices, tarif595, connect admin (non-checkout), payments admin | Staff-only, low traffic |
| `rpcOrg` | orgs, orgWebsite | Default |
| `rpcBilling` | saas-billing | Default |
| `rpcHeavy` | Every callable that today sets `1GiB` or `≥300s`: website publish, accounting rebuild, gamification recalculation, outreach, bulk jobs | 1GiB, 540s, low concurrency |
| `rpcOps` | Operator console (`manageDemoTenant`, `previewPlatformNotice`, `sendPlatformNotice`, `resyncTenantFeeRate`, `setReviewAccess`) and the rest of `packages/functions/src/ops` | Privileged; isolated |

- **Membership rule.** A callable goes to `rpcHeavy` when its options say it is
  heavy, whatever its folder. Otherwise it goes by audience, then by folder.
- **Enforcement.** A unit test asserts that every callable in the inventory is in
  exactly one router table, or on a named "not routed" list. Nothing is silently
  unrouted.
- **Until routing is nearly complete.** Full-coverage enforcement (every callable
  routed, or deliberately listed as not routed) switches on once routing is nearly
  complete. Until then `packages/functions/src/utils/routerCoverage.test.ts` pins
  agreement between the router tables and `packages/shared/src/functions/routes.ts`,
  and that no callable sits in two routers.

### 4.3 Clients

- **Route table.** `packages/shared/src/functions/routes.ts` maps each callable name
  to its router: `Record<string, RouterName>`. It is the one place the grouping is
  written down. The file also owns `functionsBaseUrl` and `callableRouteUrl`, which
  build the URLs the client helper calls.
- **Helper.** `callFunction<Req, Res>(name)` in `apps/web/src/lib/`, `apps/mobile/src/services/`
  and `apps/admin/src/lib/`:
  - When routed, it returns
    `httpsCallableFromURL(functions, `${base}/${router}/${name}`)`.
  - Otherwise it returns `httpsCallable(functions, name)`.
  - `base` is `https://europe-west6-${projectId}.cloudfunctions.net`. In the
    emulator it is `http://127.0.0.1:${functionsPort}/${projectId}/europe-west6`,
    using the port from the checkout's slot. Each app's helper takes the host from
    wherever that app already resolves its emulator host, so on web it is the page
    hostname.
  - Gen2 `cloudfunctions.net` path pass-through is **unverified**. The spike checks
    it; the fallback is `?fn=` in the query.
- **Migrating call sites.** Every `httpsCallable(functions, 'x')` becomes
  `callFunction('x')`. This also retires the variable-name helpers, whose names then
  become literals and are visible to the recipe.
- **Rollback.** Flipping a router's entries back to "unrouted" in the route table
  returns web and admin to the alias names in one deploy. **Mobile is slower:** the
  route table is compiled into the app bundle, so an installed build only picks up the
  flip through an OTA or a store update. That is why mobile routes last (Phase 4), and
  only names whose router has already soaked on web.

### 4.4 Rejected alternative: standalone Cloud Run services (Express/Hono)

- It adds a second deploy system (image build plus gcloud or Terraform) beside
  `firebase deploy`, with its own IAM and rollout.
- The functions emulator will not serve it, which breaks `local-env`, seeders and
  every worktree slot.
- It would re-implement the callable protocol, or import `onCallHandler` anyway.
- It buys nothing a gen2 `onRequest` router does not already have: that router
  **is** a Cloud Run service.
- It stays open for later, because router tables are plain `(req, res)` handlers
  that mount in Express unchanged.

**Also considered, as a complement rather than a replacement:** splitting
`firebase.json` into several **codebases** (e.g. `core`, `member`, `ops`) so domains
deploy independently. Defer this until after Phase 5. With few deployables, the
monolithic deploy stops hurting.

## 5. Compatibility and aliases

- **Old callable names stay deployed, unchanged, as aliases.** This is the same
  exported object, now also listed in a router table. A client on the old name keeps
  working with identical semantics.
- **Knowing a name is unused needs no new code.** An alias is still its own Cloud
  Run service, so `run.googleapis.com/request_count`, filtered by
  `resource.labels.service_name`, is the usage signal. Phase 0 adds one saved Metrics
  Explorer query per wave, "requests per alias service, last 30 days". The router's
  structured `callable` log field becomes a log-based metric (§7), giving per-callable
  counts once the alias is gone.
- **Exit criteria** (a name is removed only when all of its conditions hold):

| Caller set | Condition |
|---|---|
| web-only / admin-only names | Web or admin has shipped on `callFunction` for that router, **and** 14 consecutive days show zero requests on the alias service. The tail is stale browser tabs. |
| names mobile calls | A store build calling via `callFunction` is live, **and** `app_settings/mobile.min_supported_version` has been raised to or past that build (`.claude/skills/mobile-release/SKILL.md` → "Backend compatibility"), **and** 30 consecutive days show zero requests. |

  Reason for the stricter mobile rule: an OTA only reaches binaries whose native
  fingerprint matches, so older store installs keep their embedded bundle and keep
  calling old names until `min_supported_version` forces an update.
- **Deletion guard.** The deploy uses `--force`, so an export removed from `index.ts`
  is **deleted in the cloud without a prompt**, and `pnpm functions:ready` cannot see
  a function that no longer exists. Phase 0 therefore adds
  `packages/functions/src/utils/frozenFunctions.test.ts`. It reads `index.ts`
  (CRLF-normalised, see the source-reading rule in CLAUDE.md) and asserts that every
  name on a checked-in frozen list is still exported. The list holds:
  - the §3 frozen table
  - every task handler
  - every alias whose exit criterion has not been met, with a comment naming the
    criterion

  Removing an alias means deleting its line from that list, in the same PR, with the
  evidence in the PR body.

## 6. Phases

Every phase is independently shippable and reversible. Until Phase 5, nothing is
deleted, so reverting the route table always restores the previous behaviour.

### Phase 0: tooling and spike (~2–3 days)
1. Build `scripts/functions-inventory.mjs` (§2.1) and add `pnpm functions:inventory`.
2. Build `packages/functions/src/utils/callableRouter.ts` and its unit tests. The tests cover dispatch, an
   unknown name, and one member that throws `HttpsError` and serialises correctly.
3. Add the route table in `packages/shared`, plus `callFunction` in web, mobile and
   admin (all names unrouted, so there is no behaviour change).
4. Add `frozenFunctions.test.ts`, and a router-coverage test: every callable is in
   one router or on the not-routed list.
5. **Spike on staging** with a throwaway `rpcSpike` holding two harmless callables.
   Prove each of:
   - `request.auth` is present, both staff and contact-session custom token
   - App Check is enforced when the flag is on (the call fails without a token)
   - CORS from the web origin
   - `HttpsError` codes reach the client unchanged
   - the path pass-through on `cloudfunctions.net`
   - the emulator URL shape
   - `gcloud run services describe` shows the intended cpu and concurrency
6. Measure and record the router's cold start next to the 5.3s `api` figure.

**Done locally, 2026-09-19 (steps 1–4, and the emulator half of step 5).** Each call was
made twice against the functions emulator, once straight at the callable and once through
`rpcSpike` with `httpsCallableFromURL`, and the two outcomes were compared:

| Check | Direct and routed |
|---|---|
| Anonymous `listAvailability`, valid and invalid payloads | identical result and identical `invalid-argument` error |
| Signed-out `getMyBookings` | identical `unauthenticated` |
| `getMyBookings` with a contact-session custom token | identical; both get past auth, so `request.auth` and its claims reach the member |
| Unknown name through the router | `not-found`, readable by the client SDK |
| Emulator URL shape `{base}/{router}/{name}` | works; the router reads the last path segment |
| Router log line | one `callable-router` line per call, with `router`, `callable`, `status` and `ms` |
| CORS preflight | same origin and headers. The routed answer lists more methods, because the functions emulator switches on the SDK's `enableCors` debug feature for every `onRequest`, so that wrapper answers before the member does. It is off on a deployed function. `packages/functions/src/utils/callableRouter.test.ts` serves each member both ways without it and requires identical preflights. |

The comparison is a committed script, `scripts/router-spike.mjs`, so it re-runs against
any target:

```bash
node scripts/router-spike.mjs --target emulator --functions-port 5001 --auth-port 9099
node scripts/router-spike.mjs --target linyup-staging --api-key <the web API key>
```

**Done on staging, 2026-09-19** (`rpcSpike` deployed by the merge of Phase 0; the deploy
and its `functions:ready` gate were green):

| Check | Result |
|---|---|
| Path pass-through on `cloudfunctions.net` | works: `…cloudfunctions.net/rpcSpike/listAvailability` reaches the member |
| Results and error codes, direct vs routed | identical |
| Signed-out `getMyBookings` | `unauthenticated` both ways |
| CORS preflight from the staging web origin | identical, allowed methods included — the emulator difference above does not exist off the emulator |
| Invoker | `allUsers` on the router, the same as on a plain callable |
| Deployed options (`gcloud run services describe rpcspike`) | concurrency 40, 1 cpu, 512Mi, max 20 instances — as written |
| Warm latency (Cloud Run request log) | the same direct and routed, to within a few milliseconds |
| Router log line | present in Cloud Logging with `router`, `callable`, `status`, `ms` |

**Still owed:**
- The signed-in check with a real ID token. The script does it when `ROUTER_SPIKE_EMAIL`
  and `ROUTER_SPIKE_PASSWORD` are set, and skips it otherwise. The emulator run proved
  it with a contact-session token.

**Cold start, measured on staging 2026-09-19** after 25 idle minutes, one call each: routed
3.97s, direct 3.69s; warm, 111ms and 101ms. A router starts no slower than the callable it
serves, which is what loading the same bundle predicts. It is one sample per side, so read
it as "the same", not as a 0.3s difference.

**App Check cannot be exercised on a deployed project today.** `APP_CHECK_ENFORCE` and
`APP_CHECK_ENFORCE_MOBILE` are `false` in every environment, so nothing is refused for
a missing token anywhere. Enforcement through a router is proven in-process only:
`packages/functions/src/utils/callableRouter.test.ts` puts an `enforceAppCheck: true`
member behind a real router and requires the refusal. Re-run the spike against the first
environment that turns the flag on.

**Rollback:** delete `rpcSpike`. Nothing else is live.

### Phase 1: pilot `rpcOps` (~1–2 days + 1 week soak)
- **Why this domain** (Franco, 2026-09-19): the operator console is the smallest blast
  radius there is. Its only callers are operators, in the admin app, so a bad router
  inconveniences us and no studio, and it has **zero mobile and zero web call sites**.
  It still exercises the long-timeout option profile: some members run to 540s. What it
  does not prove is behaviour under load, which Phase 3 owns.
- **Steps:**
  - Add `packages/functions/src/routers/ops.ts` over the operator callables in
    `packages/functions/src/ops`, with `timeoutSeconds` and `memory` at the max of
    its members.
  - Mark its names routed in `packages/shared/src/functions/routes.ts`.
  - Migrate the admin app's call sites to `callFunction`
    (`apps/admin/src/lib/callFunction.ts`).
- **Success:**
  - Every operator action works from the console on staging.
  - The router's 5xx rate is no worse than the alias services had before.
  - The alias services' request_count falls to zero once the admin rollout is live.
- **Rollback:** flip the route-table entries back.
- **On staging since 2026-09-19.** `node scripts/router-spike.mjs --target linyup-staging
  --routers rpcOps` calls every member signed out, direct and routed, and requires the
  same refusal both ways; it passes there and on the emulator. The deployed service is as
  written: concurrency 10, 1 cpu, 512Mi, max 3 instances, 540s.
- **Still owed before production:** a click-through of the operator console on staging
  with the console itself routing (demo tenant, review access, fee-rate resync, notice
  preview). The staging deploy workflow has no step for the console — only the production
  one does — so the console routes once its App Hosting backend has rolled out, and keeps
  working on the standalone names until then.

### Phase 2: staff web domains (~1–2 days each)
- Order: `rpcFinance`, `rpcBilling`, `rpcOrg`, `rpcHeavy`, `rpcStudio`.
- `rpcFinance` migrates the finance, tarif-595 and qr-invoices plugin hooks
  (`apps/web/src/plugins/finance/hooks.ts`, `apps/web/src/plugins/tarif-595/hooks.ts`,
  `apps/web/src/plugins/qr-invoices/hooks.ts`).
- Same steps and success signal as Phase 1.
- Migrate `apps/web/src/hooks/useSaasBilling.ts` and
  `apps/web/src/hooks/usePromoCodes.ts` to literal `callFunction` names here.

### Phase 3: public and member web (~2 days + 1 week soak)
- `rpcCheckout`, then `rpcMember`, web side only. This is the hot path.
- Watch the checkout 5xx rate against Stripe checkout-session creation counts.
- Decide `minInstances: 1` on `rpcMember` from the measured cold start.
- Keep `sendContactVerificationCode` and `loginContactWithCode` on their mobile App
  Check flag inside the router.

### Phase 4: mobile (~1 day of code, then months of calendar)
- Move `apps/mobile/src/services/firestore.ts` to `callFunction`.
- Ship it as an OTA **and** in the next store build.
- Record the first store version that routes. That version is what
  `min_supported_version` has to reach.
- Every name mobile calls stays on the frozen list until its §5 criterion holds.

### Phase 5: alias-removal waves (~0.5 day per wave)
- Per router, once the exit criterion holds:
  - remove the standalone exports from `index.ts`
  - drop the names from the frozen list
  - deploy
- **This is where the deployable count actually drops.** Web and admin waves can
  start about 14 days after their phase ships. The mobile wave waits on
  `min_supported_version`.

### Phase 6 (optional): same-path trigger merges (~2–3 days)
- Use the trigger-path recipe (§2.1) to find paths that more than one trigger listens
  on, with the same event type and the same `retry` setting.
- Merge only where every member is already idempotent, and say so in the merged
  trigger's header.
- A merged trigger gets a new name, so the old trigger and the new one overlap for
  one deploy. Each member must be safe to run twice on the same event.

### Phase 7: pipeline cleanup (~0.5 day)
See §8.

## 7. Runtime trade-offs

- **Cold starts.** The bundle is unchanged, because every function already loads the
  whole index. There are fewer services and warmer instances. If routers still cold
  start slowly, lazily `require` members inside the router table; `api` already does
  this for `./mcp/server`.
- **Concurrency and `maxInstances`.** Today each callable has its own 20 instances at
  concurrency 80. A router puts a whole domain behind ONE such pool, so its
  `concurrency` × `maxInstances` is the domain's ceiling and has to be sized on purpose:
  small for `rpcOps`, generous for `rpcMember`. Size it from the alias services'
  request_count before each phase.
- **Blast radius.**
  - A bad router deploy takes down a domain, not one function.
  - Mitigation: separate `rpcCheckout` and `rpcOps`.
  - During the alias window, rollback is a route-table flip.
  - After the window, rollback is a redeploy.
- **Per-function logs and metrics.**
  - Replaced by a log-based metric on the router's `callable` field. Add it to
    `infra/modules/monitoring/main.tf` beside `linyup-error-count`, with `callable`
    as a label.
  - The existing error alert keys on resource type, so it keeps working unchanged.
  - The `apps/admin/src/lib/opsLinks.ts` filters only name webhooks, which stay.
- **Cost.**
  - Fewer idle services, and fewer image builds per deploy.
  - A `minInstances: 1` on `rpcMember` is a deliberate, small, always-on cost.
- **Cloud Run CPU quota.** Whether the quota counts services × `maxInstances` × cpu
  is **unverified**. Check the regional quota page before and after Phase 2, because
  routers with `cpu: 1` and a larger `maxInstances` could shift that sum either way.

## 8. Deploy pipeline after consolidation

| Piece | Keep? | Reason |
|---|---|---|
| `--only functions,…` monolithic deploy | Keep | With few deployables it is fast. Splitting into codebases is §4.4's optional follow-up. |
| 5×30s retry loop | Keep | Also covers WIF/STS exchange flakes. It becomes a no-op in practice. |
| `grep 'Deploy complete!'` gate | Keep | Cheap. It guards against any future CLI regression. |
| `pnpm functions:ready` | Keep | It is still the truth for refused revisions. Its hash rule assumes no deploy-time secrets. If routers ever adopt `defineSecret`, the rule must learn that; the script header says so. |
| `--force` | Keep, **guarded** | `frozenFunctions.test.ts` makes a silent deletion of a frozen name fail CI first. |
| `FUNCTIONS_DISCOVERY_TIMEOUT=120` | Keep | Discovery time is module load, not function count. Re-measure after Phase 5. Also add it to the bare `emulators:start` script, which lacks it today. |

**Files the implementation touches:**
- The deploy workflows (`.github/workflows/deploy.yml`,
  `.github/workflows/deploy-sandbox.yml`, `.github/workflows/deploy-prod.yml`):
  comment updates only.
- `scripts/check-functions-ready.mjs`: none expected.

## 9. Risks, and the signal that says a phase went wrong

| Risk | Signal | Response |
|---|---|---|
| Auth context lost under the router | Spike test; `unauthenticated` rate on the router rises | Flip route table back |
| App Check silently not enforced | Spike test with the flag on; a call without a token must fail | Block the phase |
| Router pool too small for its domain | p95 latency up, instance count at `maxInstances`, 429s from Cloud Run | Raise `concurrency` or `maxInstances`, redeploy |
| `HttpsError` codes change shape | Client error telemetry; the router unit test | Flip back, fix |
| Alias removed while still called | `frozenFunctions.test.ts` fails CI; request_count checked in the PR | Re-export the name (same object) |
| Task queue or webhook renamed by accident | `frozenFunctions.test.ts` | CI blocks it |
| A callable is left unrouted and forgotten | Router-coverage test | CI blocks it |
| Merged trigger double-applies on retry (Phase 6) | Duplicate writes in the affected collection | Split back; the phase is optional |

**Optional hardening that routers make cheap:**
- A service account per router, granted only the secrets its members read (the
  secret-name map is in the `packages/functions/src/utils/secrets.ts` call sites).
- `rpcMember` and `rpcCheckout` would then no longer hold, for example,
  `cloudflare-api-token` or `apple-asc-private-key`.
- Not required for behaviour parity. It is a follow-up.

## 10. Effort

| Phase | Engineering | Calendar |
|---|---|---|
| 0 tooling + spike | 2–3 days | — |
| 1 pilot | 2 days | + 1 week soak |
| 2 staff web | 5–8 days | spread over 2–3 weeks |
| 3 public/member web | 2 days | + 1 week soak |
| 4 mobile | 1 day | until `min_supported_version` moves |
| 5 alias removal | about 0.5 day per wave | web/admin from ~14 days after each phase; mobile after Phase 4's window |
| 6 trigger merges (optional) | 2–3 days | — |
| 7 pipeline cleanup | 0.5 day | — |

**Total:** about 3–4 weeks of engineering, spread over a few months by the mobile
window.

## 11. Open questions for Franco

1. ~~**Pilot:** `rpcFinance` or `rpcOps`?~~ **Decided 2026-09-19: `rpcOps`.**
2. **End state:** the realistic floor is set by the Firestore triggers, task handlers
   and frozen webhooks (§3). That is about a third of today's count, not "a few
   dozen". Is that acceptable, or should Phase 6 be pushed harder?
3. **Mobile window:** is "`min_supported_version` past the first routing build, plus
   30 quiet days" the right bar? When are you willing to raise the minimum?
4. **`minInstances: 1` on `rpcMember`:** accept the small always-on cost for booking
   latency?
5. **Per-router service accounts** (§9): fold them into this work or defer?
6. **Multiple Firebase codebases** (§4.4): wanted at all, once the count is down?

## Verification of this document

- `pnpm docs:check` and `pnpm docs:index:check` pass after `pnpm docs:index`.
- Every figure in it is either labelled as dated recipe output (§2.2) or points at the
  recipe.
- Every claim that has not been proven at runtime is marked unverified. That covers:
  - `cloudfunctions.net` path pass-through
  - the CPU-quota arithmetic
