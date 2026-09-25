---
title: SaaS billing
description: "Payments: studio → Linyup (SaaS billing)"
status: living
area: payments
order: 2
---
# SaaS billing

> **Scope:** how **Linyup charges studios** for their plan (Coach / Studio /
> Organization) via Stripe subscriptions. Money settles on **Linyup's** Stripe
> balance. This is distinct from how a studio charges its own members — see
> [payment-contact-studio.md](payment-contact-studio.md).

## How it works

- A studio admin starts checkout from **Settings → Billing**; the `createCheckoutSession`
  (org: `createOrgCheckoutSession`) Cloud Function creates a Stripe Checkout Session
  for a recurring subscription on **Linyup's own** Stripe account.
- Prices are resolved by **lookup key** (`linyup_{plan}_monthly`) — no price IDs are
  hardcoded.
- `handleStripeWebhook` reconciles subscription state into
  `saas_subscriptions/{teamId|orgId}` (status, current period, plan, plugin add-ons,
  trial lifecycle).
- All of this runs against Stripe **test mode** locally — no real money moves.

---

## One-time setup

### 1. Install the Stripe CLI

```
# Windows (winget)
winget install Stripe.StripeCLI

# macOS (Homebrew)
brew install stripe/stripe-cli/stripe
```

Authenticate once:
```
stripe login
```

### 2. Get your Stripe test keys

Go to [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys).
Make sure the **Test mode** toggle (top-right) is ON. Copy the **Secret key** — it
starts with `sk_test_`.

### 3. Create Stripe prices (test mode)

Do NOT create these by hand. `pnpm stripe:sync` builds the whole catalog — plans,
add-ons and the contact block — from `packages/shared/src/types/plan.ts`, which is the
source of truth for every amount. Creating a price in the dashboard instead makes the
dashboard a second source of truth, and the two then drift silently: the app charges
what Stripe holds while the pricing page advertises what the repo holds.

```bash
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:sync
```

It is a **dry run** by default and prints one line per entry — `+ create`, `= ok`, or
`! drift` where the live amount disagrees with the repo. Re-run with `--apply` to write.
Changing an existing amount additionally needs `--reprice`, because a Stripe price is
immutable: the flag creates a NEW price and moves the lookup key onto it, which is why
it is opt-in rather than implied. Scope it with `--only <lookup_key>` when one entry is
changing and the catalog holds unrelated drift you have not decided about — the other
entries still report, tagged with the flag that spared them.

**Existing subscriptions keep the price they were created on.** A reprice changes what
the NEXT checkout charges and nothing else; migrating a live subscriber is a separate,
deliberate act.

The script **only ever adds**: an entry deleted from `plan.ts` is left standing in
Stripe rather than archived, because a script cannot know whether somebody is still
billed on it. Retiring one is therefore a deliberate manual step in the dashboard —
archive the price (which stops NEW checkouts and leaves existing subscriptions running
untouched) after checking who is on it. `linyup_organization_monthly`, the flat
organization price that the per-studio rate replaced on 2026-08-28, was retired that way.

The lookup keys are `linyup_{plan}_monthly` for the paid plans, plus
`linyup_addon_{plugin}_monthly`, `linyup_studio_contact_block_monthly` and — for the
organization tier, which is billed **per studio** rather than as one flat amount —
`linyup_organization_studio_monthly`, subscribed with `quantity` = the studio count.
The lookup key is how `createCheckoutSession` resolves the price; the script is the only
thing that should ever create one.

### 4. Fill in `packages/functions/.env.local`

This file is gitignored. Set:

```env
STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
STRIPE_WEBHOOK_SECRET=whsec_FILL_AFTER_STEP_5
HOSTING_URL=http://localhost:3000
```

`STRIPE_WEBHOOK_SECRET` comes from `stripe listen` (next section) — you only know it
after starting the CLI the first time, so fill it in then.

---

## Each dev session

Local dev runs one process per terminal. For billing you need three:

### Terminal 1 — emulators + seed

```
pnpm emulators:seed
```

This builds `@linyup/shared` + Cloud Functions, starts the Firebase emulators
(auth :9099, firestore :8080, functions :5001, storage :9199), and seeds 3 test
accounts. Keeps running (Ctrl+C to stop).

### Terminal 2 — web app

```
pnpm dev:web
```

Starts the Next.js dev server on :3000.

### Terminal 3 — forward Stripe webhooks

Wait until "Ready" appears in Terminal 1, then:

```
pnpm stripe:listen
```

The CLI prints a signing secret like `whsec_abc123…`. Copy it into
`packages/functions/.env.local` as `STRIPE_WEBHOOK_SECRET` → restart Terminal 1.

> You only need the copy-paste the first time. The `whsec_` value stays the same for
> the same `stripe login` session, so later sessions can skip the restart.

---

## Test accounts (seeded)

| Email                 | Password    | Plan         | Status  |
|-----------------------|-------------|--------------|---------|
| `coach@linyup.com`    | `linyup123` | Coach        | Trial   |
| `studio@linyup.com`   | `linyup123` | Studio       | Active  |
| `org@linyup.com`      | `linyup123` | Organization | Active  |

---

## Test scenarios

### Successful subscription upgrade

1. Sign in as `coach@linyup.com`
2. Sidebar → **Billing**
3. Click **Select Plan: Studio**
4. Stripe Checkout opens — use test card:
   - Number: `4242 4242 4242 4242`
   - Expiry: any future date (e.g. `12/34`)
   - CVC: any 3 digits
5. Complete payment → redirected back to `/billing?checkout=success`
6. Page shows: **Studio · Active · Next billing: …**

Watch Terminal 3 — you'll see `customer.subscription.created` and
`invoice.payment_succeeded` events forwarded to the local function.

### Payment failure

Use card `4000 0000 0000 0002` at checkout. Stripe declines it →
`invoice.payment_failed` fires → subscription goes to `past_due`.

### 3D Secure / authentication required

Use card `4000 0025 0000 3155`. Stripe shows a 3DS prompt → complete it → succeeds.

### Cancel subscription

1. Sign in as `studio@linyup.com` (already active)
2. Billing → "Cancel at end of period"
3. Confirm → `cancel_at_period_end: true` set on the subscription
4. Badge shows: **Cancels on [date]**

### Trigger a webhook manually

```
stripe trigger customer.subscription.created
```

Other useful triggers: `invoice.payment_succeeded`, `invoice.payment_failed`,
`customer.subscription.deleted`.

---

## Inspect state

| Tool | URL | What to check |
|------|-----|---------------|
| Firestore emulator UI | [localhost:4000](http://localhost:4000) | `saas_subscriptions/{teamId}` doc |
| Stripe dashboard (test) | [dashboard.stripe.com/test](https://dashboard.stripe.com/test) | Customers, subscriptions, events |
| Terminal 3 (stripe listen) | — | Forwarded events + HTTP response codes |
| Functions emulator logs | Terminal 1 | Function errors surfaced as console output |

---

## Provisioning secrets in staging / prod

SaaS billing needs two secrets per environment (Terraform provisions the containers;
load the values out-of-band):

| Secret (Secret Manager id) | Purpose |
|---|---|
| `stripe-secret-key` | Linyup's Stripe secret key (also reused by Stripe Connect). |
| `stripe-webhook-secret` | Signing secret for the **SaaS-billing** webhook (`handleStripeWebhook`). |

```bash
echo -n "<whsec_...>" | gcloud secrets versions add stripe-webhook-secret \
  --data-file=- --project linyup-staging
```

> If you get `NOT_FOUND: Secret … not found`, the Terraform container hasn't been
> applied yet. Run `terraform apply` in `infra/environments/staging` (or `prod`) first.

---

## Troubleshooting

**"Secret 'stripe-secret-key' not found in env"**
→ `FUNCTIONS_EMULATOR=true` is set but `STRIPE_SECRET_KEY` is missing from
`packages/functions/.env.local`. Add it.

**"No Stripe price found for lookup key: linyup_studio_monthly"**
→ The price doesn't exist in your test Stripe account. Create it with the exact lookup
key from the table above.

**Webhook shows 400 / signature verification failed**
→ `STRIPE_WEBHOOK_SECRET` in `.env.local` doesn't match what `stripe listen` printed.
Copy the `whsec_…` value fresh and restart Terminal 1.

**Billing page calls fail silently in the browser**
→ Make sure Terminal 1 is running and the Functions emulator came up on :5001 —
callable functions have nothing to connect to otherwise.

**Functions emulator not starting**
→ It requires a compiled build. `pnpm emulators:seed` builds automatically, but if you
change function code mid-session, rebuild (`pnpm --filter @linyup/functions run build`,
or `pnpm functions:watch` to rebuild on save) and restart Terminal 1.
