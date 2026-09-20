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

Output of `pnpm functions:inventory --md`. It includes every router: all callables are now routed, and each ALSO still deploys under its own name until its alias is removed (Phase 5), which is why the total has gone UP, not down as `https` functions in the `routers` domain. Every endpoint is `gcfv2`, none
binds a secret and none sets a service account.

**291 deployable functions** — `packages/functions/dist/index.js`, built 2026-09-20T00:07Z. Global options: region=europe-west6, maxInstances=20.

**By kind**

| Kind | Count |
| --- | ---: |
| `callable` | 201 |
| `https` | 18 |
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
| `sync` |  |  |  |  | 2 | 25 |  |  |  |  | 27 |
| `connect` | 23 | 1 |  |  |  |  |  |  |  |  | 24 |
| `contacts` | 20 |  |  |  |  | 2 |  |  |  |  | 22 |
| `orgs` | 20 |  |  |  |  |  |  |  |  |  | 20 |
| `booking` | 17 |  |  | 1 |  | 1 |  |  |  |  | 19 |
| `teams` | 11 |  | 1 |  |  |  |  |  |  |  | 12 |
| `waivers` | 10 |  | 1 |  |  |  |  |  |  |  | 11 |
| `whatsapp` | 9 | 1 |  |  |  |  |  |  | 1 |  | 11 |
| `saas-billing` | 7 | 1 |  |  |  |  |  | 1 |  |  | 9 |
| `tarif595` | 8 |  |  |  |  |  |  |  | 1 |  | 9 |
| `automation` | 2 | 1 |  |  |  | 4 |  |  | 1 |  | 8 |
| `routers` |  | 8 |  |  |  |  |  |  |  |  | 8 |
| `analytics` |  |  |  |  |  | 4 | 1 | 2 |  |  | 7 |
| `api` | 6 | 1 |  |  |  |  |  |  |  |  | 7 |
| `auth` | 5 |  | 1 |  |  |  |  |  |  | 1 | 7 |
| `dailyTasks` |  |  |  |  |  |  |  | 2 | 5 |  | 7 |
| `accounting` | 5 |  |  |  |  | 1 |  |  |  |  | 6 |
| `appointments` | 6 |  |  |  |  |  |  |  |  |  | 6 |
| `events` | 5 |  |  |  |  | 1 |  |  |  |  | 6 |
| `invoices` | 5 |  |  |  |  |  |  |  |  |  | 5 |
| `mail` | 4 | 1 |  |  |  |  |  |  |  |  | 5 |
| `ops` | 5 |  |  |  |  |  |  |  |  |  | 5 |
| `sessions` | 4 |  |  |  |  |  |  |  | 1 |  | 5 |
| `affiliations` | 4 |  |  |  |  |  |  |  |  |  | 4 |
| `coaching` |  |  |  | 1 |  | 3 |  |  |  |  | 4 |
| `referrals` | 4 |  |  |  |  |  |  |  |  |  | 4 |
| `domains` | 3 |  |  |  |  |  |  |  |  |  | 3 |
| `gamification` | 2 |  | 1 |  |  |  |  |  |  |  | 3 |
| `plugins` | 1 |  |  |  |  | 2 |  |  |  |  | 3 |
| `aiInsights` | 1 |  |  |  |  |  |  |  | 1 |  | 2 |
| `appstores` |  | 1 |  |  |  |  |  | 1 |  |  | 2 |
| `billing` |  | 2 |  |  |  |  |  |  |  |  | 2 |
| `finance` | 1 |  |  |  |  |  |  | 1 |  |  | 2 |
| `offer` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `orgWebsite` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `payments` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `website` | 2 |  |  |  |  |  |  |  |  |  | 2 |
| `assistant` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `bio-link` |  | 1 |  |  |  |  |  |  |  |  | 1 |
| `documents` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `feedback` |  |  | 1 |  |  |  |  |  |  |  | 1 |
| `forms` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `kiosk` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `outreach` | 1 |  |  |  |  |  |  |  |  |  | 1 |
| `translate` |  |  |  |  |  | 1 |  |  |  |  | 1 |
| **Total** | **201** | **18** | **5** | **2** | **2** | **44** | **1** | **7** | **10** | **1** | **291** |

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
| `handleBrevoWebhook` | `mail` | https | `invoker=public` |
| `manageDemoTenant` | `ops` | callable | `memory=512` `timeout=540` |
| `resyncTenantFeeRate` | `ops` | callable | `timeout=300` |
| `sendPlatformNotice` | `ops` | callable | `timeout=540` |
| `publishOrgWebsite` | `orgWebsite` | callable | `timeout=300` |
| `sendOutreachEmail` | `outreach` | callable | `memory=512` `timeout=540` |
| `onOrgBundleInstallChange` | `plugins` | firestore.written | `retry=true` |
| `onTeamBundleInstallChange` | `plugins` | firestore.written | `retry=true` |
| `rpcBilling` | `routers` | https | `cpu=1` `concurrency=40` |
| `rpcCheckout` | `routers` | https | `memory=512` `cpu=1` `concurrency=80` |
| `rpcFinance` | `routers` | https | `memory=512` `timeout=120` `cpu=1` `concurrency=40` |
| `rpcHeavy` | `routers` | https | `memory=1024` `timeout=540` `cpu=1` `concurrency=4` |
| `rpcMember` | `routers` | https | `memory=512` `cpu=1` `concurrency=80` |
| `rpcOps` | `routers` | https | `memory=512` `timeout=540` `cpu=1` `concurrency=10` `maxInstances=3` |
| `rpcOrg` | `routers` | https | `cpu=1` `concurrency=40` |
| `rpcStudio` | `routers` | https | `memory=512` `timeout=120` `cpu=1` `concurrency=40` |
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
- **Enforced since every domain moved (2026-09-20).**
  `packages/functions/src/utils/routerCoverage.test.ts` pins agreement between the router
  tables and `packages/shared/src/functions/routes.ts`, that no callable sits in two routers,
  and that no deployed callable is in none.

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
- **`rpcFinance` built 2026-09-19** (`packages/functions/src/routers/finance.ts`): the
  journal, the monthly export, QR invoices and Tarif 595 receipts. Left out on purpose:
  `rebuildAccountingLedger` and `startTarif595BulkIssue` (minutes-long, so `rpcHeavy`)
  and `listMyTarif595Receipts` (the member's own copy, so `rpcMember`). The manual-payment
  and refund callables in `apps/web/src/hooks/useConnect.ts` join it in a later step.
- **`rpcFinance` is on staging since 2026-09-19**, deployed as written, and
  `node scripts/router-spike.mjs --target linyup-staging --routers rpcFinance` passes.
  Owed: a signed-in click through the finance screens there (a month's CSV export, an
  invoice PDF, a Tarif 595 preview) — the one path the spike cannot take.
- **`rpcBilling` built 2026-09-19** (`packages/functions/src/routers/billing.ts`): what
  a studio or an organisation pays Linyup. Team and org callables sit together because
  `apps/web/src/hooks/useSaasBilling.ts` treats them as one flow; each keeps its own
  authorisation. That hook still picks the name from the billing scope, so its names
  reach `callFunction` through a variable and the client-names recipe in §2.1 does not
  see them — read the hook.
- **`rpcBilling` is on staging since 2026-09-19**, deployed as written, and the spike with
  `--routers rpcBilling` passes there. Owed: a signed-in look at Settings → Billing
  (invoices list, portal link).
- **`rpcOrg` built 2026-09-20** (`packages/functions/src/routers/org.ts`): member studios,
  org members and their invitations, taking the org website offline. The invitation pages
  call some of its members signed out, which stays each member's own decision.
  `publishOrgWebsite` runs for minutes, so it waits for `rpcHeavy`.
- **`rpcOrg` is on staging since 2026-09-20**, deployed as written. Its spike found a
  STAGING defect that has nothing to do with routing: the standalone `inviteOrgMember` and
  `getOrgMemberInvitation` services there have an EMPTY invoker policy (no `allUsers`), so
  Cloud Run refuses every direct call with a bare `permission-denied` before the callable
  runs. Sandbox and production have the binding. The routed path works, because the router
  has its own policy. It is the "green deploy, broken function" class that
  `scripts/check-functions-ready.mjs` cannot see — it checks revisions, not invoker IAM —
  and the spike script is, by accident, a check for it: a direct-vs-routed difference where
  the direct side is a bare `permission-denied`.
  **Fixed 2026-09-20** by granting `allUsers` the `roles/run.invoker` role on those two
  services (`gcloud run services add-iam-policy-binding`), which is what every other callable
  there already had. The spike then passed on staging with no failure at all, for every router.
  How the two lost the binding was not established; a redeploy that fails to set IAM on a new
  function is the likely cause.
  **`scripts/check-functions-ready.mjs` now checks it (check 5):** every function meant to be
  called from outside — read off the labels firebase-tools writes, not listed — must grant
  `roles/run.invoker` to `allUsers`. Run read-only on the day it was written it found the SAME
  defect on production (`suggestTarif595Mappings`, `handleAppStoreWebhook`,
  `refreshStorePresence`) and on sandbox (`suggestTarif595Mappings`): healthy by every other
  check, and refusing every caller. They are all recently CREATED functions, which fits a create
  that succeeded followed by an IAM call that was rate-limited. **It fails the deploy workflows
  until those bindings are restored** — the script prints the command for each — and that is the
  check working: a release whose new routers came up without an invoker would now stop at the
  gate instead of reaching users.
- **`rpcHeavy` and `rpcStudio` built 2026-09-20, in ONE PR** (see the redeploy note below).
  `packages/functions/src/routers/heavy.ts` takes the callables that run for minutes or want
  a gigabyte, so that their profile is paid only by the calls that need it.
  `packages/functions/src/routers/studio.ts` takes every other staff callable. The staff side
  of member payments (Connect, subscriptions, refunds, manual payments, gift cards, promo
  codes) joined `rpcFinance`. What is left unrouted is exactly Phase 3: everything a member,
  a guest or the member app calls.
- **`rpcHeavy`, `rpcStudio` and the payments side of `rpcFinance` are on staging since
  2026-09-20**, each deployed as written. The spike passes for every router there, run with
  the DEPLOYED commit's route table (`--routes-ref`, see Phase 3). The two differences left are
  the staging invoker defect above, where the routed side is the one that works.
- **Some callables have no client caller at all** — no literal, no variable, in web, admin or
  mobile. They were routed with their domain. `scripts/functions-inventory.mjs` lists
  callables; pair it with the client-names recipe in §2.1 to list these, and consider
  deleting them instead of carrying them.
- **A test may pin the SPELLING of a call.** Two tests read the org Members page for the
  literal `httpsCallable(functions, 'x')` and read its move to `callFunction('x')` as "invokes
  nothing". They now accept either spelling. Run the WHOLE functions suite before a routing
  PR, not only the router tests: that failure reached CI because only the latter were run.
- **Every routing PR is a FULL redeploy.** The route table lives in `packages/shared`,
  which is vendored into every function, so changing it changes every function's source
  hash: the staging deploy step for `rpcBilling` took about eleven minutes, 429 retries
  included. That is how any change to shared behaves, and it shrinks as aliases are
  removed — but until then, prefer routing several domains in one PR over one PR each.
- **Web builds its callables at module load** (`export const callX = …` in the plugin
  hooks), and those modules are also loaded on the server while Next prerenders. So
  `apps/web/src/lib/callFunction.ts` builds a routed URL lazily, on first call: building
  it at import would read the emulator host with no `window`, and throw on a build whose
  env has no project id.
- `apps/web/src/hooks/usePromoCodes.ts` manages codes (staff), so it moved with `rpcFinance`;
  only `previewPromoCode`, which a buyer calls, waits for `rpcCheckout` in Phase 3.

### Phase 3: public and member web (~2 days + 1 week soak)
- `rpcCheckout`, then `rpcMember`, web side only. This is the hot path.
- Watch the checkout 5xx rate against Stripe checkout-session creation counts.
- Decide `minInstances: 1` on `rpcMember` from the measured cold start (about four seconds,
  the same routed as direct). It is NOT set: an open question below.
- **Built 2026-09-20.** `packages/functions/src/routers/checkout.ts` is where a member or a
  guest PAYS — its own router for blast radius, apart from the booking surface and apart from
  staff finance. `packages/functions/src/routers/member.ts` is everything else a member or a
  guest does. Both run at concurrency 80, what a plain callable gets today, so routing takes
  nothing away from the hot path. App Check stays on each member that carries it (the checkouts,
  `previewPromoCode`, `checkGiftCard`, `submitForm`; the contact sign-in pair on the mobile
  flag) and is enforced inside the member's own handler.
- **Proven from a BROWSER, 2026-09-20** (`apps/web/e2e/callable-routing.spec.ts`, against a
  local emulator with the app built from this code). Signed in as staff, the screens call
  `rpcStudio/listTeamMembers` and `rpcStudio/confirmEmailVerified` and get a 200 with a real ID
  token; signed out, the public booking and appointment pages call
  `rpcMember/listAvailability` and get a 200. No routed name was ALSO requested under its own
  name, so the fallback never fired: CORS works, and the lazy `callFunction` works. It is the
  first proof that does not run from Node. **Not reached in a browser: `rpcCheckout`** — the
  spec that gets there needs a seed with a Stripe test account.
- **Proven from a browser on STAGING too, 2026-09-20:** signed out, the deployed web app calls
  `rpcMember/listAvailability` and gets a 200, with no fallback. The signed-in half needs a
  login and is run by hand: `PLAYWRIGHT_BASE_URL=https://app-stg.linyup.com` with
  `E2E_LOGIN_EMAIL` / `E2E_LOGIN_PASSWORD` set in the shell, never in a file.
- **CORRECTION — an earlier version of this section said the staging web and admin apps do not
  roll out on merge. That was wrong.** Both App Hosting backends roll out automatically from
  `main` (`rolloutPolicy.codebaseBranch`), and staging was serving routing builds throughout. The
  mistake was reading ONE page of the rollouts API, which returns the oldest first: with several
  hundred rollouts, the newest on that page was weeks old, and a "Disabled" column in the CLI
  table was taken as confirmation. To see what a backend serves, read its `traffic` resource
  (`…/backends/{id}/traffic` → `current.splits`), not the head of a list.
- **The spec was blind on a deployed project at first.** It recognised a functions call by the
  EMULATOR's URL shape, region in the path; on a deployed project the region is in the HOST
  (`europe-west6-{project}.cloudfunctions.net`), so it recorded nothing and failed with "no routed
  callable was requested at all" — which reads like a routing defect and was a watcher that could
  not see. It knows both shapes now, and a test pins them.
- **The ordering window on staging is real, because rollouts ARE automatic:** the web rollout and
  the functions deploy start together on a merge and neither waits for the other. In a browser
  the fallback does not cover a missing function (see Phase 4), so a routed call can fail for the
  minutes between a web build going live and a NEW router finishing its deploy. It only bites a
  merge that adds a router; production is ordered, functions first.
- **Staff onboarding went to `rpcStudio`**, not here: `createTeam` and the two team-invitation
  callables are called from public-looking paths (the signup page, the invitation link), but
  the person is joining as staff.
- **The member app is untouched.** It calls some `rpcMember` names by their own name, from
  store binaries, and keeps doing so until Phase 4. Listing a name in the route table moves only
  callers that go through `callFunction`.
- **`rpcSpike` is retired.** Its two members moved to `rpcMember`; the deploy deletes the
  function (`--force`). `scripts/router-spike.mjs` needs no spike router — it compares whatever
  the route table says.
- **Full coverage is now ENFORCED.** Every domain has moved, so
  `packages/functions/src/utils/routerCoverage.test.ts` fails when a deployed callable is in no
  router and not on its `NOT_ROUTED` list (empty, and meant to stay so). From here a callable
  that skips its router is a new deployed function, and that test is the only thing that says so.
- **Run the spike with the DEPLOYED commit's route table.** Run from a branch that has already
  moved a name to a new router, every such name "fails" with a not-found the deployed project is
  right to give. It happened: eight false failures, from a Phase 3 checkout pointed at a Phase 2
  staging. `node scripts/router-spike.mjs … --routes-ref origin/main` reads the table at that
  commit instead.

- **On staging since 2026-09-20.** `rpcCheckout` and `rpcMember` deployed as written, and the
  spike passes for every router there with the deployed commit's route table. `rpcSpike` is gone.

### Phase 4: mobile (~1 day of code, then months of calendar)
- Move `apps/mobile/src/services/firestore.ts` to `callFunction`.
- Ship it as an OTA **and** in the next store build.
- Record the first store version that routes. That version is what
  `min_supported_version` has to reach.
- Every name mobile calls stays on the frozen list until its §5 criterion holds.
- **Code built 2026-09-20; NOT released.** Every call in
  `apps/mobile/src/services/firestore.ts` goes through
  `apps/mobile/src/services/callFunction.ts`. It is JS-only, so the release lane will choose an
  over-the-air update (`.claude/skills/mobile-release/SKILL.md` → "OTA or native build? The
  fingerprint decides — but know the rule").
- **A client and its backend do not deploy together, so `callFunction` falls back.** The member
  app ships on its own lane and talks to production, which gets routers only when a release tag
  deploys them — an update that routes could reach phones first, and the only way back from a
  broken member app is another update. `withRouterFallback` in
  `packages/shared/src/functions/routes.ts` answers a call under the callable's own name when
  there is NO ROUTER to take it: the function does not exist (the platform's 404, which the SDK
  reports as a bare `not-found`), or the router does not serve that name (its own 404). In both
  the member never ran, so nothing executes twice; a `not-found` the MEMBER throws has its own
  message and is never a fallback. Pinned by
  `packages/functions/src/utils/routerFallback.test.ts`, and checked live against staging from
  Node: a missing router lands on the direct name and returns its result.
- **What the fallback does NOT cover: a missing function, in a BROWSER.** The platform's 404
  carries no CORS headers, so the browser withholds it and the SDK reports `internal` — which
  could be a member that ran and crashed, so it is never a fallback. The web still depends on
  its rollout being ordered after the functions deploy, which the production workflow does. A
  phone has no CORS and gets both cases.
- **Release order, even with the fallback:** deploy the routers to production FIRST (a `v*`
  tag), confirm with `node scripts/router-spike.mjs --target linyup-prod --routes-ref <that tag>`,
  THEN cut the mobile release. The fallback is a seat belt; a release that leans on it spends one
  failed round trip per router on every app start until production catches up.

### Phase 5: alias-removal waves (~0.5 day per wave)
- Per router, once the exit criterion holds:
  - remove the standalone exports from `packages/functions/src/index.ts`
  - record each name, with its evidence, on `ALIAS_REMOVED` in
    `packages/functions/src/utils/routerCoverage.test.ts`
  - deploy
- **This is where the deployable count actually drops.** Web and admin waves can
  start about 14 days after their phase ships TO PRODUCTION. The mobile wave waits on
  `min_supported_version`.
- **Measure with `node scripts/alias-usage.mjs --project <id>`** (`pnpm functions:alias-usage`).
  An alias is its own Cloud Run service, so the platform already counts who calls it.
  **A raw request count never reaches zero:** every function — callables no client has ever
  called included — shows requests in fixed pairs, a 400 and a 404, on a handful of days that
  line up with deploys. Something probes each service. A client that really calls a callable
  gets a 2xx, so the script counts `ok` (2xx) apart from `other`, and QUIET MEANS NO 2xx. It
  prints the router beside each alias, because a quiet alias beside a quiet router is a quiet
  project, not a finished migration.
- **Read the window before the number.** Quiet means unused only if the clients had stopped
  using the name before the window opened. Closing a fiscal year happens once a year: it is
  quiet in almost any window and very much in use. The bar is "the clients route, AND THEN N
  quiet days" — never quiet alone.
- **The guards know three states now.** A router member is exported from `index.ts` (alias live),
  or it is on `ALIAS_REMOVED` and NOT exported (the router is the only way in) — never both, never
  neither. Dropping an export without recording it fails; listing a name that still deploys
  fails; a removed alias that no router serves fails, because removing a NAME must never remove the
  callable. Each was run against the defect it describes.
- **`scripts/router-spike.mjs` reports a removed alias as `gone`,** not as a failure: there is
  nothing to compare the routed answer with, and the router answering is the only thing left to
  prove. The list is printed at the end, so an alias that is gone by accident is on the screen.
- **Wave 1, 2026-09-20: callables nothing has ever called.** No quoted mention in any client or
  script today; none in any commit that ever touched `apps/` or `scripts/`; no successful call on
  production, staging or sandbox in the six weeks Cloud Monitoring keeps. "The clients route"
  holds vacuously — there is no client — which is the only reason this wave could go before
  production has routers. They stay routed: removing a name is not deleting a callable, and
  whether some of them should be deleted outright (`listMyWaitlist` says a member surface needs
  it; none calls it) is a product question, not this one.
- **Every other wave waits, and that is the plan working.** Production has no routers until a
  `v*` tag deploys them; the web there still calls every name directly; six weeks of metrics on
  production show successful calls on only a fraction of the callables, which says how little a
  quiet window would prove today. Next: release to production, let the clients route, run
  `pnpm functions:alias-usage` after 14 days, and remove what is quiet beside a busy router.
- **Shipped store binaries call nothing outside the frozen list.** Checked against every
  `mobile-v*` tag: the names each shipped build calls are a subset of what the app calls today,
  so the frozen list — derived from today's source — covers the binaries in the stores. Older
  commits called names that no longer exist as functions at all.

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
