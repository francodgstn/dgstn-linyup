# App-store insights in the operator console

**Status: experimental spike.** Local emulator only — no Terraform, no deploy, no
CI. `STORE_INGEST_ENABLED` is `false` in every tracked environment, so merging
this changes nothing anywhere until somebody turns it on.

## Why

The two store portals were the only part of running Linyup with no
representation in `ops.linyup.com`. Checking whether a submission was stuck,
whether a tester had left feedback, or whether crash rate had moved meant
opening App Store Connect and Play Console by hand.

## What you can and cannot get

| | iOS — App Store Connect | Android — Google Play |
|---|---|---|
| Release / review state | `appStoreVersions`, `reviewSubmissions` — **and webhooks** (WWDC25) | poll only, no webhook |
| Reviews | `customerReviews` — **text reviews only** | `reviews.list` = **last 7 days**, no history |
| Rating + count | **no aggregate endpoint** → public `itunes.apple.com/lookup` | ratings CSVs in the reports bucket |
| Installs | `salesReports` (daily gzipped TSV) | install CSVs in `gs://pubsite_prod_rev_<devId>/` |
| Vitals / attention | `perfPowerMetrics` | **Play Developer Reporting API** — crash rate, ANR rate, error issues, `anomalies.list` |

### The portal stays necessary for exactly two things

Neither vendor exposes them through any API, and no amount of further work will
change that:

- **Apple's App Review rejection message and Resolution Center thread.** The
  console can say a version is `REJECTED` within seconds. It cannot say why.
- **Google Play's policy status and Console inbox.**

The Member app page says this in as many words, because the first rejection
would otherwise be spent hunting for a message that is not there.

### And the app is pre-launch

Nothing is on the public App Store (the lookup returns `resultCount: 0`); Play
is in the closed test. So installs, reviews, ratings and vitals are **empty**,
and will be until launch. What has content today is release state, TestFlight
feedback, and the adoption figures derived from our own telemetry.

This is the single biggest risk to the feature: **an empty panel looks exactly
like a broken integration**, and an operator who learns to ignore one grey card
will ignore the one that matters later. Which is why `StoreSourceStatus` has
four members and the console renders all four differently:

| | meaning | rendered |
|---|---|---|
| `ok` | we asked and got an answer | green |
| `not_configured` | no credential — **the expected steady state today** | grey, not red |
| `unavailable` | the vendor said "nothing yet" | outline |
| `error` | it went wrong, and `error` says how | red |

Collapse any two of them and the page gains a badge nobody can act on.

## Shape

```
Cloud Functions                       Firestore                  Ops console
─────────────────────────────         ──────────────────────     ─────────────────
appstores/ingest.ts  ── writes ─→     store_presence/{ios,       lib/queries/
  ├── itunesLookup.ts                                android}    storePresence.ts
  ├── appleClient.ts (appleJwt)  ─→   store_reviews/{id}      ─→ (dashboard)/
  └── playClient.ts  (playAuth)                                    member-app/
appstores/webhook.ts ── writes ─→     store_events/{id}
        └── re-runs the ingest ─┘
analytics/mobileAdoptionMetrics ─→    platform_metrics/{date}.mobile
```

The fetching has to live in functions rather than in the console's own server:
the console's runtime service account can **write** a secret version but
deliberately **cannot read one** (`admin_writable_secret_ids` grants
`secretVersionAdder` + `viewer`, never `secretAccessor` — see
`infra/modules/secrets/variables.tf`).

The consequence to design around: the console can only ever report
"configured / not configured" from metadata, so **a wrong key looks exactly like
a right one** until something calls the API. That something is
`refreshStorePresence` — the operator callable is the credential validator, not
a convenience, and it must stay one click from wherever a key is pasted.

### Decisions worth not reversing

- **Two docs, not one summary doc in `app_settings`.** The stores fail
  independently and refresh on different cadences, and `app_settings` means
  operator configuration (two of its docs are world-readable).
- **`store_presence/{platform}` is written WHOLE, not merged.** `{merge:true}`
  does not delete an absent key, so a block omitted because its source failed
  would leave yesterday's value standing under a fresh `updated_at` — the exact
  opposite of "omit, never zero-fill". `ingest_state` is the one block not
  re-derived, so it is read first and carried forward explicitly. The per-date
  `daily` subcollection docs stay merge-safe: they are never partial.
- **One health row per QUESTION, not per HTTP call.** Versions + submissions are
  one row; builds + feedback are one row; vitals + anomalies are one row. Two
  calls sharing a source id double-count the tally and leave whichever ran last
  as the recorded status. (This was a live bug in the first draft.)
- **Two clocks, both stored.** `sources[x].last_ok_at` is when we last reached
  the vendor; `installs.through_date` is what the vendor has data *through*.
  Never derive one from the other, or a green dot sits over stale numbers.
- **Reviews are a collection with deterministic ids**
  (`${platform}_${kind}_${vendorId}`), so a re-poll is idempotent. This matters
  more than it looks: Play only exposes the last seven days, so a poll is the
  only chance to capture a review and a lost write is permanent.
- **TestFlight feedback lives in `store_reviews` too**, as
  `kind: 'beta_feedback'`. Pre-launch it *is* the entire stream; splitting it to
  honour a schema distinction would produce two empty lists instead of one
  useful one.
- **The vendor's date string is stored verbatim** as the `daily` doc id. Apple
  reports in its own reporting day, Play's CSVs are Pacific, `platform_metrics`
  keys Europe/Zurich. Re-keying a vendor date is silent and permanent.
- **Its own `onSchedule`, not a `dailyTasks` entry.** `dailyTasks` catches a
  throw but not a TIMEOUT, and a task that hangs on a vendor API kills the ones
  after it in the array — `rollSessionSeries` among them. An experimental
  read-only dashboard must not be able to stop recurring classes being
  materialised.

## The webhook

`handleAppStoreWebhook` (`packages/functions/src/appstores/webhook.ts`) is the
push half. Apple introduced these at WWDC25; they are registered **per app**
under App Store Connect → Users and Access → Integrations → Webhooks, with a URL
and a secret phrase you choose. Registration is manual and deliberately so — the
API can create one (`POST /v1/webhooks`), but that is a write, and this
integration does not write to Apple.

Because it is registered per app, every delivery is already about our app;
nothing in the payload need be checked against `ASC_APP_ID` (and for most event
types nothing could be — `appStoreVersionAppVersionStateUpdated` carries no
`appId` at all).

**The signature format is the thing to get right:**

```
x-apple-signature: hmacsha256=<hex of HMAC-SHA256(raw body, secret)>
```

The `hmacsha256=` prefix is **part of the header value**. Comparing the whole
header against a bare hex digest fails on every delivery, and fails identically
to a wrong secret — pinned by `webhook.test.ts`, which asserts a bare digest is
*refused*. The HMAC is over `req.rawBody`; `JSON.stringify(req.body)` produces
different bytes and matches nothing.

**What the payload does and does not carry.** The envelope is JSON:API-shaped —
`{ data: { type, id, version, attributes, relationships: { instance } } }` —
and `attributes` is thin. A version-state change gives `oldValue` / `newValue` /
`timestamp` but **not** the version string; beta feedback gives a timestamp and
an instance id but **not** the comment text. Two names for one idea:
`appStoreVersionAppVersionStateUpdated` uses `newValue`, `buildUploadStateUpdated`
uses `newState`. Reading only one stores a silent null.

**Three behaviours worth keeping:**

- **It does not write `store_presence`.** That doc is a gauge with one writer
  (the ingest, which replaces it wholesale). The webhook records the event and
  then **re-runs the ingest**, so the gauge keeps its single writer and the
  store card can never say `READY_FOR_REVIEW` while the log says `REJECTED`.
  The event is written *before* the ingest runs, so a slow or failing Apple API
  cannot lose the notification.
- **It fails closed.** No secret configured ⇒ 503 and nothing recorded. The
  setup-phase leniency in `handlePayrexxWebhook.ts` ("no secret? warn and allow")
  is wrong here: this endpoint is on the open internet and writes to Firestore,
  and a webhook cannot be registered in ASC without a secret anyway, so the
  lenient branch could only ever serve an attacker.
- **An unknown event type is KEPT**, as `kind: 'other'` carrying Apple's own
  type string. Apple ships new event types, and a handler that dropped them
  would lose deliveries silently — this also means a ping or test delivery is
  accepted and visible, whatever Apple calls it. Only an unusable envelope (no
  `data.type` / `data.id`) is rejected, and even then with a 200: a retry storm
  over a payload we will never understand is worse than one logged line.

`needs_attention` (`ATTENTION_VERSION_STATES` in the shared types) is a
**highlight, not a filter** — every event is stored and listed regardless, with
Apple's state rendered verbatim beside it. So a state Apple adds that we do not
recognise costs a badge, never visibility. That is what makes matching on a
known set of names safe.

**Local testing** needs no public URL: the emulator exposes
`http://localhost:5001/demo-linyup/europe-west6/handleAppStoreWebhook`, and any
script that HMACs the exact request bytes with `APPLE_ASC_WEBHOOK_SECRET` is
indistinguishable from Apple. A real registration does need a public URL.

### Deliberately absent

- **`androidpublisher.edits`.** Reading Play's release tracks requires
  `edits.insert` → `edits.tracks.list` → `edits.delete`: a write-shaped
  transaction against a live listing, from a cron, on a read-only integration.
  Not worth a track name.
- **`POST /v1/analyticsReportRequests`.** It creates a durable resource on
  Apple's side, and a cron that calls it is a cron that makes a second one after
  any lost write. If the richer analytics are ever wanted, the create belongs
  behind the operator callable, adopting an existing ONGOING request first.
  `salesReports` covers daily units with a plain GET.
- **Any write to either store.** No `customerReviewResponses`, no
  `reviews.reply`. One-way, by decision.
- **An Android public-listing lookup.** Google publishes none, and the
  alternative is scraping the store page. The console shows the asymmetry
  instead — `store_presence/android` simply has no `listing` block.

## Configuration

Public identifiers are `defineString` params; credentials are Secret Manager
secrets — including the ASC key id and issuer id, which *look* like identifiers
but would sit in git history forever, because `packages/functions/.env.*` are
tracked. Same reasoning as `utils/operator.ts`.

| Param | prod | elsewhere |
|---|---|---|
| `STORE_INGEST_ENABLED` | `false` | `false` |
| `ASC_APP_ID` | `6808572774` | empty |
| `PLAY_PACKAGE_NAME` | `com.dgstn.linyup` | empty |
| `ASC_VENDOR_NUMBER` | empty (sales reports only) | empty |
| `PLAY_REPORTS_BUCKET` | empty | empty |
| `ITUNES_LOOKUP_COUNTRY` | `ch` | `ch` |

**Every one of them must be spelled out in all five `.env` files, even empty.**
`default:` is not enough for a non-interactive deploy — that is what broke
staging on 2026-08-21.

| Secret | Contents |
|---|---|
| `apple-asc-key-id` | 10-char key id |
| `apple-asc-issuer-id` | issuer UUID |
| `apple-asc-private-key` | the `.p8`, PEM **or single-line base64** (prefer base64) |
| `apple-asc-webhook-secret` | reserved for the webhook, not built yet |
| `google-play-service-account` | the whole SA JSON on one line |

Locally these are env vars in `packages/functions/.env.local`
(`getSecret` reads env when `FUNCTIONS_EMULATOR=true`, uppercasing and turning
`-` into `_`). `.env.local.example` carries the block with instructions.

## Running it locally

```bash
node scripts/local-env.mjs status
```

then the emulator suite and `pnpm dev:admin` for this checkout's slot, and open
`/member-app`. With no credentials set at all the iTunes source still answers —
`store_presence/ios.listing.live === false`, `sources.itunes.status === 'ok'` —
which is the correct pre-launch answer rendered as "Not on the App Store yet",
not as a failure. Every Apple and Play source reads `not_configured`.

To force a refresh without waiting for the 05:30 cron, call
`refreshStorePresence` (operator-only; `force: true` bypasses the kill switch,
because a human who just clicked the button is by definition attending).

## What is NOT built

Named so nobody assumes otherwise:

- **Vendor-reported install series.** `salesReports` (needs `ASC_VENDOR_NUMBER`
  and a key with Finance-or-higher access) and the Play reports-bucket CSVs. The
  types (`StoreDailyMetricDoc`) and the `daily` subcollection exist; nothing
  writes them. Deliberately deferred: **the numbers are zero until launch.** The
  adoption card on the Member app page covers the question that *does* have an
  answer today, from our own telemetry.
- **Play bulk-report CSV parsing.** Those files are widely reported to be
  UTF-16LE with a BOM; `toString('utf8')` garbles every header silently, so
  whoever writes the parser must sniff it and should test against a checked-in
  fixture.

## Productionising

1. **Terraform — done, not applied.** The five secret ids are in `secret_ids`
   for **staging and prod** (`infra/environments/{staging,prod}/variables.tf`).
   Each environment plans to *15 to add, 0 to change, 0 to destroy*; run
   `terraform plan -target=module.secrets -out=tfplan && terraform apply tfplan`
   in each to create the containers. `-target` is deliberate here rather than
   routine: a full apply trips over pre-existing state drift unrelated to this.

   Two corrections to what this document said before the work was done:

   - **Not prod-only.** The obvious precedent, `cloudflare-api-token`, is
     prod-only because it **writes** — it registers hostnames on the production
     zone. Every credential here is read-only against Apple and Google, so that
     reasoning does not transfer, and a read-only key in staging is how the
     integration gets exercised before it reaches production. App Store Connect
     allows more than one webhook per app, so staging can have its own.
     `STORE_INGEST_ENABLED` is the guard against unattended activity, not the
     absence of a secret. Sandbox is still excluded — it hosts prospect demos
     and has nothing to do with the member app.
   - **Not in `admin_writable_secret_ids`.** The earlier argument was that an
     operator should paste the `.p8` from the console rather than put a private
     key through shell history. But there is no Settings form for these secrets,
     and granting `secretVersionAdder` for a form that does not exist is
     provisioning a capability nothing uses. Set the values with
     `gcloud secrets versions add … --data-file=-`, which keeps them out of
     shell history anyway. Add the grant if and when a form is built.

   While doing this, `deepl-api-key` turned out to be listed **twice** in every
   environment's `secret_ids`. `toset()` deduped it for most resources, but
   `extra_accessor` builds its key from `setproduct` on the raw list, so the
   duplicate produced *"Two different items produced the key
   deepl-api-key|…-compute@…"* — meaning staging and prod could not `plan` at
   all. Removed in both; the plan shows no churn from it, which confirms nothing
   else was ever affected.

2. Mint the ASC API key. **The role is chosen once and cannot be changed** —
   App Manager reads versions, builds and TestFlight; `salesReports` needs
   Finance or higher. A key with too narrow a role 403s in a way that reads as a
   bug in this code.
3. Mint the Play service account and **grant it in the Play Console**
   ("View app information and download bulk reports"), not in GCP IAM.
   Terraform cannot express this, `plan` will look clean, and the failure is a
   403 that reads like a bad key.
4. Deploy rules and indexes ahead of functions.
5. Flip `STORE_INGEST_ENABLED` to `true` in prod, then click refresh in the
   console — the callable is what actually validates the keys.
