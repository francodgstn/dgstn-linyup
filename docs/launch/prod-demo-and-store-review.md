---
title: "Production demo tenant, store review, and cutover verification"
status: living
area: ops
---
# Production demo tenant, store review, and cutover verification

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
   being verified — do not provision it.
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
   - console → the team → **Disconnect this account** (Stripe)
   - `pnpm purge:team --team <id> --project linyup-prod` (dry-run first)

### Precondition
`readiness-2026-08.md` records that **no `stripe-secret-key` version exists in
prod**. Step 5 cannot run until that is set (console → Settings → Stripe).
Confirm before booking the cutover window.

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
  window. Expect a reviewer to try it; cancelling is on the same screen.

## Related

- `packages/functions/src/ops/demoTenant.ts` — what gets provisioned, and why
- `packages/functions/src/ops/reviewAccess.ts` — the bypass and its bounds
- `packages/shared/src/utils/contactDeletion.ts` — anonymise-not-erase
- `docs/launch/data-safety-checklist.md` — teardown and external providers
