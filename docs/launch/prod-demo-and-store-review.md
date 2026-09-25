---
title: Prod demo tenant
description: "Production demo tenant, store review, and cutover verification"
status: living
area: ops
order: 7.5
---
# Prod demo tenant

Two different needs, deliberately kept apart. Conflating them makes both worse.

| | **Demo tenant** (permanent) | **Canary** (throwaway) |
|---|---|---|
| Answers | can a reviewer use the app? | does prod actually work? |
| Created by | operator console → Settings → Demo tenant | the **real signup wizard** — that path is what is under test |
| Contacts | `@example.com` only | 1–2 **real** addresses you own |
| Messaging | `silent` | `allowlist`, your addresses only |
| Stripe | **never onboarded** | real account, one small live charge, refunded |
| Lifetime | forever; reset before each submission | hours, then purged |

**Why payments and email go on the canary, never the demo tenant.** Prod runs
live Stripe keys, so any payment test moves real money — that must not sit on a
tenant whose credentials go to a store reviewer. The demo tenant has no Connect
account at all, which makes `payments_enabled` fail closed and shuts every priced
door, so a reviewer *cannot* trigger a charge.

---

## A. The demo tenant

Operator console → **Settings → Demo tenant → Provision**. Idempotent; re-apply
any time. The card shows three properties as pass/fail, and all three must be
green before the tenant is left alone in production:

- hidden from platform metrics (`flags.internal`)
- outbound messaging `silent`
- no payment account

**Reset before each submission.** Same card, typed confirmation. A reviewer will
have left bookings behind; reset purges and rebuilds so the next one meets the
same state.

## B. The review login

Console → Settings → Demo tenant → **App-store review login**.

1. Pick a six-digit code. Put it in App Store Connect / Google Play **first** —
   it is never shown again.
2. Enter the demo contact's email (`app.review@example.com`), the code, and a
   window in days (max 60).
3. Enable. From then on that one address gets that code, and **no email is
   sent**.
4. **Disable it once the build is approved.** It also expires on its own, which
   is the point of the window — nobody has to remember.

Submission fields:

- App Store Connect → App Review Information → Sign-In Required → the email and
  the code. Add a note: *"This account uses a static verification code; no email
  will arrive."*
- Google Play → App access → same.

Every issue writes `[review-otp] issued fixed code for …` to Cloud Logging.

## C. Cutover verification (the canary)

1. **Sign up through the real wizard** at app.linyup.com. That path is the thing
   being verified — do not provision it. Use a **fresh plus-address every run**
   (`you+canary3@…`): the Stripe account step 5 creates is registered to it and
   outlives the canary (see step 6), and a reused address risks Stripe offering
   the previous run's account, which is not what a new studio sees.
2. Confirm it appears correctly in the operator console, **then** set
   `flags.internal` so it stops counting.
3. `messaging_policies/{teamId}` → `allowlist`, your addresses only, **before**
   adding contacts.
4. **Email**: add a contact on a real plus-tagged address (`you+canary@…`).
   Seeded `@example.com` addresses are dropped unconditionally by
   `isSyntheticEmail()` and can never prove delivery. Check a booking
   confirmation, a reminder, and the `mail_sends` row.
5. **Payments, both rails, real money:**
   - *SaaS*: subscribe on the cheapest tier → confirm `saas_subscriptions/{id}`,
     the webhook, the invoice → cancel.
   - *Connect*: onboard → one small member charge → confirm `payment_events`,
     the finance journal row, the receipt → refund.
6. **Teardown, in this order:**
   - **Check the Stripe account, and write down its id.** In the connected
     account, confirm there is no live subscription and the balance is zero — a
     refund larger than the balance takes it negative, and Stripe clears that by
     debiting the linked bank account. Copy the `acct_…` id from the console's
     payments card: the purge below deletes the only team → account mapping.
   - console → the team → **Disconnect this account**. This unlinks it on
     Linyup's side **only**; its own confirmation says the account still exists
     at Stripe.
   - Stripe Dashboard → **Connect → Accounts** → the account → **⋯ → Remove
     account**. That is the platform-side disconnect — Stripe's UI never uses the
     word "disconnect".
   - `pnpm purge:team --team <id> --project linyup-prod` (dry-run first).

   **The Stripe account itself cannot be deleted from the platform side.**
   Onboarding creates a Standard-profile account — full dashboard, Stripe liable
   for losses (`MODEL_DASHBOARD` in `packages/functions/src/utils/connect/client.ts`)
   — and Stripe refuses that profile both API deletion
   (`stripe_loss_liable_cannot_be_deleted`) and rejection (platform-liable
   accounts only). Only its owner can close it, from inside its own dashboard, at
   a zero balance. So **every canary that onboards leaves one live account behind
   for good** — which is why step 1 uses a fresh address and the id gets written
   down before the purge.

### Preconditions
**`stripe-secret-key` in prod must be a standard `sk_live_…` key, not a
restricted one.** A restricted key passes `pnpm stripe:sync` and creates both
webhook endpoints without complaint, then fails step 5 at Connect onboarding:
`startConnectOnboarding` 500s on `stripe.v2.core.accounts.create` with
`StripePermissionError … API Key does not have permission to access account`,
and enabling every Connect permission in the key editor does not clear it
(tried 2026-08-22). Stripe's response never names a missing permission. Since
that date version 2 is a standard key; version 1, the restricted one, is still
enabled but is not `latest`.

**Contact sign-in needs the functions runtime to sign custom tokens** —
`roles/iam.serviceAccountTokenCreator` on its own service account, declared in
`infra/modules/iam`. It was missing in all three projects until 2026-08-22, and
nothing but a real person signing in exercises it. If a contact login or a
shop-registration OTP returns `internal`, look for `signBlob` in the
`logincontactwithcode` logs before anything else.

(`readiness-2026-08.md` records that no `stripe-secret-key` existed in prod at
the time; that is a dated record, and no longer true.)

---

## What a reviewer can and cannot do

Worth knowing, because it is what makes the demo tenant safe to leave standing:

- **Cannot be charged** — no Connect account, so no priced door renders.
- **Cannot email anyone** — the tenant is `silent`, and every contact is
  `@example.com`, which is dropped in every environment regardless of policy.
- **Cannot escalate** — the review login is a CONTACT session, not the owner's.
  Since 2026-08-21 a team owner cannot write `plan`, `plan_status`,
  `trial_ends_at` or `flags` from the client either.
- **Can delete the account** — Profile → Delete my account, with a 30-day
  window. Expect a reviewer to try it; canceling is on the same screen.

## Related

- `packages/functions/src/ops/demoTenant.ts` — what gets provisioned, and why
- `packages/functions/src/ops/reviewAccess.ts` — the bypass and its bounds
- `packages/shared/src/utils/contactDeletion.ts` — anonymize-not-erase
- `docs/launch/data-safety-checklist.md` — teardown and external providers
