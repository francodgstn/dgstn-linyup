# Payments e2e (real Stripe TEST mode)

Browser tests of every money path, run against ONE local slot with real Stripe
test-mode objects. Unlike `../promo-code-checkout.spec.ts`, which stops at the
Checkout Session, these specs **pay**: they fill Stripe's hosted Checkout with
a test card, let `stripe listen` deliver the webhook to the slot's functions
emulator, and assert on what the webhook wrote (and, where the amount is the
point, on what Stripe recorded).

## Preconditions (all four, or the specs fail loudly at the first step)

1. **A running, seeded slot with Stripe test accounts linked.** The seed links
   a real TEST connected account per team only when told which one:

   ```bash
   node scripts/local-env.mjs status
   STRIPE_CONNECT_TEST_ACCOUNT="seed-team-studio=acct_1TlfblGz6xnbfIzN,seed-team-org=acct_1TotVEGz6x8sQ98q" \
     node scripts/local-env.mjs reset --slot N --yes
   ```

   `pnpm connect:test-account --list` prints the acct ids on the platform.

2. **`HOSTING_URL` in `packages/functions/.env.local` pointing at the slot's
   web port** (`http://localhost:N3000`). SaaS plan checkout returns to it, so on
   slot N ≥ 1 the default `:3000` sends the browser to another checkout's app.
   `local-env init` now writes it; an older `.env.local` needs it by hand, and
   the functions emulator must be restarted to read it.

3. **`stripe listen` forwarding to the slot**, with the signing secret that is
   in `packages/functions/.env.local`:

   ```bash
   stripe listen --api-key "$STRIPE_SECRET_KEY" \
     --forward-to localhost:N5001/demo-linyup/europe-west6/handleStripeWebhook \
     --forward-connect-to localhost:N5001/demo-linyup/europe-west6/handleConnectWebhook
   ```

   (`--api-key` because the CLI's own login key expires every 90 days; the
   signing secret it prints is per device and does not change with the key.)
   Without it every spec reaches Stripe, pays, and then times out waiting for a
   webhook write that never comes.

4. **`MAIL_ENABLED=false`** in the functions env (the default in the example
   file). The contact sign-in reads the issued code from the emulator's
   `verification_codes`, so nothing needs to be mailed, and nothing should be.

Then:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:N3000 pnpm --filter @linyup/web exec playwright test e2e/payments
```

## What each spec proves

Each spec's header says what it covers and what it deliberately leaves out.
The run's findings live in `docs/launch/payments-e2e-2026-09.md`.

## Notes

- The specs create contacts with fixed `e2e-*@example.com` addresses and delete
  them (and their subcollections) before each run, so a rerun starts clean.
  Payments recorded on Stripe are left there: test mode, no money moves.
- Rate-limit buckets (`auth_code_attempts`, `shop_registration_attempts`) are
  cleared before a sign-in; on the emulator every caller shares one `unknown`
  IP bucket, so a few runs exhaust it for everyone.
- Stripe's hosted Checkout is Stripe's page. `payOnStripeCheckout` in
  `lib.ts` is the only place that knows its selectors.
