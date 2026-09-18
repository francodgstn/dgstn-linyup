# Mail (Brevo)

All application mail is sent through Brevo's HTTP **transactional email API**. There
is no SMTP and there are **no stored mail credentials** for anyone — the Brevo API
key is server-side only and BYO domains are authenticated via the studio's own DNS.

## Layout

| File | Responsibility |
|---|---|
| `types.ts` | Provider-agnostic contracts (`OutboundMessage`, `ResolvedSender`, `MailProvider`). |
| `mailService.ts` | The single entry point. `sendSystemMail` / `sendStudioMail`; test-mode redirect, suppression, idempotency, retry. |
| `senderResolution.ts` | **Pure** resolution of the sender identity (Managed vs verified BYO). Unit-tested. |
| `senderIdentity.ts` | System + Managed-studio identities, env-backed (the deferrable-subdomain seam). |
| `senderConfig.ts` | Firestore read/write of `EmailSenderConfig`, team contact-email + studio context. |
| `suppression.ts` | Suppression list read/write (`mail_suppressions`). |
| `brevoProvider.ts` | The Brevo adapter — the **only** file that sends via the Brevo SDK. |
| `brevoClient.ts` | Shared `BrevoClient` (API key from Secret Manager). |
| `brevoDomains.ts` | Brevo sender-domains API (create / status / authenticate / delete). |
| `domainAuth.ts` | Callables: `registerSenderDomain`, `checkSenderDomain`, `useManagedSender`. |
| `handleBrevoWebhook.ts` | `onRequest` webhook → suppression + delivery-status ledger. |
| `mailMetrics.ts` | Aggregations over the send log — the platform daily figure. |

Application code does **not** import this module directly — it calls
`sendEmail(...)` from `../utils/email`, a thin façade. Pass `teamId` to send **as the
studio**; omit it to send **Linyup system mail**.

## Sender resolution (`sendStudioMail`)

1. **Managed** (default, everyone): from the Managed linyup.com address, display name =
   the studio's name, Reply-To = the studio's contact email.
2. **BYO domain** (opt-in, paid plans only): once the studio's domain is `verified` in
   Brevo, mail is sent from `<local-part>@<their-domain>` (local part chosen by the
   studio, default `info`). Until verified — or if verification breaks, or the plan is
   free — it automatically falls back to Managed. An unauthenticated third-party domain
   is never put in the From.

System mail always sends from the configured system identity (`hello@linyup.com`),
kept separate from studio mail so the two streams can later move to separate
subdomains for reputation isolation.

## Environment

**Secrets** (Secret Manager in prod; `packages/functions/.env.local` for the emulator,
gitignored):

| Name | Secret Manager | Emulator env |
|---|---|---|
| Brevo API key | `brevo-api-key` | `BREVO_API_KEY` |
| Webhook shared token | `brevo-webhook-secret` | `BREVO_WEBHOOK_SECRET` |

**Non-secret params** (`firebase-functions/params`, overridable per environment;
defaults shown):

| Param | Default | Meaning |
|---|---|---|
| `MAIL_SYSTEM_FROM` | `hello@linyup.com` | System mail From |
| `MAIL_SYSTEM_NAME` | `Linyup` | System mail display name |
| `MAIL_MANAGED_STUDIO_FROM` | `studios@linyup.com` | Managed studio mail From (display name = studio) |
| `MAIL_ENABLED` | `true` | Master kill switch — set to `false` to disable ALL sending in an environment |
| `SMS_ENABLED` | `false` | SMS master switch (SMS spends prepaid Brevo credits — opt in per env) |
| `TEST_MODE` | `false` | Redirect all mail/SMS to `TEST_EMAIL`/`TEST_SMS_NUMBER` (dev/CI; **bypasses tenant policies**) |
| `TEST_EMAIL` / `TEST_SMS_NUMBER` | — | Redirect targets when `TEST_MODE=true`; empty drops the send |
| `MESSAGING_DEFAULT_MODE` | `live` | Delivery mode for tenants WITHOUT a `messaging_policies` doc (see below) |

**Per-environment policy** (committed in `packages/functions/.env.<alias>`):

| Env | Setting | Effect |
|---|---|---|
| production | `TEST_MODE=false`, `MESSAGING_DEFAULT_MODE=live` | Real sending (policies optional) |
| staging | `TEST_MODE=true`, `TEST_EMAIL=<your inbox>` | All mail redirected to one inbox |
| sandbox (mixed demo) | `MAIL_ENABLED=true`, `TEST_MODE=false`, `MESSAGING_DEFAULT_MODE=silent` | Per-tenant policies decide (below) |
| dev/emulator | no key, or `TEST_MODE=true` | Fail-soft / redirect to you |

## Per-tenant delivery policy (`messaging_policies/{entityId}`)

One environment can host tenants with OPPOSITE delivery needs (the sandbox runs
founder-lead demos that must reach the real lead AND the public `/try` playground
that must never message anyone). Environment-wide switches can't express that, so
outbound delivery is layered:

1. **Env kill switches** — `MAIL_ENABLED` / `SMS_ENABLED` (hard off, zero calls).
2. **`TEST_MODE`** — dev/CI convenience redirect; when on it *bypasses* layers 3–4.
3. **Synthetic-recipient guard** (always on, every env) — `isSyntheticEmail()` drops
   RFC-2606/reserved recipients (`@example.com|org|net`, `*.example|test|invalid|
   localhost|local`, dotless domains) before any provider call, so seeded demo
   contacts can never bounce and damage the Brevo sender reputation.
4. **Tenant policy** — `messaging_policies/{entityId}` (`entityId` = teamId | orgId |
   literal `system` for Linyup's own stream). **Operator-only**: firestore.rules
   denies ALL client access (demo tenants have shared owner logins); docs are
   written by the Admin SDK only (seeders, `pnpm messaging:policy`, operator
   console later). Absent doc → `MESSAGING_DEFAULT_MODE`.

| Mode | Behavior |
|---|---|
| `live` | Deliver normally |
| `allowlist` | Deliver only to `allowEmails` (exact or `@domain.tld` entries, case-insensitive) / `allowPhones` (E.164); everything else dropped |
| `redirect` | Replace every recipient with `redirectEmail`/`redirectPhone` (e2e capture inboxes) |
| `silent` | Drop everything |

Resolution is cached in-memory for 60s (`mail/messagingPolicy.ts`). A send that is
fully dropped writes a `mail_sends` entry with `status:'suppressed'` +
`suppress_reason` so gaps are explainable. A `'suppressed'` entry does **not**
spend the idempotency key — see "The send log" below.

**Operator visibility:** the functions runtime publishes its messaging ENV params
(kill switches, TEST_MODE + redirect target, default mode) hourly to
`app_settings/messaging_env` (`mail/messagingEnvStatus.ts`, piggybacked on
`bookingRemindersHourly`). The operator console's policy card renders it above
the tenant policy — a red banner when `MAIL_ENABLED=false`, an amber one when
`TEST_MODE` bypasses policies, else a muted status line — so the card can never
show an allowlist that the environment is silently overriding.

**Sandbox recipe:**
- lead demos: `pnpm lead:seed` writes a `redirect` policy → the operator
  (`LEAD_OPERATOR_EMAIL`, default your address) as the GENERAL RULE — the initial
  setup delivers ONLY to you (your test OTP/confirmations + the owner
  notifications that would go to the lead's studio inbox all funnel to you),
  nothing reaches the real lead. Hand over deliberately later: switch to
  `allowlist` (add the lead) or `live` in the operator console / CLI. A profile's
  `messagingPolicy` may override, but the operator stays reachable.
- `/try` teams: `pnpm sandbox:seed` writes `mode:'silent'` — the public
  form/booking-OTP surfaces can't message arbitrary addresses (side effect: the
  returning-member OTP flow doesn't deliver codes on /try; guests still book).
- everything else: `MESSAGING_DEFAULT_MODE=silent` catches it.
- inspect/adjust anytime: `pnpm messaging:policy --team lead-swimli --show`, or
  `--mode allowlist --allow a@b.c --allow-phone +41…` / `--mode silent` /
  `--mode redirect --redirect capture@linyup.com` / `--delete` (env default).
  System-stream mail (no teamId) uses the `system` entity id.

## Brevo account setup (one-time)

1. **Authenticate `linyup.com`** in Brevo (Senders & IP → Domains): add the DKIM +
   Brevo-code records. Create/verify the senders `hello@linyup.com` and
   `studios@linyup.com`.
2. Create a **restricted** API key (transactional email + domains scopes) → store as
   the `brevo-api-key` secret. Never expose it to the client or logs.
3. Create a transactional **event webhook** pointing at the deployed handler with the
   shared token in the query string:
   `https://<region>-<project>.cloudfunctions.net/handleBrevoWebhook?token=<brevo-webhook-secret>`
   Subscribe to: `delivered`, `hardBounce`, `softBounce`, `blocked`, `spam`,
   `invalid`/`invalid_email`, `unsubscribed`.

## Receiving replies (inbound)

Brevo is **send-only** — it has no inbox, so replies to Linyup mail (`hello@`, and
`studios@` when the Reply-To is stripped) need a separate inbound path. That path —
**OVH email redirection** for receiving plus **Gmail "Send mail as" via Brevo's SMTP
relay** for replying — lives entirely in DNS / OVH / a personal Gmail account, with no
dependency on this module. See [`docs/email-inbound.md`](../../../../docs/email-inbound.md)
for the full runbook.

## BYO domain flow

`registerSenderDomain` → Brevo `POST /senders/domains` → persists `pending` config +
returns the DNS records to display. The studio adds the records; `checkSenderDomain`
polls Brevo (`authenticate` + `getDomainConfiguration`) and flips the status to
`verified`. `useManagedSender` reverts to Managed and removes the Brevo domain.

## Suppression & idempotency

- The webhook writes a `mail_suppressions/{sha256(email)}` doc on
  hardBounce/blocked/spam/invalid/unsubscribed; `mailService` skips suppressed
  recipients so repeated sends to dead addresses stop.
- Pass `idempotencyKey` on critical-path sends. The key is forwarded to Brevo
  (`Idempotency-Key` header) and becomes the `mail_sends` **doc id**; a duplicate
  keyed send is skipped, and keyed sends are retried with backoff (safe because
  Brevo dedupes on the key).

### SMS opt-out

Every SMS names the contact it is for (`OutboundSms.contactId`, `null` only for a
send about no contact). `sendStudioSms` reads that contact and drops the send when
`sms_opt_out === true`, before the test-mode redirect, writing a `suppressed` row
with `suppress_reason: 'opt_out'`. A failed contact read throws rather than sends.
`sms_suppressions/{sha256(E.164)}` is the separate per-NUMBER block, checked after
the tenant policy.

**Nothing writes `sms_suppressions` yet, and there is no inbound STOP handler** —
deliberately, because Brevo's docs do not support one for transactional SMS
(checked 2026-09-17, developers.brevo.com):

- A transactional SMS that carries a stop code is **reclassified as marketing** by
  Brevo (then held outside 08:00–22:00, Sundays and French holidays), so the
  STOP-reply mechanism does not exist on the transactional path we use.
- The webhook API accepts `channel: 'sms'`, but its `events` enum is shared with
  email and the SMS mapping is undocumented. The documented SMS payloads use
  `msg_status` / `to` / numeric `messageId` — no `event`, no `email` — and the
  unsubscribe payload does not carry the reply text.
- The send API has no opt-out parameter.

Consequence: `handleBrevoWebhook` ignores SMS payloads (it returns early without
`event`/`email`), so SMS ledger rows stay `sent`. Wiring SMS delivery status or
`addSmsSuppression` needs a captured real payload first, not the docs.

## The send log (`mail_sends`)

**Every send is recorded** — keyed or not. A keyed send uses its key as the doc
id (that is what makes a resend a no-op); a keyless one gets an auto id. Until
2026-08 a row was written only when the call site passed a key, which was a
minority of sends, so anything counting the collection reported an arbitrary
fraction while reading as authoritative. There is no backfill for the gap: those
sends were never recorded, and every figure derived from the ledger says so.

Client reads and writes are denied outright (`firestore.rules`) — this is an
Admin-SDK collection.

| Field | Notes |
|---|---|
| `channel` | `'email'` \| `'sms'`. SMS shares this collection; mail rows carry it too from 2026-08, so the two are separable. Rows older than that have none. |
| `stream` | `'system'` (Linyup's own mail) \| `'studio'` (sent AS a tenant). |
| `team_id` | Present on studio mail only — system mail is attributable to no studio. |
| `status` | `'sent'` → flipped by the Brevo webhook to delivered / bounced / blocked / spam / failed; or `'suppressed'` for a send dropped before the provider. |
| `suppress_reason` | Both channels: `policy_silent` / `policy_allowlist`. Email: `synthetic` / `dead_address`. SMS: `opt_out` (the contact's `sms_opt_out`) / `invalid_number` / `suppressed_number` (on `sms_suppressions`). |
| `recipient_count` | Addresses handed to the provider — a row is one provider call, which may carry several. `0` on a suppressed row. |
| `created_at` | The SEND time, stamped **once**. `updated_at` moves when a delivery webhook lands, so it is not a send-time axis and no count ranges over it. |

A drop caused by the ENVIRONMENT writes **nothing**, on purpose — the kill
switch (`MAIL_ENABLED=false`), and TEST_MODE with no `TEST_EMAIL` to redirect to.
Neither is a fact about an address, and filing an operator's configuration beside
a hard bounce would tell a studio that a real address is bad when nothing was
ever sent.

**A suppressed row does not spend the idempotency key.** The key is the doc id,
and a keyed resend is skipped only once the row shows the message REACHED THE
PROVIDER — `sent`, or whatever the webhook made of it (`delivered`, `bounced`,
`blocked`, `spam`). `failed` and `suppressed` both mean nothing left the process.
A suppressed row records a seeded `@example.com` address, a policy the operator
set, an address on the suppression list, or a contact's SMS opt-out; every one of those can be true today
and false tomorrow, while the key is derived from the message and never changes.
Treat the drop as terminal and the legitimate send that follows the fix is
skipped forever. The rule lives in one predicate, `ledgerRowSpendsKey`
(`mailService.ts`), and is pinned by `mailService.test.ts`.

**Counting it.** Aggregations, never a stored counter — nothing here is
write-contended (a per-team counter would be touched once per email), and an
aggregation cannot drift out of sync with the rows it reads.

A ROW IS A PROVIDER CALL, NOT AN EMAIL. So a "sent" figure SUMS `recipient_count`
(the addresses, which is what an operator reads "Emails" to mean) and a
"suppressed" figure COUNTS rows — a suppressed send reached nobody and carries
`recipient_count: 0`, which is also why the sums need no `status != 'suppressed'`
filter. Just as well: an inequality drops documents where the field is absent,
and it cannot be combined with a `created_at` range anyway.

Readers: `mailMetrics.ts` (platform daily snapshot → `PlatformMetricsDoc.mail`)
and `apps/admin/src/lib/queries/messaging.ts` (per-studio + live platform
figures). Retention is deliberately unset — the collection grows forever; if a
TTL is ever added, the lifetime figures must move to the daily snapshot.

## Tests

- `senderResolution.test.ts` — Managed / BYO-verified / BYO-unverified→fallback /
  no-domain→Managed / free-plan→Managed.
- `brevoProvider.test.ts` — request mapping (sender, reply-to, idempotency, attachments).
- `handleBrevoWebhook.test.ts` — event classification.
- `mailMetrics.test.ts` — the Zurich day window, including both DST switches.
- `mailService.test.ts` — which ledger states spend an idempotency key.
- `smsService.test.ts` — phone normalisation, sender sanitising, and the
  opt-out / suppressed-ledger path of `sendStudioSms` against a fake Firestore.
- `brevo.integration.test.ts` — live, runs only when `BREVO_API_KEY` (and
  `BREVO_TEST_RECIPIENT` for sends) is set; covers system, managed-studio and BYO sends
  plus a domain-status read.
