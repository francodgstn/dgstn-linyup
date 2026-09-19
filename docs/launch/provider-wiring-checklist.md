---
title: Provider wiring
description: Provider wiring checklist (go-live QA)
status: living
area: ops
order: 6
---
# Provider wiring

Goal: prove every third-party path (Stripe Connect, Stripe SaaS billing, Brevo,
Payrexx) is wired correctly **in sandbox/test mode first**, then run a single
**controlled live smoke test** in prod. Never use real customer payments as the
test harness.

Related: [`../payment-contact-studio.md`](../payment-contact-studio.md),
[`../payment-studio-linyup.md`](../payment-studio-linyup.md),
[`../stripe-catalog.md`](../stripe-catalog.md).

---

## 1. Secrets & dashboard config (per environment)

Set in **each** environment — `linyup-sandbox` / `linyup-staging` use **TEST**
keys; `linyup-prod` uses **LIVE** keys. Secrets live in Google Secret Manager
(`packages/functions/src/utils/secrets.ts`); the emulator reads env fallbacks
from `packages/functions/.env.local`.

### Secrets

- [ ] `stripe-secret-key` — platform Stripe key (Connect + SaaS billing share it)
- [ ] `stripe-webhook-secret` — SaaS-billing webhook (`handleStripeWebhook`)
- [ ] `stripe-connect-webhook-secret` — Connect webhook (`handleConnectWebhook`) — **separate endpoint/secret**
- [ ] `brevo-api-key` — Brevo transactional + domains (restricted key)
- [ ] `brevo-webhook-secret` — Brevo event webhook token

### Mail params (non-secret, `firebase-functions/params`)

- [ ] `MAIL_SYSTEM_FROM` (e.g. `hello@linyup.com`), `MAIL_MANAGED_STUDIO_FROM` (e.g. `studios@linyup.com`)
- [ ] `TEST_MODE` = `false` in prod; set `true` (+ `TEST_EMAIL`) in sandbox to **redirect all mail** for safe bulk QA

### Webhook endpoints to register in each provider dashboard

> URL form: `https://<region>-<project>.cloudfunctions.net/<fn>`

- [ ] Stripe **Connect** → `handleConnectWebhook` (events: `account.*`, `capability.*`, `checkout.session.completed`, `payment_intent.*`, `charge.refunded`, `charge.dispute.*`, `customer.subscription.*`, `invoice.*`)
- [ ] Stripe **SaaS billing** → `handleStripeWebhook` (`customer.subscription.*`, `invoice`/`payment.*`)
- [ ] **Brevo** → `handleBrevoWebhook?token=<brevo-webhook-secret>` (delivered, hardBounce, softBounce, blocked, spam, invalid, unsubscribed)
- [ ] **Payrexx** (only if a founder uses it) → `handlePayrexxWebhook?teamId=<teamId>` (per-team signing secret in the team's `integrations` doc)

### Stripe catalogue

- [ ] Run `scripts/stripe-sync.ts --apply` against the env's Stripe account
- [ ] Verify every lookup key resolves: plans (`linyup_<plan>_monthly`), contact block, and **all add-ons including `linyup_addon_products_monthly`**
- [ ] Re-run with `--reprice` only if a price legitimately changed (see [`../stripe-catalog.md`](../stripe-catalog.md))

---

## 2. Automated test sweep (reuse existing guarded tests)

Run from `packages/functions`. Integration tests are **skipped** unless their
env creds are present (so CI stays green without secrets).

- [ ] Unit tests (always run): `pnpm --filter @linyup/functions test` — fees, sender resolution, Brevo event classify, tenant-data manifest
- [ ] Connect integration (test mode): `STRIPE_SECRET_KEY=sk_test_… [STRIPE_TEST_CONNECTED_ACCOUNT=acct_…] pnpm --filter @linyup/functions test` — account create (managed + byo), onboarding link, status, charge + refund (fee reversal)
- [ ] Brevo integration: `BREVO_API_KEY=… [BREVO_TEST_RECIPIENT=you@…] pnpm --filter @linyup/functions test`

### Stripe CLI — replay every handled webhook event

Point `stripe listen` at the sandbox functions and `stripe trigger` each event
the handlers switch on; confirm the idempotency marker (`connect_webhook_events`)
is written once and reconciliation lands in Firestore.

- [ ] `payment_intent.succeeded` / `payment_intent.payment_failed`
- [ ] `checkout.session.completed` (contact created/linked; `member_payments` + `membership_expiration`)
- [ ] `charge.refunded` (status + proportional fee reversal)
- [ ] `charge.dispute.created` / `charge.dispute.closed`
- [ ] `customer.subscription.created/updated/deleted`, `invoice.paid` / `invoice.payment_failed`
- [ ] Re-deliver one event → confirm it is **idempotent** (no double write)

### Stripe Test Clocks — time-based flows

- [ ] Member subscription **renewal** keeps `membership_expiration` in sync
- [ ] SaaS **trial expiry** → `handleTrialLifecycle` downgrades to Free
- [ ] SaaS **past_due** path on failed invoice

---

## 3. Manual E2E smoke in sandbox (scripted)

All in `linyup-sandbox`, Stripe test cards (incl. a 3DS card and TWINT test
behaviour). Use `TEST_MODE=true` so mail is safe.

**Connect / shop (member → studio):**
- [ ] Connect onboarding (managed **and** BYO) → `charges_enabled`
- [ ] Public shop **membership** checkout → contact created/linked, `member_payments` written, membership set
- [ ] Public shop **product** checkout incl. a **variant** → sale recorded, contact linked
- [ ] Public shop **course** (purchase tier) checkout → entitlement granted, lands in Space
- [ ] **Refund** a charge → status + fee reversal correct
- [ ] (TWINT) only one active mandate per studio↔member pair

**SaaS billing (team → Linyup):**
- [ ] Upgrade checkout → `saas_subscriptions` + `team.plan` synced
- [ ] Add-on **activate** then **deactivate** (Stripe item created/removed)
- [ ] **Extend trial** once (second attempt blocked)
- [ ] **Cancel** → stays active until period end → downgrades to Free

**Brevo:**
- [ ] System mail + managed studio mail land in inbox; `mail_sends` ledger updates
- [ ] BYO domain: `registerSenderDomain` → DNS → `checkSenderDomain` flips to verified
- [ ] Simulate bounce/unsubscribe → `mail_suppressions` written; future sends skipped

---

## 4. Production controlled smoke (live mode, internal only)

Done **once** in `linyup-prod`, before founders. Catches live-only config (live
keys, live webhook secret, Connect platform settings, KYC/payout) that test mode
cannot.

- [ ] Create an internal **"Linyup test studio"** tenant you own (flag it `internal` once the flag exists — see founder runbook TODO) with your **own real** Connect account
- [ ] One minimal **real** charge per critical path (≥ CHF 0.50) → webhook + reconciliation OK → **refund** it
- [ ] One real email to your inbox → inbox-placement check (mail-tester.com), not spam
- [ ] Keep this tenant as an ongoing **synthetic monitor**

---

## 5. Observability & alerting (before founders)

- [ ] Alert on Cloud Functions errors (esp. the webhook handlers)
- [ ] Alert on Stripe **failed webhook deliveries** (Stripe dashboard)
- [ ] Alert on Brevo delivery/webhook errors
- [ ] Confirm logs/ledgers are queryable: `[connect]` logs, `mail_sends`, `connect_webhook_events`
- [ ] **Induce one failure** (bad signature / forced throw) and confirm an alert actually fires

---

## Done when

Guarded tests green with test creds · CLI replay of every handled event reconciles
correctly and idempotently · sandbox E2E 100% · the prod controlled smoke (charge +
refund + email) passes · an induced failure triggers an alert.
